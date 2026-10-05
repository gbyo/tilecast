package testdb

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestPackageDatabaseIsIsolatedAndCleanedUp(t *testing.T) {
	baseURL := os.Getenv("TEST_DATABASE_URL")
	if baseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	testURL, cleanup, err := createDatabase(ctx, baseURL, "testdb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cleanup != nil {
			cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancelCleanup()
			if err := cleanup(cleanupCtx); err != nil {
				t.Errorf("cleanup temporary database: %v", err)
			}
		}
	})
	config, err := pgx.ParseConfig(testURL)
	if err != nil {
		t.Fatal(err)
	}
	baseConfig, err := pgx.ParseConfig(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	if config.Database == baseConfig.Database {
		t.Fatalf("temporary database reused base database %q", baseConfig.Database)
	}
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `CREATE TABLE temporary_scope_probe (id integer)`); err != nil {
		t.Fatal(err)
	}
	if err := conn.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	cleanup = nil

	admin, err := pgx.ConnectConfig(ctx, baseConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	var exists bool
	if err := admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, config.Database).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatalf("temporary database %q was not removed", config.Database)
	}
}
