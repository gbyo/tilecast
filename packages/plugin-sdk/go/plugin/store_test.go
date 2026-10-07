package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func storeFiles() fstest.MapFS {
	return fstest.MapFS{
		"store/icon.webp": {Data: []byte("icon")},
		"store/one.webp":  {Data: []byte("one")},
		"store/two.png":   {Data: []byte("two")},
	}
}

const validStore = `{
  "publisher": {"name": "Tilecast", "url": "https://tilecast.org"},
  "longDescription": "A longer description.",
  "artwork": {
    "icon": "./store/icon.webp",
    "screenshots": [
      {"src": "./store/one.webp", "alt": "First screenshot."},
      {"src": "store/two.png", "alt": "Second screenshot."}
    ]
  }
}`

func TestParseStoreListing(t *testing.T) {
	listing, err := ParseStoreListing([]byte(validStore), storeFiles())
	if err != nil {
		t.Fatalf("valid store metadata rejected: %v", err)
	}
	if listing.Publisher.Name != "Tilecast" || listing.Publisher.URL != "https://tilecast.org" {
		t.Fatalf("publisher = %+v", listing.Publisher)
	}
	if listing.LongDescription != "A longer description." || listing.Artwork.Icon != "./store/icon.webp" || len(listing.Artwork.Screenshots) != 2 {
		t.Fatalf("listing = %+v", listing)
	}
}

func TestParseStoreListingAllowsMinimalMetadata(t *testing.T) {
	listing, err := ParseStoreListing([]byte(`{"publisher":{"name":"Tilecast"}}`), nil)
	if err != nil {
		t.Fatalf("publisher-only metadata rejected: %v", err)
	}
	if listing.Artwork.Icon != "" || len(listing.Artwork.Screenshots) != 0 || listing.LongDescription != "" {
		t.Fatalf("optional fields should stay empty: %+v", listing)
	}
}

func TestParseStoreListingRejectsBadMetadata(t *testing.T) {
	cases := map[string]string{
		"unknown field":        `{"publisher":{"name":"T"},"capabilities":{"network":true}}`,
		"no publisher":         `{"artwork":{}}`,
		"blank publisher":      `{"publisher":{"name":"  "}}`,
		"http publisher url":   `{"publisher":{"name":"T","url":"http://tilecast.org"}}`,
		"publisher userinfo":   `{"publisher":{"name":"T","url":"https://user@tilecast.org"}}`,
		"missing icon":         `{"publisher":{"name":"T"},"artwork":{"icon":"./store/missing.webp"}}`,
		"parent path":          `{"publisher":{"name":"T"},"artwork":{"icon":"../tilecast.plugin.json"}}`,
		"absolute path":        `{"publisher":{"name":"T"},"artwork":{"icon":"/etc/passwd"}}`,
		"backslash path":       `{"publisher":{"name":"T"},"artwork":{"icon":"store\\icon.webp"}}`,
		"unsupported type":     `{"publisher":{"name":"T"},"artwork":{"icon":"./store/icon.svg"}}`,
		"missing alt":          `{"publisher":{"name":"T"},"artwork":{"screenshots":[{"src":"./store/one.webp","alt":" "}]}}`,
		"missing screenshot":   `{"publisher":{"name":"T"},"artwork":{"screenshots":[{"src":"./store/nope.webp","alt":"x"}]}}`,
		"trailing content":     validStore + `{}`,
		"too many screenshots": `{"publisher":{"name":"T"},"artwork":{"screenshots":[` + strings.TrimSuffix(strings.Repeat(`{"src":"./store/one.webp","alt":"x"},`, MaxStoreScreenshots+1), ",") + `]}}`,
		"long description":     `{"publisher":{"name":"T"},"longDescription":"` + strings.Repeat("x", 4001) + `"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseStoreListing([]byte(body), storeFiles()); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestBundleWithStore(t *testing.T) {
	manifest, err := os.ReadFile(filepath.Join("..", "..", "testdata", "manifests", "valid", "minimal.json"))
	if err != nil {
		t.Fatal(err)
	}
	bundle := NewBundle(manifest, nil)
	if _, _, ok := bundle.StoreListing(); ok {
		t.Fatal("a bundle without store metadata must report none")
	}
	with := bundle.WithStore([]byte(validStore), storeFiles())
	listing, assets, ok := with.StoreListing()
	if !ok || assets == nil || listing.Publisher.Name != "Tilecast" {
		t.Fatalf("StoreListing = %+v %v %v", listing, assets, ok)
	}
	if _, _, ok := bundle.StoreListing(); ok {
		t.Fatal("WithStore must not mutate the original bundle")
	}
	var _ StoreArtworkSource = with
	defer func() {
		if recover() == nil {
			t.Fatal("invalid store metadata must panic like an invalid manifest")
		}
	}()
	bundle.WithStore([]byte(`{}`), nil)
}

func TestStoreArtworkContentType(t *testing.T) {
	for name, want := range map[string]string{"a.webp": "image/webp", "a.WEBP": "image/webp", "a.png": "image/png"} {
		if got, ok := StoreArtworkContentType(name); !ok || got != want {
			t.Errorf("%s = %q %v", name, got, ok)
		}
	}
	if _, ok := StoreArtworkContentType("a.svg"); ok {
		t.Error("svg must not be a supported artwork type")
	}
}
