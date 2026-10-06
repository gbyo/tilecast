// Package catalog fetches, verifies, and caches the signed Tilecast
// marketplace catalog.
//
// The marketplace is a remote listing of curated extension packages. The
// server treats its bytes as untrusted input until the pinned marketplace
// key verifies the signed envelope; only verified documents reach the
// cache, and only cached listings reach the store. A failed refresh keeps
// serving the last verified document with its age and error, rather than
// blanking the store or serving unverified bytes.
//
// The marketplace is disabled until the operator configures both a catalog
// URL and a public key. Half configuration refuses to enable: an unsigned
// catalog is never fetched, and a key without a catalog has nothing to
// verify.
package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/trust"
	"github.com/tilecast/tilecast/apps/server/internal/version"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

var (
	// ErrDisabled answers refreshes and lookups when no catalog is configured.
	ErrDisabled = errors.New("marketplace catalog is not configured")
	// ErrUnverified answers a catalog document no pinned key covers.
	ErrUnverified = errors.New("marketplace catalog signature does not verify")
	// ErrExpired answers a catalog document past its expiry.
	ErrExpired = errors.New("marketplace catalog is expired")
	// ErrUnknownPackage answers a listing lookup the cache does not hold.
	ErrUnknownPackage = errors.New("marketplace package is not listed")
)

const (
	// CatalogFormatVersion is the marketplace catalog document version.
	CatalogFormatVersion = 1
	// MaxCatalogBytes caps a fetched catalog envelope before it parses.
	MaxCatalogBytes = 5 << 20
	// fetchTimeout bounds one catalog fetch.
	fetchTimeout = 30 * time.Second
	// clockSkew tolerates issued-at timestamps slightly ahead of this clock.
	clockSkew = 5 * time.Minute
	// staleRetryBackoff is how long RefreshIfStale waits after a failed
	// fetch before trying again. The last verified document keeps
	// serving meanwhile.
	staleRetryBackoff = 15 * time.Minute
)

// Publisher names the listing publisher.
type Publisher struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Listing is one validated marketplace package: display metadata, the
// compatibility range, the immutable artifact address, and the source,
// documentation, and issue links Studio shows. The link shapes mirror the
// package manifest so an install can cross-check them later.
type Listing struct {
	PackageID     string    `json:"packageId"`
	Version       string    `json:"version"`
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	Publisher     Publisher `json:"publisher"`
	License       string    `json:"license"`
	TilecastRange string    `json:"tilecastRange"`
	OCI           string    `json:"oci"`
	Digest        string    `json:"digest"`
	Repository    string    `json:"repository"`
	Documentation string    `json:"documentation,omitempty"`
	Issues        string    `json:"issues,omitempty"`
}

// Document is one validated marketplace catalog.
type Document struct {
	FormatVersion int       `json:"formatVersion"`
	IssuedAt      time.Time `json:"issuedAt"`
	ExpiresAt     time.Time `json:"expiresAt"`
	Listings      []Listing `json:"listings"`
}

// Cached pairs the last verified document with its cache state. FetchedAt
// is zero when no refresh has ever succeeded.
type Cached struct {
	Document  Document
	FetchedAt time.Time
	LastError string
}

// Stale reports whether the cache is missing or past the document expiry.
func (c Cached) Stale(now time.Time) bool {
	if c.FetchedAt.IsZero() {
		return true
	}
	return !now.Before(c.Document.ExpiresAt)
}

// Service fetches and caches the marketplace catalog.
type Service struct {
	db       *pgxpool.Pool
	client   *http.Client
	url      string
	verifier trust.Verifier

	// staleMu guards staleRetryAfter, the process-local backoff
	// RefreshIfStale observes after a failed fetch.
	staleMu         sync.Mutex
	staleRetryAfter time.Time
}

