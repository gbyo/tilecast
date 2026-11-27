package plugins

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/plugindelivery"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/samplestate"
)

// Durable timers on the plugin delivery queue: at-least-once delivery
// under a lease, generations that a late callback cannot touch, parking
// after the last attempt, and no queue for a removed plugin. The clock is a
// stepped clock; no test waits on the wall clock for a timer.

type timerEnvironment struct {
	installationEnvironment
	service *Service
	sample  *samplestate.Plugin
	clock   *steppedClock
}

func withTimers(t *testing.T, run func(timerEnvironment)) {
	t.Helper()
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, err := env.pool.Exec(env.ctx, `TRUNCATE plugin_deliveries, plugin_delivery_status`); err != nil {
			t.Fatal(err)
		}
		sample := samplestate.New()
		clock := &steppedClock{now: time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)}
		service := NewService(env.pool, nil, WithPlugins(sample), WithClock(clock))
		if _, _, err := service.Install(env.ctx, samplestate.ID, env.userID); err != nil {
			t.Fatal(err)
		}
		run(timerEnvironment{installationEnvironment: env, service: service, sample: sample, clock: clock})
	})
}

// restarted is another Server process over the same database and plugin.
func (e timerEnvironment) restarted() *Service {
	return NewService(e.pool, nil, WithPlugins(e.sample), WithClock(e.clock))
}

func (e timerEnvironment) schedule(t *testing.T, key string, in time.Duration, payload string) uuid.UUID {
	t.Helper()
	id, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, key, e.clock.Now().Add(in), []byte(payload))
	if err != nil {
		t.Fatalf("schedule %s: %v", key, err)
	}
	return id
}

func (e timerEnvironment) advance(d time.Duration) { e.clock.Set(e.clock.Now().Add(d)) }

func (e timerEnvironment) run(t *testing.T, service *Service) int {
	t.Helper()
	ran, err := service.RunDeliveries(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	return ran
}

func (e timerEnvironment) pending(t *testing.T) []string {
	t.Helper()
	rows, err := e.pool.Query(e.ctx, `SELECT source||':'||convert_from(payload,'UTF8') FROM plugin_deliveries
		WHERE plugin_id=$1 AND kind='timer' AND state='pending' ORDER BY source`, samplestate.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var item string
		if err := rows.Scan(&item); err != nil {
			t.Fatal(err)
		}
		out = append(out, item)
	}
	return out
}

func TestTimerScheduleReplaceCancelAndDeliver(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		first := e.schedule(t, "release-room", time.Minute, "one")
		second := e.schedule(t, "release-room", 2*time.Minute, "two")
		if first == second {
			t.Fatal("a replacement kept the generation ID")
		}
		if got := e.pending(t); len(got) != 1 || got[0] != "release-room:two" {
			t.Fatalf("pending = %v", got)
		}
		e.advance(90 * time.Second)
		if ran := e.run(t, e.service); ran != 0 {
			t.Fatalf("the replaced time fired: %d", ran)
		}
		e.advance(30 * time.Second)
		if ran := e.run(t, e.service); ran != 1 {
			t.Fatalf("due timer ran %d", ran)
		}
		deliveries := e.sample.Deliveries()
		if len(deliveries) != 1 || deliveries[0].Timer.Key != "release-room" || string(deliveries[0].Timer.Payload) != "two" ||
			deliveries[0].Timer.ID != second.String() || deliveries[0].Timer.Attempt != 1 {
			t.Fatalf("deliveries = %+v", deliveries)
		}
		// The callback runs in the system context, with no operator.
		if deliveries[0].Principal {
			t.Fatal("a timer callback carried an operator")
		}
		if len(e.pending(t)) != 0 || e.run(t, e.service) != 0 {
			t.Fatal("a completed timer stayed")
		}
		e.schedule(t, "end-window", time.Minute, "")
		cancelled, err := e.service.CancelTimer(e.ctx, samplestate.ID, "end-window")
		if err != nil || !cancelled {
			t.Fatalf("cancel = %t %v", cancelled, err)
		}
		if cancelled, _ := e.service.CancelTimer(e.ctx, samplestate.ID, "end-window"); cancelled {
			t.Fatal("a second cancel found a timer")
		}
		e.advance(time.Hour)
		if e.run(t, e.service) != 0 {
			t.Fatal("a cancelled timer fired")
		}
	})
}

