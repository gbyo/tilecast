package database

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

const pluginDeliveriesMigration = 144

// TestPluginTimersMoveToTheDeliveryQueue proves 00144 keeps every timer of
// an installed plugin (its generation ID, key, payload, due time, and
// attempts), drops the timers of a plugin that is not installed, and that
// the down migration moves pending timers back.
func TestPluginTimersMoveToTheDeliveryQueue(t *testing.T) {
	baseURL := os.Getenv("TEST_DATABASE_URL")
	if baseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	databaseURL := createScratchDatabase(t, ctx, baseURL)
	if err := MigrateTo(ctx, databaseURL, pluginDeliveriesMigration-1); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	exec(`INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Migration Test',$1)`, uuid.New())
	exec(`INSERT INTO plugin_installations(organization_id,plugin_id) SELECT id,'room_sign' FROM organization_settings`)
	due := time.Date(2027, 3, 1, 8, 0, 0, 0, time.UTC)
	kept, dropped := uuid.New(), uuid.New()
	exec(`INSERT INTO plugin_timers(id,plugin_id,timer_key,payload,definition_version,due_at,attempts,last_error)
		VALUES($1,'room_sign','tick','p'::bytea,1,$2,2,'handler_error'), ($3,'not_installed','tick',''::bytea,1,$2,0,NULL)`, kept, due, dropped)
	if err := useCatalog(); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpToContext(ctx, db, migrationDir, pluginDeliveriesMigration); err != nil {
		t.Fatal(err)
	}
	var (
		id                    uuid.UUID
		kind, source, subject string
		payload               []byte
		dueAt, nextAttempt    time.Time
		attempts, version     int
		lastError, state      string
		installedMatches      bool
	)
	if err := db.QueryRowContext(ctx, `SELECT d.id,kind,source,subject,payload,due_at,next_attempt_at,attempts,definition_version,last_error,state,
		d.installed_at=i.installed_at FROM plugin_deliveries d JOIN plugin_installations i USING (plugin_id)`).Scan(&id, &kind, &source, &subject, &payload, &dueAt, &nextAttempt, &attempts, &version, &lastError, &state, &installedMatches); err != nil {
		t.Fatal(err)
	}
	if id != kept || kind != "timer" || source != "tick" || subject != "timer:tick" || string(payload) != "p" ||
		!dueAt.Equal(due) || !nextAttempt.Equal(due) || attempts != 2 || version != 1 || lastError != "handler_error" || state != "pending" || !installedMatches {
		t.Fatalf("moved timer = %v %s %s %s %q %v %v %d %d %s %s", id, kind, source, subject, payload, dueAt, nextAttempt, attempts, version, lastError, state)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM plugin_deliveries`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rows = %d %v", count, err)
	}
	if err := goose.DownToContext(ctx, db, migrationDir, pluginDeliveriesMigration-1); err != nil {
		t.Fatal(err)
	}
	var back uuid.UUID
	var key string
	if err := db.QueryRowContext(ctx, `SELECT id,timer_key FROM plugin_timers`).Scan(&back, &key); err != nil || back != kept || key != "tick" {
		t.Fatalf("down = %v %s %v", back, key, err)
	}
}
