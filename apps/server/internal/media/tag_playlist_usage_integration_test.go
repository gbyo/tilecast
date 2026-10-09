package media

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// tagTestStorage accepts removals; the refusal happens before any file work.
type tagTestStorage struct{ Storage }

func (tagTestStorage) Delete(string) error { return nil }

// A Tag-driven Playlist supplies every asset carrying one of its tags, so such
// an asset must not be archived out from under it.
func TestArchiveRefusesAssetSuppliedByTagPlaylist(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Tag Archive", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	asset, tag, playlist := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,origin,system_managed,created_by)VALUES($1,$2,'Welcome','image','welcome.png','image/png',$3,100,'ready','library',FALSE,$4)`, asset, org, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO content_tags(id,organization_id,name,created_by)VALUES($1,$2,'Lunch',$3)`, tag, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO content_asset_tags(asset_id,tag_id)VALUES($1,$2)`, asset, tag); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,source_type,tag_match,created_by)VALUES($1,$2,'Tagged loop','','tag','any',$3)`, playlist, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlist_tags(playlist_id,tag_id)VALUES($1,$2)`, playlist, tag); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, tagTestStorage{}, Config{})
	if err = service.ArchiveAssets(ctx, []uuid.UUID{asset}, owner.User.ID); err == nil {
		t.Fatal("asset supplying a Tag-driven Playlist was archived")
	}
	var archived bool
	if err = pool.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM assets WHERE id=$1`, asset).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if archived {
		t.Fatal("asset was archived despite the refusal")
	}
}
