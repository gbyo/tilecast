package contentdefs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWidgetModulesJoinTheCatalog(t *testing.T) {
	catalog := MustLoad()
	clock, ok := catalog.Widget("clock")
	if !ok || clock.Component == nil {
		t.Fatal("the Clock module is not in the catalog")
	}
	if clock.Component.Capability() != "widget.tilecast.clock" || clock.Component.Version != 1 {
		t.Fatalf("unexpected Clock component: %+v", clock.Component)
	}
	if !clock.LegacyEditor || !clock.HasFallback() || clock.Compatibility.Fallback != "legacy" {
		t.Fatalf("Clock must keep its legacy compatibility presentation: %+v", clock.Compatibility)
	}
	count := 0
	for _, definition := range catalog.Widgets {
		if definition.ID == "clock" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("clock is defined %d times; a module must replace, not duplicate, its catalog entry", count)
	}
}

func componentDefinition(mutate func(*WidgetDefinition)) WidgetDefinition {
	definition := WidgetDefinition{
		ID: "probe", Version: 1, APIVersion: 1, Name: "Probe", Category: "Essentials", Runtime: "native",
		ConfigurationSchema:       ConfigurationSchema{Fields: []FieldDefinition{}},
		DefaultConfiguration:      map[string]any{},
		PresentationSchemaVersion: 1,
		RequiredCapabilities:      map[string]int{"content.text": 1},
		EmptyStateBehavior:        "text",
		LegacyEditor:              true,
		Component: &ComponentSpec{
			Type: "tilecast.probe", Version: 1, TagName: "tc-widget-probe",
			Entrypoint: "./runtime/index.ts", Empty: "render",
			ConfigTemplate: json.RawMessage(`{"zone":{"$config":"timezone","default":""}}`),
		},
		Compatibility: &Compatibility{Fallback: "legacy"},
	}
	if mutate != nil {
		mutate(&definition)
	}
	return definition
}

func TestComponentValidation(t *testing.T) {
	if _, err := New([]WidgetDefinition{componentDefinition(nil)}, nil); err != nil {
		t.Fatalf("valid component rejected: %v", err)
	}
	boundaryType := strings.Repeat("a", 25) + "." + strings.Repeat("b", 47)
	if len("widget."+boundaryType) != 80 {
		t.Fatalf("test component capability has length %d, want 80", len("widget."+boundaryType))
	}
	if _, err := New([]WidgetDefinition{componentDefinition(func(d *WidgetDefinition) {
		d.Component.Type = boundaryType
		d.Component.TagName = "acme-boundary"
	})}, nil); err != nil {
		t.Fatalf("80-character component capability rejected: %v", err)
	}
	if _, err := New([]WidgetDefinition{componentDefinition(func(d *WidgetDefinition) {
		d.Component.Type = "gbyo.athletics.scoreboard"
		d.Component.TagName = "acme-scoreboard"
	})}, nil); err != nil {
		t.Fatalf("multi-segment component type rejected: %v", err)
	}
	cases := map[string]func(*WidgetDefinition){
		"unnamespaced type": func(d *WidgetDefinition) { d.Component.Type = "probe" },
		"version zero":      func(d *WidgetDefinition) { d.Component.Version = 0 },
		"type too long": func(d *WidgetDefinition) {
			d.Component.Type = strings.Repeat("a", 25) + "." + strings.Repeat("b", 48)
			d.Component.TagName = "acme-long"
		},
		"missing apiVersion":  func(d *WidgetDefinition) { d.APIVersion = 0 },
		"version above 100":   func(d *WidgetDefinition) { d.Component.Version = 101 },
		"wrong tilecast tag":  func(d *WidgetDefinition) { d.Component.TagName = "tc-widget-other" },
		"invalid tag":         func(d *WidgetDefinition) { d.Component.TagName = "Probe" },
		"other entrypoint":    func(d *WidgetDefinition) { d.Component.Entrypoint = "../evil.ts" },
		"unknown empty":       func(d *WidgetDefinition) { d.Component.Empty = "hide" },
		"template not object": func(d *WidgetDefinition) { d.Component.ConfigTemplate = json.RawMessage(`[]`) },
		"template directive": func(d *WidgetDefinition) {
			d.Component.ConfigTemplate = json.RawMessage(`{"a":{"$ifConfig":"x"}}`)
		},
		"reference extra key": func(d *WidgetDefinition) {
			d.Component.ConfigTemplate = json.RawMessage(`{"a":{"$config":"x","suffix":"!"}}`)
		},
		"legacy without editor": func(d *WidgetDefinition) { d.LegacyEditor = false; d.PresentationTemplate = nil },
		"template without template": func(d *WidgetDefinition) {
			d.Compatibility.Fallback = "template"
		},
		"missing compatibility": func(d *WidgetDefinition) { d.Compatibility = nil },
		"compatibility alone":   func(d *WidgetDefinition) { d.Component = nil },
		"data source not a control": func(d *WidgetDefinition) {
			d.LegacyEditor = false
			d.Compatibility.Fallback = "none"
			d.ConfigurationSchema.Fields = []FieldDefinition{{Key: "title", Label: "Title", Control: "text"}}
			d.Component.DataSourceFields = []string{"title"}
		},
	}
	for name, mutate := range cases {
		if _, err := New([]WidgetDefinition{componentDefinition(mutate)}, nil); err == nil {
			t.Errorf("%s: invalid component accepted", name)
		}
	}
	// The same component type at another version is a collision, not a
	// compatibility alias; aliases name the same version, element and
	// entrypoint (TestComponentAliasValidation).
	duplicate := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "probe-two"
		d.Component.Version = 2
	})
	if _, err := New([]WidgetDefinition{componentDefinition(nil), duplicate}, nil); err == nil || !strings.Contains(err.Error(), "tilecast.probe") {
		t.Fatalf("duplicate component type accepted: %v", err)
	}
	duplicateTag := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "probe-tag"
		d.Component.Type = "acme.other"
	})
	if _, err := New([]WidgetDefinition{componentDefinition(nil), duplicateTag}, nil); err == nil || !strings.Contains(err.Error(), "tc-widget-probe") {
		t.Fatalf("duplicate component tag accepted: %v", err)
	}
}

