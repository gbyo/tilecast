package packages

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifiedContributionMetadataRejectsChangedExtractedCache(t *testing.T) {
	entries := []tarEntry{
		{name: "widgets/scoreboard/tilecast.widget.json", body: nestedManifestDoc("scoreboard")},
		{name: "data-sources/schedule/tilecast.datasource.json", body: nestedManifestDoc("schedule")},
		{name: "plugin/tilecast.plugin.json", body: `{"apiVersion":2,"id":"corner","definitionVersion":1,"name":"Corner","description":"Verified corner surface.","capabilities":{"playerManifest":true},"runtime":{"surfaces":["corner.bottom-left"],"tier":"ambient"}}`},
	}
	layout, verified := extractFixture(t, entries)
	content := filepath.Join(t.TempDir(), "content")
	if err := ExtractContent(layout, verified, content); err != nil {
		t.Fatal(err)
	}
	items, err := ReadVerifiedContributions(context.Background(), layout, content, verified)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, item := range items {
		if item.PluginRuntime != nil {
			found = true
			if item.PluginRuntime.Tier != "ambient" || len(item.PluginRuntime.Surfaces) != 1 || item.PluginRuntime.Surfaces[0] != "corner.bottom-left" {
				t.Fatalf("review metadata: %+v", item)
			}
		}
	}
	if !found {
		t.Fatal("verified runtime permissions missing")
	}
	if err := os.WriteFile(filepath.Join(content, "plugin/tilecast.plugin.json"), []byte(strings.Replace(entries[2].body, "ambient", "emergency", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadVerifiedContributions(context.Background(), layout, content, verified); err == nil {
		t.Fatal("changed cache supplied review or activation metadata")
	}
}
