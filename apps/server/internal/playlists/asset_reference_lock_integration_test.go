package playlists

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestSnapshotValidationWaitsForAssetDeletion(t *testing.T) {
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

	assetID := uuid.New()
	// The asset is not inserted: validation stops at the lock, and the test only
	// needs to observe whether it waits.
	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_lock(hashtext('tilecast.media.asset.'||$1))`, assetID.String()); err != nil {
		t.Fatal(err)
	}

	raw, err := json.Marshal(map[string]any{
		"name":               "Lunch",
		"description":        "",
		"sourceType":         "static",
		"tagMatch":           "any",
		"tagImageDurationMs": 5000,
		"items":              []map[string]any{{"id": uuid.New(), "assetId": assetID}},
	})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	service := NewService(pool, nil)
	done := make(chan error, 1)
	go func() { done <- service.ValidateSnapshotTx(ctx, tx, uuid.New(), raw) }()
	select {
	case <-done:
		t.Fatal("snapshot validation finished while asset deletion held the reference lock")
	case <-time.After(300 * time.Millisecond):
	}
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_unlock(hashtext('tilecast.media.asset.'||$1))`, assetID.String()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot validation did not resume after the lock was released")
	}
}
