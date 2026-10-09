package media

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// An integration reads a Manual Table, validates its rows against that
// snapshot, and writes them. A Studio edit that lands between the read and the
// write must survive: the write fails with ErrDataSourceChanged, and a retry
// validates against the newer schema.
func TestManualRowsWriteDoesNotRevertConcurrentSchemaEdit(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Manual Rows", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, nil, Config{})
	initial, err := json.Marshal(ManualSourceConfig{
		Columns: []ManualColumn{{Key: "item", Label: "Item", Type: "text"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	source, err := service.CreateDataSource(ctx, owner.User.ID, DataSourceInput{Provider: "manual", Name: "Menu", Configuration: initial})
	if err != nil {
		t.Fatal(err)
	}

	// The integration's read.
	snapshot, err := service.rawDataSource(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}

	// A Studio edit adds a column after that read.
	edited, err := json.Marshal(ManualSourceConfig{
		Columns: []ManualColumn{
			{Key: "item", Label: "Item", Type: "text"},
			{Key: "note", Label: "Note", Type: "text"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.UpdateDataSource(ctx, source.ID, owner.User.ID, DataSourceInput{Provider: "manual", Name: "Menu", Configuration: edited}); err != nil {
		t.Fatal(err)
	}

	// The integration's write, built from the stale snapshot, must not revert the column.
	rows := []ManualRowWrite{{Values: map[string]string{"item": "Soup"}}}
	if _, err = service.replaceManualRowsFrom(ctx, snapshot, owner.User.ID, rows); !errors.Is(err, ErrDataSourceChanged) {
		t.Fatalf("stale write error = %v, want ErrDataSourceChanged", err)
	}
	stored, err := service.rawDataSource(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	var config ManualSourceConfig
	if err = json.Unmarshal(stored.Configuration, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Columns) != 2 || len(config.Rows) != 0 {
		t.Fatalf("stored config after rejected write: columns=%d rows=%d, want columns=2 rows=0", len(config.Columns), len(config.Rows))
	}

	// A retry reads the current schema and succeeds.
	written, err := service.ReplaceManualRows(ctx, source.ID, owner.User.ID, rows)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if err = json.Unmarshal(written.Configuration, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Columns) != 2 || len(config.Rows) != 1 || config.Rows[0].Values["item"] != "Soup" {
		t.Fatalf("retry result: columns=%d rows=%d, want columns=2 rows=1 with Soup", len(config.Columns), len(config.Rows))
	}
}
