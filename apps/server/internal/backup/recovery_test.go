package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestClearOrphanedTempKeepsFilesAnotherProcessIsWriting(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	live := filepath.Join(dir, "live.partial")
	orphan := filepath.Join(dir, "orphan.partial")
	for _, path := range []string{live, orphan} {
		if err := os.WriteFile(path, []byte("archive"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chtimes(orphan, now.Add(-2*backupLease), now.Add(-2*backupLease)); err != nil {
		t.Fatal(err)
	}
	clearOrphanedTemp(dir, now)
	if _, err := os.Stat(live); err != nil {
		t.Fatalf("live archive removed: %v", err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("orphaned archive kept: %v", err)
	}
}

func TestFailExpiredRunningJobsLeavesLiveJobsRunning(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE backup_jobs CASCADE`); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	// The schema allows one active job, so the expired job is failed before the
	// live one is queued.
	expired, live := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO backup_jobs(id,kind,trigger,status,locked_at) VALUES($1,'backup','manual','running',$2)`, expired, now.Add(-2*backupLease)); err != nil {
		t.Fatal(err)
	}
	if err = failExpiredRunningJobs(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO backup_jobs(id,kind,trigger,status,locked_at) VALUES($1,'backup','manual','running',$2)`, live, now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err = failExpiredRunningJobs(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	var liveStatus, expiredStatus string
	if err = pool.QueryRow(ctx, `SELECT status FROM backup_jobs WHERE id=$1`, live).Scan(&liveStatus); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT status FROM backup_jobs WHERE id=$1`, expired).Scan(&expiredStatus); err != nil {
		t.Fatal(err)
	}
	if liveStatus != "running" || expiredStatus != "failed" {
		t.Fatalf("live job status=%s expired job status=%s, want running and failed", liveStatus, expiredStatus)
	}
}
