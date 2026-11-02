package contributions

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

const externalDescriptor = `{"apiVersion":2,"id":"corner","definitionVersion":1,"name":"Corner","description":"An external surface.","capabilities":{"playerManifest":true},"runtime":{"surfaces":["corner.bottom-left"],"tier":"ambient"}}`
const externalBundle = `window.__tilecastExternalPlugin={update:function(state,context,bridge){bridge.claim({slot:'corner.bottom-left',priority:0})}};`

func TestExternalPluginContributionJoinsVerifiedCatalog(t *testing.T) {
	f := newContributionsFixture(t)
	manifest := testManifest("acme.surfaces")
	manifest.Contributions = []packagemanifest.Contribution{{Type: "plugin", Path: "./plugin"}}
	f.seedPackage(t, manifest.PackageID, testDigestGood, manifest, map[string]string{"plugin/tilecast.plugin.json": externalDescriptor, "plugin/runtime/index.js": externalBundle})
	if err := f.service.Validate(f.content[testDigestGood], manifest, testDigestGood); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	payload, ok := f.service.PluginPayload(manifest.PackageID, "corner")
	if !ok {
		t.Fatal("external plugin remained inert")
	}
	frame, err := sandbox.AssemblePluginFrame(externalBundle)
	if err != nil {
		t.Fatal(err)
	}
	if payload.ContributionID != "acme.surfaces.corner" || payload.PackageDigest != testDigestGood || payload.FrameSHA256Hex != frame.SHA256Hex || payload.FrameSize != frame.Size {
		t.Fatalf("incorrect verified metadata: %+v", payload)
	}
	payload.Descriptor.Runtime.Surfaces[0] = "overlay"
	still, _ := f.service.PluginPayload(manifest.PackageID, "corner")
	if still.Descriptor.Runtime.Surfaces[0] != "corner.bottom-left" {
		t.Fatal("caller mutated the catalog")
	}
	if _, ok := f.service.PluginPayload("acme.other", "corner"); ok {
		t.Fatal("package namespaces collided")
	}
	if err := os.Remove(filepath.Join(f.content[testDigestGood], "plugin/runtime/index.js")); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Rebuild(context.Background()); err == nil {
		t.Fatal("missing plugin bundle was accepted")
	}
	if _, ok := f.service.PluginPayload(manifest.PackageID, "corner"); ok {
		t.Fatal("unverified plugin remained executable")
	}
}

func TestFrozenExternalPluginAPI1RemainsInert(t *testing.T) {
	f := newContributionsFixture(t)
	manifest := testManifest("acme.legacy")
	manifest.Contributions = []packagemanifest.Contribution{{Type: "plugin", Path: "./plugin"}}
	f.seedPackage(t, manifest.PackageID, testDigestGood, manifest, map[string]string{"plugin/tilecast.plugin.json": `{"apiVersion":1,"id":"corner"}`})
	if err := f.service.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.service.PluginPayload(manifest.PackageID, "corner"); ok {
		t.Fatal("compiled-plugin descriptor became executable")
	}
}

func TestCurrentPluginPayloadCachesOutcomesAndRefreshesOutsideTheRequest(t *testing.T) {
	f := newContributionsFixture(t)
	ctx := context.Background()
	manifest := testManifest("acme.cached")
	manifest.Contributions = []packagemanifest.Contribution{{Type: "plugin", Path: "./plugin"}}
	f.seedPackage(t, manifest.PackageID, testDigestGood, manifest, map[string]string{"plugin/tilecast.plugin.json": externalDescriptor, "plugin/runtime/index.js": externalBundle})
	bundle := filepath.Join(f.content[testDigestGood], "plugin/runtime/index.js")
	if err := os.Remove(bundle); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Rebuild(ctx); err == nil {
		t.Fatal("missing plugin bundle was accepted")
	}
	current, _, err := f.installer.ExecutionSnapshot(ctx, manifest.PackageID)
	if err != nil {
		t.Fatal(err)
	}
	// The bytes become valid, but the rejection of this epoch is already cached.
	if err := os.WriteFile(bundle, []byte(externalBundle), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := f.service.CurrentPluginPayload(ctx, manifest.PackageID, "corner", current.ExecutionEpoch); err != nil || ok {
		t.Fatalf("a rejected epoch was rebuilt inside the request: %v %v", ok, err)
	}
	if f.service.refreshing.Load() {
		t.Fatal("a cached rejection started a refresh")
	}
	// An epoch this replica never saw answers at once and refreshes in the background.
	if _, ok, err := f.service.CurrentPluginPayload(ctx, manifest.PackageID, "corner", uuid.New()); err != nil || ok {
		t.Fatalf("unknown epoch: %v %v", ok, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if payload, ok, err := f.service.CurrentPluginPayload(ctx, manifest.PackageID, "corner", current.ExecutionEpoch); err == nil && ok && payload.ExecutionEpoch == current.ExecutionEpoch {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background refresh never loaded the repaired package")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
