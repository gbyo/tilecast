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

// fixedSpaceStorage reports a fixed amount of free space.
type fixedSpaceStorage struct {
	Storage
	available uint64
}

func (s fixedSpaceStorage) AvailableBytes() (uint64, error) { return s.available, nil }

// CreateUpload hands back a real temporary file for an accepted upload.
func (s fixedSpaceStorage) CreateUpload(string) (*os.File, error) {
	return os.CreateTemp("", "reserve-test-*")
}

func TestUploadReserveCountsAcceptedUploadsStillToWrite(t *testing.T) {
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
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Reserve", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	// A pending session that still has 800 bytes to receive.
	if _, err = pool.Exec(ctx, `INSERT INTO upload_sessions(id,organization_id,created_by,original_filename,declared_mime_type,expected_size,current_offset,temporary_storage_key,status,expires_at) VALUES($1,$2,$3,'big.mp4','video/mp4',800,0,'uploads/big','uploading',now()+interval '1 hour')`, uuid.New(), org, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	// 1000 bytes free, a 100-byte reserve. The pending session leaves 200 free,
	// so a 150-byte upload would leave less than the reserve.
	service := NewService(pool, fixedSpaceStorage{available: 1000}, Config{MaxUploadBytes: 10_000, ReservedFreeBytes: 100})
	if _, err = service.CreateUpload(ctx, owner.User.ID, "small.png", "image/png", 150); !errors.Is(err, ErrInsufficientSpace) {
		t.Fatalf("upload beside a pending session = %v, want ErrInsufficientSpace", err)
	}
	if _, err = service.CreateUpload(ctx, owner.User.ID, "small.png", "image/png", 50); err != nil {
		t.Fatalf("upload that fits beside the pending session: %v", err)
	}
}

// Two creations that start together must not both pass the reserve check
// against the same snapshot. The second waits for the first to commit.
func TestUploadCreationWaitsForReserveLock(t *testing.T) {
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
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Reserve Lock", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}

	// Another creation holds the reserve lock while it checks and inserts.
	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_lock(hashtext('tilecast.media.upload-reserve'))`); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, fixedSpaceStorage{available: 1000}, Config{MaxUploadBytes: 10_000, ReservedFreeBytes: 100})
	done := make(chan error, 1)
	go func() {
		_, err := service.CreateUpload(ctx, owner.User.ID, "small.png", "image/png", 50)
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("creation finished while the reserve lock was held: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_unlock(hashtext('tilecast.media.upload-reserve'))`); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("creation after the lock was released: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("creation did not resume after the reserve lock was released")
	}
}
