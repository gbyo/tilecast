package notify

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func newLeaseService(t *testing.T) (*Service, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := database.Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `DELETE FROM notification_deliveries`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO notification_deliveries(id,event_key,category,channel,target,next_attempt_at)
		VALUES($1,'lease-test','backup','webhook','target',now()-interval '1 minute')`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	return &Service{db: pool, cfg: cfg, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, pool
}

// A worker whose lease expired must not overwrite the result of the worker
// that claimed the row after it.
func TestExpiredLeaseCannotOverwriteNewerResult(t *testing.T) {
	s, pool := newLeaseService(t)
	ctx := context.Background()

	stale, err := s.claimDue(ctx)
	if err != nil || len(stale) != 1 {
		t.Fatalf("first claim: %v, %d rows", err, len(stale))
	}
	if again, _ := s.claimDue(ctx); len(again) != 0 {
		t.Fatalf("a leased row was claimed twice")
	}
	// The first worker's lease runs out.
	if _, err = pool.Exec(ctx, `UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.claimDue(ctx)
	if err != nil || len(fresh) != 1 {
		t.Fatalf("second claim: %v, %d rows", err, len(fresh))
	}
	s.markSent(ctx, fresh)

	s.failAll(ctx, stale, errors.New("late failure"), false)
	s.markSent(ctx, stale)
	s.cancel(ctx, stale[0], "late cancel")

	var status, lastError string
	var attempts int
	if err = pool.QueryRow(ctx, `SELECT status,attempts,last_error FROM notification_deliveries`).Scan(&status, &attempts, &lastError); err != nil {
		t.Fatal(err)
	}
	if status != "sent" || attempts != 1 || lastError != "" {
		t.Fatalf("status=%q attempts=%d last_error=%q, want the newer worker's sent result", status, attempts, lastError)
	}
}

// Rows a batch never attempted are due again at once, and only for the worker
// that still holds the lease.
func TestReleaseReturnsUnattemptedRows(t *testing.T) {
	s, _ := newLeaseService(t)
	ctx := context.Background()
	claimed, err := s.claimDue(ctx)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %v, %d rows", err, len(claimed))
	}
	s.release(claimed)
	again, err := s.claimDue(ctx)
	if err != nil || len(again) != 1 {
		t.Fatalf("released row was not due again: %v, %d rows", err, len(again))
	}
	s.release(claimed) // stale lease: must not release the new claim
	if third, _ := s.claimDue(ctx); len(third) != 0 {
		t.Fatalf("a stale release freed a row held by another worker")
	}
}
