package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// pluginWidgetCatalog builds a synthetic catalog with one Widget
// definition and one Data Source definition owned by the stable
// emergency_alerts identity.
func pluginWidgetCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	source := contentdefs.DataSourceDefinition{
		ID: "emergency_alerts_intake", Version: 1,
		Source: contentdefs.PluginSource("emergency_alerts"),
		Name:   "Intake", Description: "Intake.", Category: "Essentials", Icon: "layout",
		ConfigurationSchema:  contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{}},
		DefaultConfiguration: map[string]any{},
		OutputSchema: contentdefs.OutputSchema{Kind: "records", Fields: []contentdefs.OutputField{
			{Key: "title", Label: "Title", Type: "text"},
		}},
		AdapterID:       "manual_records",
		RefreshBehavior: "manual",
	}
	definition := contentdefs.WidgetDefinition{
		ID: "emergency_alerts_siren", Version: 1, APIVersion: 1,
		Source: contentdefs.PluginSource("emergency_alerts"),
		Name:   "Siren", Description: "Siren.", Category: "Essentials", Icon: "layout",
		Runtime: "native",
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "title", Label: "Title", Control: "text", MaxLength: 80, Default: "Siren"},
		}},
		DefaultConfiguration:      map[string]any{"title": "Siren"},
		PresentationSchemaVersion: 1,
		RequiredCapabilities:      map[string]int{"content.text": 1},
		EmptyStateBehavior:        "text",
		Compatibility:             &contentdefs.Compatibility{Fallback: "none"},
		Component: &contentdefs.ComponentSpec{
			Type: "emergencyalerts.siren", Version: 1, TagName: "tc-widget-emergencyalerts-siren",
			Entrypoint:     "./runtime/index.ts",
			ConfigTemplate: json.RawMessage(`{"title":{"$config":"title","default":""}}`),
			Empty:          "render",
		},
	}
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{definition}, []contentdefs.DataSourceDefinition{source})
	if err != nil {
		t.Fatalf("build plugin Widget catalog: %v", err)
	}
	return catalog
}

