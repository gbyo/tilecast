package presentations

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
)

type testNotifier struct {
	mu      sync.Mutex
	changed []uuid.UUID
}

func (n *testNotifier) ManifestChanged(screenID uuid.UUID, _ int64) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.changed = append(n.changed, screenID)
}

func TestQuickPresentPersistsGroupStateAndExpiresWithoutSnapshotRestore(t *testing.T) {
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
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	orgID, ownerID, screenID, secondScreenID, groupID, assetID, playlistID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id)VALUES(TRUE,'Quick Present Test',$1)`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active)VALUES($1,'Owner','owner','unused','owner',TRUE)`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Cafeteria TV','linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, screenID, orgID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id)VALUES($1)`, screenID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id)VALUES($1)`, screenID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by)VALUES($1,$2,'Cafeteria',$3)`, groupID, orgID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3)`, groupID, screenID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Cafeteria Right','linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, secondScreenID, orgID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id)VALUES($1)`, secondScreenID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id)VALUES($1)`, secondScreenID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3)`, groupID, secondScreenID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE screen_groups SET display_mode='span' WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,origin,system_managed,created_by)VALUES($1,$2,'Welcome','image','welcome.png','image/png',$3,100,'ready','library',FALSE,$4)`, assetID, orgID, make([]byte, 32), ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,created_by)VALUES($1,$2,'Welcome loop',$3)`, playlistID, orgID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlist_items(id,playlist_id,asset_id,position)VALUES($1,$2,$3,0)`, uuid.New(), playlistID, assetID); err != nil {
		t.Fatal(err)
	}

	notifier := &testNotifier{}
	service := NewService(pool, notifier)
	clock := time.Date(2026, time.July, 17, 15, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return clock }
	created, err := service.Create(ctx, CreateInput{TargetType: "group", TargetID: groupID, ContentType: "playlist", ContentID: playlistID, Duration: 5 * time.Minute, CreatedBy: ownerID})
	if err != nil {
		t.Fatal(err)
	}
	active, err := service.ActiveForScreen(ctx, screenID)
	if err != nil || active == nil || active.ID != created.ID || active.TargetType != "group" {
		t.Fatalf("active override=%#v err=%v", active, err)
	}
	secondActive, err := service.ActiveForScreen(ctx, secondScreenID)
	if err != nil || secondActive == nil || secondActive.ID != created.ID || secondActive.TargetType != "group" {
		t.Fatalf("Span member did not resolve the group Quick Present override: active=%#v err=%v", secondActive, err)
	}
	for _, inspection := range []struct {
		at         time.Time
		wantActive bool
	}{{created.StartedAt.Add(-time.Microsecond), false}, {created.StartedAt, true}, {*created.ExpiresAt, false}} {
		got, lookupErr := service.ActiveForScreenAt(ctx, screenID, inspection.at)
		if lookupErr != nil || (got != nil) != inspection.wantActive {
			t.Fatalf("inspect at %s: override=%#v err=%v", inspection.at, got, lookupErr)
		}
	}
	// Inspecting expiry must not reconcile the live override or notify Players.
	active, err = service.ActiveForScreen(ctx, screenID)
	if err != nil || active == nil || active.ID != created.ID {
		t.Fatalf("future inspection changed live override: active=%#v err=%v", active, err)
	}
	if _, err = service.Create(ctx, CreateInput{TargetType: "screen", TargetID: screenID, ContentType: "playlist", ContentID: playlistID, Duration: 15 * time.Minute}); !errors.Is(err, ErrConflict) {
		t.Fatalf("overlapping override error=%v, want ErrConflict", err)
	}
	clock = clock.Add(6 * time.Minute)
	if err = service.ReconcileExpired(ctx); err != nil {
		t.Fatal(err)
	}
	active, err = service.ActiveForScreen(ctx, screenID)
	if err != nil || active != nil {
		t.Fatalf("expired override=%#v err=%v", active, err)
	}
	if _, err = service.Stop(ctx, created.ID, ownerID, "manual stop after expiry"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stop expired override error=%v, want ErrNotFound", err)
	}
}
