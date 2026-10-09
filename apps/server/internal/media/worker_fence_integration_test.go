package media

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// A worker that lost its lease must not change the job its replacement now runs.
func TestSupersededWorkerCannotCompleteJob(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE media_jobs, organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err = auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Fence", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"}); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, nil, Config{})
	worker := NewWorkerPool(service, slog.New(slog.NewTextHandler(io.Discard, nil)))
	job, replacement := uuid.New(), "replacement-worker"
	// The replacement claimed the job on its second attempt.
	if _, err = pool.Exec(ctx, `INSERT INTO media_jobs(id,kind,status,attempts,locked_by,locked_at) VALUES($1,'clean_expired_uploads','running',2,$2,now())`, job, replacement); err != nil {
		t.Fatal(err)
	}
	stale := staleJob(job, 1)
	worker.complete(ctx, stale)
	var status, lockedBy string
	if err = pool.QueryRow(ctx, `SELECT status,locked_by FROM media_jobs WHERE id=$1`, job).Scan(&status, &lockedBy); err != nil {
		t.Fatal(err)
	}
	if status != "running" || lockedBy != replacement {
		t.Fatalf("stale completion changed the job: status=%s locked_by=%s", status, lockedBy)
	}
}

func staleJob(id uuid.UUID, attempts int) job {
	return job{ID: id, Kind: "clean_expired_uploads", Attempts: attempts, MaxAttempts: 5}
}
