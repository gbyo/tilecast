package takeovers

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

type recordingNotifier struct {
	mu    sync.Mutex
	calls []notifyCall
}

type notifyCall struct {
	screen  uuid.UUID
	message map[string]any
}

func (n *recordingNotifier) Notify(screen uuid.UUID, message map[string]any) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls = append(n.calls, notifyCall{screen: screen, message: message})
	return true
}

func (n *recordingNotifier) types() map[string]int {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := map[string]int{}
	for _, call := range n.calls {
		if kind, _ := call.message["type"].(string); kind != "" {
			out[kind]++
		}
	}
	return out
}

type takeoverFixture struct {
	pool      *pgxpool.Pool
	service   *Service
	playlists *playlists.Service
	notifier  *recordingNotifier
	orgID     uuid.UUID
	userID    uuid.UUID
	screenA   uuid.UUID
	screenB   uuid.UUID
	groupID   uuid.UUID
	playlist  uuid.UUID
}

func newTakeoverFixture(t *testing.T) *takeoverFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	f := &takeoverFixture{pool: pool, orgID: uuid.New(), userID: uuid.New()}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	exec(`INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Takeover Test',$1)`, f.orgID)
	exec(`INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','takeover-owner','unused','owner',TRUE)`, f.userID)
	f.screenA = newScreen(t, ctx, pool, f.orgID, "Lobby")
	f.screenB = newScreen(t, ctx, pool, f.orgID, "Cafeteria")
	f.groupID = uuid.New()
	exec(`INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Downstairs',$3)`, f.groupID, f.orgID, f.userID)
	exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, f.groupID, f.screenA, f.userID)
	exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, f.groupID, f.screenB, f.userID)
	f.playlist = newReadyPlaylist(t, ctx, pool, f.orgID, f.userID)
	f.notifier = &recordingNotifier{}
	f.playlists = playlists.NewService(pool, nil)
	f.service = NewService(pool, f.playlists, f.notifier, 24*time.Hour)
	return f
}

func newScreen(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
		VALUES($1,$2,$3,$4,'android-tv','Test','TV','14','1.0',1920,1080,1,'en-US','UTC')`,
		id, orgID, uuid.NewString(), name); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func newReadyPlaylist(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID uuid.UUID) uuid.UUID {
	t.Helper()
	assetID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,width,height,processing_status,created_by)
		VALUES($1,$2,'Takeover image','image','takeover.png','image/png',$3,100,1920,1080,'ready',$4)`,
		assetID, orgID, make([]byte, 32), userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,player_compatible)
		VALUES($1,$2,'original','local','originals/takeover','image/png',100,$3,1920,1080,TRUE)`,
		uuid.New(), assetID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	playlistID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,created_by) VALUES($1,$2,'Takeover playlist',$3)`,
		playlistID, orgID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO playlist_items(id,playlist_id,asset_id,position,duration_ms) VALUES($1,$2,$3,0,10000)`,
		uuid.New(), playlistID, assetID); err != nil {
		t.Fatal(err)
	}
	return playlistID
}

func (f *takeoverFixture) activate(t *testing.T, targets plugin.ScreenTargets, playlist uuid.UUID, activatedAt, expiresAt time.Time) (plugin.TakeoverResult, plugin.AfterCommit) {
	t.Helper()
	return f.activateClass(t, plugin.TakeoverOperator, targets, playlist, activatedAt, expiresAt)
}

func (f *takeoverFixture) activateClass(t *testing.T, class plugin.TakeoverClass, targets plugin.ScreenTargets, playlist uuid.UUID, activatedAt, expiresAt time.Time) (plugin.TakeoverResult, plugin.AfterCommit) {
	t.Helper()
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	result, afterCommit, err := f.service.ActivateInTx(context.Background(), tx, plugin.TakeoverRequest{
		Class: class, Name: "Drill", Description: "Drill", PlaylistID: playlist, Targets: targets,
		ActivatedBy: f.userID, ActivatedAt: activatedAt, ExpiresAt: expiresAt,
		AuditAction: "takeover.activated", AuditMetadata: map[string]any{"source": "test"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	return result, afterCommit
}

// shown is the Takeover the screen's manifest carries at the given time.
func (f *takeoverFixture) shown(t *testing.T, screenID uuid.UUID, at time.Time) uuid.UUID {
	t.Helper()
	takeover, err := f.playlists.ActiveTakeoverAt(context.Background(), screenID, at)
	if err != nil {
		t.Fatal(err)
	}
	if takeover == nil {
		return uuid.Nil
	}
	return takeover.ID
}

func (f *takeoverFixture) status(t *testing.T, id uuid.UUID) string {
	t.Helper()
	var status string
	if err := f.pool.QueryRow(context.Background(), `SELECT status FROM takeovers WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func (f *takeoverFixture) cancel(t *testing.T, id uuid.UUID) {
	t.Helper()
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	afterCommit, err := f.service.CancelInTx(context.Background(), tx, id, f.userID, "Done")
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	afterCommit()
}

