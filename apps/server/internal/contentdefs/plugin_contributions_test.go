package contentdefs

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/widgets"
)

// pluginManifestJSON is a synthetic plugin-owned Widget manifest. The
// directory uses hyphens while the owning plugin id uses underscores, the
// way plugins/emergency-alerts/ is owned by emergency_alerts.
func pluginManifestJSON() []byte {
	definition := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "emergency_alerts_siren"
		d.Component.Type = "emergencyalerts.siren"
		d.Component.TagName = "tc-widget-emergencyalerts-siren"
	})
	raw, err := json.Marshal(definition)
	if err != nil {
		panic(err)
	}
	return raw
}

func TestDecodePluginWidgetManifest(t *testing.T) {
	definition, err := decodeWidgetManifest(
		"plugins/emergency-alerts/widgets/siren",
		pluginManifestJSON(),
		PluginSource("emergency_alerts"),
	)
	if err != nil {
		t.Fatalf("plugin manifest rejected: %v", err)
	}
	if definition.ID != "emergency_alerts_siren" {
		t.Fatalf("unexpected definition id %q", definition.ID)
	}
	source := definition.Source.Normalized()
	if source.Kind != SourceKindPlugin || source.PluginID != "emergency_alerts" {
		t.Fatalf("unexpected source %+v", definition.Source)
	}
}

func TestDecodeWidgetManifestRejectsDeclaredSource(t *testing.T) {
	var raw map[string]any
	if err := json.Unmarshal(pluginManifestJSON(), &raw); err != nil {
		t.Fatal(err)
	}
	raw["source"] = map[string]any{"kind": "core"}
	lying, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeWidgetManifest("widgets/siren", lying, CoreSource()); err == nil ||
		!strings.Contains(err.Error(), "must not declare its own source") {
		t.Fatalf("manifest declaring its own source accepted: %v", err)
	}
}

func TestPluginWidgetProviders(t *testing.T) {
	core := componentDefinition(nil)
	plugin := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "emergency_alerts_siren"
		d.Component.Type = "emergencyalerts.siren"
		d.Component.TagName = "tc-widget-emergencyalerts-siren"
		d.Source = PluginSource("emergency_alerts")
	})
	other := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "countdown_bar_race"
		d.Component.Type = "countdownbar.race"
		d.Component.TagName = "tc-widget-countdownbar-race"
		d.Source = PluginSource("countdown_bar")
	})
	catalog, err := New([]WidgetDefinition{other, core, plugin}, nil)
	if err != nil {
		t.Fatalf("catalog rejected: %v", err)
	}
	if providers := catalog.PluginWidgetProviders("emergency_alerts"); len(providers) != 1 || providers[0] != "emergency_alerts_siren" {
		t.Fatalf("unexpected emergency_alerts providers %v", providers)
	}
	if providers := catalog.PluginWidgetProviders("unknown"); len(providers) != 0 {
		t.Fatalf("unexpected unknown providers %v", providers)
	}
	contributors := catalog.StaticWidgetContributors()
	if len(contributors) != 2 || contributors[0] != "countdown_bar" || contributors[1] != "emergency_alerts" {
		t.Fatalf("unexpected contributors %v", contributors)
	}
}

func TestWidgetManifestsJoinTheCatalog(t *testing.T) {
	core, err := widgets.Manifests()
	if err != nil {
		t.Fatal(err)
	}
	if len(core) == 0 {
		t.Fatal("no root Widget manifests embedded")
	}
	ledger := widgets.PluginWidgetManifests()
	catalog := MustLoad()
	// Every root manifest joins the catalog as a core definition: this
	// proves loadWidgetModules consumes the embedded manifests.
	for _, manifest := range core {
		id := manifestID(string(manifest.JSON))
		definition, ok := catalog.Widget(id)
		if !ok {
			t.Fatalf("root Widget %s is not in the catalog", manifest.Dir)
		}
		if source := definition.Source.Normalized(); source.Kind != SourceKindCore {
			t.Fatalf("root Widget %s has source %+v", manifest.Dir, definition.Source)
		}
	}
	// Every ledger entry joins the catalog with its owning plugin's
	// stable tilecast.plugin.json id: this proves plugins Widgets are
	// consumed by the Server catalog, not just Player/Studio tooling.
	// The loop is vacuous until a plugin bundles a Widget, and
	// load-bearing from that release on.
	for _, entry := range ledger {
		definition, ok := catalog.Widget(manifestID(entry.JSON))
		if !ok {
			t.Fatalf("ledger Widget %s is not in the catalog", entry.Dir)
		}
		source := definition.Source.Normalized()
		if source.Kind != SourceKindPlugin || source.PluginID != entry.PluginID {
			t.Fatalf("ledger Widget %s has source %+v", entry.Dir, definition.Source)
		}
	}
}

func manifestID(raw string) string {
	var decoded struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return ""
	}
	return decoded.ID
}
