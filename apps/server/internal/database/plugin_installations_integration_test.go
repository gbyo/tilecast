package database

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
)

const pluginInstallationsMigration = 102

// TestPluginInstallationBackfill proves 00102 installs exactly the plugins an
// upgraded installation's data shows are in use. It runs in a throwaway
// database so it can stop at the preceding schema version, and steps the one
// migration down and up again for each scenario.
func TestPluginInstallationBackfill(t *testing.T) {
	baseURL := os.Getenv("TEST_DATABASE_URL")
	if baseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	databaseURL := createScratchDatabase(t, ctx, baseURL)
	if err := MigrateTo(ctx, databaseURL, pluginInstallationsMigration-1); err != nil {
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
	rerun := func() []string {
		t.Helper()
		if err := useCatalog(); err != nil {
			t.Fatal(err)
		}
		if current, err := goose.GetDBVersionContext(ctx, db); err != nil {
			t.Fatal(err)
		} else if current == pluginInstallationsMigration {
			if err = goose.DownContext(ctx, db, migrationDir); err != nil {
				t.Fatal(err)
			}
		}
		if err := goose.UpToContext(ctx, db, migrationDir, pluginInstallationsMigration); err != nil {
			t.Fatal(err)
		}
		rows, err := db.QueryContext(ctx, `SELECT plugin_id FROM plugin_installations`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		ids := []string{}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		sort.Strings(ids)
		return ids
	}
	expect := func(scenario string, want ...string) {
		t.Helper()
		sort.Strings(want)
		if got := rerun(); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s: installed %v, want %v", scenario, got, want)
		}
	}

	expect("no organization yet")

	orgID, userID := uuid.New(), uuid.New()
	exec(`INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Backfill',$1)`, orgID)
	exec(`INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','backfill-owner','unused','owner',TRUE)`, userID)
	expect("empty installation; NWS singleton present but disabled")

	exec(`UPDATE alert_monitor SET enabled=TRUE,areas='{OH}'`)
	expect("NWS monitor enabled", "emergency_alerts")
	exec(`UPDATE alert_monitor SET enabled=FALSE`)
	ruleID := uuid.New()
	exec(`INSERT INTO alert_rules(id,organization_id,name,created_by) VALUES($1,$2,'Tornado',$3)`, ruleID, orgID, userID)
	expect("NWS rule with monitor disabled", "emergency_alerts")
	exec(`DELETE FROM alert_rules`)

	formID := uuid.New()
	exec(`INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by,deleted_at)
		VALUES($1,$2,'Old form','','form',1,'{}'::jsonb,$3,now())`, formID, orgID, userID)
	expect("deleted form only")
	exec(`UPDATE data_sources SET deleted_at=NULL WHERE id=$1`, formID)
	expect("live form", "forms")
	exec(`DELETE FROM data_sources`)

	exec(`INSERT INTO countdown_bar_instances(id,organization_id,name,message,schedule_type,target_time,days_of_week,timezone,
		lead_time_seconds,display_mode,height_px,enabled,target_scope,created_by)
		VALUES($1,$2,'Lunch','Lunch ends in','weekly','12:00',ARRAY[1,2]::smallint[],'UTC',900,'overlay',72,FALSE,'all',$3)`,
		uuid.New(), orgID, userID)
	expect("disabled countdown bar", "countdown_bar")

	exec(`INSERT INTO brand_bug_instances(id,organization_id,name,corner,text,width_percent,text_size_percent,opacity_percent,
		margin_percent,text_color,background_style,target_scope,created_by)
		VALUES($1,$2,'Sponsor','top_right','Sponsor',12,3,85,3,'#FFFFFF','scrim','all',$3)`, uuid.New(), orgID, userID)
	exec(`INSERT INTO noise_meter_instances(id,organization_id,name,warning_level,loud_level,sensitivity,trigger_hold_ms,
		clear_hold_ms,display_mode,height_px,target_scope,created_by)
		VALUES($1,$2,'Cafeteria',60,80,100,1000,3000,'overlay',96,'all',$3)`, uuid.New(), orgID, userID)
	expect("countdown, brand bug, and noise meter", "brand_bug", "countdown_bar", "noise_meter")

	// Idempotent under the normal Goose guarantee: applying Up again is a no-op.
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
}

// createScratchDatabase creates a uniquely named database on the same server
// as the shared test database and drops it when the test ends.
func createScratchDatabase(t *testing.T, ctx context.Context, baseURL string) string {
	t.Helper()
	parsed, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	name := "tilecast_scratch_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	admin, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %s`, name)); err != nil {
		admin.Close(ctx)
		t.Skipf("cannot create a scratch database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, name))
		admin.Close(context.Background())
	})
	parsed.Path = "/" + name
	return parsed.String()
}
