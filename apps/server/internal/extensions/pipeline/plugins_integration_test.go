package pipeline

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

func TestInstalledExternalPluginFrameUsesAuthenticatedLayer(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	manifest, err := packagemanifest.Parse([]byte(f.github.manifest))
	if err != nil {
		t.Fatal(err)
	}
	manifest.Contributions = []packagemanifest.Contribution{{Type: "plugin", Path: "./plugin"}}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	f.github.manifest = string(raw)
	descriptor := `{"apiVersion":2,"id":"corner","definitionVersion":1,"name":"Corner","description":"External surface.","capabilities":{"playerManifest":true},"runtime":{"surfaces":["corner.bottom-left"],"tier":"ambient"}}`
	bundle := `window.__tilecastExternalPlugin={update:function(){document.body.textContent='Verified surface'}};`
	var content bytes.Buffer
	zip := gzip.NewWriter(&content)
	archive := tar.NewWriter(zip)
	for name, body := range map[string]string{"plugin/tilecast.plugin.json": descriptor, "plugin/runtime/index.js": bundle} {
		if err := archive.WriteHeader(&tar.Header{Name: name, Mode: 0644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zip.Close(); err != nil {
		t.Fatal(err)
	}
	layout := t.TempDir()
	digest, err := packages.WriteLayout(layout, raw, content.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	f.registry.layout = layout
	f.registry.tags = map[string]string{f.github.releaseTag: digest}
	f.digest = digest
	installed, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Digest != digest || f.verifyCalls == 0 {
		t.Fatal("activation bypassed pinned provenance")
	}
	expected, err := sandbox.AssemblePluginFrame(bundle)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := f.service.PluginFrame(ctx, pipelinePID, "corner")
	if err != nil || frame != expected {
		t.Fatalf("installed frame: %v %v", frame, err)
	}
	contentDir, err := f.service.ContentDir(ctx, f.oci, digest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(contentDir, "plugin", "runtime", "index.js"), []byte("altered cache"), 0600); err != nil {
		t.Fatal(err)
	}
	frame, err = f.service.PluginFrame(ctx, pipelinePID, "corner")
	if err != nil || frame != expected {
		t.Fatalf("derived cache changed authenticated frame: %v", err)
	}
	if _, err := f.service.PluginFrame(ctx, pipelinePID, "missing"); !errors.Is(err, installer.ErrNotFound) {
		t.Fatalf("unknown contribution: %v", err)
	}
	if err := f.service.Remove(ctx, pipelinePID, f.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.PluginFrame(ctx, pipelinePID, "corner"); !errors.Is(err, installer.ErrNotFound) {
		t.Fatalf("removed plugin still served: %v", err)
	}
}
