package media

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// A Layout draft save validates each Data Source under a share lock and holds
// it until the dependency row commits. Deletion must wait for that save, then
// see the dependency and refuse.
func TestDataSourceDeleteWaitsForLayoutDraftSave(t *testing.T) {
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
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Source Lock", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	source, layout := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by) VALUES($1,$2,'Schedule data','csv','{}'::jsonb,$3)`, source, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO layouts(id,organization_id,name,orientation,canvas_width,canvas_height,draft_document,created_by)VALUES($1,$2,'Menu board','landscape',1920,1080,'{}'::jsonb,$3)`, layout, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	// The save's transaction: share lock on the source, dependency row not yet committed.
	save, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = save.Exec(ctx, `SELECT 1 FROM data_sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, source); err != nil {
		_ = save.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err = save.Exec(ctx, `INSERT INTO layout_draft_dependencies(layout_id,dependency_type,dependency_id)VALUES($1,'data_source',$2)`, layout, source); err != nil {
		_ = save.Rollback(ctx)
		t.Fatal(err)
	}

	service := NewService(pool, nil, Config{})
	done := make(chan error, 1)
	go func() { done <- service.DeleteDataSource(ctx, source, owner.User.ID) }()
	select {
	case err := <-done:
		_ = save.Rollback(ctx)
		t.Fatalf("deletion finished while the draft save was in progress: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if err = save.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		var dependency *DependencyError
		if !errors.As(err, &dependency) {
			t.Fatalf("deletion after the draft save = %v, want a DependencyError", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("deletion did not resume after the draft save committed")
	}
	var deleted bool
	if err = pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM data_sources WHERE id=$1`, source).Scan(&deleted); err != nil {
		t.Fatal(err)
	}
	if deleted {
		t.Fatal("a Data Source used by a committed Layout draft was deleted")
	}
}
