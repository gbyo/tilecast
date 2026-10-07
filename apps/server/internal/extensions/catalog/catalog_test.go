package catalog

import (
	"encoding/json"
	"strings"
	"testing"
)

// validTestListing builds a listing that passes validation. Tests mutate
// one field at a time to prove each rule rejects.
func validTestListing() Listing {
	return Listing{
		PackageID:     "acme.athletics",
		Version:       "2.4.1",
		Name:          "Athletics",
		Description:   "Scoreboards.",
		Publisher:     Publisher{ID: "acme", Name: "Acme"},
		License:       "MIT",
		TilecastRange: ">=1.2.0 <2.0.0",
		OCI:           "ghcr.io/acme/tilecast-athletics",
		Digest:        testDigest,
		Repository:    "https://github.com/acme/tilecast-athletics",
		Categories:    []string{"sports", "data"},
		Featured:      true,
	}
}

func encodeTestDocument(t *testing.T, listings []Listing) []byte {
	t.Helper()
	payload, err := json.Marshal(Document{FormatVersion: CatalogFormatVersion, Listings: listings})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestParseCatalog(t *testing.T) {
	document, err := ParseCatalog(encodeTestDocument(t, []Listing{validTestListing()}))
	if err != nil {
		t.Fatalf("valid catalog rejected: %v", err)
	}
	if len(document.Listings) != 1 || !document.Listings[0].Featured {
		t.Fatalf("document = %+v", document)
	}
}

func TestParseCatalogAcceptsEmpty(t *testing.T) {
	document, err := ParseCatalog(encodeTestDocument(t, nil))
	if err != nil {
		t.Fatalf("empty catalog rejected: %v", err)
	}
	if len(document.Listings) != 0 {
		t.Fatalf("document = %+v", document)
	}
}

func TestParseCatalogRejects(t *testing.T) {
	second := validTestListing()
	second.PackageID = "acme.baseball"
	for name, listings := range map[string][]Listing{
		"duplicate package": {validTestListing(), validTestListing()},
		"unsorted":          {second, validTestListing()},
	} {
		// "unsorted" needs the greater ID first: acme.baseball sorts
		// after acme.athletics, so the second-then-valid order breaks
		// the sort.
		if _, err := ParseCatalog(encodeTestDocument(t, listings)); err == nil {
			t.Fatalf("%s: expected a rejection", name)
		}
	}
	for _, payload := range []string{
		`{"formatVersion":2,"listings":[]}`,
		`{"formatVersion":1,"listings":[],"extra":true}`,
		`not json`,
	} {
		if _, err := ParseCatalog([]byte(payload)); err == nil {
			t.Fatalf("%s: expected a rejection", payload)
		}
	}
}

func TestValidateListingRejects(t *testing.T) {
	for name, mutate := range map[string]func(*Listing){
		"unqualified id":      func(l *Listing) { l.PackageID = "athletics" },
		"reserved namespace":  func(l *Listing) { l.PackageID = "tilecast.athletics" },
		"namespace mismatch":  func(l *Listing) { l.PackageID = "other.athletics" },
		"bad version":         func(l *Listing) { l.Version = "2.4" },
		"empty name":          func(l *Listing) { l.Name = "" },
		"long name":           func(l *Listing) { l.Name = strings.Repeat("n", 81) },
		"empty description":   func(l *Listing) { l.Description = "" },
		"long description":    func(l *Listing) { l.Description = strings.Repeat("d", 501) },
		"bad publisher id":    func(l *Listing) { l.Publisher.ID = "acme.co" },
		"empty publisher":     func(l *Listing) { l.Publisher.Name = "" },
		"empty license":       func(l *Listing) { l.License = "" },
		"bad range":           func(l *Listing) { l.TilecastRange = "someday" },
		"tagged oci":          func(l *Listing) { l.OCI = "ghcr.io/acme/tilecast-athletics:latest" },
		"unpinned digest":     func(l *Listing) { l.Digest = "v2.4.1" },
		"empty repository":    func(l *Listing) { l.Repository = "" },
		"deep repository":     func(l *Listing) { l.Repository = "https://github.com/acme/tilecast-athletics/issues" },
		"http repository":     func(l *Listing) { l.Repository = "http://github.com/acme/tilecast-athletics" },
		"non-github repo":     func(l *Listing) { l.Repository = "https://example.com/acme/tilecast-athletics" },
		"shallow repo":        func(l *Listing) { l.Repository = "https://github.com/acme" },
		"credentialed repo":   func(l *Listing) { l.Repository = "https://user@github.com/acme/tilecast-athletics" },
		"bad documentation":   func(l *Listing) { l.Documentation = "not a url" },
		"http documentation":  func(l *Listing) { l.Documentation = "http://example.com/docs" },
		"bad issues":          func(l *Listing) { l.Issues = "not a url" },
		"too many categories": func(l *Listing) { l.Categories = []string{"a", "b", "c", "d", "e", "f"} },
		"bad category":        func(l *Listing) { l.Categories = []string{"Sports!"} },
		"empty category":      func(l *Listing) { l.Categories = []string{""} },
		"duplicate category":  func(l *Listing) { l.Categories = []string{"data", "data"} },
	} {
		t.Run(name, func(t *testing.T) {
			listing := validTestListing()
			mutate(&listing)
			if err := validateListing(listing); err == nil {
				t.Fatalf("%s: expected a rejection", name)
			}
		})
	}
}

func TestValidateListingAcceptsRepositoryShapes(t *testing.T) {
	for _, repository := range []string{
		"https://github.com/acme/tilecast-athletics",
		"https://github.com/acme/tilecast-athletics/",
		"https://github.com/acme/tilecast-athletics.git",
	} {
		listing := validTestListing()
		listing.Repository = repository
		if err := validateListing(listing); err != nil {
			t.Fatalf("%s: %v", repository, err)
		}
	}
}

func TestValidateListingAcceptsMinimal(t *testing.T) {
	listing := validTestListing()
	listing.Documentation = ""
	listing.Issues = ""
	listing.Categories = nil
	listing.Featured = false
	listing.Icon = ""
	listing.Screenshots = nil
	if err := validateListing(listing); err != nil {
		t.Fatalf("minimal listing rejected: %v", err)
	}
}

func TestOfficialCatalogURL(t *testing.T) {
	if !strings.HasPrefix(OfficialCatalogURL, "https://raw.githubusercontent.com/gbyo/tilecast/") {
		t.Fatalf("official catalog URL = %q", OfficialCatalogURL)
	}
	if !strings.HasSuffix(OfficialCatalogURL, "/marketplace/catalog.json") {
		t.Fatalf("official catalog URL = %q", OfficialCatalogURL)
	}
}
