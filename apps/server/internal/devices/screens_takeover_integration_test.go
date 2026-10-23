package devices

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestListScreensShowsActiveTakeoverAsNowPlaying(t *testing.T) {
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
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}

	orgID := uuid.New()
	screenID := uuid.New()
	fallbackID := uuid.New()
	takeoverPlaylistID := uuid.New()
	takeoverID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Fleet takeover test',$1)`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
		VALUES($1,$2,$3,'Lobby','linux','Test','Display','n/a','1.0',1920,1080,1,'en-US','UTC')`, screenID, orgID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash) VALUES($1,$2,$3,'\x00'::bytea)`, uuid.New(), screenID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name) VALUES($1,$3,'Regular rotation'),($2,$3,'Emergency message')`, fallbackID, takeoverPlaylistID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id) VALUES($1,$2,$3)`, uuid.New(), screenID, fallbackID); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, NewPresenceHub(), "https://signage.example.org")
	assertNowPlaying := func(name, kind string) {
		t.Helper()
		screens, err := service.ListScreens(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(screens) != 1 {
			t.Fatalf("screen count=%d, want 1", len(screens))
		}
		if screens[0].NowPlayingName == nil || *screens[0].NowPlayingName != name {
			t.Fatalf("now playing name=%v, want %q", screens[0].NowPlayingName, name)
		}
		if screens[0].NowPlayingType == nil || *screens[0].NowPlayingType != kind {
			t.Fatalf("now playing type=%v, want %q", screens[0].NowPlayingType, kind)
		}
	}

	assertNowPlaying("Regular rotation", "playlist")

	now := time.Now().UTC()
	if _, err := pool.Exec(ctx, `INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_at,expires_at,created_at)
		VALUES($1,$2,'Emergency takeover',$3,'active',$4,$5,$6)`, takeoverID, orgID, takeoverPlaylistID, now.Add(-time.Minute), now.Add(time.Hour), now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state) VALUES($1,$2,2,'active')`, takeoverID, screenID); err != nil {
		t.Fatal(err)
	}

	assertNowPlaying("Emergency message", "playlist")

	if _, err := pool.Exec(ctx, `UPDATE takeover_screen_states SET state='restored',restored_at=now(),last_updated_at=now() WHERE takeover_id=$1 AND screen_id=$2`, takeoverID, screenID); err != nil {
		t.Fatal(err)
	}
	assertNowPlaying("Regular rotation", "playlist")
}
