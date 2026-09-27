package plugins

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

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

func TestConfigurationRequiresInstallation(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, err := env.service.CreateBrandBug(env.ctx, env.userID, validBrandBug()); !errors.Is(err, ErrPluginNotInstalled) {
			t.Fatalf("brand bug create without installation err = %v", err)
		}
		if _, err := env.service.CreateNoiseMeter(env.ctx, env.userID, validNoiseMeter()); !errors.Is(err, ErrPluginNotInstalled) {
			t.Fatalf("noise meter create without installation err = %v", err)
		}
		var rows int
		if err := env.pool.QueryRow(env.ctx, `SELECT count(*) FROM plugin_installations`).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("configuration implicitly installed a plugin: %d rows (%v)", rows, err)
		}
	})
}

func TestRemoveIsBlockedWhileResourcesRemain(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, _, err := env.service.Install(env.ctx, NoiseMeterID, env.userID); err != nil {
			t.Fatal(err)
		}
		first, err := env.service.CreateNoiseMeter(env.ctx, env.userID, validNoiseMeter())
		if err != nil {
			t.Fatal(err)
		}
		second := validNoiseMeter()
		second.Name = "Library noise"
		second.Enabled = false
		secondMeter, err := env.service.CreateNoiseMeter(env.ctx, env.userID, second)
		if err != nil {
			t.Fatal(err)
		}
		entry := env.catalogEntry(t, NoiseMeterID)
		if !entry.Installed || !entry.Configured || !entry.Active || entry.InstanceCount != 2 {
			t.Fatalf("noise meter status = %+v", entry)
		}
		err = env.service.Remove(env.ctx, NoiseMeterID, env.userID)
		var inUse *InUseError
		if !errors.As(err, &inUse) || len(inUse.Resources) != 1 || inUse.Resources[0].Count != 2 ||
			inUse.Resources[0].Kind != "noise_meter_instance" || inUse.Resources[0].Label != "meters" {
			t.Fatalf("remove with meters err = %#v", err)
		}
		if inUse.Error() != "Noise Meter cannot be removed while 2 meters remain." {
			t.Fatalf("message = %q", inUse.Error())
		}
		for _, id := range []uuid.UUID{first.ID, secondMeter.ID} {
			if err = env.service.DeleteNoiseMeter(env.ctx, id, env.userID); err != nil {
				t.Fatal(err)
			}
		}
		before := env.manifestVersion(t)
		if err = env.service.Remove(env.ctx, NoiseMeterID, env.userID); err != nil {
			t.Fatalf("remove empty plugin: %v", err)
		}
		if env.manifestVersion(t) <= before {
			t.Fatal("remove did not advance the manifest")
		}
		if err = env.service.Remove(env.ctx, NoiseMeterID, env.userID); err != nil {
			t.Fatalf("repeat remove should be idempotent, got %v", err)
		}
		if entry = env.catalogEntry(t, NoiseMeterID); entry.Installed {
			t.Fatal("noise meter still installed after remove")
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
		if _, err = env.pool.Exec(env.ctx, `UPDATE alert_monitor SET enabled=FALSE; DELETE FROM alert_rules`); err != nil {
			t.Fatal(err)
		}
		if err = env.service.Remove(env.ctx, EmergencyAlertsID, env.userID); err != nil {
			t.Fatalf("remove after cleanup: %v", err)
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

func TestNoiseHistoryIgnoredWhenUninstalled(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		if _, _, err := env.service.Install(env.ctx, NoiseMeterID, env.userID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.service.CreateNoiseMeter(env.ctx, env.userID, validNoiseMeter()); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(env.ctx, `DELETE FROM plugin_installations WHERE plugin_id='noise_meter'`); err != nil {
			t.Fatal(err)
		}
		record := NoiseHistoryRecord{StartedAt: time.Now().UTC().Add(-time.Minute).Truncate(10 * time.Second),
			AverageLevel: 40, PeakLevel: 60, MonitoredMS: 10000}
		accepted, err := env.service.RecordNoiseHistory(env.ctx, env.screenID, []NoiseHistoryRecord{record})
		if err != nil || accepted != 1 {
			t.Fatalf("uninstalled history accepted=%d err=%v, want consumed so the Player stops resending", accepted, err)
		}
		var stored int
		if err = env.pool.QueryRow(env.ctx, `SELECT count(*) FROM noise_meter_history`).Scan(&stored); err != nil || stored != 0 {
			t.Fatalf("uninstalled history stored %d rows (%v)", stored, err)
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
