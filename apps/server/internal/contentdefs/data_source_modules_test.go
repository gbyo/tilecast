package contentdefs

import (
	"encoding/json"
	"strings"
	"testing"

	datasources "github.com/tilecast/tilecast/data-sources"
)

// sourceModuleJSON is a synthetic declarative Data Source module: a
// manual_records definition with a hyphenated directory owned by an
// underscored plugin id, the way plugins/emergency-alerts/ is owned by
// emergency_alerts.
func sourceModuleJSON(id string) []byte {
	raw := `{
		"apiVersion": 1,
		"id": "` + id + `",
		"version": 1,
		"name": "Intake",
		"description": "Collect intake rows.",
		"category": "Essentials",
		"icon": "layout",
		"configurationSchema": {"fields": []},
		"defaultConfiguration": {},
		"outputSchema": {
			"kind": "records",
			"fields": [{"key": "title", "label": "Title", "type": "text"}]
		},
		"adapterId": "manual_records",
		"refreshBehavior": "manual"
	}`
	return []byte(raw)
}

func mustDecodeSourceModule(t *testing.T, dir string, raw []byte, source ExtensionSource) DataSourceDefinition {
	t.Helper()
	definition, err := decodeDataSourceModule(dir, raw, source)
	if err != nil {
		t.Fatalf("%s: %v", dir, err)
	}
	return definition
}

func TestDecodeDataSourceModule(t *testing.T) {
	definition := mustDecodeSourceModule(t,
		"plugins/emergency-alerts/data-sources/intake",
		sourceModuleJSON("emergency_alerts_intake"),
		PluginSource("emergency_alerts"),
	)
	if definition.ID != "emergency_alerts_intake" {
		t.Fatalf("unexpected definition id %q", definition.ID)
	}
	source := definition.Source.Normalized()
	if source.Kind != SourceKindPlugin || source.PluginID != "emergency_alerts" {
		t.Fatalf("unexpected source %+v", definition.Source)
	}
}

func TestDecodeDataSourceModuleRejectsDeclaredSource(t *testing.T) {
	var raw map[string]any
	if err := json.Unmarshal(sourceModuleJSON("intake"), &raw); err != nil {
		t.Fatal(err)
	}
	raw["source"] = map[string]any{"kind": "core"}
	lying, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeDataSourceModule("data-sources/intake", lying, CoreSource()); err == nil ||
		!strings.Contains(err.Error(), "must not declare its own source") {
		t.Fatalf("manifest declaring its own source accepted: %v", err)
	}
}

func TestPluginDataSourceProviders(t *testing.T) {
	core := mustDecodeSourceModule(t, "data-sources/intake", sourceModuleJSON("intake"), CoreSource())
	plugin := mustDecodeSourceModule(t,
		"plugins/emergency-alerts/data-sources/intake",
		sourceModuleJSON("emergency_alerts_intake"),
		PluginSource("emergency_alerts"),
	)
	other := mustDecodeSourceModule(t,
		"plugins/countdown-bar/data-sources/splits",
		sourceModuleJSON("countdown_bar_splits"),
		PluginSource("countdown_bar"),
	)
	catalog, err := New(nil, []DataSourceDefinition{other, core, plugin})
	if err != nil {
		t.Fatalf("catalog rejected: %v", err)
	}
	if providers := catalog.PluginDataSourceProviders("emergency_alerts"); len(providers) != 1 || providers[0] != "emergency_alerts_intake" {
		t.Fatalf("unexpected emergency_alerts providers %v", providers)
	}
	if providers := catalog.PluginDataSourceProviders("unknown"); len(providers) != 0 {
		t.Fatalf("unexpected unknown providers %v", providers)
	}
	contributors := catalog.StaticDataSourceContributors()
	if len(contributors) != 2 || contributors[0] != "countdown_bar" || contributors[1] != "emergency_alerts" {
		t.Fatalf("unexpected contributors %v", contributors)
	}
}

func TestDataSourceModuleCollisionIsFatal(t *testing.T) {
	first := mustDecodeSourceModule(t, "data-sources/intake", sourceModuleJSON("intake"), CoreSource())
	second := mustDecodeSourceModule(t,
		"plugins/emergency-alerts/data-sources/intake",
		sourceModuleJSON("intake"),
		PluginSource("emergency_alerts"),
	)
	if _, err := New(nil, []DataSourceDefinition{first, second}); err == nil ||
		!strings.Contains(err.Error(), "duplicate Data Source definition id") {
		t.Fatalf("cross-source collision accepted: %v", err)
	}
}

func TestDataSourceModulesJoinTheCatalog(t *testing.T) {
	core, err := datasources.Manifests()
	if err != nil {
		t.Fatal(err)
	}
	if len(core) == 0 {
		t.Fatal("no root Data Source manifests embedded")
	}
	ledger := datasources.PluginSourceManifests()
	catalog := MustLoad()
	// Every root manifest joins the catalog as a core definition: this
	// proves loadDataSourceModules consumes the embedded manifests.
	for _, manifest := range core {
		id := manifestID(string(manifest.JSON))
		definition, ok := catalog.DataSource(id)
		if !ok {
			t.Fatalf("root Data Source %s is not in the catalog", manifest.Dir)
		}
		if source := definition.Source.Normalized(); source.Kind != SourceKindCore {
			t.Fatalf("root Data Source %s has source %+v", manifest.Dir, definition.Source)
		}
	}
	// Every ledger entry joins the catalog with its owning plugin's
	// stable tilecast.plugin.json id. The loop is vacuous until a plugin
	// bundles a Data Source, and load-bearing from that release on.
	for _, entry := range ledger {
		definition, ok := catalog.DataSource(manifestID(entry.JSON))
		if !ok {
			t.Fatalf("ledger Data Source %s is not in the catalog", entry.Dir)
		}
		source := definition.Source.Normalized()
		if source.Kind != SourceKindPlugin || source.PluginID != entry.PluginID {
			t.Fatalf("ledger Data Source %s has source %+v", entry.Dir, definition.Source)
		}
	}
	// The migrated announcements module keeps its release identity and
	// adapter: moving the format must never change the product.
	definition, ok := catalog.DataSource("announcements")
	if !ok {
		t.Fatal("migrated announcements module is not in the catalog")
	}
	if definition.AdapterID != "manual_records" {
		t.Fatalf("announcements adapter is %q", definition.AdapterID)
	}
	if definition.Version != 1 || definition.Name != "Announcements" {
		t.Fatalf("announcements identity changed: %+v", definition)
	}
	found := false
	for _, field := range definition.ConfigurationSchema.Fields {
		if field.Key == "records" {
			found = true
		}
	}
	if !found {
		t.Fatal("announcements lost its records configuration field")
	}
}
