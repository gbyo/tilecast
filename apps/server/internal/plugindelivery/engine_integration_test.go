package plugindelivery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, database.Migrate)) }

// The engine's contract with a fake plugin and a stepped clock. No test
// waits on the wall clock for a retry or a lease: the clock moves, and
// barriers prove parallel execution.

type steppedClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *steppedClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *steppedClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type call struct {
	ID      uuid.UUID
	Subject string
	Payload string
	Attempt int
}

type fakeTarget struct {
	mu       sync.Mutex
	version  int
	rejected map[string]bool
	handle   func(ctx context.Context, d Delivery) error
	calls    []call
}

func (t *fakeTarget) DefinitionVersion() int { return t.version }

func (t *fakeTarget) Accepts(kind, source string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.rejected[kind+"/"+source]
}

func (t *fakeTarget) Deliver(ctx context.Context, d Delivery) error {
	t.mu.Lock()
	t.calls = append(t.calls, call{ID: d.ID, Subject: d.Subject, Payload: string(d.Payload), Attempt: d.Attempt})
	handle := t.handle
	t.mu.Unlock()
	if handle != nil {
		return handle(ctx, d)
	}
	return nil
}

func (t *fakeTarget) setHandle(handle func(context.Context, Delivery) error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.handle = handle
}

func (t *fakeTarget) payloads() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := []string{}
	for _, c := range t.calls {
		out = append(out, c.Payload)
	}
	return out
}

func (t *fakeTarget) callList() []call {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]call(nil), t.calls...)
}

type directory map[string]*fakeTarget

func (d directory) Target(pluginID string) (Target, bool) {
	target, ok := d[pluginID]
	return target, ok
}

const testPlugin = "sample_delivery"

type env struct {
	t      *testing.T
	ctx    context.Context
	pool   *pgxpool.Pool
	clock  *steppedClock
	target *fakeTarget
	dir    directory
	engine *Engine
}

func setup(t *testing.T) env {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	for _, statement := range []string{
		`TRUNCATE plugin_deliveries, plugin_delivery_status`,
		`TRUNCATE organization_settings, users CASCADE`,
	} {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Delivery Test',$1)`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	e := env{t: t, ctx: ctx, pool: pool, clock: &steppedClock{now: time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)},
		target: &fakeTarget{version: 1, rejected: map[string]bool{}}}
	e.dir = directory{testPlugin: e.target}
	e.install(testPlugin)
	e.engine = e.process()
	return e
}

// process is another Server process over the same database.
func (e env) process(options ...Option) *Engine {
	return NewEngine(e.pool, e.dir, e.clock, nil, options...)
}

func (e env) install(pluginID string) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO plugin_installations(organization_id,plugin_id) SELECT id,$1 FROM organization_settings WHERE singleton ON CONFLICT DO NOTHING`, pluginID); err != nil {
		e.t.Fatal(err)
	}
}

func (e env) enqueue(subject, payload string, due time.Duration) uuid.UUID {
	e.t.Helper()
	id := uuid.New()
	e.enqueueItem(Item{ID: id, PluginID: testPlugin, DefinitionVersion: 1, Kind: KindEvent, Source: "test.event@1",
		Subject: subject, Payload: []byte(payload), DueAt: e.clock.Now().Add(due)})
	return id
}

func (e env) enqueueItem(item Item) bool {
	e.t.Helper()
	var queued bool
	err := pgx.BeginFunc(e.ctx, e.pool, func(tx pgx.Tx) error {
		var err error
		queued, err = Enqueue(e.ctx, tx, item)
		return err
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return queued
}

func (e env) run(engine *Engine) int {
	e.t.Helper()
	ran, err := engine.RunDue(e.ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	return ran
}

func (e env) drain() {
	e.t.Helper()
	for i := 0; i < 100; i++ {
		if e.run(e.engine) == 0 {
			return
		}
	}
	e.t.Fatal("the queue did not drain")
}

func (e env) count(where string) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM plugin_deliveries WHERE `+where).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e env) status() Status {
	e.t.Helper()
	status, err := ReadStatus(e.ctx, e.pool, testPlugin, e.clock.Now())
	if err != nil {
		e.t.Fatal(err)
	}
	return status
}