func TestSourcedWidgetValidation(t *testing.T) {
	pluginTilecast := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "plugin-clock"
		d.Source = ExtensionSource{Kind: SourceKindPlugin, PluginID: "athletics"}
	})
	if _, err := New([]WidgetDefinition{pluginTilecast}, nil); err == nil {
		t.Fatal("plugin source with a tilecast component type accepted")
	}
	outsidePackage := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "outside"
		d.Component.Type = "other.scoreboard"
		d.Component.TagName = "acme-scoreboard"
		d.Source = ExtensionSource{Kind: SourceKindPackage, PackageID: "district96.athletics", PackageVersion: "2.1.0", Digest: "sha256:abc"}
	})
	if _, err := New([]WidgetDefinition{outsidePackage}, nil); err == nil {
		t.Fatal("package contribution outside its namespace accepted")
	}
	insidePackage := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "inside"
		d.Component.Type = "district96.athletics.scoreboard"
		d.Component.TagName = "acme-scoreboard"
		d.Source = ExtensionSource{Kind: SourceKindPackage, PackageID: "district96.athletics", PackageVersion: "2.1.0", Digest: "sha256:abc"}
	})
	if _, err := New([]WidgetDefinition{insidePackage}, nil); err != nil {
		t.Fatalf("package contribution inside its namespace rejected: %v", err)
	}
	badSource := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "bad-source"
		d.Source = ExtensionSource{Kind: "marketplace"}
	})
	if _, err := New([]WidgetDefinition{badSource}, nil); err == nil {
		t.Fatal("unknown source kind accepted")
	}
}

func TestComponentAliasValidation(t *testing.T) {
	// A superseded provider generation may project into the component owned
	// by the canonical definition when it names the same version, element
	// and entrypoint, translating its own persisted keys instead.
	legacy := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "legacy-qr"
		d.Component.Type = "tilecast.qr-code"
		d.Component.Version = 1
		d.Component.TagName = "tc-widget-qr-code"
	})
	canonical := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "qr-code"
		d.Component.Type = "tilecast.qr-code"
		d.Component.Version = 1
		d.Component.TagName = "tc-widget-qr-code"
	})
	if _, err := New([]WidgetDefinition{canonical, legacy}, nil); err != nil {
		t.Fatalf("compatibility alias rejected: %v", err)
	}
	// The same type at another version is a different component, not an
	// alias.
	diverged := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "diverged"
		d.Component.Type = "tilecast.qr-code"
		d.Component.Version = 2
		d.Component.TagName = "tc-widget-qr-code"
	})
	if _, err := New([]WidgetDefinition{canonical, diverged}, nil); err == nil {
		t.Fatal("diverged component version accepted as an alias")
	}
	// The same element rendering another type collides rather than aliases.
	retagged := componentDefinition(func(d *WidgetDefinition) {
		d.ID = "retagged"
		d.Component.Type = "acme.other"
		d.Component.TagName = "tc-widget-probe"
	})
	if _, err := New([]WidgetDefinition{componentDefinition(nil), retagged}, nil); err == nil {
		t.Fatal("shared element tag accepted for another component type")
	}
}

