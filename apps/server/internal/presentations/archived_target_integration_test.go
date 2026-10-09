package presentations

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestQuickPresentRejectsArchivedScreenTarget(t *testing.T) {
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
	orgID, ownerID, screenID, assetID, playlistID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id)VALUES(TRUE,'Archived Present Test',$1)`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active)VALUES($1,'Owner','owner','unused','owner',TRUE)`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone,archived_at,archived_reason,enabled)VALUES($1,$2,$3,'Archived TV','linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC',now(),'test',FALSE)`, screenID, orgID, uuid.NewString()); err != nil {
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

	service := NewService(pool, nil)
	service.now = func() time.Time { return time.Date(2026, time.July, 17, 15, 0, 0, 0, time.UTC) }
	if _, err = service.Create(ctx, CreateInput{TargetType: "screen", TargetID: screenID, ContentType: "playlist", ContentID: playlistID, Duration: 5 * time.Minute, CreatedBy: ownerID}); err == nil {
		t.Fatal("Quick Present for an archived screen was accepted")
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM presentation_overrides WHERE target_id=$1`, screenID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("overrides for archived screen = %d, want 0", count)
	}
}
