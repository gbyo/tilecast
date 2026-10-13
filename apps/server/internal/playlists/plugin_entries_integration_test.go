package playlists

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/externalplugins"
)

type externalProjector struct {
	entries []externalplugins.Entry
	calls   int
}

func (p *externalProjector) ManifestForScreen(context.Context, uuid.UUID) ([]externalplugins.Entry, error) {
	p.calls++
	return p.entries, nil
}

func TestExternalPluginManifestRequiresGenericCapability(t *testing.T) {
	f := setupCapabilityFixture(t)
	projector := &externalProjector{}
	f.service.SetExternalPluginProjector(projector)
	if _, _, err := f.service.BuildManifest(f.ctx, f.screen); err != nil {
		t.Fatal(err)
	}
	if projector.calls != 0 {
		t.Fatal("unreported Player received external plugin execution")
	}
	f.reportCapabilities(t, "{1,2,3}", map[string]int{"plugin.external-runtime": 1})
	manifest, _, err := f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != 20 || len(manifest.Plugins) != 0 || projector.calls != 1 {
		t.Fatalf("empty capable manifest: schema=%d plugins=%d calls=%d", manifest.SchemaVersion, len(manifest.Plugins), projector.calls)
	}
	projector.entries = []externalplugins.Entry{{ID: "acme.surface.corner", Type: "external_plugin", Version: 1}}
	manifest, _, err = f.service.BuildManifest(f.ctx, f.screen)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != 20 || len(manifest.Plugins) != 1 || manifest.Plugins[0].External == nil {
		t.Fatal("generic external entry did not join the manifest")
	}
}
