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

// noopStorage records nothing: cancellation only deletes the temporary object.
type noopStorage struct{ Storage }

func (noopStorage) Delete(string) error { return nil }

func TestCancelWaitsForUploadFinalization(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE upload_sessions, organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Upload Lock", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	upload := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO upload_sessions(id,organization_id,created_by,original_filename,declared_mime_type,expected_size,temporary_storage_key,status,expires_at) VALUES($1,$2,$3,'poster.png','image/png',1,'uploads/cancel-lock','pending',now()+interval '1 hour')`, upload, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	// A finalizer holds the upload's advisory lock for its whole hand-off.
	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,0))`, upload.String()); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, noopStorage{}, Config{})
	done := make(chan error, 1)
	go func() { done <- service.CancelUpload(ctx, upload, owner.User.ID) }()
	select {
	case err := <-done:
		t.Fatalf("cancellation finished while finalization held the upload lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, upload.String()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancel after finalization lock release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not resume after the finalization lock was released")
	}
	var status string
	if err = pool.QueryRow(ctx, `SELECT status FROM upload_sessions WHERE id=$1`, upload).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" {
		t.Fatalf("status = %s, want cancelled", status)
	}
}
