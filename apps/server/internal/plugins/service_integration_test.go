package plugins

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestCatalogAndAlertTickerProjection(t *testing.T) {
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
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	organizationID, userID, locationID, groupID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	targetedScreen, otherScreen := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Plugin Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','plugin-owner','unused','owner',TRUE)`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Cafeteria')`, locationID, organizationID); err != nil {
		t.Fatal(err)
	}
	for _, record := range []struct {
		id       uuid.UUID
		location *uuid.UUID
		name     string
	}{{targetedScreen, &locationID, "Cafeteria"}, {otherScreen, nil, "Lobby"}} {
		if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,location_id,platform,
			device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
			VALUES($1,$2,$3,$4,$5,'linux','Test','Display','Linux','1',1920,1080,1,'en-US','UTC')`,
			record.id, organizationID, uuid.NewString(), record.name, record.location); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, record.id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Lunch screens',$3)`, groupID, organizationID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, groupID, targetedScreen, userID); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, nil)
	installPluginsForTest(t, pool, EmergencyAlertsID)

	// The catalog is the list of what Tilecast can do. Emergency Alerts belongs
	// in it whether or not this installation has configured any of it, which is
	// what moving it out of Settings and into Plugins means.
	catalog, err := service.Catalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]CatalogPlugin{}
	for _, item := range catalog.Items {
		byID[item.ID] = item
	}
	if len(catalog.Items) != 3 || byID["countdown_bar"].Name == "" || byID["emergency_alerts"].Name == "" ||
		byID["forms"].Name == "" {
		t.Fatalf("catalog = %+v, want Countdown Bar, Emergency Alerts, and Forms", catalog.Items)
	}
	if _, listed := byID["dependency_graph"]; listed {
		t.Fatal("Dependency Graph is a system tool, not an installable plugin")
	}
	if alerts := byID["emergency_alerts"]; !alerts.Installed || alerts.Active || alerts.Configured || alerts.InstanceCount != 0 {
		t.Fatalf("unconfigured Emergency Alerts = %+v, want installed, inactive, with no rules", alerts)
	}
	if forms := byID["forms"]; forms.Installed || forms.Active || forms.InstanceCount != 0 {
		t.Fatalf("uninstalled Forms = %+v, want not installed with no forms", forms)
	}
	graph, err := service.DependencyGraph(ctx, []uuid.UUID{targetedScreen, otherScreen})
	if err != nil {
		t.Fatal(err)
	}
	var groupContainsScreen bool
	for _, edge := range graph.Edges {
		if edge.FromType == "screen_group" && edge.FromID == groupID &&
			edge.ToType == "screen" && edge.ToID == targetedScreen &&
			edge.Relationship == "contains" {
			groupContainsScreen = true
			break
		}
	}
	if !groupContainsScreen {
		t.Fatalf("dependency graph omitted sync group membership: %+v", graph.Edges)
	}
	// The migration seeds the singleton row, but this test truncates users, and
	// TRUNCATE ... CASCADE reaches every table referencing it.
	if _, err = pool.Exec(ctx, `INSERT INTO alert_monitor(singleton,enabled) VALUES(TRUE,TRUE)
		ON CONFLICT(singleton) DO UPDATE SET enabled=TRUE`); err != nil {
		t.Fatal(err)
	}
	alertRuleID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO alert_rules(id,organization_id,name,created_by,response_mode,ticker_display_mode,ticker_height_px,ticker_speed) VALUES($1,$2,'Tornado Warning',$3,'ticker','push',120,'fast')`,
		alertRuleID, organizationID, userID); err != nil {
		t.Fatal(err)
	}
	catalog, err = service.Catalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range catalog.Items {
		if item.ID != "emergency_alerts" {
			continue
		}
		// Monitoring is what "active" means here; the rules are the instances.
		if !item.Active || !item.Configured || item.InstanceCount != 1 {
			t.Fatalf("configured Emergency Alerts = %+v, want active with one rule", item)
		}
	}

	// A live alert answered with a bar reaches the screen through the same plugin
	// array as a Countdown Bar, with its message composed from the alert itself.
	if _, err = pool.Exec(ctx, `INSERT INTO alert_rule_targets(rule_id,target_type,screen_id) VALUES($1,'screen',$2)`,
		alertRuleID, targetedScreen); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO alert_activations(alert_id,rule_id,event,headline,area_description,instruction,severity,urgency,response_mode,expires_at)
		VALUES('alert-1',$1,'Tornado Warning','Tornado observed','Franklin County','Move to an interior room.','Extreme','Immediate','ticker',now()+interval '30 minutes')`,
		alertRuleID); err != nil {
		t.Fatal(err)
	}
	withTicker, err := service.ManifestForScreen(ctx, targetedScreen)
	if err != nil {
		t.Fatal(err)
	}
	var ticker *ManifestAlertTickerConfig
	for _, plugin := range withTicker {
		if config, ok := plugin.Config.(ManifestAlertTickerConfig); ok && plugin.Type == "alert_ticker" {
			if plugin.ID != alertRuleID {
				t.Fatalf("ticker plugin id = %s, want the rule that raised it", plugin.ID)
			}
			ticker = &config
		}
	}
	if ticker == nil {
		t.Fatalf("no alert ticker in manifest: %#v", withTicker)
	}
	if ticker.Message != "Tornado Warning — Tornado observed — Franklin County — Move to an interior room." ||
		ticker.Severity != "Extreme" || ticker.DisplayMode != "push" ||
		ticker.HeightPX != 120 || ticker.Speed != "fast" || ticker.Priority != alertTickerPriority {
		t.Fatalf("alert ticker config = %#v", *ticker)
	}
	// An untargeted screen is not carrying someone else's emergency.
	untargeted, err := service.ManifestForScreen(ctx, otherScreen)
	if err != nil {
		t.Fatal(err)
	}
	for _, plugin := range untargeted {
		if plugin.Type == "alert_ticker" {
			t.Fatalf("alert ticker leaked to an untargeted screen: %#v", plugin)
		}
	}
	// A cleared activation takes the bar out of the manifest, which is the only
	// way an offline-capable player learns the alert is over.
	if _, err = pool.Exec(ctx, `UPDATE alert_activations SET cleared_at=now(),clear_reason='no_longer_active' WHERE rule_id=$1`, alertRuleID); err != nil {
		t.Fatal(err)
	}
	cleared, err := service.ManifestForScreen(ctx, targetedScreen)
	if err != nil {
		t.Fatal(err)
	}
	for _, plugin := range cleared {
		if plugin.Type == "alert_ticker" {
			t.Fatalf("cleared alert still in manifest: %#v", plugin)
		}
	}
}

// The manifest carries one plugin array for every plugin type, so a test that
// wants a Countdown Bar's configuration has to say which type it expects.
func firstConfig(items []ManifestPlugin) any {
	if len(items) == 0 {
		return nil
	}
	return items[0].Config
}
