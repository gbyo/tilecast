package plugins

import (
	"io/fs"
	"os"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/sampleplugin"
	bundled "github.com/tilecast/tilecast/plugins"
)

var artworkPathPattern = regexp.MustCompile(`^/api/v1/plugin-store/[a-z][a-z0-9_]*/artwork/(icon|screenshots/\d+)\?v=[0-9a-f]{12}$`)

const stubStoreJSON = `{
  "publisher": {"name": "Tilecast", "url": "https://tilecast.org"},
  "longDescription": "A longer description.",
  "artwork": {
    "icon": "./store/icon.webp",
    "screenshots": [
      {"src": "./store/one.webp", "alt": "First screenshot of the plugin."},
      {"src": "./store/two.png", "alt": "Second screenshot of the plugin."}
    ]
  }
}`

func stubStoreFiles() fstest.MapFS {
	return fstest.MapFS{
		"store/icon.webp": {Data: []byte("RIFF-icon")},
		"store/one.webp":  {Data: []byte("RIFF-one")},
		"store/two.png":   {Data: []byte("\x89PNG-two")},
	}
}

// storeStub is the sample plugin with Store presentation attached, so these
// tests never depend on the artwork a real plugin ships.
type storeStub struct {
	*sampleplugin.Plugin
	listing plugin.StoreListing
	assets  fs.FS
}

func (s storeStub) StoreListing() (plugin.StoreListing, fs.FS, bool) {
	return s.listing, s.assets, true
}

func newStoreStub(t *testing.T, storeJSON string, files fs.FS) storeStub {
	t.Helper()
	listing, err := plugin.ParseStoreListing([]byte(storeJSON), files)
	if err != nil {
		t.Fatal(err)
	}
	return storeStub{Plugin: sampleplugin.New(), listing: listing, assets: files}
}

func TestBundledPluginsShipStoreMetadata(t *testing.T) {
	for _, p := range bundled.Bundled() {
		id := p.Manifest().ID
		t.Run(id, func(t *testing.T) {
			presentation := loadIncludedPresentation(p, id)
			listing := presentation.listing
			if listing.PublisherName != "Tilecast" || listing.PublisherURL != "https://tilecast.org" {
				t.Fatalf("publisher = %q %q", listing.PublisherName, listing.PublisherURL)
			}
			if !strings.Contains(listing.LongDescription, p.Manifest().Name) {
				t.Fatalf("long description should describe %s: %q", p.Manifest().Name, listing.LongDescription)
			}
			// Artwork is optional. Whatever a plugin declares must be a
			// Tilecast server path, never a file path.
			if listing.Artwork != nil {
				for _, address := range append([]string{listing.Artwork.IconURL}, screenshotURLs(listing)...) {
					if address != "" && !artworkPathPattern.MatchString(address) {
						t.Fatalf("artwork URL %q is not a Tilecast server path", address)
					}
				}
			}
		})
	}
}

func screenshotURLs(listing IncludedListing) []string {
	var out []string
	for _, shot := range listing.Artwork.Screenshots {
		out = append(out, shot.URL)
	}
	return out
}

