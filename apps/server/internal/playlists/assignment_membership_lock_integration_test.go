package playlists

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

// An assignment reads its screen's Display Group under the screen's row lock.
// A membership change that is still open holds the same lock through its
// foreign-key share lock, so the assignment must wait for it.
func TestAssignmentWaitsForOpenMembershipChange(t *testing.T) {
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
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Assignment Lock", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	screen, group, playlist := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Lobby TV','linux','Test','TV','none','1.0',1920,1080,1,'en-US','UTC')`, screen, org, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Lobby',$3)`, group, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,source_type,created_by)VALUES($1,$2,'Announcements','','static',$3)`, playlist, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	// The membership change's transaction, still open.
	change, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = change.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, group, screen, owner.User.ID); err != nil {
		_ = change.Rollback(ctx)
		t.Fatal(err)
	}

	service := NewService(pool, nil)
	done := make(chan error, 1)
	go func() {
		_, err := service.AssignPresentation(ctx, screen, &playlist, nil, owner.User.ID)
		done <- err
	}()
	select {
	case <-done:
		_ = change.Rollback(ctx)
		t.Fatal("assignment read the screen's group while its membership change was still open")
	case <-time.After(300 * time.Millisecond):
	}
	if err = change.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("assignment did not resume after the membership change committed")
	}
}
