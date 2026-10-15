package playlists

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/externalplugins"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// The plugins array carries three independent contracts. Each entry decodes
// back into exactly the contract it was encoded from.
func TestManifestPluginEntryRoundTripsEveryContract(t *testing.T) {
	entries := []ManifestPluginEntry{
		{Builtin: &plugins.ManifestPlugin{ID: uuid.New(), Type: "countdown_bar", Version: 1, Config: map[string]any{}}},
		{State: &plugins.PlayerStateEntry{ID: uuid.New(), Type: "plugin_state", Version: 1, Plugin: "sample_beacon",
			DefinitionVersion: 1, StateType: "sample_beacon", StateVersion: 1, State: json.RawMessage(`{"label":"Lobby"}`)}},
		{External: &externalplugins.Entry{ID: "acme.surface.corner", Type: "external_plugin", Version: 1}},
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	var decoded []ManifestPluginEntry
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded[0].Builtin == nil || decoded[1].State == nil || decoded[2].External == nil ||
		decoded[1].Builtin != nil || decoded[1].External != nil {
		t.Fatalf("contracts were mixed up: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"stateType":"sample_beacon"`) || !strings.Contains(string(encoded), `"media":null`) && !strings.Contains(string(encoded), `"media":[]`) {
		t.Fatalf("state entry wire shape: %s", encoded)
	}
}

func TestManifestPluginEntryRefusesAmbiguousOrReservedEntries(t *testing.T) {
	for name, entry := range map[string]ManifestPluginEntry{
		"empty":            {},
		"two contracts":    {Builtin: &plugins.ManifestPlugin{Type: "countdown_bar"}, State: &plugins.PlayerStateEntry{Type: "plugin_state"}},
		"v1 reserved type": {Builtin: &plugins.ManifestPlugin{Type: "plugin_state"}},
		"v2 wrong type":    {State: &plugins.PlayerStateEntry{Type: "countdown_bar"}},
	} {
		if _, err := json.Marshal(entry); err == nil {
			t.Errorf("%s: encoded", name)
		}
	}
}

// The shared cross-player fixture decodes as v2 state and encodes back to
// the same wire entry, so the Server and every Player agree on one shape.
func TestPlayerStateFixtureRoundTrips(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "manifest-schema", "plugin-state-entry-fixture.json"))
	if err != nil {
		t.Fatal(err)
	}
	var entry ManifestPluginEntry
	if err := json.Unmarshal(raw, &entry); err != nil || entry.State == nil {
		t.Fatalf("fixture is not v2 state: %v %+v", err, entry)
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	var wantValue, gotValue any
	if err := json.Unmarshal(raw, &wantValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &gotValue); err != nil {
		t.Fatal(err)
	}
	wantJSON, _ := json.Marshal(wantValue)
	gotJSON, _ := json.Marshal(gotValue)
	if string(wantJSON) != string(gotJSON) {
		t.Fatalf("round trip changed the entry:\n%s\n%s", wantJSON, gotJSON)
	}
}