// NewService pins one marketplace catalog URL and signing key. An empty
// URL disables the service: Refresh and Cached answer ErrDisabled and no
// request ever leaves the server.
func NewService(db *pgxpool.Pool, catalogURL string, verifier trust.Verifier) *Service {
	catalogURL = strings.TrimSpace(catalogURL)
	origin, _ := url.Parse(catalogURL)
	client := &http.Client{Timeout: fetchTimeout}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many catalog redirects")
		}
		if !fetchableURL(req.URL) {
			return errors.New("catalog redirected to an unacceptable URL")
		}
		if origin == nil || !sameOrigin(origin, req.URL) {
			return errors.New("catalog redirect changed origin")
		}
		return nil
	}
	return &Service{db: db, client: client, url: catalogURL, verifier: verifier}
}

func sameOrigin(left, right *url.URL) bool {
	return left != nil &&
		right != nil &&
		strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Host, right.Host)
}

// Enabled reports whether a catalog URL is configured.
func (s *Service) Enabled() bool { return s.url != "" }

// fetchableURL accepts https anywhere and http only on loopback, so tests
// can serve a catalog without the product ever fetching one in cleartext.
func fetchableURL(u *url.URL) bool {
	if u == nil || u.Hostname() == "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	if u.Scheme != "http" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// Refresh fetches the catalog, verifies its signature, validates the
// document, and caches it. A 304 keeps the cached document and clears the
// recorded error. Any other failure records its error and keeps serving
// the last verified document.
func (s *Service) Refresh(ctx context.Context) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	parsed, err := url.Parse(s.url)
	if err != nil || !fetchableURL(parsed) {
		return fmt.Errorf("marketplace catalog URL is unacceptable: %w", ErrDisabled)
	}
	cached, etag, err := s.cachedRow(ctx)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "Tilecast-Server/"+version.Display()+" (+https://github.com/gbyo/tilecast)")
	request.Header.Set("Accept", "application/json")
	if etag != "" && !cached.Stale(time.Now()) {
		request.Header.Set("If-None-Match", etag)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return s.recordError(ctx, fmt.Sprintf("fetch failed: %v", err))
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
		if cached.Stale(time.Now()) {
			return s.recordError(ctx, "catalog answered 304 for a stale cache")
		}
		return s.recordRefreshed(ctx)
	}
	if response.StatusCode != http.StatusOK {
		return s.recordError(ctx, fmt.Sprintf("fetch answered HTTP %d", response.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxCatalogBytes+1))
	if err != nil {
		return s.recordError(ctx, fmt.Sprintf("fetch failed: %v", err))
	}
	if int64(len(body)) > MaxCatalogBytes {
		return s.recordError(ctx, fmt.Sprintf("catalog exceeds %d bytes", MaxCatalogBytes))
	}
	payload, err := trust.VerifyEnvelope(body, s.verifier)
	if err != nil {
		return s.recordError(ctx, fmt.Sprintf("%v: %v", ErrUnverified, err))
	}
	document, err := ParseDocument(payload, time.Now())
	if err != nil {
		return s.recordError(ctx, err.Error())
	}
	return s.store(ctx, payload, response.Header.Get("ETag"), document.ExpiresAt)
}

// RefreshIfStale refreshes the catalog when the cache is missing or past
// its expiry, and does nothing when the cached document is still fresh.
// A failed fetch records its error in the cache row and backs off: the
// next attempt waits staleRetryBackoff, while the last verified document
// keeps serving. A manual Refresh always attempts and never consults the
// backoff. Disabled services answer nil.
func (s *Service) RefreshIfStale(ctx context.Context) error {
	if !s.Enabled() {
		return nil
	}
	s.staleMu.Lock()
	wait := time.Now().Before(s.staleRetryAfter)
	s.staleMu.Unlock()
	if wait {
		return nil
	}
	now := time.Now()
	cached, err := s.Cached(ctx)
	if err != nil {
		return err
	}
	if !cached.Stale(now) {
		return nil
	}
	if err := s.Refresh(ctx); err != nil {
		s.staleMu.Lock()
		s.staleRetryAfter = time.Now().Add(staleRetryBackoff)
		s.staleMu.Unlock()
		return err
	}
	s.staleMu.Lock()
	s.staleRetryAfter = time.Time{}
	s.staleMu.Unlock()
	return nil
}

// Cached returns the last verified catalog document and its cache state.
// No successful refresh yet answers a zero Cached, not an error: callers
// without a marketplace show no marketplace entries.
func (s *Service) Cached(ctx context.Context) (Cached, error) {
	cached, _, err := s.cachedRow(ctx)
	return cached, err
}

