package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

const (
	catalogEtag = `"catalog-v1"`
	testDigest  = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

type catalogFixture struct {
	pool *pgxpool.Pool
}

func newCatalogFixture(t *testing.T) *catalogFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Catalog Test',$1)`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	return &catalogFixture{pool: pool}
}

func (f *catalogFixture) service(url string) *Service {
	return NewServiceWithURL(f.pool, url)
}

func (f *catalogFixture) document(mutate func(*Document)) json.RawMessage {
	document := Document{
		FormatVersion: CatalogFormatVersion,
		Listings: []Listing{{
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
		}},
	}
	if mutate != nil {
		mutate(&document)
	}
	payload, err := json.Marshal(document)
	if err != nil {
		panic(err)
	}
	return payload
}

// marketplace serves one catalog document, honoring If-None-Match.
func (f *catalogFixture) marketplace(t *testing.T, document func() []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == catalogEtag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", catalogEtag)
		_, _ = w.Write(document())
	}))
}

func TestRefreshCachesCatalog(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	payload := f.document(nil)
	server := f.marketplace(t, func() []byte { return payload })
	defer server.Close()

	service := f.service(server.URL)
	if err := service.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	cached, err := service.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cached.FetchedAt.IsZero() || cached.LastError != "" {
		t.Fatalf("cache state = %+v", cached)
	}
	if len(cached.Document.Listings) != 1 || cached.Document.Listings[0].Digest != testDigest {
		t.Fatalf("listings = %+v", cached.Document.Listings)
	}
	if got := cached.Document.Listings[0].Categories; len(got) != 2 || got[0] != "sports" {
		t.Fatalf("categories = %v", got)
	}
	if !cached.Document.Listings[0].Featured {
		t.Fatal("featured listing lost its flag")
	}
	if cached.Stale() {
		t.Fatal("fresh cache reports stale")
	}
	listing, _, err := service.ListingFor(ctx, "acme.athletics")
	if err != nil {
		t.Fatal(err)
	}
	if listing.Version != "2.4.1" {
		t.Fatalf("listing = %+v", listing)
	}
	if _, _, err := service.ListingFor(ctx, "no.such"); !errors.Is(err, ErrUnknownPackage) {
		t.Fatalf("unknown listing = %v, want ErrUnknownPackage", err)
	}

	// A 304 revalidation keeps the document and clears errors.
	if err := service.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	cached, err = service.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached.Document.Listings) != 1 {
		t.Fatalf("listings after 304 = %d", len(cached.Document.Listings))
	}
}

func TestRefreshRejectsMalformedCatalogs(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	good := f.document(nil)
	current := append([]byte(nil), good...)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(current)
	}))
	defer server.Close()
	service := f.service(server.URL)
	if err := service.Refresh(ctx); err != nil {
		t.Fatal(err)
	}

	for name, body := range map[string][]byte{
		"not json":      []byte("{oops"),
		"bad format":    f.document(func(d *Document) { d.FormatVersion = 999 }),
		"unknown field": []byte(`{"formatVersion":1,"listings":[],"surprise":true}`),
		"duplicate":     f.document(func(d *Document) { d.Listings = append(d.Listings, d.Listings[0]) }),
		"unsorted": f.document(func(d *Document) {
			d.Listings = append(d.Listings, d.Listings[0])
			d.Listings[0].PackageID = "zzz.last"
		}),
		"bad package id":   f.document(func(d *Document) { d.Listings[0].PackageID = "tilecast.athletics" }),
		"bad version":      f.document(func(d *Document) { d.Listings[0].Version = "2.4" }),
		"bad digest":       f.document(func(d *Document) { d.Listings[0].Digest = "v2.4.1" }),
		"http repository":  f.document(func(d *Document) { d.Listings[0].Repository = "http://github.com/acme/tilecast-athletics" }),
		"wrong host":       f.document(func(d *Document) { d.Listings[0].Repository = "https://example.com/acme/tilecast-athletics" }),
		"shallow path":     f.document(func(d *Document) { d.Listings[0].Repository = "https://github.com/acme" }),
		"deep repo path":   f.document(func(d *Document) { d.Listings[0].Repository = "https://github.com/acme/tilecast-athletics/issues" }),
		"bad issues link":  f.document(func(d *Document) { d.Listings[0].Issues = "not a url" }),
		"bad category":     f.document(func(d *Document) { d.Listings[0].Categories = []string{"Sports!"} }),
		"duplicate cat":    f.document(func(d *Document) { d.Listings[0].Categories = []string{"data", "data"} }),
		"namespace breach": f.document(func(d *Document) { d.Listings[0].PackageID = "other.athletics" }),
	} {
		t.Run(name, func(t *testing.T) {
			current = body
			if err := service.Refresh(ctx); err == nil {
				t.Fatalf("%s: expected a rejection", name)
			}
			cached, err := service.Cached(ctx)
			if err != nil {
				t.Fatal(err)
			}
			// The malformed catalog never replaces the last valid one.
			if len(cached.Document.Listings) != 1 || cached.Document.Listings[0].PackageID != "acme.athletics" {
				t.Fatalf("%s: cache = %+v, want last valid document", name, cached.Document)
			}
			if cached.LastError == "" || !cached.Stale() {
				t.Fatalf("%s: cache records no failure: %+v", name, cached)
			}
		})
	}

	// A successful refresh replaces the failed document and clears the error.
	current = good
	if err := service.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	cached, err := service.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cached.LastError != "" || cached.Stale() {
		t.Fatalf("last error after recovery = %q", cached.LastError)
	}
}

