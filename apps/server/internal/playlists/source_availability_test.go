package playlists

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// pluginWidgetCatalog builds a synthetic catalog with one core Widget and
// one Widget owned by the stable emergency_alerts identity.
func pluginWidgetCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	widget := func(id, sourcePlugin, componentType, tag string) contentdefs.WidgetDefinition {
		definition := contentdefs.WidgetDefinition{
			ID: id, Version: 1, APIVersion: 1,
			Name: "Probe", Description: "Probe.", Category: "Essentials", Icon: "layout",
			Runtime: "native",
			ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
				{Key: "title", Label: "Title", Control: "text", MaxLength: 80, Default: "Probe"},
			}},
			DefaultConfiguration:      map[string]any{"title": "Probe"},
			PresentationSchemaVersion: 1,
			RequiredCapabilities:      map[string]int{"content.text": 1},
			EmptyStateBehavior:        "text",
			Compatibility:             &contentdefs.Compatibility{Fallback: "none"},
			Component: &contentdefs.ComponentSpec{
				Type: componentType, Version: 1, TagName: tag,
				Entrypoint:     "./runtime/index.ts",
				ConfigTemplate: json.RawMessage(`{"title":{"$config":"title","default":""}}`),
				Empty:          "render",
			},
		}
		if sourcePlugin != "" {
			definition.Source = contentdefs.PluginSource(sourcePlugin)
		}
		return definition
	}
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{
		widget("probe-core", "", "probecore.widget", "tc-widget-probecore-widget"),
		widget("emergency_alerts_siren", "emergency_alerts", "emergencyalerts.siren", "tc-widget-emergencyalerts-siren"),
	}, nil)
	if err != nil {
		t.Fatalf("build plugin Widget catalog: %v", err)
	}
	return catalog
}

func TestRequireWidgetSourceUsable(t *testing.T) {
	service := NewService(nil, nil)
	service.SetContentDefinitions(pluginWidgetCatalog(t))

	// Core providers and unknown IDs pass through: unknown IDs fail
	// later with the existing unsupported-provider error.
	if err := service.requireWidgetSourceUsable(map[string]bool{}, "Core", "probe-core"); err != nil {
		t.Fatalf("core provider refused: %v", err)
	}
	if err := service.requireWidgetSourceUsable(map[string]bool{}, "Mystery", "no-such-provider"); err != nil {
		t.Fatalf("unknown provider refused: %v", err)
	}
	// A plugin-owned provider is usable while its plugin is installed.
	installed := map[string]bool{"emergency_alerts": true}
	if err := service.requireWidgetSourceUsable(installed, "Siren", "emergency_alerts_siren"); err != nil {
		t.Fatalf("installed plugin provider refused: %v", err)
	}
	// Without the installation the Widget is refused, naming the plugin
	// the way Studio shows it rather than an internal ID.
	err := service.requireWidgetSourceUsable(map[string]bool{}, "Siren", "emergency_alerts_siren")
	if err == nil {
		t.Fatal("missing-plugin provider usable")
	}
	if !strings.Contains(err.Error(), "Emergency Alerts") || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("unhelpful refusal: %v", err)
	}
}

// pluginDataSourceCatalog builds a synthetic catalog with one core Data
// Source and one owned by the stable emergency_alerts identity.
func pluginDataSourceCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	source := func(id, sourcePlugin string) contentdefs.DataSourceDefinition {
		definition := contentdefs.DataSourceDefinition{
			ID: id, Version: 1,
			Name: "Probe", Description: "Probe.", Category: "Essentials", Icon: "layout",
			ConfigurationSchema:  contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{}},
			DefaultConfiguration: map[string]any{},
			OutputSchema: contentdefs.OutputSchema{Kind: "records", Fields: []contentdefs.OutputField{
				{Key: "title", Label: "Title", Type: "text"},
			}},
			AdapterID:       "manual_records",
			RefreshBehavior: "manual",
		}
		if sourcePlugin != "" {
			definition.Source = contentdefs.PluginSource(sourcePlugin)
		}
		return definition
	}
	catalog, err := contentdefs.New(nil, []contentdefs.DataSourceDefinition{
		source("probe-core", ""),
		source("emergency_alerts_intake", "emergency_alerts"),
	})
	if err != nil {
		t.Fatalf("build plugin Data Source catalog: %v", err)
	}
	return catalog
}

func TestRequireDataSourceSourceUsable(t *testing.T) {
	service := NewService(nil, nil)
	service.SetContentDefinitions(pluginDataSourceCatalog(t))

	// Core providers and unknown IDs pass through: unknown IDs fail
	// later with the existing unavailable-source error.
	if err := service.requireDataSourceSourceUsable(map[string]bool{}, "Core", "probe-core"); err != nil {
		t.Fatalf("core provider refused: %v", err)
	}
	if err := service.requireDataSourceSourceUsable(map[string]bool{}, "Mystery", "no-such-provider"); err != nil {
		t.Fatalf("unknown provider refused: %v", err)
	}
	// A plugin-owned provider is usable while its plugin is installed.
	installed := map[string]bool{"emergency_alerts": true}
	if err := service.requireDataSourceSourceUsable(installed, "Intake", "emergency_alerts_intake"); err != nil {
		t.Fatalf("installed plugin provider refused: %v", err)
	}
	// Without the installation the Data Source is refused, naming the
	// plugin the way Studio shows it rather than an internal ID.
	err := service.requireDataSourceSourceUsable(map[string]bool{}, "Intake", "emergency_alerts_intake")
	if err == nil {
		t.Fatal("missing-plugin provider usable")
	}
	if !strings.Contains(err.Error(), "Emergency Alerts") || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("unhelpful refusal: %v", err)
	}
}
