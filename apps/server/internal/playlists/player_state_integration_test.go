package playlists

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

type stateProjector struct {
	states    []plugins.PlayerStateEntry
	calls     int
	reported  map[string]int
	v1        []plugins.ManifestPlugin
	v1Calls   int
	hostCalls int
}

func (p *stateProjector) ManifestForScreen(context.Context, uuid.UUID) ([]plugins.ManifestPlugin, error) {
	p.v1Calls++
	return p.v1, nil
}

func (p *stateProjector) ManifestForPluginHost(context.Context, uuid.UUID) ([]plugins.ManifestPlugin, error) {
	p.hostCalls++
	return nil, nil
}

func (p *stateProjector) PlayerStateForScreen(_ context.Context, _ uuid.UUID, reported map[string]int) ([]plugins.PlayerStateEntry, error) {
	p.calls++
	p.reported = reported
	return p.states, nil
}

// Plugin API v2 state reaches only a Player that reports the v2 plugin host.
// A capable Player receives schema 21 even with no entries, so the first
// state change is a plugin-only revision. Media that does not resolve to a
// verified library variant is dropped from the entry instead of becoming a
// manifest claim no Player could verify.
func TestPlayerStateRequiresGenericPluginHostCapability(t *testing.T) {
	f := setupCapabilityFixture(t)
	projector := &stateProjector{}
	f.service.SetPluginProjector(projector)
	unreported, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if projector.calls != 0 || unreported.SchemaVersion >= ManifestSchemaPlayerPlugins {
		t.Fatalf("an unreported Player was offered v2 state: calls=%d schema=%d", projector.calls, unreported.SchemaVersion)
	}
	if projector.v1Calls != 1 || projector.hostCalls != 0 {
		t.Fatalf("an unreported Player must receive the v1 projection with compatibility entries: v1=%d host=%d", projector.v1Calls, projector.hostCalls)
	}
	// The external surface ABI is a different contract and never implies v2.
	f.reportCapabilities(t, "{1,2,3}", map[string]int{"plugin.external-runtime": 1})
	if _, _, err := f.service.BuildManifest(f.ctx, f.screen); err != nil || projector.calls != 0 {
		t.Fatalf("external runtime implied the v2 host: %v calls=%d", err, projector.calls)
	}

	f.reportCapabilities(t, "{1,2,3}", map[string]int{plugin.PlayerPluginHostCapability: 2, "player.clock": 1})
	empty, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if projector.hostCalls != 1 {
		t.Fatalf("a v2 host must receive the v1 projection without compatibility entries: host=%d", projector.hostCalls)
	}
	if empty.SchemaVersion != ManifestSchemaPlayerPlugins || len(empty.Plugins) != 0 || projector.calls != 1 ||
		projector.reported["player.clock"] != 1 {
		t.Fatalf("empty capable manifest: schema=%d plugins=%d calls=%d reported=%v", empty.SchemaVersion, len(empty.Plugins), projector.calls, projector.reported)
	}

	missingAsset, missingVariant := uuid.New(), uuid.New()
	projector.states = []plugins.PlayerStateEntry{{
		ID: uuid.New(), Type: plugin.PlayerStateEntryType, Version: 1, Plugin: "sample_beacon", DefinitionVersion: 1,
		StateType: "sample_beacon", StateVersion: 1, State: json.RawMessage(`{"label":"Lobby"}`),
		Media: []plugin.MediaRef{{AssetID: missingAsset, VariantID: missingVariant}},
	}}
	withState, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if withState.SchemaVersion != empty.SchemaVersion || len(withState.Plugins) != 1 || withState.Plugins[0].State == nil {
		t.Fatalf("state entry did not join the manifest: %+v", withState.Plugins)
	}
	if len(withState.Plugins[0].State.Media) != 0 {
		t.Fatal("an unresolvable media reference stayed on the entry")
	}
	for _, asset := range withState.Assets {
		if asset.AssetID == missingAsset {
			t.Fatal("an unresolvable media reference became a manifest asset")
		}
	}
	// Only plugins changed between the two manifests: nothing a Player
	// compares for a plugin-only revision.
	strip := func(m Manifest) string {
		m.Plugins, m.ManifestVersion, m.GeneratedAt, m.ServerTime = nil, 0, empty.GeneratedAt, empty.ServerTime
		encoded, _ := json.Marshal(m)
		return string(encoded)
	}
	if strip(empty) != strip(withState) {
		t.Fatal("v2 state changed manifest fields outside plugins")
	}
}

