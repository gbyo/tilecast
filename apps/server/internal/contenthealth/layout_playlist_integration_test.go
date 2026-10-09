package contenthealth

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

// emptySettings keeps the default thresholds; the sweep only reads them.
type emptySettings struct{}

func (emptySettings) Organization(context.Context) (settings.Document, error) {
	return settings.Document{}, nil
}

func TestEmptyPlaylistSweepCountsPublishedLayoutItems(t *testing.T) {
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
	owner, err := auth.NewService(pool, 0).Setup(ctx, auth.SetupInput{OrganizationName: "Health Layout Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}

	layout, revision, playlist, screen := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO layouts(id,organization_id,name,orientation,canvas_width,canvas_height,draft_document,created_by)VALUES($1,$2,'Menu board','landscape',1920,1080,'{}'::jsonb,$3)`, layout, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO layout_revisions(id,layout_id,revision,document,document_sha256,published_by)VALUES($1,$2,1,'{}'::jsonb,$3,$4)`, revision, layout, "0000000000000000000000000000000000000000000000000000000000000000", owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE layouts SET published_revision_id=$2 WHERE id=$1`, layout, revision); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,source_type,created_by)VALUES($1,$2,'Menu playlist','','static',$3)`, playlist, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlist_items(id,playlist_id,layout_id,position)VALUES($1,$2,$3,0)`, uuid.New(), playlist, layout); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Cafeteria TV','linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, screen, org, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by)VALUES($1,$2,$3,$4)`, uuid.New(), screen, playlist, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	if err = NewService(pool, emptySettings{}).Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	var open int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM incidents WHERE title='Playlist has nothing to play' AND status='open'`).Scan(&open); err != nil {
		t.Fatal(err)
	}
	if open != 0 {
		t.Fatalf("empty-playlist incidents for a published Layout = %d, want 0", open)
	}
}