func (f *takeoverFixture) manifestVersion(t *testing.T, screenID uuid.UUID) int64 {
	t.Helper()
	var version int64
	if err := f.pool.QueryRow(context.Background(), `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screenID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	return version
}

// Activation expands mixed targets, records declared targets, revises each
// effective screen's manifest, and notifies players only after commit.
func TestActivateExpandsTargets(t *testing.T) {
	f := newTakeoverFixture(t)
	ctx := context.Background()
	beforeA, beforeB := f.manifestVersion(t, f.screenA), f.manifestVersion(t, f.screenB)
	now := time.Now().UTC()
	result, afterCommit := f.activate(t,
		plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}, GroupIDs: []uuid.UUID{f.groupID}},
		f.playlist, now, now.Add(time.Hour))
	if result.AffectedCount != 2 {
		t.Fatalf("affected=%d, want 2", result.AffectedCount)
	}
	var targetScreens, targetGroups int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM takeover_targets WHERE takeover_id=$1 AND target_type='screen'`, result.ID).Scan(&targetScreens); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM takeover_targets WHERE takeover_id=$1 AND target_type='group'`, result.ID).Scan(&targetGroups); err != nil {
		t.Fatal(err)
	}
	var states int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM takeover_screen_states WHERE takeover_id=$1 AND state='pending'`, result.ID).Scan(&states); err != nil {
		t.Fatal(err)
	}
	if targetScreens != 1 || targetGroups != 1 || states != 2 {
		t.Fatalf("targets screens=%d groups=%d states=%d, want 1/1/2", targetScreens, targetGroups, states)
	}
	if after, before := f.manifestVersion(t, f.screenA), beforeA; after <= before {
		t.Fatalf("screen A manifest %d->%d", before, after)
	}
	if after, before := f.manifestVersion(t, f.screenB), beforeB; after <= before {
		t.Fatalf("screen B manifest %d->%d", before, after)
	}
	// Nothing reaches players before the commit callback runs.
	if len(f.notifier.calls) != 0 {
		t.Fatalf("notified before commit: %#v", f.notifier.calls)
	}
	afterCommit()
	types := f.notifier.types()
	if types["takeover.changed"] != 2 || types["manifest.changed"] != 2 {
		t.Fatalf("notifications=%v, want 2 takeover.changed and 2 manifest.changed", types)
	}
	var audit int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action='takeover.activated' AND resource_id=$1`, result.ID.String()).Scan(&audit); err != nil {
		t.Fatal(err)
	}
	if audit != 1 {
		t.Fatal("activation was not audited")
	}
	// The activation is followed by the same manifest read a reconnecting
	// player uses. This catches regressions where a durable takeover exists
	// but its playlist graph is not projected into the manifest.
	manifest, _, err := f.playlists.BuildManifest(ctx, f.screenA)
	if err != nil {
		t.Fatalf("build manifest after takeover activation: %v", err)
	}
	projected := false
	for _, playlist := range manifest.Playlists {
		if playlist.ID == f.playlist {
			projected = true
			break
		}
	}
	if manifest.Takeover == nil || manifest.Takeover.ID != result.ID || !projected {
		t.Fatalf("takeover was not projected after activation: takeover=%#v playlists=%d",
			manifest.Takeover, len(manifest.Playlists))
	}
}

// A second activation of the same class never cancels the first. The newer
// one is shown on the shared screen; the older one keeps its other screens
// and is shown again on the shared screen when the newer one ends.
func TestNewerEqualTakeoverWaitsOutTheOlderOne(t *testing.T) {
	f := newTakeoverFixture(t)
	now := time.Now().UTC()
	first, afterFirst := f.activate(t,
		plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA, f.screenB}},
		f.playlist, now, now.Add(time.Hour))
	afterFirst()
	beforeB := f.manifestVersion(t, f.screenB)
	second, afterSecond := f.activate(t,
		plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}},
		f.playlist, now.Add(time.Minute), now.Add(2*time.Hour))
	afterSecond()
	at := now.Add(2 * time.Minute)
	if f.status(t, first.ID) != "active" || f.status(t, second.ID) != "active" {
		t.Fatalf("statuses first=%q second=%q, want both active", f.status(t, first.ID), f.status(t, second.ID))
	}
	if shown := f.shown(t, f.screenA, at); shown != second.ID {
		t.Fatalf("screen A shows %s, want the newer Takeover", shown)
	}
	if shown := f.shown(t, f.screenB, at); shown != first.ID {
		t.Fatalf("screen B shows %s, want the older Takeover", shown)
	}
	if len(second.SuspendedScreenIDs) != 0 {
		t.Fatalf("newer equal Takeover suspended on %v", second.SuspendedScreenIDs)
	}
	// Screen B is untouched by the activation on screen A.
	if after := f.manifestVersion(t, f.screenB); after != beforeB {
		t.Fatalf("screen B manifest %d->%d, want unchanged", beforeB, after)
	}
	f.cancel(t, second.ID)
	if shown := f.shown(t, f.screenA, at); shown != first.ID {
		t.Fatalf("screen A shows %s after the newer one ended, want the older Takeover", shown)
	}
}

// A weaker Takeover on a screen with a stronger one waits there. It is shown
// once the stronger one ends, and it never cancels the stronger one.
func TestWeakerTakeoverWaitsForStrongerOne(t *testing.T) {
	f := newTakeoverFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	emergency, afterEmergency := f.activateClass(t, plugin.TakeoverEmergency,
		plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA, f.screenB}},
		f.playlist, now, now.Add(time.Hour))
	afterEmergency()
	operator, afterOperator := f.activateClass(t, plugin.TakeoverOperator,
		plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}},
		f.playlist, now.Add(time.Minute), now.Add(2*time.Hour))
	afterOperator()
	at := now.Add(2 * time.Minute)
	if f.status(t, emergency.ID) != "active" {
		t.Fatalf("emergency status=%q, want active", f.status(t, emergency.ID))
	}
	for _, screen := range []uuid.UUID{f.screenA, f.screenB} {
		if shown := f.shown(t, screen, at); shown != emergency.ID {
			t.Fatalf("screen %s shows %s, want the emergency Takeover", screen, shown)
		}
	}
	if len(operator.SuspendedScreenIDs) != 1 || operator.SuspendedScreenIDs[0] != f.screenA {
		t.Fatalf("operator suspended on %v, want screen A", operator.SuspendedScreenIDs)
	}
	var class string
	var suspendedCount float64
	if err := f.pool.QueryRow(ctx, `SELECT metadata->>'class',(metadata->>'suspendedScreenCount')::float FROM audit_logs WHERE resource_id=$1 AND action='takeover.activated'`, operator.ID.String()).Scan(&class, &suspendedCount); err != nil {
		t.Fatal(err)
	}
	if class != "operator" || suspendedCount != 1 {
		t.Fatalf("audit class=%q suspended=%v, want operator and 1", class, suspendedCount)
	}
	f.cancel(t, emergency.ID)
	if shown := f.shown(t, f.screenA, at); shown != operator.ID {
		t.Fatalf("screen A shows %s after the emergency ended, want the operator Takeover", shown)
	}
	if shown := f.shown(t, f.screenB, at); shown != uuid.Nil {
		t.Fatalf("screen B shows %s after the emergency ended, want normal playback", shown)
	}
}

// A stronger Takeover outranks an earlier weaker one at once, and the weaker
// one comes back when the stronger one expires.
func TestStrongerTakeoverOutranksAndExpires(t *testing.T) {
	f := newTakeoverFixture(t)
	now := time.Now().UTC()
	automation, afterAutomation := f.activateClass(t, plugin.TakeoverAutomation,
		plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}},
		f.playlist, now, now.Add(2*time.Hour))
	afterAutomation()
	emergency, afterEmergency := f.activateClass(t, plugin.TakeoverEmergency,
		plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}},
		f.playlist, now.Add(time.Minute), now.Add(30*time.Minute))
	afterEmergency()
	if len(emergency.SuspendedScreenIDs) != 0 {
		t.Fatalf("emergency suspended on %v", emergency.SuspendedScreenIDs)
	}
	if shown := f.shown(t, f.screenA, now.Add(2*time.Minute)); shown != emergency.ID {
		t.Fatalf("screen A shows %s, want the emergency Takeover", shown)
	}
	if f.status(t, automation.ID) != "active" {
		t.Fatalf("automation status=%q, want active", f.status(t, automation.ID))
	}
	if shown := f.shown(t, f.screenA, now.Add(31*time.Minute)); shown != automation.ID {
		t.Fatalf("screen A shows %s after the emergency expired, want the automation Takeover", shown)
	}
}

// Activations in concurrent transactions are serialized, so the second one
// computes its suspended screens against the committed first one. Neither
// cancels the other.
func TestConcurrentActivationsAreSerialized(t *testing.T) {
	f := newTakeoverFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	targets := plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}}
	request := func(class plugin.TakeoverClass, activatedAt, expiresAt time.Time) plugin.TakeoverRequest {
		return plugin.TakeoverRequest{
			Class: class, Name: "Drill", Description: "Drill", PlaylistID: f.playlist, Targets: targets,
			ActivatedBy: f.userID, ActivatedAt: activatedAt, ExpiresAt: expiresAt,
			AuditAction: "takeover.activated", AuditMetadata: map[string]any{"source": "test"},
		}
	}
	txStronger, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer txStronger.Rollback(ctx) //nolint:errcheck
	stronger, _, err := f.service.ActivateInTx(ctx, txStronger, request(plugin.TakeoverEmergency, now, now.Add(3*time.Hour)))
	if err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		result plugin.TakeoverResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		tx, err := f.pool.Begin(ctx)
		if err != nil {
			done <- outcome{err: err}
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		result, _, err := f.service.ActivateInTx(ctx, tx, request(plugin.TakeoverOperator, now.Add(time.Minute), now.Add(time.Hour)))
		if err == nil {
			err = tx.Commit(ctx)
		}
		done <- outcome{result: result, err: err}
	}()
	select {
	case got := <-done:
		t.Fatalf("second activation finished before the first committed: %+v", got)
	case <-time.After(300 * time.Millisecond):
	}
	if err = txStronger.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	if f.status(t, stronger.ID) != "active" || f.status(t, got.result.ID) != "active" {
		t.Fatalf("statuses stronger=%q weaker=%q, want both active", f.status(t, stronger.ID), f.status(t, got.result.ID))
	}
	if len(got.result.SuspendedScreenIDs) != 1 {
		t.Fatalf("weaker suspended on %v, want screen A", got.result.SuspendedScreenIDs)
	}
}

// The suspended screens an activation reports and the Takeover each
// manifest carries come from one rule, so they agree for every class pair.
func TestActivationAndManifestAgree(t *testing.T) {
	for _, existing := range plugin.TakeoverClasses {
		for _, incoming := range plugin.TakeoverClasses {
			t.Run(string(existing)+"_then_"+string(incoming), func(t *testing.T) {
				f := newTakeoverFixture(t)
				now := time.Now().UTC()
				first, done := f.activateClass(t, existing, plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}}, f.playlist, now, now.Add(time.Hour))
				done()
				second, done := f.activateClass(t, incoming, plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}}, f.playlist, now.Add(time.Second), now.Add(time.Hour))
				done()
				want := second.ID
				if existing.StrongerThan(incoming) {
					want = first.ID
				}
				shown := f.shown(t, f.screenA, now.Add(2*time.Second))
				if shown != want {
					t.Fatalf("screen shows %s, want %s", shown, want)
				}
				if suspended := len(second.SuspendedScreenIDs) == 1; suspended != (shown != second.ID) {
					t.Fatalf("activation reports suspended=%v but the manifest shows %s", suspended, shown)
				}
			})
		}
	}
}

// Cancellation stamps the canonical database time, retires screen states,
// revises manifests, and reports an already-inactive takeover instead of
// cancelling it twice.
func TestCancelTakeover(t *testing.T) {
	f := newTakeoverFixture(t)
	ctx := context.Background()
	before := time.Now().UTC()
	now := time.Now().UTC()
	result, afterCommit := f.activate(t,
		plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}},
		f.playlist, now, now.Add(time.Hour))
	afterCommit()
	versionAfterActivate := f.manifestVersion(t, f.screenA)

	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cancel, err := f.service.CancelInTx(ctx, tx, result.ID, f.userID, "Drill ended")
	if err != nil {
		tx.Rollback(ctx) //nolint:errcheck
		t.Fatal(err)
	}
	if len(f.notifier.calls) != 2 {
		tx.Rollback(ctx) //nolint:errcheck
		t.Fatalf("notified before cancel commit: %#v", f.notifier.calls)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	var status string
	var cancelledAt time.Time
	if err = f.pool.QueryRow(ctx, `SELECT status,cancelled_at FROM takeovers WHERE id=$1`, result.ID).Scan(&status, &cancelledAt); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" || cancelledAt.Before(before) || cancelledAt.After(time.Now().UTC().Add(time.Minute)) {
		t.Fatalf("cancelled_at=%s, want the canonical database time near now", cancelledAt)
	}
	var states int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM takeover_screen_states WHERE takeover_id=$1 AND state='cancelled'`, result.ID).Scan(&states); err != nil {
		t.Fatal(err)
	}
	if states != 1 || f.manifestVersion(t, f.screenA) <= versionAfterActivate {
		t.Fatal("cancel did not retire states and revise the manifest")
	}
	if types := f.notifier.types(); types["takeover.changed"] != 2 || types["manifest.changed"] != 2 {
		t.Fatalf("notifications=%v, want activate and cancel pairs", types)
	}

	tx, err = f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err = f.service.CancelInTx(ctx, tx, result.ID, f.userID, "again"); err != ErrInactive {
		t.Fatalf("second cancel err=%v, want ErrInactive", err)
	}
}

