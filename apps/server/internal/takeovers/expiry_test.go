package takeovers

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// tableSink records each core event in the producer's transaction, so a
// rolled-back expiry leaves no row and the count is what committed.
type tableSink struct{}

func (tableSink) Emit(ctx context.Context, tx pgx.Tx, event coreevents.Event) error {
	payload, _ := event.Payload.(coreevents.Takeover)
	_, err := tx.Exec(ctx, `INSERT INTO test_takeover_events(name,takeover_id,reason,at) VALUES($1,$2,$3,$4)`,
		event.Name, payload.TakeoverID, payload.Reason, payload.At)
	return err
}

func withEventTable(t *testing.T, f *takeoverFixture) {
	t.Helper()
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS test_takeover_events(name text NOT NULL, takeover_id uuid NOT NULL, reason text NOT NULL, at timestamptz NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `TRUNCATE test_takeover_events`); err != nil {
		t.Fatal(err)
	}
	f.service.SetEvents(tableSink{})
	// The first manifest build of a database settles the presentation
	// catalog revision, which bumps every screen. Do it before a test counts
	// manifest versions.
	if _, _, err := f.playlists.BuildManifest(ctx, f.screenA); err != nil {
		t.Fatal(err)
	}
}

func (f *takeoverFixture) endedEvents(t *testing.T, id uuid.UUID) (int, time.Time) {
	t.Helper()
	var count int
	var at *time.Time
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*), max(at) FROM test_takeover_events WHERE name=$1 AND takeover_id=$2 AND reason='expired'`,
		plugin.CoreTakeoverEnded, id).Scan(&count, &at); err != nil {
		t.Fatal(err)
	}
	if at == nil {
		return count, time.Time{}
	}
	return count, *at
}

func (f *takeoverFixture) liveStates(t *testing.T, id uuid.UUID) int {
	t.Helper()
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM takeover_screen_states WHERE takeover_id=$1 AND state NOT IN ('restored','cancelled','expired')`, id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// lapsed activates a Takeover on targets and moves its end into the past, so
// it is due for expiry. It returns the Takeover and its end.
func (f *takeoverFixture) lapsed(t *testing.T, targets plugin.ScreenTargets) (uuid.UUID, time.Time) {
	t.Helper()
	now := time.Now().UTC()
	result, afterCommit := f.activate(t, targets, f.playlist, now, now.Add(time.Hour))
	afterCommit()
	var expiresAt time.Time
	if err := f.pool.QueryRow(context.Background(), `UPDATE takeovers SET created_at=now()-interval '2 hours',activated_at=now()-interval '2 hours',expires_at=date_trunc('second',now())-interval '1 minute' WHERE id=$1 RETURNING expires_at`, result.ID).Scan(&expiresAt); err != nil {
		t.Fatal(err)
	}
	return result.ID, expiresAt
}

func (f *takeoverFixture) notifiedTakeoverScreens(id uuid.UUID) map[uuid.UUID]int {
	f.notifier.mu.Lock()
	defer f.notifier.mu.Unlock()
	out := map[uuid.UUID]int{}
	for _, call := range f.notifier.calls {
		if call.message["type"] == "takeover.changed" && call.message["takeoverId"] == id {
			out[call.screen]++
		}
	}
	return out
}

// A manifest request from one screen ends the whole Takeover: every target
// screen's state expires and its manifest version moves, one
// takeover.ended@1 is emitted, and the background sweep finds nothing left.
func TestManifestRequestExpiresTheWholeTakeover(t *testing.T) {
	f := newTakeoverFixture(t)
	withEventTable(t, f)
	ctx := context.Background()
	id, expiresAt := f.lapsed(t, plugin.ScreenTargets{GroupIDs: []uuid.UUID{f.groupID}})
	beforeA, beforeB := f.manifestVersion(t, f.screenA), f.manifestVersion(t, f.screenB)
	f.notifier.calls = nil

	manifest, _, err := f.playlists.BuildManifest(ctx, f.screenA)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Takeover != nil {
		t.Fatalf("manifest still carries Takeover %s", manifest.Takeover.ID)
	}
	if f.status(t, id) != "expired" || f.liveStates(t, id) != 0 {
		t.Fatalf("status=%q live states=%d, want expired and none", f.status(t, id), f.liveStates(t, id))
	}
	afterA, afterB := f.manifestVersion(t, f.screenA), f.manifestVersion(t, f.screenB)
	if afterA != beforeA+1 || afterB != beforeB+1 {
		t.Fatalf("manifest versions A %d->%d B %d->%d, want each +1", beforeA, afterA, beforeB, afterB)
	}
	if manifest.ManifestVersion != afterA {
		t.Fatalf("manifest version %d, want the bumped %d", manifest.ManifestVersion, afterA)
	}
	if count, at := f.endedEvents(t, id); count != 1 || !at.Equal(expiresAt) {
		t.Fatalf("takeover.ended@1 count=%d at=%s, want 1 at %s", count, at, expiresAt)
	}
	if notified := f.notifiedTakeoverScreens(id); notified[f.screenA] != 1 || notified[f.screenB] != 1 {
		t.Fatalf("takeover.changed notifications %v, want one per screen", notified)
	}

	// The sweep that follows has nothing to do.
	expired, err := f.service.ExpireDue(ctx, time.Now().UTC())
	if err != nil || len(expired) != 0 {
		t.Fatalf("sweep expired %v %v, want nothing", expired, err)
	}
	if f.manifestVersion(t, f.screenB) != afterB {
		t.Fatal("the sweep bumped screen B again")
	}
	if count, _ := f.endedEvents(t, id); count != 1 {
		t.Fatalf("takeover.ended@1 count=%d after the sweep, want 1", count)
	}
}

