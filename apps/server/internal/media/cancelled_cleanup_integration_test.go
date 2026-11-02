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

// failingOnceStorage fails its first delete, then succeeds.
type failingOnceStorage struct {
	Storage
	failures int
	deleted  []string
}

func (s *failingOnceStorage) Delete(key string) error {
	if s.failures > 0 {
		s.failures--
		return errors.New("storage unavailable")
	}
	s.deleted = append(s.deleted, key)
	return nil
}

func TestCancelledUploadCleanupRetriesAfterFailedDelete(t *testing.T) {
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
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Cancel Cleanup", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	upload, key := uuid.New(), "uploads/cancel-retry"
	if _, err = pool.Exec(ctx, `INSERT INTO upload_sessions(id,organization_id,created_by,original_filename,declared_mime_type,expected_size,temporary_storage_key,status,expires_at) VALUES($1,$2,$3,'poster.png','image/png',1,$4,'uploading',now()+interval '1 hour')`, upload, org, owner.User.ID, key); err != nil {
		t.Fatal(err)
	}

	storage := &failingOnceStorage{failures: 1}
	service := NewService(pool, storage, Config{})
	if err = service.CancelUpload(ctx, upload, owner.User.ID); err == nil {
		t.Fatal("first cancellation reported success although its file delete failed")
	}
	var marker *string
	if err = pool.QueryRow(ctx, `SELECT failure_code FROM upload_sessions WHERE id=$1`, upload).Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if marker == nil || *marker != uploadCancelledCleanupPending {
		t.Fatalf("failed removal left no retry marker: %v", marker)
	}

	// A repeated cancellation must retry the removal, not return success over it.
	if err = service.CancelUpload(ctx, upload, owner.User.ID); err != nil {
		t.Fatalf("repeated cancellation: %v", err)
	}
	if len(storage.deleted) != 1 || storage.deleted[0] != key {
		t.Fatalf("deleted files = %v, want [%s]", storage.deleted, key)
	}
	if err = pool.QueryRow(ctx, `SELECT failure_code FROM upload_sessions WHERE id=$1`, upload).Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if marker != nil {
		t.Fatalf("marker kept after the file was removed: %s", *marker)
	}
}