func (s *Service) cachedRow(ctx context.Context) (Cached, string, error) {
	var cached Cached
	var etag, documentURL, keyID string
	var payload []byte
	var fetchedAt, expiresAt pgtype.Timestamptz
	err := s.db.QueryRow(ctx, `SELECT document_url,key_id,payload,etag,
		fetched_at,expires_at,last_error FROM marketplace_catalog_cache`).Scan(
		&documentURL, &keyID, &payload, &etag, &fetchedAt, &expiresAt, &cached.LastError)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Cached{}, "", nil
		}
		return Cached{}, "", err
	}
	if documentURL != s.url || s.verifier == nil || keyID != s.verifier.KeyID() {
		return Cached{}, "", nil
	}
	if len(payload) == 0 {
		return cached, "", nil
	}
	if !fetchedAt.Valid || !expiresAt.Valid {
		return Cached{}, "", errors.New("cached catalog metadata is incomplete")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cached.Document); err != nil {
		return Cached{}, "", fmt.Errorf("cached catalog is corrupt: %w", err)
	}
	if !cached.Document.ExpiresAt.Equal(expiresAt.Time) {
		return Cached{}, "", errors.New("cached catalog expiry does not match verified payload")
	}
	cached.FetchedAt = fetchedAt.Time
	return cached, etag, nil
}

// ListingFor returns one cached listing.
func (s *Service) ListingFor(ctx context.Context, packageID string) (Listing, Cached, error) {
	cached, err := s.Cached(ctx)
	if err != nil {
		return Listing{}, Cached{}, err
	}
	for _, listing := range cached.Document.Listings {
		if listing.PackageID == packageID {
			return listing, cached, nil
		}
	}
	return Listing{}, cached, ErrUnknownPackage
}

// UpdateAvailable reports whether the listing carries a newer version than
// the installed one. Either version malformed answers false: an update the
// server cannot order is not offered.
func UpdateAvailable(installed, listed string) bool {
	order, ok := packagemanifest.CompareSemver(installed, listed)
	return ok && order < 0
}

// ParseDocument decodes and validates one verified catalog payload.
func ParseDocument(payload []byte, now time.Time) (Document, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var document Document
	if err := decoder.Decode(&document); err != nil {
		return Document{}, fmt.Errorf("marketplace catalog: %w", err)
	}
	if document.FormatVersion != CatalogFormatVersion {
		return Document{}, fmt.Errorf("marketplace catalog: unsupported format version %d", document.FormatVersion)
	}
	if document.IssuedAt.After(now.Add(clockSkew)) {
		return Document{}, fmt.Errorf("marketplace catalog: issued in the future")
	}
	if !now.Before(document.ExpiresAt) {
		return Document{}, fmt.Errorf("marketplace catalog: %w", ErrExpired)
	}
	seen := make(map[string]bool, len(document.Listings))
	for index, listing := range document.Listings {
		if err := validateListing(listing); err != nil {
			return Document{}, fmt.Errorf("marketplace catalog listing %d: %w", index, err)
		}
		if seen[listing.PackageID] {
			return Document{}, fmt.Errorf("marketplace catalog listing %d: duplicate package %s", index, listing.PackageID)
		}
		seen[listing.PackageID] = true
	}
	return document, nil
}

