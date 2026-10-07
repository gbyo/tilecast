// Package catalog fetches and caches the official Tilecast marketplace
// catalog.
//
// The marketplace is a curated directory of extension packages. The file
// marketplace/catalog.json in the Tilecast repository is the source of
// truth; changes to it are ordinary reviewed pull requests. Tilecast
// Server fetches that file, validates it strictly, and caches the last
// valid document. Studio reads the cache through the plugin store and
// never contacts GitHub itself.
//
// The catalog is a directory, not a security boundary. A listing means
// the Tilecast project accepted the package into the official
// marketplace. Install integrity stays with the package pipeline: the
// pinned digest, provenance verification, and manifest validation. A
// malformed or unreachable catalog never replaces the cached listings
// and never breaks installed packages or playback.
package catalog

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/ghrepo"
	"github.com/tilecast/tilecast/apps/server/internal/version"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

var (
	// ErrUnknownPackage answers a listing lookup the cache does not hold.
	ErrUnknownPackage = errors.New("marketplace package is not listed")
)

const (
	// OfficialCatalogURL is the canonical marketplace source: the reviewed
	// catalog file in the Tilecast repository. The server knows this
	// address itself; operators configure nothing for the marketplace to
	// work. Tests override the fetch target through NewServiceWithURL.
	OfficialCatalogURL = "https://raw.githubusercontent.com/gbyo/tilecast/main/marketplace/catalog.json"
	// CatalogFormatVersion is the marketplace catalog document version.
	CatalogFormatVersion = 1
	// MaxCatalogBytes caps a fetched catalog before it parses.
	MaxCatalogBytes = 5 << 20
	// fetchTimeout bounds one catalog fetch.
	fetchTimeout = 30 * time.Second
	// refreshInterval is how long a cached catalog serves before the
	// maintenance loop fetches it again.
	refreshInterval = time.Hour
	// staleRetryBackoff is how long RefreshIfStale waits after a failed
	// fetch before trying again. The last valid document keeps serving
	// meanwhile.
	staleRetryBackoff = 15 * time.Minute
)

//go:embed bundled_catalog.json
var bundledCatalog []byte