func createIntakeSource(t *testing.T, env staticContributionEnvironment, name string) uuid.UUID {
	t.Helper()
	source, err := env.media.CreateDataSource(env.ctx, env.userID, media.DataSourceInput{
		Provider: "emergency_alerts_intake", Name: name, Configuration: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("create plugin-owned Data Source: %v", err)
	}
	return source.ID
}

func dataSourceRowCount(t *testing.T, env staticContributionEnvironment) int {
	t.Helper()
	var count int
	if err := env.service.db.QueryRow(env.ctx, `SELECT count(*) FROM data_sources WHERE provider='emergency_alerts_intake' AND deleted_at IS NULL`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

type staticContributionEnvironment struct {
	ctx     context.Context
	service *Service
	media   *media.Service
	userID  uuid.UUID
}

func withStaticContributionServices(t *testing.T, run func(staticContributionEnvironment)) {
	t.Helper()
	withInstallationDatabase(t, func(env installationEnvironment) {
		catalog := pluginWidgetCatalog(t)
		env.service.SetContentDefinitions(catalog)
		mediaService := media.NewService(env.pool, nil, media.Config{})
		mediaService.SetContentDefinitions(catalog)
		mediaService.SetPluginSourceGate(env.service)
		run(staticContributionEnvironment{ctx: env.ctx, service: env.service, media: mediaService, userID: env.userID})
	})
}

func createSirenWidget(t *testing.T, env staticContributionEnvironment) uuid.UUID {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"title": "Siren test"})
	asset, err := env.media.CreateWidget(env.ctx, env.userID, media.WidgetInput{
		Provider: "emergency_alerts_siren", Name: "Siren", Description: "Siren.", Configuration: raw,
	})
	if err != nil {
		t.Fatalf("create plugin-owned Widget: %v", err)
	}
	return asset.ID
}

func widgetRowCount(t *testing.T, env staticContributionEnvironment) int {
	t.Helper()
	var count int
	if err := env.service.db.QueryRow(env.ctx, `SELECT count(*) FROM widgets WHERE provider='emergency_alerts_siren'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func installationPresent(t *testing.T, env staticContributionEnvironment) bool {
	t.Helper()
	installed, err := env.service.IsInstalled(env.ctx, "emergency_alerts")
	if err != nil {
		t.Fatal(err)
	}
	return installed
}

func TestStaticWidgetUsageBlocksRemoval(t *testing.T) {
	withStaticContributionServices(t, func(env staticContributionEnvironment) {
		if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatal(err)
		}
		createSirenWidget(t, env)
		err := env.service.Remove(env.ctx, "emergency_alerts", env.userID)
		var inUse *InUseError
		if !errors.As(err, &inUse) {
			t.Fatalf("remove with contributed content err = %#v", err)
		}
		if len(inUse.Resources) != 1 {
			t.Fatalf("resources = %+v, want one generic Widget blocker", inUse.Resources)
		}
		blocker := inUse.Resources[0]
		if blocker.Kind != "widget" || blocker.Count != 1 || blocker.Label != "Widget" || blocker.Resolution != "delete" {
			t.Fatalf("blocker = %+v, want one Widget with delete resolution", blocker)
		}
		// Removal deletes the installation, never the contributed content.
		if widgetRowCount(t, env) != 1 || !installationPresent(t, env) {
			t.Fatal("blocked removal changed rows or the installation")
		}
		// Deleting the Widget through the library clears the blocker.
		var assetID uuid.UUID
		if err := env.service.db.QueryRow(env.ctx, `SELECT asset_id FROM widgets WHERE provider='emergency_alerts_siren'`).Scan(&assetID); err != nil {
			t.Fatalf("find Widget asset: %v", err)
		}
		if err := env.media.DeleteAsset(env.ctx, assetID, env.userID); err != nil {
			t.Fatalf("delete Widget: %v", err)
		}
		if err := env.service.Remove(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatalf("remove after cleanup: %v", err)
		}
		if installationPresent(t, env) {
			t.Fatal("installation remains after remove")
		}
	})
}

func TestMissingPluginContentIsPreservedButUnavailable(t *testing.T) {
	withStaticContributionServices(t, func(env staticContributionEnvironment) {
		// A restored database can hold plugin-owned content without the
		// installation row: the content stays, inert, until the plugin
		// is installed again.
		if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatal(err)
		}
		createSirenWidget(t, env)
		if _, err := env.service.db.Exec(env.ctx, `DELETE FROM plugin_installations WHERE plugin_id='emergency_alerts'`); err != nil {
			t.Fatal(err)
		}
		if widgetRowCount(t, env) != 1 {
			t.Fatal("content deleted with its installation")
		}
		definition, ok := env.service.catalog().Widget("emergency_alerts_siren")
		if !ok {
			t.Fatal("contributed provider left the release catalog")
		}
		if usable, _ := definition.Source.Usable(map[string]bool{}); usable {
			t.Fatal("missing-plugin content reports usable")
		}
		if _, err := env.media.CreateWidget(env.ctx, env.userID, media.WidgetInput{Provider: "emergency_alerts_siren", Name: "Siren 2", Configuration: json.RawMessage(`{"title":"x"}`)}); err == nil {
			t.Fatal("created plugin-owned content while its plugin is missing")
		}
		// Removing a plugin that is not installed is idempotent and keeps rows.
		if err := env.service.Remove(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatalf("remove without installation: %v", err)
		}
		if widgetRowCount(t, env) != 1 {
			t.Fatal("remove deleted preserved content")
		}
		// Installing the known bundled plugin makes it available again.
		if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatal(err)
		}
		if usable, _ := definition.Source.Usable(map[string]bool{"emergency_alerts": true}); !usable {
			t.Fatal("reinstalled content still unavailable")
		}
		createSirenWidget(t, env)
		if widgetRowCount(t, env) != 2 {
			t.Fatal("creation after reinstall failed")
		}
	})
}

func TestInstalledSetTracksLifecycle(t *testing.T) {
	withStaticContributionServices(t, func(env staticContributionEnvironment) {
		set, err := InstalledSet(env.ctx, env.service.db)
		if err != nil {
			t.Fatal(err)
		}
		if len(set) != 0 {
			t.Fatalf("fresh set = %v", set)
		}
		if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatal(err)
		}
		if set, err = InstalledSet(env.ctx, env.service.db); err != nil || !set["emergency_alerts"] {
			t.Fatalf("installed set = %v (%v)", set, err)
		}
		if err := env.service.Remove(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatal(err)
		}
		if set, err = InstalledSet(env.ctx, env.service.db); err != nil || set["emergency_alerts"] {
			t.Fatalf("removed set = %v (%v)", set, err)
		}
	})
}

func TestCreateAndRemoveSerializeThroughTheInstallationRow(t *testing.T) {
	withStaticContributionServices(t, func(env staticContributionEnvironment) {
		// Create Widget and Remove Plugin race freely; exactly one may
		// win, and the installation state must always agree with the
		// committed rows: never an uninstalled plugin with a newly
		// committed Widget caused by the race.
		for round := 0; round < 5; round++ {
			if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			var group sync.WaitGroup
			group.Add(2)
			var createErr, removeErr error
			go func() {
				defer group.Done()
				<-start
				raw, _ := json.Marshal(map[string]any{"title": "Race"})
				_, createErr = env.media.CreateWidget(env.ctx, env.userID, media.WidgetInput{
					Provider: "emergency_alerts_siren", Name: "Race", Configuration: raw,
				})
			}()
			go func() {
				defer group.Done()
				<-start
				removeErr = env.service.Remove(env.ctx, "emergency_alerts", env.userID)
			}()
			close(start)
			group.Wait()
			widgets := widgetRowCount(t, env)
			installed := installationPresent(t, env)
			if widgets > 0 && !installed {
				t.Fatalf("round %d: Widget committed for an uninstalled plugin (create=%v remove=%v)", round, createErr, removeErr)
			}
			// Reset for the next round: delete the Widget if one won, and
			// reinstall when removal won.
			if widgets > 0 {
				if _, err := env.service.db.Exec(env.ctx, `DELETE FROM widgets WHERE provider='emergency_alerts_siren'`); err != nil {
					t.Fatal(err)
				}
				if _, err := env.service.db.Exec(env.ctx, `DELETE FROM assets WHERE type='widget' AND deleted_at IS NULL AND id NOT IN (SELECT asset_id FROM widgets)`); err != nil {
					t.Fatal(err)
				}
			}
			if !installed {
				if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
					t.Fatal(err)
				}
			}
			_ = removeErr
		}
	})
}

func TestStaticDataSourceUsageBlocksRemoval(t *testing.T) {
	withStaticContributionServices(t, func(env staticContributionEnvironment) {
		if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatal(err)
		}
		first := createIntakeSource(t, env, "Intake one")
		second := createIntakeSource(t, env, "Intake two")
		err := env.service.Remove(env.ctx, "emergency_alerts", env.userID)
		var inUse *InUseError
		if !errors.As(err, &inUse) {
			t.Fatalf("remove with contributed content err = %#v", err)
		}
		if len(inUse.Resources) != 1 {
			t.Fatalf("resources = %+v, want one generic Data Source blocker", inUse.Resources)
		}
		blocker := inUse.Resources[0]
		if blocker.Kind != "data_source" || blocker.Count != 2 || blocker.Label != "Data Sources" || blocker.Resolution != "delete" {
			t.Fatalf("blocker = %+v, want two Data Sources with delete resolution", blocker)
		}
		// Removal deletes the installation, never the contributed content.
		if dataSourceRowCount(t, env) != 2 || !installationPresent(t, env) {
			t.Fatal("blocked removal changed rows or the installation")
		}
		// Deleting the Data Sources through the library clears the blocker.
		if err := env.media.DeleteDataSource(env.ctx, first, env.userID); err != nil {
			t.Fatalf("delete Data Source: %v", err)
		}
		if err := env.media.DeleteDataSource(env.ctx, second, env.userID); err != nil {
			t.Fatalf("delete Data Source: %v", err)
		}
		if err := env.service.Remove(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatalf("remove after cleanup: %v", err)
		}
		if installationPresent(t, env) {
			t.Fatal("installation remains after remove")
		}
	})
}

func TestStaticBlockersCombineWidgetAndDataSourceUsage(t *testing.T) {
	withStaticContributionServices(t, func(env staticContributionEnvironment) {
		if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
			t.Fatal(err)
		}
		createSirenWidget(t, env)
		createIntakeSource(t, env, "Intake")
		err := env.service.Remove(env.ctx, "emergency_alerts", env.userID)
		var inUse *InUseError
		if !errors.As(err, &inUse) {
			t.Fatalf("remove with contributed content err = %#v", err)
		}
		// Generic Widget blockers come first, then Data Source blockers,
		// both ahead of any plugin-specific RemovalGuard results.
		if len(inUse.Resources) != 2 {
			t.Fatalf("resources = %+v, want Widget and Data Source blockers", inUse.Resources)
		}
		if inUse.Resources[0].Kind != "widget" || inUse.Resources[1].Kind != "data_source" {
			t.Fatalf("blockers out of order: %+v", inUse.Resources)
		}
	})
}

func TestCreateDataSourceAndRemoveSerializeThroughTheInstallationRow(t *testing.T) {
	withStaticContributionServices(t, func(env staticContributionEnvironment) {
		// Create Data Source and Remove Plugin race freely; exactly one
		// may win, and the installation state must always agree with the
		// committed rows: never an uninstalled plugin with a newly
		// committed Data Source caused by the race.
		for round := 0; round < 5; round++ {
			if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			var group sync.WaitGroup
			group.Add(2)
			var createErr, removeErr error
			go func() {
				defer group.Done()
				<-start
				_, createErr = env.media.CreateDataSource(env.ctx, env.userID, media.DataSourceInput{
					Provider: "emergency_alerts_intake", Name: "Race", Configuration: json.RawMessage(`{}`),
				})
			}()
			go func() {
				defer group.Done()
				<-start
				removeErr = env.service.Remove(env.ctx, "emergency_alerts", env.userID)
			}()
			close(start)
			group.Wait()
			sources := dataSourceRowCount(t, env)
			installed := installationPresent(t, env)
			if sources > 0 && !installed {
				t.Fatalf("round %d: Data Source committed for an uninstalled plugin (create=%v remove=%v)", round, createErr, removeErr)
			}
			// Reset for the next round: delete the Data Source if one
			// won, and reinstall when removal won.
			if sources > 0 {
				if _, err := env.service.db.Exec(env.ctx, `DELETE FROM data_sources WHERE provider='emergency_alerts_intake'`); err != nil {
					t.Fatal(err)
				}
			}
			if !installed {
				if _, _, err := env.service.Install(env.ctx, "emergency_alerts", env.userID); err != nil {
					t.Fatal(err)
				}
			}
			_ = removeErr
		}
	})
}