// Activation refuses a missing or unready playlist, an over-long duration,
// and targets that resolve to no screen.
func TestActivateValidation(t *testing.T) {
	f := newTakeoverFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	activate := func(targets plugin.ScreenTargets, playlist uuid.UUID, expires time.Time) error {
		tx, err := f.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		_, _, err = f.service.ActivateInTx(ctx, tx, plugin.TakeoverRequest{
			Class: plugin.TakeoverOperator, Name: "Drill", PlaylistID: playlist, Targets: targets,
			ActivatedBy: f.userID, ActivatedAt: now, ExpiresAt: expires,
		})
		return err
	}
	targets := plugin.ScreenTargets{ScreenIDs: []uuid.UUID{f.screenA}}
	if err := activate(targets, uuid.New(), now.Add(time.Hour)); err == nil {
		t.Fatal("missing playlist was accepted")
	}
	empty := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,created_by) VALUES($1,$2,'Empty',$3)`,
		empty, f.orgID, f.userID); err != nil {
		t.Fatal(err)
	}
	if err := activate(targets, empty, now.Add(time.Hour)); err == nil {
		t.Fatal("empty playlist was accepted")
	}
	if err := activate(targets, f.playlist, now.Add(25*time.Hour)); err == nil {
		t.Fatal("over-long duration was accepted")
	}
	if err := activate(plugin.ScreenTargets{ScreenIDs: []uuid.UUID{uuid.New()}}, f.playlist, now.Add(time.Hour)); err != ErrNoEligibleScreens {
		t.Fatalf("unresolvable targets err=%v, want ErrNoEligibleScreens", err)
	}
	for _, class := range []plugin.TakeoverClass{"", "critical"} {
		tx, err := f.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = f.service.ActivateInTx(ctx, tx, plugin.TakeoverRequest{
			Class: class, Name: "Drill", PlaylistID: f.playlist, Targets: targets,
			ActivatedBy: f.userID, ActivatedAt: now, ExpiresAt: now.Add(time.Hour),
		})
		tx.Rollback(ctx) //nolint:errcheck
		if !errors.Is(err, plugin.ErrInvalid) {
			t.Fatalf("class %q err=%v, want ErrInvalid", class, err)
		}
	}
}
