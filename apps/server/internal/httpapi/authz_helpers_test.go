package httpapi

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// setScreenPolicy stores a screen-access policy the way the API does.
func setScreenPolicy(t *testing.T, pool *pgxpool.Pool, actor, user uuid.UUID, input authz.PolicyInput) {
	t.Helper()
	ctx := audit.WithSurface(context.Background(), audit.SurfaceStudio)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if input.Grants == nil {
		input.Grants = []authz.Grant{}
	}
	if err := authz.ReplacePolicyTx(ctx, tx, actor, user, input); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func databaseURLOrSkip(t *testing.T) string {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	return url
}

// migrateTo applies migrations up to version, or every migration for 0.
func migrateTo(t *testing.T, ctx context.Context, databaseURL string, version int64) {
	t.Helper()
	var err error
	if version == 0 {
		err = database.Migrate(ctx, databaseURL)
	} else {
		err = database.MigrateTo(ctx, databaseURL, version)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func openPool(t *testing.T, ctx context.Context, databaseURL string) *pgxpool.Pool {
	t.Helper()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func mustExec(t *testing.T, pool *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}