func TestTimerValidation(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		now := e.clock.Now()
		for name, call := range map[string]func() error{
			"long key": func() error {
				_, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, strings.Repeat("k", 129), now, nil)
				return err
			},
			"empty key": func() error { _, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "", now, nil); return err },
			"control key": func() error {
				_, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "a\nb", now, nil)
				return err
			},
			"large payload": func() error {
				_, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "k", now, make([]byte, 4097))
				return err
			},
			"no time": func() error {
				_, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "k", time.Time{}, nil)
				return err
			},
			"far future": func() error {
				_, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "k", now.Add(401*24*time.Hour), nil)
				return err
			},
		} {
			if err := call(); !errors.Is(err, ErrTimerInvalid) {
				t.Errorf("%s = %v", name, err)
			}
		}
		if _, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "k", now, make([]byte, 4096)); err != nil {
			t.Fatalf("4 KiB payload = %v", err)
		}
		if _, _, err := e.service.ScheduleTimer(e.ctx, "sample_signs", "k", now, nil); !errors.Is(err, ErrPluginNotFound) {
			t.Fatalf("a plugin without timers = %v", err)
		}
		// The pending timer limit counts other keys; replacing a key fits.
		if _, err := e.pool.Exec(e.ctx, `INSERT INTO plugin_deliveries(id,plugin_id,definition_version,installed_at,kind,source,subject,payload,due_at,next_attempt_at)
			SELECT gen_random_uuid(),$1,1,(SELECT installed_at FROM plugin_installations WHERE plugin_id=$1),'timer','bulk'||n,'timer:bulk'||n,''::bytea,$2,$2 FROM generate_series(2,1000) n`, samplestate.ID, now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		if _, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "k", now, nil); err != nil {
			t.Fatalf("replace at the limit = %v", err)
		}
		if _, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "one-more", now, nil); !errors.Is(err, ErrTimerLimit) {
			t.Fatalf("over the limit = %v", err)
		}
	})
}

func TestTimersSurviveRestartAndExpiredClaimsAreReclaimed(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		// A restart before the due time: another process delivers it.
		e.schedule(t, "before", time.Minute, "p")
		e.advance(time.Minute)
		if ran := e.run(t, e.restarted()); ran != 1 || len(e.sample.Deliveries()) != 1 {
			t.Fatalf("after restart ran %d", ran)
		}
		// A process claims a timer, runs its side effect, and stops before
		// it records the result.
		e.sample.Reset()
		id := e.schedule(t, "after", 0, "p")
		if _, err := e.pool.Exec(e.ctx, `UPDATE plugin_deliveries SET claim_token=gen_random_uuid(), claimed_until=$2, attempts=attempts+1 WHERE id=$1`,
			id, e.clock.Now().Add(plugindelivery.Lease)); err != nil {
			t.Fatal(err)
		}
		// While the lease holds, no other process claims it.
		if ran := e.run(t, e.restarted()); ran != 0 {
			t.Fatalf("a held lease was claimed: %d", ran)
		}
		e.advance(plugindelivery.Lease)
		if ran := e.run(t, e.restarted()); ran != 1 {
			t.Fatalf("an expired lease was not reclaimed: %d", ran)
		}
		deliveries := e.sample.Deliveries()
		if len(deliveries) != 1 || deliveries[0].Timer.Attempt != 2 || deliveries[0].Timer.ID != id.String() {
			t.Fatalf("redelivery = %+v", deliveries)
		}
	})
}

func TestTwoWorkersNeverClaimTheSameGeneration(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		for i := 0; i < 60; i++ {
			e.schedule(t, fmt.Sprintf("t%02d", i), 0, "")
		}
		var wg sync.WaitGroup
		workers := []*Service{e.service, e.restarted(), e.restarted(), e.restarted()}
		for _, worker := range workers {
			wg.Add(1)
			go func(worker *Service) {
				defer wg.Done()
				for {
					ran, err := worker.RunDeliveries(e.ctx)
					if err != nil {
						t.Error(err)
						return
					}
					if ran == 0 {
						return
					}
				}
			}(worker)
		}
		wg.Wait()
		// Each worker stops when it finds nothing; one more pass drains
		// anything a busy bound held back.
		for e.run(t, e.service) > 0 {
		}
		seen := map[string]int{}
		for _, delivery := range e.sample.Deliveries() {
			seen[delivery.Timer.ID]++
		}
		if len(seen) != 60 {
			t.Fatalf("delivered %d distinct timers", len(seen))
		}
		for id, count := range seen {
			if count != 1 {
				t.Fatalf("timer %s delivered %d times", id, count)
			}
		}
	})
}