func validateListing(listing Listing) error {
	if !packagemanifest.ValidPackageID(listing.PackageID) {
		return fmt.Errorf("packageId %q is not loadable", listing.PackageID)
	}
	if !packagemanifest.ValidSemVer(listing.Version) {
		return fmt.Errorf("version %q is not SemVer", listing.Version)
	}
	if listing.Name == "" || len(listing.Name) > 80 {
		return fmt.Errorf("name must be 1 to 80 characters")
	}
	if listing.Description == "" || len(listing.Description) > 500 {
		return fmt.Errorf("description must be 1 to 500 characters")
	}
	if !packagemanifest.ValidPublisherID(listing.Publisher.ID) {
		return fmt.Errorf("publisher id %q is not one namespace segment", listing.Publisher.ID)
	}
	if listing.Publisher.Name == "" || len(listing.Publisher.Name) > 80 {
		return fmt.Errorf("publisher name must be 1 to 80 characters")
	}
	if listing.PackageID != listing.Publisher.ID && !strings.HasPrefix(listing.PackageID, listing.Publisher.ID+".") {
		return fmt.Errorf("packageId must start with the publisher namespace")
	}
	if listing.License == "" || len(listing.License) > 32 {
		return fmt.Errorf("license must be 1 to 32 characters")
	}
	if !packagemanifest.ValidTilecastRange(listing.TilecastRange) {
		return fmt.Errorf("tilecast range %q is invalid", listing.TilecastRange)
	}
	if !packagemanifest.ValidOCIReference(listing.OCI) {
		return fmt.Errorf("oci reference %q is invalid", listing.OCI)
	}
	if !packagemanifest.ValidDigest(listing.Digest) {
		return fmt.Errorf("digest %q is not pinned", listing.Digest)
	}
	if !packagemanifest.ValidHTTPSURL(listing.Repository) {
		return fmt.Errorf("repository must be an https URL with a host and path")
	}
	if listing.Documentation != "" && !packagemanifest.ValidHTTPSURL(listing.Documentation) {
		return fmt.Errorf("documentation must be an https URL with a host and path")
	}
	if listing.Issues != "" && !packagemanifest.ValidHTTPSURL(listing.Issues) {
		return fmt.Errorf("issues must be an https URL with a host and path")
	}
	return nil
}

func (s *Service) store(ctx context.Context, payload []byte, etag string, expiresAt time.Time) error {
	_, err := s.db.Exec(ctx, `INSERT INTO marketplace_catalog_cache(organization_id,
		document_url,key_id,payload,etag,fetched_at,expires_at,last_error)
		SELECT id,$1,$2,$3,$4,now(),$5,'' FROM organization_settings WHERE singleton
		ON CONFLICT (organization_id) DO UPDATE SET document_url=EXCLUDED.document_url,
		key_id=EXCLUDED.key_id,payload=EXCLUDED.payload,etag=EXCLUDED.etag,
		fetched_at=now(),expires_at=EXCLUDED.expires_at,last_error=''`,
		s.url, s.verifier.KeyID(), payload, etag, expiresAt)
	return err
}

func (s *Service) recordRefreshed(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `UPDATE marketplace_catalog_cache SET fetched_at=now(),last_error=''`)
	return err
}

func (s *Service) recordError(ctx context.Context, message string) error {
	if len(message) > 512 {
		message = message[:512]
	}
	if s.verifier == nil {
		return errors.New(message)
	}
	_, err := s.db.Exec(ctx, `INSERT INTO marketplace_catalog_cache(
		organization_id,document_url,key_id,last_error)
		SELECT id,$1,$2,$3 FROM organization_settings WHERE singleton
		ON CONFLICT (organization_id) DO UPDATE SET
			payload=CASE
				WHEN marketplace_catalog_cache.document_url=EXCLUDED.document_url
				 AND marketplace_catalog_cache.key_id=EXCLUDED.key_id
				THEN marketplace_catalog_cache.payload ELSE NULL END,
			etag=CASE
				WHEN marketplace_catalog_cache.document_url=EXCLUDED.document_url
				 AND marketplace_catalog_cache.key_id=EXCLUDED.key_id
				THEN marketplace_catalog_cache.etag ELSE '' END,
			fetched_at=CASE
				WHEN marketplace_catalog_cache.document_url=EXCLUDED.document_url
				 AND marketplace_catalog_cache.key_id=EXCLUDED.key_id
				THEN marketplace_catalog_cache.fetched_at ELSE NULL END,
			expires_at=CASE
				WHEN marketplace_catalog_cache.document_url=EXCLUDED.document_url
				 AND marketplace_catalog_cache.key_id=EXCLUDED.key_id
				THEN marketplace_catalog_cache.expires_at ELSE NULL END,
			document_url=EXCLUDED.document_url,key_id=EXCLUDED.key_id,
			last_error=EXCLUDED.last_error`,
		s.url, s.verifier.KeyID(), message)
	if err != nil {
		return err
	}
	return errors.New(message)
}
