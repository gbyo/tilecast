package plugins

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleplugin"
)

type installationEnvironment struct {
	ctx      context.Context
	pool     *pgxpool.Pool
	service  *Service
	userID   uuid.UUID
	orgID    uuid.UUID
	screenID uuid.UUID
}

func withInstallationDatabase(t *testing.T, run func(installationEnvironment)) {
	t.Helper()
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
	env := installationEnvironment{ctx: ctx, pool: pool, service: NewService(pool, nil),
		userID: uuid.New(), orgID: uuid.New(), screenID: uuid.New()}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Install Test',$1)`, env.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','install-owner','unused','owner',TRUE)`, env.userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,
		device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
		VALUES($1,$2,$3,'Lobby','linux','Test','Display','Linux','1',1920,1080,1,'en-US','UTC')`,
		env.screenID, env.orgID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, env.screenID); err != nil {
		t.Fatal(err)
	}
	// TRUNCATE ... CASCADE reaches the singleton monitor through updated_by.
	if _, err = pool.Exec(ctx, `INSERT INTO alert_monitor(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	run(env)
}

func (env installationEnvironment) manifestVersion(t *testing.T) int64 {
	t.Helper()
	var version int64
	if err := env.pool.QueryRow(env.ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, env.screenID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	return version
}

func (env installationEnvironment) catalogEntry(t *testing.T, id string) CatalogPlugin {
	t.Helper()
	item, err := env.service.CatalogItem(env.ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return item
}

func TestFreshInstallationHasNoPluginsInstalled(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		catalog, err := env.service.Catalog(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(catalog.Items) != len(registry) {
			t.Fatalf("catalog lists %d plugins, want every registry entry", len(catalog.Items))
		}
		for _, item := range catalog.Items {
			if item.Installed || item.Active || item.Configured {
				t.Fatalf("fresh catalog entry %+v should be available only", item)
			}
		}
	})
}

func TestInstallIsIdempotentAuditedAndInvalidatesManifests(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		sample := NewService(env.pool, nil, WithPlugins(sampleplugin.New()))
		before := env.manifestVersion(t)
		item, created, err := sample.Install(env.ctx, sampleplugin.ID, env.userID)
		if err != nil || !created || !item.Installed || item.Configured {
			t.Fatalf("first install = %+v, created=%v, err=%v", item, created, err)
		}
		if after := env.manifestVersion(t); after <= before {
			t.Fatalf("install did not advance the manifest: %d -> %d", before, after)
		}
		if _, created, err = sample.Install(env.ctx, sampleplugin.ID, env.userID); err != nil || created {
			t.Fatalf("repeat install created=%v err=%v, want idempotent", created, err)
		}
		var audits int
		if err = env.pool.QueryRow(env.ctx, `SELECT count(*) FROM audit_logs WHERE action='plugin.installed' AND resource_id='sample_tally'
			AND metadata->>'definitionVersion'='2'`).Scan(&audits); err != nil || audits != 1 {
			t.Fatalf("plugin.installed audits = %d (%v), want 1", audits, err)
		}
		if _, _, err = env.service.Install(env.ctx, "some_future_plugin", env.userID); !errors.Is(err, ErrPluginNotFound) {
			t.Fatalf("unknown install err = %v", err)
		}
		// Forms has no Player surface, so installing it leaves manifests alone.
		version := env.manifestVersion(t)
		if _, _, err = env.service.Install(env.ctx, FormsID, env.userID); err != nil {
			t.Fatal(err)
		}
		if env.manifestVersion(t) != version {
			t.Fatal("installing Forms should not revise Player manifests")
		}
	})
}

func TestEmergencyAlertsRemovalBlockers(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, _, err := env.service.Install(env.ctx, EmergencyAlertsID, env.userID); err != nil {
			t.Fatal(err)
		}
		// Installed with monitoring off is a valid, removable state.
		entry := env.catalogEntry(t, EmergencyAlertsID)
		if !entry.Installed || entry.Active || entry.Configured {
			t.Fatalf("installed idle Emergency Alerts = %+v", entry)
		}
		if _, err := env.pool.Exec(env.ctx, `UPDATE alert_monitor SET enabled=TRUE,areas='{OH}'`); err != nil {
			t.Fatal(err)
		}
		ruleID := uuid.New()
		if _, err := env.pool.Exec(env.ctx, `INSERT INTO alert_rules(id,organization_id,name,created_by) VALUES($1,$2,'Tornado',$3)`,
			ruleID, env.orgID, env.userID); err != nil {
			t.Fatal(err)
		}
		err := env.service.Remove(env.ctx, EmergencyAlertsID, env.userID)
		var inUse *InUseError
		if !errors.As(err, &inUse) || len(inUse.Resources) != 2 {
			t.Fatalf("remove with monitor and rule err = %#v", err)
		}
		if !strings.HasPrefix(inUse.Error(), "Emergency Alerts cannot be removed while ") {
			t.Fatalf("message = %q", inUse.Error())
		}
		if _, err = env.pool.Exec(env.ctx, `UPDATE alert_monitor SET enabled=FALSE; DELETE FROM alert_rules`); err != nil {
			t.Fatal(err)
		}
		before := env.manifestVersion(t)
		if err = env.service.Remove(env.ctx, EmergencyAlertsID, env.userID); err != nil {
			t.Fatalf("remove after cleanup: %v", err)
		}
		// A Player-facing plugin's removal revises Player manifests.
		if env.manifestVersion(t) <= before {
			t.Fatal("remove did not advance the manifest")
		}
		if err = env.service.Remove(env.ctx, EmergencyAlertsID, env.userID); err != nil {
			t.Fatalf("repeat remove should be idempotent, got %v", err)
		}
		if entry = env.catalogEntry(t, EmergencyAlertsID); entry.Installed {
			t.Fatal("Emergency Alerts still installed after remove")
		}
	})
}

func TestFormsRemovalIgnoresDeletedForms(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, _, err := env.service.Install(env.ctx, FormsID, env.userID); err != nil {
			t.Fatal(err)
		}
		formID := uuid.New()
		if _, err := env.pool.Exec(env.ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by)
			VALUES($1,$2,'Requests','','form',1,'{}'::jsonb,$3)`, formID, env.orgID, env.userID); err != nil {
			t.Fatal(err)
		}
		var inUse *InUseError
		if err := env.service.Remove(env.ctx, FormsID, env.userID); !errors.As(err, &inUse) || inUse.Resources[0].Kind != "form" {
			t.Fatalf("remove with a form err = %#v", err)
		}
		if _, err := env.pool.Exec(env.ctx, `UPDATE data_sources SET deleted_at=now() WHERE id=$1`, formID); err != nil {
			t.Fatal(err)
		}
		if err := env.service.Remove(env.ctx, FormsID, env.userID); err != nil {
			t.Fatalf("remove with only a deleted form: %v", err)
		}
		// Removal deletes the installation, never the form's own row.
		var remaining int
		if err := env.pool.QueryRow(env.ctx, `SELECT count(*) FROM data_sources WHERE id=$1`, formID).Scan(&remaining); err != nil || remaining != 1 {
			t.Fatalf("form row removed by plugin removal: %d (%v)", remaining, err)
		}
	})
}