func TestSameSubjectRunsInOrderAndSuccessDeletes(t *testing.T) {
	e := setup(t)
	for i := 1; i <= 5; i++ {
		e.enqueue("room-1", fmt.Sprint("r1-", i), 0)
		e.enqueue("room-2", fmt.Sprint("r2-", i), 0)
	}
	e.drain()
	var r1, r2 []string
	for _, payload := range e.target.payloads() {
		if payload[:2] == "r1" {
			r1 = append(r1, payload)
		} else {
			r2 = append(r2, payload)
		}
	}
	if fmt.Sprint(r1) != "[r1-1 r1-2 r1-3 r1-4 r1-5]" || fmt.Sprint(r2) != "[r2-1 r2-2 r2-3 r2-4 r2-5]" {
		t.Fatalf("order = %v %v", r1, r2)
	}
	if e.count("true") != 0 {
		t.Fatal("a delivered item stayed")
	}
}

func TestALaterItemNeverJumpsAnEarlierItemOfItsSubject(t *testing.T) {
	e := setup(t)
	failFirst := true
	e.target.setHandle(func(_ context.Context, d Delivery) error {
		if string(d.Payload) == "first" && failFirst {
			failFirst = false
			return errors.New("provider unavailable")
		}
		return nil
	})
	e.enqueue("s", "first", 0)
	e.enqueue("s", "second", 0)
	// A future item does not let a later due item of its subject pass.
	e.enqueue("t", "future", time.Hour)
	e.enqueue("t", "after-future", 0)
	e.run(e.engine)
	// first failed and waits for its retry; second must wait too.
	if got := e.target.payloads(); fmt.Sprint(got) != "[first]" {
		t.Fatalf("ran %v", got)
	}
	if e.run(e.engine) != 0 {
		t.Fatal("an item ran while the head of its subject waited")
	}
	e.clock.advance(RetryBase)
	e.drain()
	if got := e.target.payloads(); fmt.Sprint(got) != "[first first second]" {
		t.Fatalf("ran %v", got)
	}
	e.clock.advance(time.Hour)
	e.drain()
	if got := e.target.payloads(); fmt.Sprint(got[3:]) != "[future after-future]" {
		t.Fatalf("ran %v", got)
	}
}

// barrier blocks each callback until n callbacks run at the same time, or
// fails the test after a bound.
func barrier(t *testing.T, n int) (func(context.Context, Delivery) error, func()) {
	var mu sync.Mutex
	arrived := 0
	all := make(chan struct{})
	release := make(chan struct{})
	return func(ctx context.Context, _ Delivery) error {
			mu.Lock()
			arrived++
			if arrived == n {
				close(all)
			}
			mu.Unlock()
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}, func() {
			select {
			case <-all:
			case <-time.After(10 * time.Second):
				t.Errorf("%d callbacks never ran at the same time", n)
			}
			close(release)
		}
}