func TestCompileComponentConfigBounds(t *testing.T) {
	spec := *componentDefinition(nil).Component
	config, err := CompileComponentConfig(spec, map[string]any{})
	if err != nil || config["zone"] != "" {
		t.Fatalf("default not applied: %v %v", config, err)
	}
	spec.ConfigTemplate = json.RawMessage(`{"zone":{"$config":"timezone"}}`)
	if _, err := CompileComponentConfig(spec, map[string]any{}); err == nil {
		t.Fatal("a missing key without a default compiled")
	}
	// A default may reference superseded configuration keys, so a
	// compatibility definition prefers its current keys and still honors
	// the legacy keys it replaces.
	spec.ConfigTemplate = json.RawMessage(`{"payload":{"$config":"payload","default":{"$config":"value","default":""}}}`)
	config, err = CompileComponentConfig(spec, map[string]any{"value": "https://example.org"})
	if err != nil || config["payload"] != "https://example.org" {
		t.Fatalf("chained default did not resolve the legacy key: %v %v", config, err)
	}
	config, err = CompileComponentConfig(spec, map[string]any{"payload": "https://example.com", "value": "https://example.org"})
	if err != nil || config["payload"] != "https://example.com" {
		t.Fatalf("the current key did not win over the legacy key: %v %v", config, err)
	}
	config, err = CompileComponentConfig(spec, map[string]any{})
	if err != nil || config["payload"] != "" {
		t.Fatalf("an empty chained default did not resolve: %v %v", config, err)
	}
	spec.ConfigTemplate = json.RawMessage(`{"zone":{"$config":"timezone"}}`)
	oversized := map[string]any{"timezone": strings.Repeat("x", 2001)}
	if _, err := CompileComponentConfig(spec, oversized); err == nil {
		t.Fatal("an oversized string compiled")
	}
	huge := map[string]any{"timezone": strings.Repeat("y", 1900)}
	spec.ConfigTemplate = json.RawMessage(`{"a":{"$config":"timezone"},"b":{"$config":"timezone"},"c":{"$config":"timezone"},"d":{"$config":"timezone"},"e":{"$config":"timezone"}}`)
	if _, err := CompileComponentConfig(spec, huge); err == nil {
		t.Fatal("configuration above 8 KiB compiled")
	}
}

// TestWidgetFixturesCompileInGo keeps the Go compiler in step with the
// TypeScript one (packages/widget-sdk): every fixture's persisted
// configuration compiles within bounds, and the Clock defaults resolve as the
// Widget tests expect.
func TestWidgetFixturesCompileInGo(t *testing.T) {
	catalog := MustLoad()
	paths, err := filepath.Glob("../../../../widgets/*/fixtures/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no Widget fixtures found: %v", err)
	}
	for _, path := range paths {
		dir := filepath.Base(filepath.Dir(filepath.Dir(path)))
		manifest, err := os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(path)), "tilecast.widget.json"))
		if err != nil {
			t.Fatal(err)
		}
		var identity struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(manifest, &identity); err != nil {
			t.Fatal(err)
		}
		definition, ok := catalog.Widget(identity.ID)
		if !ok || definition.Component == nil {
			t.Fatalf("widgets/%s is not a catalog component", dir)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var fixture struct {
			Configuration map[string]any `json:"configuration"`
		}
		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if _, err := CompileComponentConfig(*definition.Component, fixture.Configuration); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	clock, _ := catalog.Widget("clock")
	config, err := CompileComponentConfig(*clock.Component, map[string]any{"timezone": "", "format": "locale", "showSeconds": false, "foregroundColor": "#F5F7FA", "backgroundColor": "#0E141B"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(config)
	want := `{"background":"#0E141B","foreground":"#F5F7FA","format":"locale","showDate":false,"showSeconds":false,"style":"standard","timeZone":""}`
	if string(encoded) != want {
		t.Fatalf("Clock default compiled to %s, want %s", encoded, want)
	}
}
