package widgets

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func TestManifestsEmbedEveryWidget(t *testing.T) {
	manifests, err := Manifests()
	if err != nil {
		t.Fatal(err)
	}
	if len(manifests) == 0 {
		t.Fatal("no Widget manifests embedded")
	}
	for _, manifest := range manifests {
		var decoded struct {
			ID        string `json:"id"`
			Component struct {
				Type string `json:"type"`
			} `json:"component"`
		}
		if err := json.Unmarshal(manifest.JSON, &decoded); err != nil {
			t.Fatalf("%s: %v", manifest.Dir, err)
		}
		if decoded.ID == "" || decoded.Component.Type == "" {
			t.Fatalf("%s: manifest lacks an id or component type", manifest.Dir)
		}
	}
}

var pluginIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)

func TestPluginLedgerIsDeterministic(t *testing.T) {
	manifests := PluginWidgetManifests()
	previous := ""
	for _, manifest := range manifests {
		if manifest.Dir == "" || manifest.JSON == "" {
			t.Fatalf("ledger entry lacks a directory or manifest bytes: %+v", manifest)
		}
		if !strings.HasPrefix(manifest.Dir, "plugins/") || !strings.Contains(manifest.Dir, "/widgets/") {
			t.Fatalf("%s: ledger directory is not a plugin Widget", manifest.Dir)
		}
		if manifest.Dir <= previous {
			t.Fatalf("ledger is not in directory order at %s", manifest.Dir)
		}
		previous = manifest.Dir
		// The stable tilecast.plugin.json id owns the Widget: the
		// directory basename never does, so a hyphenated directory like
		// plugins/emergency-alerts/ keeps its underscored identity.
		if !pluginIDPattern.MatchString(manifest.PluginID) {
			t.Fatalf("%s: ledger plugin id %q is invalid", manifest.Dir, manifest.PluginID)
		}
		var decoded struct {
			ID        string         `json:"id"`
			Source    map[string]any `json:"source"`
			Component struct {
				Type string `json:"type"`
			} `json:"component"`
		}
		if err := json.Unmarshal([]byte(manifest.JSON), &decoded); err != nil {
			t.Fatalf("%s: %v", manifest.Dir, err)
		}
		if decoded.ID == "" || decoded.Component.Type == "" {
			t.Fatalf("%s: manifest lacks an id or component type", manifest.Dir)
		}
		if decoded.Source != nil {
			t.Fatalf("%s: a Widget manifest must not declare its own source", manifest.Dir)
		}
	}
	// The accessor returns a copy: mutating it must not change the ledger.
	if len(manifests) > 0 {
		manifests[0].PluginID = "mutated"
		if again := PluginWidgetManifests(); again[0].PluginID == "mutated" {
			t.Fatal("PluginWidgetManifests shares its table with callers")
		}
	}
}
