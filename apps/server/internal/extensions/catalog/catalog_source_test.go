package catalog

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TestCanonicalMarketplaceCatalogSource validates the repository catalog
// with the same validator the server uses for fetched documents, so an
// invalid listing cannot merge silently.
func TestCanonicalMarketplaceCatalogSource(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "..", "marketplace", "catalog.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseCatalog(data); err != nil {
		t.Fatalf("canonical marketplace catalog: %v", err)
	}
}

// TestBundledCatalogMatchesSource fails when the embedded snapshot drifts
// from the repository catalog. Run make generate to refresh the copy.
func TestBundledCatalogMatchesSource(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "..", "marketplace", "catalog.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, bundledCatalog) {
		t.Fatal("bundled marketplace snapshot drifts from marketplace/catalog.json; run make generate")
	}
	if _, err := Bundled(); err != nil {
		t.Fatalf("bundled marketplace snapshot: %v", err)
	}
}