func TestDifferentSubjectsRunInParallelWithinTheBound(t *testing.T) {
	e := setup(t)
	for i := 0; i < ConcurrencyPerPlugin+3; i++ {
		e.enqueue(fmt.Sprint("subject-", i), "", 0)
	}
	handle, release := barrier(t, ConcurrencyPerPlugin)
	e.target.setHandle(handle)
	done := make(chan int)
	go func() { done <- e.run(e.engine) }()
	// While the first engine holds the bound, a second process claims
	// nothing.
	waitFor(t, func() bool { return e.count("claimed_until IS NOT NULL") == ConcurrencyPerPlugin })
	if ran := e.run(e.process()); ran != 0 {
		t.Fatalf("another process exceeded the bound: %d", ran)
	}
	release()
	if ran := <-done; ran != ConcurrencyPerPlugin {
		t.Fatalf("first pass ran %d", ran)
	}
	e.target.setHandle(nil)
	e.drain()
	if len(e.target.callList()) != ConcurrencyPerPlugin+3 {
		t.Fatalf("calls = %d", len(e.target.callList()))
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition never held")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestTwoProcessesNeverRunOneSubjectAtOnce(t *testing.T) {
	e := setup(t)
	e.enqueue("door", "a", 0)
	e.enqueue("door", "b", 0)
	e.enqueue("other", "c", 0)
	started := make(chan struct{})
	release := make(chan struct{})
	e.target.setHandle(func(ctx context.Context, d Delivery) error {
		if string(d.Payload) == "a" {
			close(started)
			<-release
		}
		return nil
	})
	done := make(chan int)
	go func() { done <- e.run(e.engine) }()
	<-started
	// The second process may run the other subject, never "door".
	second := e.process()
	for i := 0; i < 3; i++ {
		e.run(second)
	}
	for _, c := range e.target.callList() {
		if c.Payload == "b" {
			t.Fatal("a second process ran the subject while its head ran")
		}
	}
	close(release)
	<-done
	e.drain()
	if got := e.target.payloads(); !slices.Contains(got, "b") || !slices.Contains(got, "c") {
		t.Fatalf("ran %v", got)
	}
}

func TestExpiredLeaseIsReclaimedWithTheSameID(t *testing.T) {
	e := setup(t)
	id := e.enqueue("s", "side-effect", 0)
	// A process claims the item, performs the side effect, and crashes
	// before it records the result.
	claims, err := e.engine.claim(e.ctx, testPlugin, e.target, e.clock.Now())
	if err != nil || len(claims) != 1 || claims[0].ID != id {
		t.Fatalf("claim = %v %v", claims, err)
	}
	if err := e.target.Deliver(e.ctx, claims[0].Delivery); err != nil {
		t.Fatal(err)
	}
	if e.run(e.process()) != 0 {
		t.Fatal("a held lease was claimed")
	}
	e.clock.advance(Lease)
	if e.run(e.process()) != 1 {
		t.Fatal("the expired lease was not reclaimed")
	}
	calls := e.target.callList()
	if len(calls) != 2 || calls[0].ID != id || calls[1].ID != id || calls[1].Attempt != 2 {
		t.Fatalf("calls = %+v", calls)
	}
	// The crashed process's late result changes nothing.
	e.engine.settle(e.ctx, claims[0], FailureHandlerError, false)
	if e.count("true") != 0 {
		t.Fatal("a stale result restored the item")
	}
}

func TestFailuresBackOffParkAndLetTheSubjectContinue(t *testing.T) {
	e := setup(t)
	e.target.setHandle(func(_ context.Context, d Delivery) error {
		if string(d.Payload) == "broken" {
			return errors.New("boom")
		}
		return nil
	})
	id := e.enqueue("s", "broken", 0)
	e.enqueue("s", "next", 0)
	delays := []time.Duration{}
	for attempt := 1; attempt <= MaxAttempts; attempt++ {
		if ran := e.run(e.engine); ran != 1 {
			t.Fatalf("attempt %d ran %d", attempt, ran)
		}
		if attempt == MaxAttempts {
			break
		}
		var next time.Time
		if err := e.pool.QueryRow(e.ctx, `SELECT next_attempt_at FROM plugin_deliveries WHERE id=$1`, id).Scan(&next); err != nil {
			t.Fatal(err)
		}
		delay := next.Sub(e.clock.Now())
		delays = append(delays, delay)
		e.clock.advance(delay - time.Second)
		if e.run(e.engine) != 0 {
			t.Fatal("a retry ran early")
		}
		e.clock.advance(time.Second)
	}
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second, 160 * time.Second, 320 * time.Second}
	if fmt.Sprint(delays) != fmt.Sprint(want) {
		t.Fatalf("delays = %v", delays)
	}
	if got := retryDelay(50); got != RetryMax {
		t.Fatalf("cap = %v", got)
	}
	status := e.status()
	if status.ParkedCount != 1 || status.Parked[0].ID != id || status.Parked[0].Attempts != MaxAttempts ||
		status.Parked[0].LastError != FailureHandlerError || status.LastFailure == nil || status.LastFailure.Code != FailureHandlerError {
		t.Fatalf("status = %+v", status)
	}
	// The parked item does not block its subject.
	e.drain()
	if got := e.target.payloads(); got[len(got)-1] != "next" {
		t.Fatalf("ran %v", got)
	}
	// Retry: the same ID runs again, with its attempts reset.
	if err := pgx.BeginFunc(e.ctx, e.pool, func(tx pgx.Tx) error {
		_, err := Retry(e.ctx, tx, testPlugin, id, e.clock.Now())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	e.target.setHandle(nil)
	e.drain()
	calls := e.target.callList()
	if last := calls[len(calls)-1]; last.ID != id || last.Attempt != 1 || e.count("true") != 0 {
		t.Fatalf("retry = %+v", last)
	}
	// Discard removes a parked item; neither works on an item that is not
	// parked.
	e.target.setHandle(func(context.Context, Delivery) error { panic("boom") })
	other := e.enqueue("x", "", 0)
	for i := 0; i < MaxAttempts; i++ {
		e.run(e.engine)
		e.clock.advance(RetryMax)
	}
	if status := e.status(); status.ParkedCount != 1 || status.Parked[0].LastError != FailureHandlerPanic {
		t.Fatalf("panic status = %+v", status)
	}
	err := pgx.BeginFunc(e.ctx, e.pool, func(tx pgx.Tx) error {
		if _, err := Retry(e.ctx, tx, testPlugin, uuid.New(), e.clock.Now()); !errors.Is(err, ErrNotParked) {
			return fmt.Errorf("retry of an unknown item = %v", err)
		}
		if _, err := Discard(e.ctx, tx, "another_plugin", other); !errors.Is(err, ErrNotParked) {
			return fmt.Errorf("discard through another plugin = %v", err)
		}
		_, err := Discard(e.ctx, tx, testPlugin, other)
		return err
	})
	if err != nil || e.count("true") != 0 {
		t.Fatalf("discard = %v", err)
	}
}

func TestTimeoutAndPanicAreStableFailures(t *testing.T) {
	e := setup(t)
	engine := e.process(WithCallTimeout(20 * time.Millisecond))
	e.target.setHandle(func(ctx context.Context, d Delivery) error {
		if string(d.Payload) == "panic" {
			panic("plugin bug")
		}
		<-ctx.Done()
		return ctx.Err()
	})
	slow := e.enqueue("a", "slow", 0)
	broken := e.enqueue("b", "panic", 0)
	if ran := e.run(engine); ran != 2 {
		t.Fatalf("ran %d", ran)
	}
	for id, code := range map[uuid.UUID]string{slow: FailureHandlerTimeout, broken: FailureHandlerPanic} {
		var lastError string
		var attempts int
		if err := e.pool.QueryRow(e.ctx, `SELECT last_error,attempts FROM plugin_deliveries WHERE id=$1`, id).Scan(&lastError, &attempts); err != nil {
			t.Fatal(err)
		}
		if lastError != code || attempts != 1 {
			t.Fatalf("%s: %s after %d", code, lastError, attempts)
		}
	}
}

func TestRetentionCountsFromDueTimeAndCountsExpiry(t *testing.T) {
	e := setup(t)
	// A future item older than the retention stays until it is overdue.
	future := e.enqueue("future", "", 10*24*time.Hour)
	e.target.setHandle(func(context.Context, Delivery) error { return errors.New("down") })
	e.enqueue("blocked", "head", 0)
	e.enqueue("blocked", "waiting", 0)
	// The waiting item never runs while its head fails; advance without
	// running so both stay pending.
	e.clock.advance(PendingRetention + time.Minute)
	swept, err := e.engine.Sweep(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if swept.Expired != 2 || e.count("true") != 1 || e.count(fmt.Sprintf("id='%s'", future)) != 1 {
		t.Fatalf("swept %+v, rows %d", swept, e.count("true"))
	}
	status := e.status()
	if status.ExpiredCount != 2 || status.LastExpiredAt == nil || !status.LastExpiredAt.Equal(e.clock.Now()) {
		t.Fatalf("status = %+v", status)
	}
	// A parked item expires 14 days after it was parked.
	e.clock.advance(3 * 24 * time.Hour) // the future item is due now
	for i := 0; i < MaxAttempts; i++ {
		e.run(e.engine)
		e.clock.advance(RetryMax)
	}
	if e.status().ParkedCount != 1 {
		t.Fatalf("not parked: %+v", e.status())
	}
	e.clock.advance(ParkedRetention - time.Hour)
	if swept, _ := e.engine.Sweep(e.ctx); swept.Expired != 0 {
		t.Fatal("a parked item expired early")
	}
	e.clock.advance(2 * time.Hour)
	if swept, _ := e.engine.Sweep(e.ctx); swept.Expired != 1 || e.status().ExpiredCount != 3 || e.count("true") != 0 {
		t.Fatalf("parked expiry = %+v %+v", swept, e.status())
	}
}

func TestNothingQueuesOrRunsForPluginsThatCannotTakeIt(t *testing.T) {
	e := setup(t)
	// Not installed: nothing is written.
	if e.enqueueItem(Item{PluginID: "not_installed", DefinitionVersion: 1, Kind: KindEvent, Source: "x", Subject: "s", DueAt: e.clock.Now()}) {
		t.Fatal("an item was queued for a plugin that is not installed")
	}
	// Removal deletes the queue and the status.
	e.enqueue("s", "", 0)
	if err := pgx.BeginFunc(e.ctx, e.pool, func(tx pgx.Tx) error {
		if err := recordFailure(e.ctx, tx, testPlugin, KindEvent, FailureHandlerError, e.clock.Now()); err != nil {
			return err
		}
		if _, err := tx.Exec(e.ctx, `DELETE FROM plugin_installations WHERE plugin_id=$1`, testPlugin); err != nil {
			return err
		}
		return RemovePlugin(e.ctx, tx, testPlugin)
	}); err != nil {
		t.Fatal(err)
	}
	if e.count("true") != 0 || e.run(e.engine) != 0 || e.status().LastFailure != nil {
		t.Fatal("a removed plugin kept its queue")
	}
	e.install(testPlugin)
	// An item that a removal raced with belongs to the earlier installation:
	// it never runs after a reinstall, and the sweep deletes it.
	e.enqueue("s", "raced", 0)
	if _, err := e.pool.Exec(e.ctx, `UPDATE plugin_installations SET installed_at=installed_at+interval '1 second' WHERE plugin_id=$1`, testPlugin); err != nil {
		t.Fatal(err)
	}
	if e.run(e.engine) != 0 {
		t.Fatal("an item of an earlier installation ran")
	}
	if swept, err := e.engine.Sweep(e.ctx); err != nil || swept.Reconciled != 1 || e.count("true") != 0 {
		t.Fatalf("an item of an earlier installation stayed: %+v %v", swept, err)
	}
	// An item of another definition never runs.
	e.enqueueItem(Item{PluginID: testPlugin, DefinitionVersion: 2, Kind: KindEvent, Source: "x", Subject: "s", DueAt: e.clock.Now()})
	if e.run(e.engine) != 0 || e.count("true") != 0 {
		t.Fatal("an item of another definition ran or stayed")
	}
	// A source the plugin no longer accepts is reconciled away.
	e.enqueue("s", "gone", 0)
	e.target.rejected[KindEvent+"/test.event@1"] = true
	if swept, err := e.engine.Sweep(e.ctx); err != nil || swept.Reconciled != 1 || e.count("true") != 0 {
		t.Fatalf("reconcile = %+v %v", swept, err)
	}
	if len(e.target.callList()) != 0 {
		t.Fatal("an item ran for a plugin that could not take it")
	}
	// Invalid items are refused.
	for name, item := range map[string]Item{
		"kind":    {PluginID: testPlugin, DefinitionVersion: 1, Kind: "Bad", Source: "x", Subject: "s", DueAt: e.clock.Now()},
		"payload": {PluginID: testPlugin, DefinitionVersion: 1, Kind: KindEvent, Source: "x", Subject: "s", Payload: make([]byte, MaxPayloadBytes+1), DueAt: e.clock.Now()},
		"subject": {PluginID: testPlugin, DefinitionVersion: 1, Kind: KindEvent, Source: "x", Subject: string(make([]byte, MaxSubjectBytes)), DueAt: e.clock.Now()},
		"due":     {PluginID: testPlugin, DefinitionVersion: 1, Kind: KindEvent, Source: "x", Subject: "s"},
	} {
		err := pgx.BeginFunc(e.ctx, e.pool, func(tx pgx.Tx) error { _, err := Enqueue(e.ctx, tx, item); return err })
		if !errors.Is(err, ErrInvalidItem) {
			t.Errorf("%s = %v", name, err)
		}
	}
}

func TestCancellingARunningItemHoldsItsSubjectUntilItEnds(t *testing.T) {
	e := setup(t)
	started := make(chan struct{})
	release := make(chan struct{})
	e.target.setHandle(func(_ context.Context, d Delivery) error {
		if string(d.Payload) == "A" {
			close(started)
			<-release
			return errors.New("A fails after it was replaced")
		}
		return nil
	})
	item := func(payload string) Item {
		return Item{PluginID: testPlugin, DefinitionVersion: 1, Kind: KindTimer, Source: "refresh", Subject: "refresh",
			Payload: []byte(payload), DueAt: e.clock.Now()}
	}
	e.enqueueItem(item("A"))
	done := make(chan int)
	go func() { done <- e.run(e.engine) }()
	<-started
	// Replace A with B while A runs.
	if err := pgx.BeginFunc(e.ctx, e.pool, func(tx pgx.Tx) error {
		if _, err := CancelSource(e.ctx, tx, e.clock.Now(), testPlugin, KindTimer, "refresh"); err != nil {
			return err
		}
		_, err := Enqueue(e.ctx, tx, item("B"))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// B waits: A still holds the subject.
	if ran := e.run(e.process()); ran != 0 {
		t.Fatalf("B ran while A ran: %d", ran)
	}
	close(release)
	<-done
	// A's failure did not retry A and did not touch B.
	if e.count("state='cancelled'") != 0 || e.count("payload='B'::bytea AND attempts=0") != 1 {
		t.Fatal("A's late result touched the queue")
	}
	e.drain()
	if got := e.target.payloads(); fmt.Sprint(got) != "[A B]" {
		t.Fatalf("ran %v", got)
	}
}