func TestManifestRequiresInstallation(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		sample := sampleplugin.New()
		service := NewService(env.pool, nil, WithPlugins(sample))
		if _, _, err := service.Install(env.ctx, sampleplugin.ID, env.userID); err != nil {
			t.Fatal(err)
		}
		sample.Seed("Lobby")
		items, err := service.ManifestForScreen(env.ctx, env.screenID)
		if err != nil || len(items) != 1 || items[0].Type != "sample_tally" {
			t.Fatalf("installed manifest = %+v (%v)", items, err)
		}
		// Configuration left behind without an installation — a restore, a
		// downgrade, or a manual edit — must not reach a Player.
		if _, err = env.pool.Exec(env.ctx, `DELETE FROM plugin_installations WHERE plugin_id='sample_tally'`); err != nil {
			t.Fatal(err)
		}
		if items, err = service.ManifestForScreen(env.ctx, env.screenID); err != nil || len(items) != 0 {
			t.Fatalf("uninstalled manifest = %+v (%v), want no plugins", items, err)
		}
		entry, err := service.CatalogItem(env.ctx, sampleplugin.ID)
		if err != nil || entry.Installed || len(entry.Attention) != 1 || entry.Attention[0].Code != "data_without_installation" {
			t.Fatalf("orphaned sample entry = %+v (%v)", entry, err)
		}
	})
}