func TestRefreshFailsClosedAndKeepsCache(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	good := f.document(nil)
	current := append([]byte(nil), good...)
	var failing atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failing.Load() {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(current)
	}))
	defer server.Close()
	service := f.service(server.URL)
	if err := service.Refresh(ctx); err != nil {
		t.Fatal(err)
	}

	failing.Store(true)
	if err := service.Refresh(ctx); err == nil {
		t.Fatal("expected a fetch failure")
	}
	cached, err := service.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached.Document.Listings) != 1 || cached.LastError == "" {
		t.Fatalf("cache after failure = %+v", cached)
	}
	if !strings.Contains(cached.LastError, "HTTP 500") {
		t.Fatalf("last error = %q", cached.LastError)
	}

	failing.Store(false)
	if err := service.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	cached, err = service.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cached.LastError != "" {
		t.Fatalf("last error after recovery = %q", cached.LastError)
	}
}

func TestUnacceptableURLs(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	for _, raw := range []string{"ftp://example.com/catalog.json", "http://example.com/catalog.json", "://bad"} {
		service := f.service(raw)
		if err := service.Refresh(ctx); err == nil {
			t.Fatalf("%s: expected an unacceptable-URL error", raw)
		}
	}
}

func TestRefreshIfStale(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	payload := f.document(nil)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	service := f.service(server.URL)

	// A missing cache fetches.
	if err := service.RefreshIfStale(ctx); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d, want 1", requests.Load())
	}
	// A fresh cache makes no request.
	if err := service.RefreshIfStale(ctx); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d, want still 1", requests.Load())
	}
	// An old cache fetches again.
	if _, err := f.pool.Exec(ctx, `UPDATE marketplace_catalog_cache SET fetched_at = now() - make_interval(hours => 2)`); err != nil {
		t.Fatal(err)
	}
	if err := service.RefreshIfStale(ctx); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatalf("requests = %d, want 2", requests.Load())
	}

	// A failed fetch errors once, then backs off without new requests.
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	defer failing.Close()
	if _, err := f.pool.Exec(ctx, `TRUNCATE marketplace_catalog_cache`); err != nil {
		t.Fatal(err)
	}
	broken := f.service(failing.URL)
	if err := broken.RefreshIfStale(ctx); err == nil {
		t.Fatal("expected a refresh error")
	}
	before := requests.Load()
	if err := broken.RefreshIfStale(ctx); err != nil {
		t.Fatalf("backed-off refresh = %v, want nil", err)
	}
	if requests.Load() != before {
		t.Fatal("backed-off refresh made a request")
	}
	// A manual refresh always attempts, ignoring the backoff.
	if err := broken.Refresh(ctx); err == nil {
		t.Fatal("expected a manual refresh error")
	}
	if requests.Load() != before+1 {
		t.Fatalf("requests = %d, want one manual attempt", requests.Load())
	}
}

func TestBundledFallback(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	bundled, err := Bundled()
	if err != nil {
		t.Fatalf("bundled snapshot is invalid: %v", err)
	}

	// No database cache: the bundled snapshot serves.
	cached, err := f.service("http://127.0.0.1:1/catalog.json").Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !cached.FetchedAt.IsZero() || cached.LastError != "" {
		t.Fatalf("bundled cache state = %+v", cached)
	}
	if len(cached.Document.Listings) != len(bundled.Listings) {
		t.Fatalf("bundled listings = %d, want %d", len(cached.Document.Listings), len(bundled.Listings))
	}

	// A failed first refresh keeps serving the bundled listings with the
	// failure recorded.
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	defer failing.Close()
	broken := f.service(failing.URL)
	if err := broken.Refresh(ctx); err == nil {
		t.Fatal("expected a refresh error")
	}
	cached, err = broken.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached.Document.Listings) != len(bundled.Listings) {
		t.Fatalf("listings after failed first refresh = %d, want bundled %d", len(cached.Document.Listings), len(bundled.Listings))
	}
	if cached.LastError == "" || !cached.Stale() {
		t.Fatalf("failed first refresh records no failure: %+v", cached)
	}

	// A later successful refresh replaces the bundled snapshot.
	payload := f.document(nil)
	server := f.marketplace(t, func() []byte { return payload })
	defer server.Close()
	if err := f.service(server.URL).Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	cached, err = f.service(server.URL).Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached.Document.Listings) != 1 || cached.LastError != "" {
		t.Fatalf("cache after refresh = %+v", cached)
	}
}

func TestUpdateAvailable(t *testing.T) {
	if !UpdateAvailable("2.4.0", "2.4.1") {
		t.Fatal("2.4.0 -> 2.4.1 should offer an update")
	}
	if UpdateAvailable("2.4.1", "2.4.1") {
		t.Fatal("equal versions should not offer an update")
	}
	if UpdateAvailable("2.5.0", "2.4.1") {
		t.Fatal("downgrade should not offer an update")
	}
	if UpdateAvailable("2.4", "2.4.1") {
		t.Fatal("unordered versions should not offer an update")
	}
}
