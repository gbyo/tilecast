package backup

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestConcurrentDeleteKeepsOneCompleteArchive(t *testing.T) {
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
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE backup_archives CASCADE`); err != nil {
		t.Fatal(err)
	}

	service, err := NewService(pool, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var ids []uuid.UUID
	for _, name := range []string{"first.tcbackup", "second.tcbackup"} {
		archive := Archive{
			ID:               uuid.New(),
			FileName:         name,
			Kind:             "manual",
			Status:           "complete",
			SizeBytes:        1,
			ArchiveSHA256:    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			TilecastVersion:  "test",
			SchemaVersion:    1,
			InstallationID:   uuid.NewString(),
			OrganizationName: "Backup Test",
			Verification:     "verified",
			CreatedAt:        time.Now().UTC(),
		}
		if err := service.RegisterArchive(ctx, archive); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, archive.ID)
	}

	// Hold the catalog lock while both deletions start. Each one must queue
	// behind it, so the second sees the first one's committed removal.
	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_lock(hashtext('tilecast.backup.catalog'))`); err != nil {
		holder.Release()
		t.Fatal(err)
	}
	results := make(chan error, len(ids))
	for _, id := range ids {
		go func(id uuid.UUID) {
			_, err := service.Delete(ctx, id, false)
			results <- err
		}(id)
	}
	time.Sleep(200 * time.Millisecond)
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_unlock(hashtext('tilecast.backup.catalog'))`); err != nil {
		holder.Release()
		t.Fatal(err)
	}
	holder.Release()
	first, second := <-results, <-results
	refused := 0
	for _, err := range []error{first, second} {
		if errors.Is(err, ErrLastBackup) {
			refused++
		} else if err != nil {
			t.Fatalf("unexpected delete error: %v", err)
		}
	}
	if refused != 1 {
		t.Fatalf("refused deletes = %d, want 1 (first=%v second=%v)", refused, first, second)
	}
	var complete int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM backup_archives WHERE status = 'complete'`).Scan(&complete); err != nil {
		t.Fatal(err)
	}
	if complete != 1 {
		t.Fatalf("complete archives after delete = %d, want 1", complete)
	}
}
