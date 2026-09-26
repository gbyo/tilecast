// Package plugintest holds the parts of the Official Tilecast Plugin
// Conformance suite that run inside a plugin's own tests, without a database.
// The server runs the rest (installation, status, removal, projection, and
// migrations against PostgreSQL) for every bundled plugin; see
// apps/server/internal/plugins/conformance_integration_test.go.
package plugintest

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Conformance checks that a plugin's declarations match what it implements,
// that its routes stay inside its declared base paths, that its migrations
// are well formed, that the manifest in the plugin directory is the one it
// embeds, and that Init neither fails nor needs services before first use.
// Run it from the plugin package's own directory.
func Conformance(t *testing.T, p plugin.Plugin) {
	t.Helper()
	if err := plugin.CheckDeclarations(p); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(".", "tilecast.plugin.json"))
	if err != nil {
		t.Fatalf("run Conformance from the plugin directory: %v", err)
	}
	onDisk, err := plugin.ParseManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.ID != p.Manifest().ID || onDisk.DefinitionVersion != p.Manifest().DefinitionVersion {
		t.Fatalf("the embedded manifest (%s v%d) is not tilecast.plugin.json (%s v%d)",
			p.Manifest().ID, p.Manifest().DefinitionVersion, onDisk.ID, onDisk.DefinitionVersion)
	}
	if initializer, ok := p.(plugin.Initializer); ok {
		if err := initializer.Init(context.Background(), Host()); err != nil {
			t.Fatalf("Init must only keep its services; it failed: %v", err)
		}
	}
}

// Host returns a Host with a discarding logger and a fixed clock. Every other
// service is nil, so a plugin that uses one during Init fails loudly; tests
// that exercise a service fill in the field.
func Host() plugin.Host {
	return plugin.Host{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:  FixedClock(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)),
	}
}

// FixedClock is a Clock that always answers the same instant.
type FixedClock time.Time

func (c FixedClock) Now() time.Time { return time.Time(c) }
