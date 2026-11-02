package backup

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// testLease mirrors the 15-minute lease the claim query reclaims after.
const testLease = 15 * time.Minute

func TestHeartbeatRefreshesLeaseOfRunningJob(t *testing.T) {
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
	job := uuid.New()
	stale := time.Now().Add(-2 * testLease).UTC().Truncate(time.Microsecond)
	if _, err = pool.Exec(ctx, `INSERT INTO backup_jobs(id,kind,trigger,status,locked_at) VALUES($1,'backup','manual','running',$2)`, job, stale); err != nil {
		t.Fatal(err)
	}

	stop := heartbeatLease(ctx, pool, job, 20*time.Millisecond)
	defer stop()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var locked time.Time
		if err = pool.QueryRow(ctx, `SELECT locked_at FROM backup_jobs WHERE id=$1`, job).Scan(&locked); err != nil {
			t.Fatal(err)
		}
		if locked.After(stale.Add(testLease)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("lease was not refreshed: locked_at=%v", locked)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
