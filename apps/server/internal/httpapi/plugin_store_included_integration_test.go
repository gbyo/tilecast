package httpapi

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleplugin"
)

// storePresentationPlugin is the sample plugin with Store presentation, so the
// test does not depend on the artwork a real plugin ships.
type storePresentationPlugin struct {
	*sampleplugin.Plugin
	listing plugin.StoreListing
	assets  fs.FS
}

func (p storePresentationPlugin) StoreListing() (plugin.StoreListing, fs.FS, bool) {
	return p.listing, p.assets, true
}

// TestIncludedPluginArtworkServedFromRelease drives the store through the
// production router: included entries carry publisher, long description, and
// Tilecast artwork paths, and the images come straight from the release. The
// marketplace is deliberately not configured, so any attempt to route an
// included image through the marketplace fetcher would fail the test.
func TestIncludedPluginArtworkServedFromRelease(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		files := fstest.MapFS{
			"store/icon.webp": {Data: []byte("RIFF....WEBPicon")},
			"store/one.webp":  {Data: []byte("RIFF....WEBPone")},
			"store/two.png":   {Data: []byte("\x89PNG\r\n\x1a\ntwo")},
		}
		listing, err := plugin.ParseStoreListing([]byte(`{
			"publisher": {"name": "Tilecast", "url": "https://tilecast.org"},
			"longDescription": "A longer description for the detail page, in plain text.",
			"artwork": {"icon": "./store/icon.webp", "screenshots": [
				{"src": "./store/one.webp", "alt": "The first screenshot."},
				{"src": "./store/two.png", "alt": "The second screenshot."}]}}`), files)
		if err != nil {
			t.Fatal(err)
		}
		stub := storePresentationPlugin{Plugin: sampleplugin.New(), listing: listing, assets: files}
		client := newMarketplaceTestClient(t, env, func() {
			env.server.plugins = plugins.NewService(env.pool, nil, plugins.WithPlugins(stub))
		})
		id := sampleplugin.ID

		status, raw, storeBody := client.raw("viewer", "/api/v1/plugin-store", nil)
		if status != http.StatusOK {
			t.Fatalf("store status = %d (%s)", status, raw)
		}
		for _, leaked := range []string{"tilecast.store.json", "./store/", "store/icon", ".webp\"", "/Users/"} {
			if strings.Contains(string(storeBody), leaked) {
				t.Fatalf("the store response exposes a source path (%q)", leaked)
			}
		}
		var store map[string]any
		if err := json.Unmarshal(storeBody, &store); err != nil {
			t.Fatal(err)
		}
		entry := findStoreItem(t, marketplaceStoreItems(t, store), id)
		included, ok := entry["included"].(map[string]any)
		if !ok {
			t.Fatalf("no included presentation: %v", entry)
		}
		if included["publisherName"] != "Tilecast" || included["publisherUrl"] != "https://tilecast.org" ||
			!strings.HasPrefix(included["longDescription"].(string), "A longer description") {
			t.Fatalf("included = %v", included)
		}
		// Presentation never changes what the plugin is.
		if entry["plugin"].(map[string]any)["id"] != id || entry["marketplace"] != nil || entry["custom"] != nil {
			t.Fatalf("identity changed: %v", entry)
		}
		artwork := included["artwork"].(map[string]any)
		iconURL := artwork["iconUrl"].(string)
		if !strings.HasPrefix(iconURL, "/api/v1/plugin-store/"+id+"/artwork/icon?v=") {
			t.Fatalf("icon URL = %q", iconURL)
		}
		status, header, body := client.raw("viewer", iconURL, nil)
		if status != http.StatusOK || header.Get("Content-Type") != "image/webp" || string(body) != "RIFF....WEBPicon" {
			t.Fatalf("icon status=%d type=%q body=%q", status, header.Get("Content-Type"), body)
		}
		if header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(header.Get("Content-Security-Policy"), "default-src 'none'") || header.Get("ETag") == "" {
			t.Fatalf("icon headers = %v", header)
		}
		if status, _, _ = client.raw("viewer", iconURL, http.Header{"If-None-Match": {header.Get("ETag")}}); status != http.StatusNotModified {
			t.Fatalf("conditional icon status = %d, want 304", status)
		}
		if status, _, _ = client.raw("", iconURL, nil); status != http.StatusUnauthorized {
			t.Fatalf("anonymous icon status = %d, want 401", status)
		}
		shots := artwork["screenshots"].([]any)
		wantTypes := []string{"image/webp", "image/png"}
		if len(shots) != 2 {
			t.Fatalf("screenshots = %v", shots)
		}
		for index, rawShot := range shots {
			shot := rawShot.(map[string]any)
			if shot["alt"] == "" {
				t.Fatalf("screenshot %d has no alt text", index)
			}
			if status, header, _ = client.raw("viewer", shot["url"].(string), nil); status != http.StatusOK || header.Get("Content-Type") != wantTypes[index] {
				t.Fatalf("screenshot %d status=%d type=%q", index, status, header.Get("Content-Type"))
			}
		}
		for name, path := range map[string]string{
			"index out of range": "/api/v1/plugin-store/" + id + "/artwork/screenshots/9",
			"negative index":     "/api/v1/plugin-store/" + id + "/artwork/screenshots/-1",
			"non-numeric index":  "/api/v1/plugin-store/" + id + "/artwork/screenshots/..%2F..%2Fetc",
		} {
			if status, _, body = client.raw("viewer", path, nil); status != http.StatusNotFound || !strings.Contains(string(body), "artwork_unavailable") {
				t.Errorf("%s: status=%d body=%s", name, status, body)
			}
		}

		// The single-entry endpoint carries the same presentation.
		status, raw, body = client.raw("viewer", "/api/v1/plugin-store/"+id, nil)
		if status != http.StatusOK || !strings.Contains(string(body), `"publisherName":"Tilecast"`) {
			t.Fatalf("detail status=%d %s", status, raw)
		}
	})
}

// TestBundledPluginsCarryPublisherInTheStore checks the real release: every
// included entry names its publisher, and a plugin with no artwork simply has
// none.
func TestBundledPluginsCarryPublisherInTheStore(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		client := newMarketplaceTestClient(t, env, func() {
			env.server.plugins = plugins.NewService(env.pool, nil)
		})
		status, raw, body := client.raw("viewer", "/api/v1/plugin-store", nil)
		if status != http.StatusOK {
			t.Fatalf("store status = %d (%s)", status, raw)
		}
		var store map[string]any
		if err := json.Unmarshal(body, &store); err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{"countdown_bar", "emergency_alerts", "forms"} {
			included := findStoreItem(t, marketplaceStoreItems(t, store), id)["included"].(map[string]any)
			if included["publisherName"] != "Tilecast" || len(included["longDescription"].(string)) < 100 {
				t.Fatalf("%s included = %v", id, included)
			}
		}
	})
}