func TestUnknownInstallationsArePreservedAndInert(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, err := env.pool.Exec(env.ctx, `INSERT INTO plugin_installations(organization_id,plugin_id) VALUES($1,'some_future_plugin')`, env.orgID); err != nil {
			t.Fatal(err)
		}
		catalog, err := env.service.Catalog(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(catalog.UnsupportedInstallations) != 1 || catalog.UnsupportedInstallations[0].PluginID != "some_future_plugin" {
			t.Fatalf("unsupported installations = %+v", catalog.UnsupportedInstallations)
		}
		for _, item := range catalog.Items {
			if item.ID == "some_future_plugin" {
				t.Fatal("unknown plugin appeared as a catalog item")
			}
		}
		if installed, err := env.service.IsInstalled(env.ctx, "some_future_plugin"); err != nil || installed {
			t.Fatalf("unknown plugin reported installed=%v err=%v", installed, err)
		}
		if items, err := env.service.ManifestForScreen(env.ctx, env.screenID); err != nil || len(items) != 0 {
			t.Fatalf("unknown plugin projected: %+v (%v)", items, err)
		}
		// An administrator may remove the row explicitly; nothing else goes.
		if err = env.service.Remove(env.ctx, "some_future_plugin", env.userID); err != nil {
			t.Fatal(err)
		}
		if err = env.service.Remove(env.ctx, "some_future_plugin", env.userID); !errors.Is(err, ErrPluginNotFound) {
			t.Fatalf("second removal of unknown plugin err = %v", err)
		}
	})
}

// Brand Bug and Noise Meter were removed. An installation that used them
// keeps its rows and data, nothing runs or projects for them, and the catalog
// says they are retired rather than from a newer release.
func TestRetiredPluginsStayInertWithTheirData(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		exec := func(query string, args ...any) {
			t.Helper()
			if _, err := env.pool.Exec(env.ctx, query, args...); err != nil {
				t.Fatal(err)
			}
		}
		for _, id := range []string{"brand_bug", "noise_meter", "some_future_plugin"} {
			exec(`INSERT INTO plugin_installations(organization_id,plugin_id) VALUES($1,$2)`, env.orgID, id)
		}
		exec(`INSERT INTO brand_bug_instances(id,organization_id,name,corner,text,width_percent,text_size_percent,opacity_percent,
			margin_percent,text_color,background_style,enabled,target_scope,created_by)
			VALUES($1,$2,'Sponsor','top_right','Sponsor',12,3,85,3,'#FFFFFF','scrim',TRUE,'all',$3)`, uuid.New(), env.orgID, env.userID)
		exec(`INSERT INTO noise_meter_instances(id,organization_id,name,warning_level,loud_level,sensitivity,trigger_hold_ms,
			clear_hold_ms,display_mode,height_px,enabled,target_scope,created_by)
			VALUES($1,$2,'Cafeteria',60,80,100,1000,3000,'overlay',96,TRUE,'all',$3)`, uuid.New(), env.orgID, env.userID)

		catalog, err := env.service.Catalog(env.ctx)
		if err != nil {
			t.Fatal(err)
		}
		retired := map[string]bool{}
		for _, item := range catalog.UnsupportedInstallations {
			retired[item.PluginID] = item.Retired
		}
		if len(retired) != 3 || !retired["brand_bug"] || !retired["noise_meter"] || retired["some_future_plugin"] {
			t.Fatalf("unsupported installations = %+v", catalog.UnsupportedInstallations)
		}
		for _, item := range catalog.Items {
			if item.ID == "brand_bug" || item.ID == "noise_meter" {
				t.Fatalf("retired plugin %s is offered in the catalog", item.ID)
			}
		}
		if items, err := env.service.ManifestForScreen(env.ctx, env.screenID); err != nil || len(items) != 0 {
			t.Fatalf("retired plugin projected: %+v (%v)", items, err)
		}
		// The row can be removed; the plugin's data stays.
		if err = env.service.Remove(env.ctx, "brand_bug", env.userID); err != nil {
			t.Fatal(err)
		}
		var marks int
		if err = env.pool.QueryRow(env.ctx, `SELECT count(*) FROM brand_bug_instances`).Scan(&marks); err != nil || marks != 1 {
			t.Fatalf("brand bug data after removal = %d (%v)", marks, err)
		}
	})
}
