package plugin

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

const studioOnlyV2 = `{
	"apiVersion": 2, "id": "studio_only", "definitionVersion": 1, "name": "Studio Only",
	"description": "No Player behavior.", "category": "Workflow", "icon": "puzzle",
	"maintainers": ["@gbyo"], "instanceNoun": {"singular": "item", "plural": "items"},
	"server": {"entrypoint": "./plugin.go"},
	"studio": {"route": "/plugins/studio-only", "entrypoint": "./studio/index.tsx"}
}`

const playerV2 = `{
	"apiVersion": 2, "id": "player_v2", "definitionVersion": 1, "name": "Player",
	"description": "Player behavior.", "category": "Display", "icon": "puzzle",
	"maintainers": ["@gbyo"], "instanceNoun": {"singular": "item", "plural": "items"},
	"server": {"entrypoint": "./plugin.go"},
	"player": {"state": [{"type": "player_v2", "version": 1}],
		"runtime": {"entrypoint": "./runtime/index.ts", "services": {"required": ["player.clock@1"]}}}
}`

type bundleOnly struct{ Bundle }

type stateProjector struct{ Bundle }

func (stateProjector) ProjectPlayerState(context.Context, uuid.UUID) ([]PlayerState, error) {
	return nil, nil
}

const compatibleV2 = `{
	"apiVersion": 2, "id": "compatible_v2", "definitionVersion": 1, "name": "Compatible",
	"description": "Projects v1 entries for older Players.", "category": "Display", "icon": "puzzle",
	"maintainers": ["@gbyo"], "instanceNoun": {"singular": "item", "plural": "items"},
	"server": {"entrypoint": "./plugin.go"},
	"player": {"state": [{"type": "compatible_v2", "version": 1}], "v1ManifestTypes": ["compatible_v2"],
		"runtime": {"entrypoint": "./runtime/index.ts", "services": {"required": ["player.clock@1"]}}}
}`

type bothProjectors struct{ Bundle }

func (bothProjectors) ProjectPlayerState(context.Context, uuid.UUID) ([]PlayerState, error) {
	return nil, nil
}

func (bothProjectors) ProjectManifest(context.Context, uuid.UUID) ([]ManifestEntry, error) {
	return nil, nil
}

type manifestProjector struct{ Bundle }

func (manifestProjector) ProjectManifest(context.Context, uuid.UUID) ([]ManifestEntry, error) {
	return nil, nil
}

func TestCheckDeclarationsV2(t *testing.T) {
	bundle := func(text string) Bundle { return NewBundle([]byte(text), nil) }
	for _, test := range []struct {
		name   string
		plugin Plugin
		want   string
	}{
		{"server and studio only", bundleOnly{bundle(studioOnlyV2)}, ""},
		{"player with projector", stateProjector{bundle(playerV2)}, ""},
		{"player without projector", bundleOnly{bundle(playerV2)}, "does not implement PlayerStateProjector"},
		{"projector without player", stateProjector{bundle(studioOnlyV2)}, "without declaring a player contribution"},
		{"v1 projector on v2", manifestProjector{bundle(playerV2)}, "without declaring player.v1ManifestTypes"},
		{"compatibility types without projector", stateProjector{bundle(compatibleV2)}, "does not implement ManifestProjector"},
		{"compatibility types with both projectors", bothProjectors{bundle(compatibleV2)}, ""},
	} {
		err := CheckDeclarations(test.plugin)
		switch {
		case test.want == "" && err != nil:
			t.Errorf("%s: %v", test.name, err)
		case test.want != "" && (err == nil || !strings.Contains(err.Error(), test.want)):
			t.Errorf("%s: got %v, want %q", test.name, err, test.want)
		}
	}
}

func TestV1PluginCannotProjectPlayerState(t *testing.T) {
	v1 := `{"apiVersion": 1, "id": "old_style", "definitionVersion": 1, "name": "Old",
		"description": "v1.", "category": "Display", "icon": "puzzle", "maintainers": ["@gbyo"],
		"instanceNoun": {"singular": "item", "plural": "items"}, "server": {"entrypoint": "./plugin.go"}}`
	if err := CheckDeclarations(stateProjector{NewBundle([]byte(v1), nil)}); err == nil ||
		!strings.Contains(err.Error(), "needs Plugin API 2") {
		t.Fatalf("got %v", err)
	}
}

func TestManifestAccessorsNormalizeVersions(t *testing.T) {
	m := NewBundle([]byte(playerV2), nil).Manifest()
	if !m.PlayerFacing() || len(m.ManifestTypes()) != 1 || m.ManifestTypes()[0] != "player_v2" {
		t.Fatalf("v2 accessors: %v %v", m.PlayerFacing(), m.ManifestTypes())
	}
	if NewBundle([]byte(studioOnlyV2), nil).Manifest().PlayerFacing() {
		t.Fatal("a plugin without a player contribution is not Player facing")
	}
}
