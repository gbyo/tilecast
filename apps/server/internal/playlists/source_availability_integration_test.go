package playlists

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// TestPluginWidgetProjectionFollowsInstallation proves the same
// authoritative availability decision reaches assignment validation and
// manifest projection: a preserved plugin-owned Widget compiles while its
// plugin is installed, is refused once the installation is gone, and
// compiles again after a reinstall. Persisted rows are never deleted.
func TestPluginWidgetProjectionFollowsInstallation(t *testing.T) {
	fixture := setupCapabilityFixture(t)
	catalog := pluginWidgetCatalog(t)
	fixture.media.SetContentDefinitions(catalog)
	fixture.service.SetContentDefinitions(catalog)
	pluginService := plugins.NewService(fixture.pool, nil)
	fixture.media.SetPluginSourceGate(pluginService)
	if _, _, err := pluginService.Install(fixture.ctx, "emergency_alerts", fixture.user); err != nil {
		t.Fatal(err)
	}

	raw, _ := json.Marshal(map[string]any{"title": "Siren test"})
	widget, err := fixture.media.CreateWidget(fixture.ctx, fixture.user, media.WidgetInput{
		Provider: "emergency_alerts_siren", Name: "Siren", Configuration: raw,
	})
	if err != nil {
		t.Fatalf("create plugin-owned Widget: %v", err)
	}
	playlist, err := fixture.service.Create(fixture.ctx, fixture.user, "Lobby", "", "static")
	if err != nil {
		t.Fatalf("create playlist: %v", err)
	}
	duration := int64(30_000)
	if _, err := fixture.service.AddItem(fixture.ctx, playlist.ID, fixture.user, ItemInput{AssetID: widget.ID, DurationMS: &duration, DeliveryPolicy: "stream"}); err != nil {
		t.Fatalf("add Widget to playlist: %v", err)
	}
	publishDraftForTest(t, fixture.ctx, fixture.service, playlist.ID, fixture.user)
	fixture.reportCapabilities(t, "{1,2}", map[string]int{"widget.emergencyalerts.siren": 1})
	if _, err := fixture.pool.Exec(fixture.ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by) VALUES($1,$2,$3,$4)`,
		uuid.New(), fixture.screen, playlist.ID, fixture.user); err != nil {
		t.Fatalf("assign playlist: %v", err)
	}

	requirements, _, err := fixture.service.presentationRequirements(fixture.ctx, fixture.pool, &playlist.ID, nil)
	if err != nil {
		t.Fatalf("requirements while installed: %v", err)
	}
	if len(requirements) != 1 {
		t.Fatalf("requirements = %d, want the preserved Widget", len(requirements))
	}
	if _, _, err := fixture.service.BuildManifest(fixture.ctx, fixture.screen); err != nil {
		t.Fatalf("manifest while installed: %v", err)
	}

	if _, err := fixture.pool.Exec(fixture.ctx, `DELETE FROM plugin_installations WHERE plugin_id='emergency_alerts'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.service.presentationRequirements(fixture.ctx, fixture.pool, &playlist.ID, nil); !errors.Is(err, ErrConflict) ||
		!strings.Contains(err.Error(), "Emergency Alerts") {
		t.Fatalf("requirements without installation err = %v", err)
	}
	if _, _, err := fixture.service.BuildManifest(fixture.ctx, fixture.screen); !errors.Is(err, ErrConflict) ||
		!strings.Contains(err.Error(), "Emergency Alerts") {
		t.Fatalf("manifest without installation err = %#v", err)
	}

	if _, _, err := pluginService.Install(fixture.ctx, "emergency_alerts", fixture.user); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.service.BuildManifest(fixture.ctx, fixture.screen); err != nil {
		t.Fatalf("manifest after reinstall: %v", err)
	}
}

// TestPluginDataSourceProjectionFollowsInstallation proves the same
// authoritative availability decision reaches assignment validation and
// manifest projection for Data Sources: a preserved plugin-owned row
// projects while its plugin is installed, is refused as a live source
// once the installation is gone, and projects again after a reinstall.
// Persisted rows are never deleted.
func TestPluginDataSourceProjectionFollowsInstallation(t *testing.T) {
	fixture := setupCapabilityFixture(t)
	catalog := pluginDataSourceCatalog(t)
	fixture.media.SetContentDefinitions(catalog)
	fixture.service.SetContentDefinitions(catalog)
	pluginService := plugins.NewService(fixture.pool, nil)
	fixture.media.SetPluginSourceGate(pluginService)
	if _, _, err := pluginService.Install(fixture.ctx, "emergency_alerts", fixture.user); err != nil {
		t.Fatal(err)
	}

	source, err := fixture.media.CreateDataSource(fixture.ctx, fixture.user, media.DataSourceInput{
		Provider: "emergency_alerts_intake", Name: "Intake", Configuration: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("create plugin-owned Data Source: %v", err)
	}
	layoutID := fixture.createLayoutBoundToSource(t, source.ID)
	playlist, err := fixture.service.Create(fixture.ctx, fixture.user, "Lobby", "", "static")
	if err != nil {
		t.Fatalf("create playlist: %v", err)
	}
	duration := int64(30_000)
	if _, err := fixture.service.AddItem(fixture.ctx, playlist.ID, fixture.user, ItemInput{LayoutID: &layoutID, DurationMS: &duration, DeliveryPolicy: "stream"}); err != nil {
		t.Fatalf("add layout to playlist: %v", err)
	}
	publishDraftForTest(t, fixture.ctx, fixture.service, playlist.ID, fixture.user)
	if _, err := fixture.pool.Exec(fixture.ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by) VALUES($1,$2,$3,$4)`,
		uuid.New(), fixture.screen, playlist.ID, fixture.user); err != nil {
		t.Fatalf("assign playlist: %v", err)
	}

	if _, _, err := fixture.service.presentationRequirements(fixture.ctx, fixture.pool, &playlist.ID, nil); err != nil {
		t.Fatalf("requirements while installed: %v", err)
	}
	manifest, _, err := fixture.service.BuildManifest(fixture.ctx, fixture.screen)
	if err != nil {
		t.Fatalf("manifest while installed: %v", err)
	}
	if len(manifest.DataSources) != 1 || manifest.DataSources[0].Provider != "emergency_alerts_intake" {
		t.Fatalf("manifest sources = %+v, want the preserved Data Source", manifest.DataSources)
	}

	if _, err := fixture.pool.Exec(fixture.ctx, `DELETE FROM plugin_installations WHERE plugin_id='emergency_alerts'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.service.presentationRequirements(fixture.ctx, fixture.pool, &playlist.ID, nil); err == nil ||
		!strings.Contains(err.Error(), "Emergency Alerts") {
		t.Fatalf("requirements without installation err = %v", err)
	}
	if _, _, err := fixture.service.BuildManifest(fixture.ctx, fixture.screen); !errors.Is(err, ErrConflict) ||
		!strings.Contains(err.Error(), "Emergency Alerts") {
		t.Fatalf("manifest without installation err = %#v", err)
	}

	if _, _, err := pluginService.Install(fixture.ctx, "emergency_alerts", fixture.user); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.service.BuildManifest(fixture.ctx, fixture.screen); err != nil {
		t.Fatalf("manifest after reinstall: %v", err)
	}
}