// A plugin names a library family by ID. The Server resolves it to the
// family's verified faces, shares each face file with every other consumer
// of the same family, and drops a family that was removed so the Player's
// plugin keeps its own face.
func TestPlayerStateResolvesLibraryFonts(t *testing.T) {
	f := setupCapabilityFixture(t)
	projector := &stateProjector{}
	f.service.SetPluginProjector(projector)
	f.reportCapabilities(t, "{1,2,3}", map[string]int{plugin.PlayerPluginHostCapability: 2, "player.fonts": 1})
	familyID, assetID, variantID := insertFontFamily(t, f, "Fixture Display")
	removedID, _, _ := insertFontFamily(t, f, "Removed Display")
	if _, err := f.pool.Exec(f.ctx, `UPDATE font_families SET deleted_at=now() WHERE id=$1`, removedID); err != nil {
		t.Fatal(err)
	}
	entry := func(fonts ...uuid.UUID) plugins.PlayerStateEntry {
		refs := []plugin.FontRef{}
		for _, id := range fonts {
			refs = append(refs, plugin.FontRef{ID: id})
		}
		return plugins.PlayerStateEntry{
			ID: uuid.New(), Type: plugin.PlayerStateEntryType, Version: 1, Plugin: "sample_beacon", DefinitionVersion: 1,
			StateType: "sample_beacon", StateVersion: 1, State: json.RawMessage(`{}`), Fonts: refs,
		}
	}
	// Two entries use the same family; a third names a removed and an unknown one.
	projector.states = []plugins.PlayerStateEntry{entry(familyID), entry(familyID), entry(removedID, uuid.New())}
	manifest, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Plugins) != 3 {
		t.Fatalf("plugins = %d", len(manifest.Plugins))
	}
	for _, index := range []int{0, 1} {
		fonts := manifest.Plugins[index].State.Fonts
		if len(fonts) != 1 || fonts[0].ID != familyID || fonts[0].Family != "Fixture Display" || len(fonts[0].Faces) != 1 {
			t.Fatalf("entry %d fonts = %#v", index, fonts)
		}
		face := fonts[0].Faces[0]
		if face.AssetID != assetID || face.VariantID != variantID || face.WeightMin != 100 || face.WeightMax != 900 ||
			face.Style != "normal" || face.UnicodeRange != "U+0000-00FF" {
			t.Fatalf("face = %#v", face)
		}
	}
	if len(manifest.Plugins[2].State.Fonts) != 0 {
		t.Fatalf("a removed or unknown family stayed on the entry: %#v", manifest.Plugins[2].State.Fonts)
	}
	files := 0
	for _, asset := range manifest.Assets {
		if asset.VariantID == variantID {
			files++
			if asset.MIMEType != "font/woff2" || asset.DownloadPath != "/api/v1/player/assets/"+assetID.String()+"/variants/"+variantID.String() {
				t.Fatalf("font file asset = %#v", asset)
			}
		}
	}
	if files != 1 {
		t.Fatalf("the face file is in the manifest %d times, want once", files)
	}
	encoded, err := json.Marshal(manifest.Plugins[0])
	if err != nil || !strings.Contains(string(encoded), `"fonts":[{"id":"`+familyID.String()+`"`) {
		t.Fatalf("wire entry = %s (%v)", encoded, err)
	}
}