func TestTimerErrorsRetryWithBackoffWithoutSpinning(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		failures := 2
		e.sample.Handle = func(context.Context, *plugin.Services, plugin.Timer) error {
			if failures > 0 {
				failures--
				return errors.New("provider unavailable")
			}
			return nil
		}
		e.schedule(t, "sync", 0, "")
		if ran := e.run(t, e.service); ran != 1 {
			t.Fatalf("first run = %d", ran)
		}
		var attempts int
		var lastError string
		var due time.Time
		if err := e.pool.QueryRow(e.ctx, `SELECT attempts,last_error,next_attempt_at FROM plugin_deliveries WHERE source='sync'`).Scan(&attempts, &lastError, &due); err != nil {
			t.Fatal(err)
		}
		if attempts != 1 || lastError != "handler_error" || !due.Equal(e.clock.Now().Add(plugindelivery.RetryBase)) {
			t.Fatalf("after a failure: attempts %d, error %s, due %v", attempts, lastError, due)
		}
		// No spinning: the same moment delivers nothing.
		if ran := e.run(t, e.service); ran != 0 {
			t.Fatalf("a failed timer ran again at once: %d", ran)
		}
		e.advance(plugindelivery.RetryBase)
		e.run(t, e.service)
		e.advance(plugindelivery.RetryBase) // the second retry waits twice as long
		if ran := e.run(t, e.service); ran != 0 {
			t.Fatal("the backoff did not double")
		}
		e.advance(plugindelivery.RetryBase)
		if ran := e.run(t, e.service); ran != 1 || len(e.pending(t)) != 0 {
			t.Fatalf("third attempt = %d, pending %v", ran, e.pending(t))
		}
		attemptsSeen := []int{}
		for _, delivery := range e.sample.Deliveries() {
			attemptsSeen = append(attemptsSeen, delivery.Timer.Attempt)
		}
		if fmt.Sprint(attemptsSeen) != "[1 2 3]" {
			t.Fatalf("attempts = %v", attemptsSeen)
		}
		// A panic is a failure of the callback; the eighth failure parks
		// the timer, and it stays visible until an Owner acts on it.
		e.sample.Handle = func(context.Context, *plugin.Services, plugin.Timer) error { panic("boom") }
		broken := e.schedule(t, "broken", 0, "")
		for i := 0; i < plugindelivery.MaxAttempts; i++ {
			if ran := e.run(t, e.service); ran != 1 {
				t.Fatalf("attempt %d ran %d", i+1, ran)
			}
			e.advance(plugindelivery.RetryMax)
		}
		if e.run(t, e.service) != 0 || len(e.pending(t)) != 0 {
			t.Fatalf("a timer ran after its last attempt: %v", e.pending(t))
		}
		status, err := e.service.Status(e.ctx, samplestate.ID)
		if err != nil || status.Deliveries.ParkedCount != 1 || status.Deliveries.Parked[0].ID != broken ||
			status.Deliveries.Parked[0].Kind != "timer" || status.Deliveries.Parked[0].Source != "broken" ||
			status.Deliveries.Parked[0].LastError != "handler_panic" || status.Deliveries.LastFailure.Code != "handler_panic" {
			t.Fatalf("status = %+v %v", status, err)
		}
		// Scheduling the key again replaces the parked generation.
		e.sample.Handle = nil
		e.schedule(t, "broken", 0, "again")
		if e.run(t, e.service) != 1 {
			t.Fatal("the new generation did not run")
		}
		if status, _ := e.service.Status(e.ctx, samplestate.ID); status.Deliveries.ParkedCount != 0 {
			t.Fatalf("the parked generation stayed: %+v", status)
		}
	})
}

