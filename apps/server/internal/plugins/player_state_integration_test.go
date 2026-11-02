package plugins

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleplugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/samplev2"
)

// A Plugin API v2 plugin with a Player contribution is hosted beside an
// unchanged v1 plugin. No core code names either one.
func TestHostProjectsPluginAPI2StateBesideVersion1(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		v1 := sampleplugin.New()
		v2 := samplev2.New()
		service := NewService(env.pool, nil, WithPlugins(v1, v2))
		beacon := uuid.New()
		v2.Put(samplev2.Beacon{ID: beacon, Label: "Lobby"})
		reported := map[string]int{"plugin.host": 2, "player.clock": 1}

		states, err := service.PlayerStateForScreen(env.ctx, env.screenID, reported)
		if err != nil || len(states) != 0 {
			t.Fatalf("an uninstalled plugin projected state: %v %v", states, err)
		}
		for _, id := range []string{sampleplugin.ID, samplev2.ID} {
			if _, _, err := service.Install(env.ctx, id, env.userID); err != nil {
				t.Fatal(err)
			}
		}
		catalog, err := service.CatalogItem(env.ctx, samplev2.ID)
		if err != nil || !catalog.Installed {
			t.Fatalf("v2 catalog entry = %+v, %v", catalog, err)
		}
		for _, definition := range service.definitions {
			if definition.ID == samplev2.ID && !service.affectsPlayerContent(definition) {
				t.Fatal("installing a v2 plugin with a player contribution must revise screens")
			}
		}

		states, err = service.PlayerStateForScreen(env.ctx, env.screenID, reported)
		if err != nil || len(states) != 1 {
			t.Fatalf("states = %+v, %v", states, err)
		}
		state := states[0]
		if state.ID != beacon || state.Type != "plugin_state" || state.Plugin != samplev2.ID ||
			state.StateType != "sample_beacon" || state.StateVersion != 1 || string(state.State) != `{"label":"Lobby"}` {
			t.Fatalf("unexpected state entry %+v", state)
		}

		// The v1 projection path is unchanged and never carries v2 state.
		entries, err := service.ManifestForScreen(env.ctx, env.screenID)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.Type == "plugin_state" || entry.Type == "sample_beacon" {
				t.Fatalf("v2 state leaked into the v1 projection: %+v", entry)
			}
		}

		// A Shared Runtime contribution whose required service the Player
		// lacks would never activate, so its state is not sent.
		states, err = service.PlayerStateForScreen(env.ctx, env.screenID, map[string]int{"plugin.host": 2})
		if err != nil || len(states) != 0 {
			t.Fatalf("state reached a Player without player.clock: %v %v", states, err)
		}

		// An undeclared or unbounded projection fails loudly.
		far := time.Now().Add(400 * 24 * time.Hour)
		v2.Put(samplev2.Beacon{ID: uuid.New(), Label: "Too long", ValidUntil: &far})
		if _, err := service.PlayerStateForScreen(env.ctx, env.screenID, reported); err == nil {
			t.Fatal("an out-of-bounds state value was projected")
		}
	})
}