// Publisher names the listing publisher.
type Publisher struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Listing is one validated marketplace package: display metadata, the
// compatibility range, the immutable artifact address, presentation
// metadata for the directory, and the source, documentation, and issue
// links Studio shows. The link shapes mirror the package manifest so an
// install can cross-check them later.
type Listing struct {
	PackageID   string `json:"packageId"`
	Version     string `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// LongDescription is optional plain text for the listing page. It is
	// presentation only: it never takes part in identity, digest, or
	// installation, and Studio falls back to Description without it.
	LongDescription string    `json:"longDescription,omitempty"`
	Publisher       Publisher `json:"publisher"`
	License         string    `json:"license"`
	TilecastRange   string    `json:"tilecastRange"`
	OCI             string    `json:"oci"`
	Digest          string    `json:"digest"`
	Repository      string    `json:"repository"`
	Documentation   string    `json:"documentation,omitempty"`
	Issues          string    `json:"issues,omitempty"`
	Categories      []string  `json:"categories,omitempty"`
	Featured        bool      `json:"featured,omitempty"`
	// Icon and Screenshots are presentation metadata. They never take
	// part in package identity, digest verification, provenance, or
	// capabilities. Studio reaches them only through the artwork path
	// the server owns.
	Icon        string       `json:"icon,omitempty"`
	Screenshots []Screenshot `json:"screenshots,omitempty"`
}

// Screenshot is one listing image with the text a screen reader speaks
// for it.
type Screenshot struct {
	Src string `json:"src"`
	Alt string `json:"alt"`
}

// Document is one validated marketplace catalog.
type Document struct {
	FormatVersion int       `json:"formatVersion"`
	Listings      []Listing `json:"listings"`
}

// Cached pairs the last valid document with its cache state. FetchedAt
// is zero when no refresh has ever succeeded; the document then comes
// from the bundled snapshot.
type Cached struct {
	Document  Document
	FetchedAt time.Time
	LastError string
}

// Stale reports whether the cache serves last-known-good data after a
// failed refresh. A failed refresh records its error and keeps serving
// the previous document; a successful refresh clears the error.
func (c Cached) Stale() bool {
	return c.LastError != ""
}

// Service fetches and caches the marketplace catalog.
type Service struct {
	db      *pgxpool.Pool
	client  *http.Client
	url     string
	artwork *artworkCache

	// staleMu guards staleRetryAfter, the process-local backoff
	// RefreshIfStale observes after a failed fetch.
	staleMu         sync.Mutex
	staleRetryAfter time.Time
}

// NewService serves the official Tilecast marketplace catalog.
func NewService(db *pgxpool.Pool) *Service {
	return NewServiceWithURL(db, OfficialCatalogURL)
}

// NewServiceWithURL serves the catalog at rawURL. Tests use it to point
// the service at a local server; production always uses NewService.
func NewServiceWithURL(db *pgxpool.Pool, rawURL string) *Service {
	rawURL = strings.TrimSpace(rawURL)
	origin, _ := url.Parse(rawURL)
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
	return &Service{db: db, client: client, url: rawURL, artwork: newArtworkCache()}
}

func sameOrigin(left, right *url.URL) bool {
	return left != nil &&
		right != nil &&
		strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Host, right.Host)
}

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

// Refresh fetches the catalog, validates it, and caches it. A 304 keeps
// the cached document and clears the recorded error. Any other failure
// records its error and keeps serving the last valid document; a
// malformed catalog never replaces it.
func (s *Service) Refresh(ctx context.Context) error {
	parsed, err := url.Parse(s.url)
	if err != nil || !fetchableURL(parsed) {
		return fmt.Errorf("marketplace catalog URL is unacceptable: %s", s.url)
	}
	_, etag, err := s.cachedRow(ctx)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "Tilecast-Server/"+version.Display()+" (+https://github.com/gbyo/tilecast)")
	request.Header.Set("Accept", "application/json")
	if etag != "" {
		request.Header.Set("If-None-Match", etag)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return s.recordError(ctx, fmt.Sprintf("fetch failed: %v", err))
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
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
	if _, err := ParseCatalog(body); err != nil {
		return s.recordError(ctx, err.Error())
	}
	return s.store(ctx, body, response.Header.Get("ETag"))
}

// RefreshIfStale refreshes the catalog when the cache is missing or
// older than the refresh interval, and does nothing when the cached
// document is still fresh. A failed fetch records its error in the cache
// row and backs off: the next attempt waits staleRetryBackoff, while the
// last valid document keeps serving. A manual Refresh always attempts
// and never consults the backoff.
func (s *Service) RefreshIfStale(ctx context.Context) error {
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
	if !cached.FetchedAt.IsZero() && now.Sub(cached.FetchedAt) < refreshInterval && !cached.Stale() {
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

// Cached returns the last valid catalog document and its cache state.
// Before the first successful refresh it serves the bundled snapshot
// shipped with the server, so a fresh installation lists the marketplace
// even when GitHub is unreachable at first boot.
func (s *Service) Cached(ctx context.Context) (Cached, error) {
	cached, _, err := s.cachedRow(ctx)
	if err != nil {
		return Cached{}, err
	}
	if !cached.FetchedAt.IsZero() {
		return cached, nil
	}
	// No refresh has succeeded yet. Serve the bundled snapshot with any
	// recorded error, so a fresh installation lists the marketplace even
	// when the first refresh fails.
	document, err := Bundled()
	if err != nil {
		if cached.LastError == "" {
			return Cached{}, err
		}
		return cached, nil
	}
	cached.Document = document
	return cached, nil
}

func (s *Service) cachedRow(ctx context.Context) (Cached, string, error) {
	var cached Cached
	var etag string
	var payload []byte
	var fetchedAt pgtype.Timestamptz
	err := s.db.QueryRow(ctx, `SELECT payload,etag,fetched_at,last_error
		FROM marketplace_catalog_cache`).Scan(&payload, &etag, &fetchedAt, &cached.LastError)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Cached{}, "", nil
		}
		return Cached{}, "", err
	}
	if len(payload) == 0 {
		return cached, "", nil
	}
	if !fetchedAt.Valid {
		return Cached{}, "", errors.New("cached catalog metadata is incomplete")
	}
	document, err := ParseCatalog(payload)
	if err != nil {
		return Cached{}, "", fmt.Errorf("cached catalog is corrupt: %w", err)
	}
	cached.Document = document
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

// Bundled returns the catalog snapshot shipped with the server binary.
// The snapshot is a copy of the repository catalog, refreshed by the
// build; repository tests fail when the copy drifts from its source.
func Bundled() (Document, error) {
	return ParseCatalog(bundledCatalog)
}

// ParseCatalog decodes and validates one catalog document. Repository
// tests, fetched catalogs, and the bundled snapshot all validate through
// this function so the three can never diverge.
func ParseCatalog(data []byte) (Document, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document Document
	if err := decoder.Decode(&document); err != nil {
		return Document{}, fmt.Errorf("marketplace catalog: %w", err)
	}
	if document.FormatVersion != CatalogFormatVersion {
		return Document{}, fmt.Errorf("marketplace catalog: unsupported format version %d", document.FormatVersion)
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
		if index > 0 && document.Listings[index-1].PackageID >= listing.PackageID {
			return Document{}, fmt.Errorf("marketplace catalog listing %d: listings must be sorted by packageId", index)
		}
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
	if err := validateLongDescription(listing.LongDescription); err != nil {
		return err
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
	if !validGitHubRepository(listing.Repository) {
		return fmt.Errorf("repository must be a github.com repository URL with exactly an owner and name")
	}
	if listing.Documentation != "" && !packagemanifest.ValidHTTPSURL(listing.Documentation) {
		return fmt.Errorf("documentation must be an https URL with a host and path")
	}
	if listing.Issues != "" && !packagemanifest.ValidHTTPSURL(listing.Issues) {
		return fmt.Errorf("issues must be an https URL with a host and path")
	}
	if len(listing.Categories) > 5 {
		return fmt.Errorf("categories must hold at most 5 entries")
	}
	seen := make(map[string]bool, len(listing.Categories))
	for _, category := range listing.Categories {
		if !validCategory(category) {
			return fmt.Errorf("category %q must be 1 to 32 lowercase letters, digits, or hyphens", category)
		}
		if seen[category] {
			return fmt.Errorf("category %q repeats", category)
		}
		seen[category] = true
	}
	return validateArtwork(listing)
}

// maxLongDescription bounds the optional listing text in characters.
const maxLongDescription = 2000

// validateLongDescription accepts plain text only: 1 to 2000 characters, with
// line breaks allowed and every other control character refused. Studio
// renders it as text, never as markup, so the rule keeps the field honest
// about what it is.
func validateLongDescription(text string) error {
	if text == "" {
		return nil
	}
	if utf8.RuneCountInString(text) > maxLongDescription {
		return fmt.Errorf("longDescription must be at most %d characters", maxLongDescription)
	}
	if !utf8.ValidString(text) {
		return fmt.Errorf("longDescription must be valid UTF-8")
	}
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("longDescription must hold visible text")
	}
	for _, r := range text {
		if r == '\n' {
			continue
		}
		if unicode.IsControl(r) {
			return fmt.Errorf("longDescription must be plain text without control characters")
		}
	}
	return nil
}

// validGitHubRepository accepts a repository address the installer can
// resolve: the same parser installation uses, so catalog CI and
// installation accept exactly the same URL forms. The directory lists
// GitHub repositories only; documentation and issue links may live
// anywhere over https.
func validGitHubRepository(value string) bool {
	_, err := ghrepo.ParseRepositoryURL(value)
	return err == nil
}

// validCategory accepts a directory slug: lowercase letters, digits, and
// hyphens. Categories stay free-form while the directory is small; a
// controlled vocabulary can replace them once listings need one.
func validCategory(category string) bool {
	if category == "" || len(category) > 32 {
		return false
	}
	for _, rune := range category {
		if rune >= 'a' && rune <= 'z' || rune >= '0' && rune <= '9' || rune == '-' {
			continue
		}
		return false
	}
	return true
}

func (s *Service) store(ctx context.Context, payload []byte, etag string) error {
	_, err := s.db.Exec(ctx, `INSERT INTO marketplace_catalog_cache(
		organization_id,payload,etag,fetched_at,last_error)
		SELECT id,$1,$2,now(),'' FROM organization_settings WHERE singleton
		ON CONFLICT (organization_id) DO UPDATE SET payload=EXCLUDED.payload,
		etag=EXCLUDED.etag,fetched_at=now(),last_error=''`,
		payload, etag)
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
	_, err := s.db.Exec(ctx, `INSERT INTO marketplace_catalog_cache(
		organization_id,last_error)
		SELECT id,$1 FROM organization_settings WHERE singleton
		ON CONFLICT (organization_id) DO UPDATE SET last_error=EXCLUDED.last_error`,
		message)
	if err != nil {
		return err
	}
	return errors.New(message)
}