func TestALateCallbackCannotDeleteItsReplacement(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		// Generation A is running when the plugin schedules generation B of
		// the same key, and A then finishes. A completes only its own row.
		e.sample.Handle = func(ctx context.Context, _ *plugin.Services, timer plugin.Timer) error {
			if string(timer.Payload) == "A" {
				if _, _, err := e.service.ScheduleTimer(ctx, samplestate.ID, timer.Key, e.clock.Now().Add(time.Hour), []byte("B")); err != nil {
					return err
				}
			}
			return nil
		}
		e.schedule(t, "refresh", 0, "A")
		if ran := e.run(t, e.service); ran != 1 {
			t.Fatalf("A ran %d", ran)
		}
		if got := e.pending(t); len(got) != 1 || got[0] != "refresh:B" {
			t.Fatalf("A's completion deleted B: %v", got)
		}
		// The same race from another process, and with a failing A: A's
		// retry does not move B either.
		e.sample.Handle = func(ctx context.Context, _ *plugin.Services, timer plugin.Timer) error {
			if _, _, err := e.restarted().ScheduleTimer(ctx, samplestate.ID, timer.Key, e.clock.Now().Add(2*time.Hour), []byte("C")); err != nil {
				return err
			}
			return errors.New("A failed after B was scheduled")
		}
		e.advance(time.Hour)
		if ran := e.run(t, e.service); ran != 1 {
			t.Fatalf("B ran %d", ran)
		}
		var due time.Time
		var attempts int
		if err := e.pool.QueryRow(e.ctx, `SELECT next_attempt_at,attempts FROM plugin_deliveries WHERE source='refresh'`).Scan(&due, &attempts); err != nil {
			t.Fatal(err)
		}
		if got := e.pending(t); len(got) != 1 || got[0] != "refresh:C" || attempts != 0 || !due.Equal(e.clock.Now().Add(2*time.Hour)) {
			t.Fatalf("a failed callback moved its replacement: %v attempts %d due %v", got, attempts, due)
		}
	})
}

func TestRemovalDeletesTimersAndTimersAreBoundToTheirDefinition(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		e.schedule(t, "later", time.Minute, "removed")
		if err := e.service.Remove(e.ctx, samplestate.ID, e.userID); err != nil {
			t.Fatal(err)
		}
		if got := e.pending(t); len(got) != 0 {
			t.Fatalf("removal kept the queue: %v", got)
		}
		// A plugin that is not installed cannot schedule a timer.
		if _, _, err := e.service.ScheduleTimer(e.ctx, samplestate.ID, "k", e.clock.Now(), nil); !errors.Is(err, ErrPluginNotFound) {
			t.Fatalf("schedule while removed = %v", err)
		}
		if _, _, err := e.service.Install(e.ctx, samplestate.ID, e.userID); err != nil {
			t.Fatal(err)
		}
		e.advance(time.Hour)
		if ran := e.run(t, e.service); ran != 0 || len(e.sample.Deliveries()) != 0 {
			t.Fatalf("a removed plugin's timer fired after a reinstall: %d", ran)
		}
		// A timer of another definitionVersion never fires; the host drops it.
		e.schedule(t, "old", 0, "")
		if _, err := e.pool.Exec(e.ctx, `UPDATE plugin_deliveries SET definition_version=2 WHERE source='old'`); err != nil {
			t.Fatal(err)
		}
		if ran := e.run(t, e.service); ran != 0 || len(e.sample.Deliveries()) != 0 || len(e.pending(t)) != 0 {
			t.Fatalf("an old definition's timer fired or stayed: %d %v", ran, e.pending(t))
		}
	})
}

func TestTimersFarAheadAreNotExpired(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		// A timer 30 days ahead outlives the 7-day pending retention: the
		// retention counts from the due time.
		e.schedule(t, "renew", 30*24*time.Hour, "")
		e.advance(20 * 24 * time.Hour)
		if swept, err := e.service.SweepDeliveries(e.ctx); err != nil || swept.Expired != 0 || len(e.pending(t)) != 1 {
			t.Fatalf("sweep = %+v %v %v", swept, err, e.pending(t))
		}
		e.advance(10 * 24 * time.Hour)
		if e.run(t, e.service) != 1 {
			t.Fatal("the far timer did not fire")
		}
	})
}

func TestTimerCallbacksUseTheirOwnServices(t *testing.T) {
	withTimers(t, func(e timerEnvironment) {
		var callErr error
		e.sample.Handle = func(ctx context.Context, services *plugin.Services, timer plugin.Timer) error {
			// The system invocation is live for the callback: the transport
			// accepts the call (and fails later only because these tests
			// wire no dispatcher).
			_, callErr = services.KVGet(ctx, "cursor")
			return nil
		}
		e.schedule(t, "k", 0, "")
		e.run(t, e.service)
		var denial *plugin.ServiceDenial
		var failure *plugin.ServiceError
		if errors.As(callErr, &denial) || !errors.As(callErr, &failure) || failure.Code != plugin.ServiceUnavailable {
			t.Fatalf("service call in a callback = %v", callErr)
		}
		// Outside a callback the same client is refused.
		if _, err := e.sample.Services().KVGet(e.ctx, "cursor"); !errors.As(err, &denial) {
			t.Fatalf("call outside an invocation = %v", err)
		}
	})
}
