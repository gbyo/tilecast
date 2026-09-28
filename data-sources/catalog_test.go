package datasources

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func TestManifestsEmbedEveryModule(t *testing.T) {
	manifests, err := Manifests()
	if err != nil {
		t.Fatal(err)
	}
	if len(manifests) == 0 {
		t.Fatal("no Data Source manifests embedded")
	}
	for _, manifest := range manifests {
		var decoded struct {
			APIVersion int    `json:"apiVersion"`
			ID         string `json:"id"`
			AdapterID  string `json:"adapterId"`
		}
		if err := json.Unmarshal(manifest.JSON, &decoded); err != nil {
			t.Fatalf("%s: %v", manifest.Dir, err)
		}
		if decoded.APIVersion != 1 {
			t.Fatalf("%s: manifest apiVersion is %d, want 1", manifest.Dir, decoded.APIVersion)
		}
		if decoded.ID == "" || decoded.AdapterID == "" {
			t.Fatalf("%s: manifest lacks an id or adapter id", manifest.Dir)
		}
	}
}

var pluginIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)

func TestPluginLedgerIsDeterministic(t *testing.T) {
	manifests := PluginSourceManifests()
	previous := ""
	for _, manifest := range manifests {
		if manifest.Dir == "" || manifest.JSON == "" {
			t.Fatalf("ledger entry lacks a directory or manifest bytes: %+v", manifest)
		}
		if !strings.HasPrefix(manifest.Dir, "plugins/") || !strings.Contains(manifest.Dir, "/data-sources/") {
			t.Fatalf("%s: ledger directory is not a plugin Data Source", manifest.Dir)
		}
		if manifest.Dir <= previous {
			t.Fatalf("ledger is not in directory order at %s", manifest.Dir)
		}
		previous = manifest.Dir
		// The stable tilecast.plugin.json id owns the module: the
		// directory basename never does, so a hyphenated directory like
		// plugins/emergency-alerts/ keeps its underscored identity.
		if !pluginIDPattern.MatchString(manifest.PluginID) {
			t.Fatalf("%s: ledger plugin id %q is invalid", manifest.Dir, manifest.PluginID)
		}
		var decoded struct {
			APIVersion int            `json:"apiVersion"`
			ID         string         `json:"id"`
			Source     map[string]any `json:"source"`
		}
		if err := json.Unmarshal([]byte(manifest.JSON), &decoded); err != nil {
			t.Fatalf("%s: %v", manifest.Dir, err)
		}
		if decoded.APIVersion != 1 || decoded.ID == "" {
			t.Fatalf("%s: manifest lacks apiVersion 1 or an id", manifest.Dir)
		}
		if decoded.Source != nil {
			t.Fatalf("%s: a Data Source manifest must not declare its own source", manifest.Dir)
		}
	}
	// The accessor returns a copy: mutating it must not change the ledger.
	if len(manifests) > 0 {
		manifests[0].PluginID = "mutated"
		if again := PluginSourceManifests(); again[0].PluginID == "mutated" {
			t.Fatal("PluginSourceManifests shares its table with callers")
		}
	}
}