func TestIncludedPresentationExposesServerPathsOnly(t *testing.T) {
	stub := newStoreStub(t, stubStoreJSON, stubStoreFiles())
	presentation := loadIncludedPresentation(stub, "sample_tally")
	listing := presentation.listing
	if listing.PublisherName != "Tilecast" || listing.PublisherURL != "https://tilecast.org" || listing.LongDescription != "A longer description." {
		t.Fatalf("listing = %+v", listing)
	}
	artwork := listing.Artwork
	if artwork == nil || !artworkPathPattern.MatchString(artwork.IconURL) || !strings.Contains(artwork.IconURL, "/sample_tally/artwork/icon?v=") {
		t.Fatalf("icon URL = %+v", artwork)
	}
	if len(artwork.Screenshots) != 2 {
		t.Fatalf("screenshots = %+v", artwork.Screenshots)
	}
	for index, shot := range artwork.Screenshots {
		if !artworkPathPattern.MatchString(shot.URL) || !strings.Contains(shot.URL, "/screenshots/"+string(rune('0'+index))+"?v=") {
			t.Fatalf("screenshot %d URL = %q", index, shot.URL)
		}
		if strings.ContainsAny(shot.URL, ".\\") || shot.Alt == "" {
			t.Fatalf("screenshot %d = %+v", index, shot)
		}
	}
	if presentation.screenshots[0].ContentType != "image/webp" || presentation.screenshots[1].ContentType != "image/png" {
		t.Fatalf("content types = %q %q", presentation.screenshots[0].ContentType, presentation.screenshots[1].ContentType)
	}
	// The version token follows the image bytes, so a new image defeats caches.
	changed := stubStoreFiles()
	changed["store/icon.webp"] = &fstest.MapFile{Data: []byte("RIFF-new-icon")}
	other := loadIncludedPresentation(newStoreStub(t, stubStoreJSON, changed), "sample_tally")
	if other.listing.Artwork.IconURL == artwork.IconURL || other.listing.Artwork.Screenshots[0].URL != artwork.Screenshots[0].URL {
		t.Fatal("only the changed image may change its URL")
	}
}

// bareBundle is a plugin that ships no Store metadata at all.
type bareBundle struct{ plugin.Bundle }

func TestMissingStoreMetadataDegradesSafely(t *testing.T) {
	manifest, err := os.ReadFile("../../../../packages/plugin-sdk/testdata/manifests/valid/minimal.json")
	if err != nil {
		t.Fatal(err)
	}
	bare := bareBundle{Bundle: plugin.NewBundle(manifest, nil)}
	presentation := loadIncludedPresentation(bare, bare.Manifest().ID)
	if presentation.listing.PublisherName != DefaultIncludedPublisher {
		t.Fatalf("publisher = %q, want the default", presentation.listing.PublisherName)
	}
	if presentation.listing.Artwork != nil || presentation.listing.LongDescription != "" || presentation.icon != nil || len(presentation.screenshots) != 0 {
		t.Fatalf("an unadorned plugin must carry no presentation: %+v", presentation)
	}
	// Publisher-only metadata is also valid.
	only := newStoreStub(t, `{"publisher":{"name":"Tilecast"}}`, nil)
	if got := loadIncludedPresentation(only, "sample_tally").listing; got.Artwork != nil || got.PublisherName != "Tilecast" {
		t.Fatalf("publisher-only listing = %+v", got)
	}
}

func TestIncludedArtworkLookups(t *testing.T) {
	stub := newStoreStub(t, stubStoreJSON, stubStoreFiles())
	id := stub.Manifest().ID
	s := &Service{hosted: []hostedPlugin{{plugin: stub, manifest: stub.Manifest(), presentation: loadIncludedPresentation(stub, id)}}}

	icon, known, ok := s.IncludedIcon(id)
	if !known || !ok || icon.ContentType != "image/webp" || !strings.HasPrefix(icon.ETag, `"`) || string(icon.Body) != "RIFF-icon" {
		t.Fatalf("icon = %+v known=%v ok=%v", icon, known, ok)
	}
	if shot, known, ok := s.IncludedScreenshot(id, 1); !known || !ok || shot.ContentType != "image/png" {
		t.Fatalf("screenshot 1 known=%v ok=%v", known, ok)
	}
	for _, index := range []int{-1, 2, 99} {
		if _, known, ok := s.IncludedScreenshot(id, index); !known || ok {
			t.Fatalf("screenshot %d should be a known plugin's missing image", index)
		}
	}
	if _, known, ok := s.IncludedIcon("marketplace_listing"); known || ok {
		t.Fatal("an ID that is not included must fall through to other sources")
	}
	noArtwork := newStoreStub(t, `{"publisher":{"name":"Tilecast"}}`, nil)
	s = &Service{hosted: []hostedPlugin{{plugin: noArtwork, manifest: noArtwork.Manifest(), presentation: loadIncludedPresentation(noArtwork, id)}}}
	if _, known, ok := s.IncludedIcon(id); !known || ok {
		t.Fatal("a plugin without an icon is known but has no image")
	}
}