// When the sweep wins, a later manifest request changes nothing.
func TestSweepExpiresBeforeAnyManifestRequest(t *testing.T) {
	f := newTakeoverFixture(t)
	withEventTable(t, f)
	ctx := context.Background()
	id, _ := f.lapsed(t, plugin.ScreenTargets{GroupIDs: []uuid.UUID{f.groupID}})
	beforeA, beforeB := f.manifestVersion(t, f.screenA), f.manifestVersion(t, f.screenB)
	f.service.SetClock(func() time.Time { return time.Now().Add(time.Second) })
	if err := f.service.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if f.status(t, id) != "expired" || f.liveStates(t, id) != 0 {
		t.Fatalf("status=%q live states=%d after the sweep", f.status(t, id), f.liveStates(t, id))
	}
	afterA, afterB := f.manifestVersion(t, f.screenA), f.manifestVersion(t, f.screenB)
	if afterA != beforeA+1 || afterB != beforeB+1 {
		t.Fatalf("manifest versions A %d->%d B %d->%d, want each +1", beforeA, afterA, beforeB, afterB)
	}
	for _, screen := range []uuid.UUID{f.screenA, f.screenB} {
		if _, _, err := f.playlists.BuildManifest(ctx, screen); err != nil {
			t.Fatal(err)
		}
	}
	if f.manifestVersion(t, f.screenA) != afterA || f.manifestVersion(t, f.screenB) != afterB {
		t.Fatal("a manifest request bumped a screen the sweep already bumped")
	}
	if count, _ := f.endedEvents(t, id); count != 1 {
		t.Fatalf("takeover.ended@1 count=%d, want 1", count)
	}
}

// A second expiry that starts while the first holds the Takeover waits for
// it, then finds the Takeover already ended. It emits nothing.
func TestConcurrentExpiryWaitsAndFindsNothing(t *testing.T) {
	for _, second := range []string{"sweep", "manifest"} {
		t.Run(second, func(t *testing.T) {
			f := newTakeoverFixture(t)
			withEventTable(t, f)
			ctx := context.Background()
			id, _ := f.lapsed(t, plugin.ScreenTargets{GroupIDs: []uuid.UUID{f.groupID}})
			beforeA, beforeB := f.manifestVersion(t, f.screenA), f.manifestVersion(t, f.screenB)
			tx, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx) //nolint:errcheck
			first, done, err := f.service.expireDueInTx(ctx, tx, time.Now().UTC(), &f.screenB)
			if err != nil || len(first) != 1 || first[0] != id {
				t.Fatalf("first expiry = %v %v", first, err)
			}
			result := make(chan error, 1)
			var secondExpired []uuid.UUID
			go func() {
				var err error
				if second == "sweep" {
					secondExpired, err = f.service.ExpireDue(ctx, time.Now().UTC())
				} else {
					_, _, err = f.playlists.BuildManifest(ctx, f.screenA)
				}
				result <- err
			}()
			select {
			case err := <-result:
				t.Fatalf("second expiry finished while the first held the Takeover: %v", err)
			case <-time.After(300 * time.Millisecond):
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			done()
			if err := <-result; err != nil {
				t.Fatal(err)
			}
			if len(secondExpired) != 0 {
				t.Fatalf("second expiry ended %v again", secondExpired)
			}
			if count, _ := f.endedEvents(t, id); count != 1 {
				t.Fatalf("takeover.ended@1 count=%d, want 1", count)
			}
			if f.manifestVersion(t, f.screenA) != beforeA+1 || f.manifestVersion(t, f.screenB) != beforeB+1 {
				t.Fatal("a screen was bumped more than once")
			}
		})
	}
}

// Many sweeps and manifest requests racing over several Takeovers end each
// Takeover exactly once, without a deadlock.
func TestRacingExpiriesEndEachTakeoverOnce(t *testing.T) {
	f := newTakeoverFixture(t)
	withEventTable(t, f)
	ctx := context.Background()
	group, _ := f.lapsed(t, plugin.ScreenTargets{GroupIDs: []uuid.UUID{f.groupID}})
	onlyA, _ := f.lapsed(t, plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}})
	onlyB, _ := f.lapsed(t, plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenB}})
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	errs := []error{}
	ended := map[uuid.UUID]int{}
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			var err error
			switch i % 3 {
			case 0:
				var ids []uuid.UUID
				ids, err = f.service.ExpireDue(ctx, time.Now().UTC())
				mu.Lock()
				for _, id := range ids {
					ended[id]++
				}
				mu.Unlock()
			case 1:
				_, _, err = f.playlists.BuildManifest(ctx, f.screenA)
			default:
				_, _, err = f.playlists.BuildManifest(ctx, f.screenB)
			}
			if err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if len(errs) != 0 {
		t.Fatalf("racing expiries failed: %v", errs)
	}
	for _, id := range []uuid.UUID{group, onlyA, onlyB} {
		if f.status(t, id) != "expired" || f.liveStates(t, id) != 0 {
			t.Fatalf("Takeover %s status=%q live=%d", id, f.status(t, id), f.liveStates(t, id))
		}
		if count, _ := f.endedEvents(t, id); count != 1 {
			t.Fatalf("Takeover %s takeover.ended@1 count=%d, want 1", id, count)
		}
		if ended[id] > 1 {
			t.Fatalf("Takeover %s reported expired by %d sweeps", id, ended[id])
		}
	}
}
