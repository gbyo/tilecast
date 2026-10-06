package catalog

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCanonicalMarketplaceCatalogSource(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "..", "marketplace", "catalog.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	var source struct {
		FormatVersion int       `json:"formatVersion"`
		Listings      []Listing `json:"listings"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&source); err != nil {
		t.Fatalf("decode canonical marketplace catalog: %v", err)
	}
	if source.FormatVersion != CatalogFormatVersion {
		t.Fatalf("formatVersion = %d, want %d", source.FormatVersion, CatalogFormatVersion)
	}

	seen := make(map[string]bool, len(source.Listings))
	for index, listing := range source.Listings {
		if err := validateListing(listing); err != nil {
			t.Fatalf("listing %d (%s): %v", index, listing.PackageID, err)
		}
		if seen[listing.PackageID] {
			t.Fatalf("listing %d: duplicate package %s", index, listing.PackageID)
		}
		seen[listing.PackageID] = true
		if index > 0 && source.Listings[index-1].PackageID >= listing.PackageID {
			t.Fatalf(
				"catalog listings must be sorted by packageId: %s appears before %s",
				source.Listings[index-1].PackageID,
				listing.PackageID,
			)
		}
	}
}
