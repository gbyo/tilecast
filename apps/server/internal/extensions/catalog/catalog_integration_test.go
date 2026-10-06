package catalog

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/trust"
)

const (
	catalogKeyID = "tilecast-marketplace-test"
	catalogEtag  = `"catalog-v1"`
	testDigest   = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

type catalogFixture struct {
	pool    *pgxpool.Pool
	public  ed25519.PublicKey
	private ed25519.PrivateKey
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
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &catalogFixture{pool: pool, public: public, private: private}
}

func (f *catalogFixture) service(t *testing.T, url string) *Service {
	t.Helper()
	verifier, err := trust.NewEd25519Verifier(catalogKeyID, f.public)
	if err != nil {
		t.Fatal(err)
	}
	return NewService(f.pool, url, verifier)
}

func (f *catalogFixture) document(expiresAt time.Time, mutate func(*Document)) json.RawMessage {
	now := time.Now().UTC().Truncate(time.Second)
	document := Document{
		FormatVersion: CatalogFormatVersion,
		IssuedAt:      now,
		ExpiresAt:     expiresAt,
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

func (f *catalogFixture) envelope(t *testing.T, payload json.RawMessage) []byte {
	t.Helper()
	signature := ed25519.Sign(f.private, payload)
	data, err := json.Marshal(trust.Envelope{
		Payload:    payload,
		Signatures: []trust.Signature{{KeyID: catalogKeyID, Signature: base64.StdEncoding.EncodeToString(signature)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// marketplace serves one signed envelope, honoring If-None-Match.
func (f *catalogFixture) marketplace(t *testing.T, envelope func() []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == catalogEtag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", catalogEtag)
		_, _ = w.Write(envelope())
	}))
}

func TestRefreshCachesVerifiedCatalog(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	payload := f.document(time.Now().Add(24*time.Hour), nil)
	server := f.marketplace(t, func() []byte { return f.envelope(t, payload) })
	defer server.Close()

	service := f.service(t, server.URL)
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
	if cached.Stale(time.Now()) {
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

func TestRefreshFailsClosedAndKeepsCache(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	good := f.document(time.Now().Add(24*time.Hour), nil)
	current := f.envelope(t, good)
	server := f.marketplace(t, func() []byte { return current })
	defer server.Close()
	service := f.service(t, server.URL)
	if err := service.Refresh(ctx); err != nil {
		t.Fatal(err)
	}

	// A broken signature fails verification; the cache keeps serving.
	signed := f.envelope(t, good)
	var decoded struct {
		Payload    json.RawMessage `json:"payload"`
		Signatures []struct {
			KeyID     string `json:"keyId"`
			Signature string `json:"signature"`
		} `json:"signatures"`
	}
	if err := json.Unmarshal(signed, &decoded); err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(decoded.Signatures[0].Signature)
	if err != nil {
		t.Fatal(err)
	}
	raw[0] ^= 0xff
	decoded.Signatures[0].Signature = base64.StdEncoding.EncodeToString(raw)
	broken, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	current = broken
	// Bypass the 304 path: the failure cases need fresh bodies.
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(current)
	})
	if err := service.Refresh(ctx); err == nil {
		t.Fatal("expected a verification failure")
	}
	cached, err := service.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached.Document.Listings) != 1 || cached.LastError == "" {
		t.Fatalf("cache after failure = %+v", cached)
	}
	if !strings.Contains(cached.LastError, "does not verify") {
		t.Fatalf("last error = %q", cached.LastError)
	}

	// An expired document is rejected the same way.
	expired := f.document(time.Now().Add(-time.Hour), nil)
	current = f.envelope(t, expired)
	if err := service.Refresh(ctx); err == nil {
		t.Fatal("expected an expiry failure")
	}
	cached, err = service.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached.Document.Listings) != 1 || !strings.Contains(cached.LastError, "expired") {
		t.Fatalf("cache after expiry = %+v", cached)
	}

	// A successful refresh clears the recorded error.
	current = f.envelope(t, good)
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

func TestRefreshRejectsBadListings(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	for name, mutate := range map[string]func(*Document){
		"bad digest": func(d *Document) {
			d.Listings[0].Digest = "v2.4.1"
		},
		"bad package id": func(d *Document) {
			d.Listings[0].PackageID = "tilecast.athletics"
		},
		"bad version": func(d *Document) {
			d.Listings[0].Version = "2.4"
		},
		"duplicate package": func(d *Document) {
			d.Listings = append(d.Listings, d.Listings[0])
		},
		"missing repository": func(d *Document) {
			d.Listings[0].Repository = ""
		},
		"http repository": func(d *Document) {
			d.Listings[0].Repository = "http://github.com/acme/tilecast-athletics"
		},
		"bad issues link": func(d *Document) {
			d.Listings[0].Issues = "not a url"
		},
	} {
		t.Run(name, func(t *testing.T) {
			payload := f.document(time.Now().Add(24*time.Hour), mutate)
			server := f.marketplace(t, func() []byte { return f.envelope(t, payload) })
			defer server.Close()
			// Fresh database state per case would need a new fixture; the
			// cases share one cache and each must fail without caching.
			if _, err := f.pool.Exec(ctx, `TRUNCATE marketplace_catalog_cache`); err != nil {
				t.Fatal(err)
			}
			service := f.service(t, server.URL)
			if err := service.Refresh(ctx); err == nil {
				t.Fatalf("%s: expected a rejection", name)
			}
			cached, err := service.Cached(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !cached.FetchedAt.IsZero() {
				t.Fatalf("%s: bad document was cached", name)
			}
		})
	}
}

func TestDisabledAndUnacceptableURLs(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	disabled := f.service(t, "")
	if disabled.Enabled() {
		t.Fatal("empty URL service reports enabled")
	}
	if err := disabled.Refresh(ctx); !errors.Is(err, ErrDisabled) {
		t.Fatalf("refresh = %v, want ErrDisabled", err)
	}
	cached, err := disabled.Cached(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !cached.FetchedAt.IsZero() || !cached.Stale(time.Now()) {
		t.Fatalf("disabled cache = %+v", cached)
	}
	for _, raw := range []string{"ftp://example.com/catalog.json", "http://example.com/catalog.json", "://bad"} {
		service := f.service(t, raw)
		if err := service.Refresh(ctx); !errors.Is(err, ErrDisabled) {
			t.Fatalf("%s: refresh = %v, want ErrDisabled", raw, err)
		}
	}
}

func TestRefreshIfStale(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	payload := f.document(time.Now().Add(24*time.Hour), nil)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(f.envelope(t, payload))
	}))
	defer server.Close()

	service := f.service(t, server.URL)

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
	// An expired row fetches again. The row is seeded directly: the
	// refresh path itself would never cache an expired document.
	if _, err := f.pool.Exec(ctx, `UPDATE marketplace_catalog_cache SET expires_at=now()-interval '1 hour'`); err != nil {
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
	broken := f.service(t, failing.URL)
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
	// Disabled services answer nil.
	if err := f.service(t, "").RefreshIfStale(ctx); err != nil {
		t.Fatalf("disabled RefreshIfStale = %v", err)
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
