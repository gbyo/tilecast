// Package pipeline turns package discovery into activation.
//
// A custom repository resolves through its latest published release: the
// repository must exist and be public, the release tag names the OCI tag,
// and the manifest read from git declares the package. A marketplace
// listing resolves through its pinned digest. Either way the pipeline
// verifies Sigstore provenance for the digest, pulls the artifact by
// digest, verifies the layout, cross-checks the published manifest
// against the discovered one, and hands the result to the installer,
// which re-enforces compatibility, namespace, collision, and trust.
//
// Installs pin digests; tags and branches are never executed or stored.
// Studio-supplied digests are untrusted input: updates re-resolve fresh
// and confirm the digest before applying.
package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/catalog"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/github"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/registry"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/trust"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

var (
	// ErrInvalidRepository answers input that is not a public GitHub
	// repository address.
	ErrInvalidRepository = errors.New("not a GitHub repository URL")
	// ErrRepositoryNotFound answers a repository GitHub does not have.
	ErrRepositoryNotFound = errors.New("GitHub repository not found")
	// ErrRepositoryPrivate answers a repository this release cannot
	// resolve because it is private.
	ErrRepositoryPrivate = errors.New("GitHub repository is private")
	// ErrNoRelease answers a repository with no published release.
	ErrNoRelease = errors.New("repository has no published release")
	// ErrNoManifest answers a release with no readable manifest.
	ErrNoManifest = errors.New("release has no tilecast.package.json")
	// ErrManifestInvalid answers a manifest that fails validation.
	ErrManifestInvalid = errors.New("package manifest is invalid")
	// ErrTagUnusable answers a release tag that cannot name an OCI tag.
	ErrTagUnusable = errors.New("release tag cannot name a package artifact")
	// ErrNoPublishedPackage answers a release with no published package
	// artifact for its tag.
	ErrNoPublishedPackage = errors.New("release has no published package")
	// ErrPackageUnsigned answers an artifact with no verifying
	// provenance when unsigned installs are forbidden.
	ErrPackageUnsigned = errors.New("package has no verifying provenance")
	// ErrTrustUnavailable answers verification without Sigstore trust
	// material, such as an offline server.
	ErrTrustUnavailable = errors.New("provenance verification is unavailable")
	// ErrUpstream answers a failed network dependency: GitHub, the
	// registry, or the marketplace catalog.
	ErrUpstream = errors.New("package source is unreachable")
	// ErrArtifactInvalid answers pulled bytes that fail layout,
	// content, or contribution checks.
	ErrArtifactInvalid = errors.New("package artifact is invalid")
	// ErrCrossCheck answers a published artifact whose manifest does
	// not match the discovered one.
	ErrCrossCheck = errors.New("published package does not match its manifest")
	// ErrAlreadyInstalled answers an install for an active package.
	ErrAlreadyInstalled = errors.New("package is already installed")
	// ErrNotInstalled answers an update for a package with no
	// installation.
	ErrNotInstalled = errors.New("package is not installed")
	// ErrDigestMismatch answers an update confirmation for a digest
	// that no longer matches a fresh resolution.
	ErrDigestMismatch = errors.New("update check expired")
	// ErrSourceConflict answers a repository already bound to another
	// package.
	ErrSourceConflict = errors.New("repository is already bound to another package")
	// ErrNotGitHub answers a marketplace listing whose repository is
	// not a GitHub address. Provenance binds to GitHub Actions, so only
	// GitHub-backed listings install in this release.
	ErrNotGitHub = errors.New("listing repository is not a GitHub address")
)

// GitHub resolves repositories, releases, manifests, and attestations.
// *github.Client satisfies it; tests substitute fakes.
type GitHub interface {
	Repo(ctx context.Context, repo github.Repository) (string, error)
	LatestRelease(ctx context.Context, repo github.Repository) (github.Release, error)
	Manifest(ctx context.Context, repo github.Repository, ref string) (json.RawMessage, error)
	Attestations(ctx context.Context, repo github.Repository, digest string) ([][]byte, error)
}

// Registry resolves tags and pulls layouts. *registry.Repository
// satisfies it; tests substitute fakes.
type Registry interface {
	Resolve(ctx context.Context, ref, tag string) (string, error)
	Pull(ctx context.Context, ref, digest, dir string) error
}

// AttestationVerifier checks provenance bundles.
// *trust.AttestationVerifier satisfies it; tests substitute fakes.
type AttestationVerifier interface {
	Verify(bundleJSON []byte, digest, owner, repo string) (string, error)
}

// Catalog looks up marketplace listings. *catalog.Service satisfies it;
// a nil Catalog disables marketplace installs.
type Catalog interface {
	ListingFor(ctx context.Context, packageID string) (catalog.Listing, catalog.Cached, error)
	Refresh(ctx context.Context) error
}

var (
	_ GitHub              = (*github.Client)(nil)
	_ Registry            = (*registry.Repository)(nil)
	_ AttestationVerifier = (*trust.AttestationVerifier)(nil)
	_ Catalog             = (*catalog.Service)(nil)
)

// Resolution is a fully resolved, verified artifact: the manifest,
// the pinned digest, and the provenance that approved it.
type Resolution struct {
	Manifest      packagemanifest.Manifest
	ManifestJSON  json.RawMessage
	Digest        string
	RegistryRef   string
	ReleaseTag    string
	ReleaseName   string
	PublishedAt   time.Time
	Owner         string
	Repo          string
	RepositoryURL string
	Signer        string
	Trust         installer.TrustState
	Compatible    bool
}

// CustomSource is a persisted custom repository binding.
type CustomSource struct {
	PackageID      string
	Owner          string
	Name           string
	RepositoryURL  string
	Manifest       packagemanifest.Manifest
	ResolvedDigest string
	ResolvedAt     time.Time
	AddedAt        time.Time
}

// UpdateCheck reports whether an installed package has a newer
// resolution. Resolution is valid when Available.
type UpdateCheck struct {
	Installed   installer.InstalledPackage
	Available   bool
	Resolution  Resolution
	UpToDate    bool
	LastChecked time.Time
}

// UpdateResult is an applied update. Updated is false for an idempotent
// no-op, when the confirmed digest already matches the installation.
type UpdateResult struct {
	Installed installer.InstalledPackage
	Updated   bool
}

// CustomEntry joins a custom source with its installation state for the
// plugin store.
type CustomEntry struct {
	PackageID        string
	Manifest         packagemanifest.Manifest
	RepositoryURL    string
	Installed        bool
	InstalledVersion string
}

// Service resolves and installs external packages.
type Service struct {
	db              *pgxpool.Pool
	installer       *installer.Service
	github          GitHub
	registry        Registry
	attest          AttestationVerifier
	catalog         Catalog
	packagesRoot    string
	tilecastVersion string
	allowUnsigned   bool
}

// Option configures a Service.
type Option func(*Service)

// WithGitHub sets the repository client.
func WithGitHub(client GitHub) Option {
	return func(s *Service) { s.github = client }
}

// WithRegistry sets the artifact client.
func WithRegistry(client Registry) Option {
	return func(s *Service) { s.registry = client }
}

// WithAttestations sets the provenance verifier.
func WithAttestations(verifier AttestationVerifier) Option {
	return func(s *Service) { s.attest = verifier }
}

// WithCatalog sets the marketplace lookup. A nil catalog disables
// marketplace installs.
func WithCatalog(catalog Catalog) Option {
	return func(s *Service) { s.catalog = catalog }
}

// WithAllowUnsigned permits unsigned installs. The flag comes from
// configuration, honored on development builds only.
func WithAllowUnsigned() Option {
	return func(s *Service) { s.allowUnsigned = true }
}

// NewService orchestrates package resolution into installer activation.
// packagesRoot retains verified package bytes by digest. tilecastVersion
// is the running release, checked against every manifest range.
func NewService(db *pgxpool.Pool, inst *installer.Service, packagesRoot, tilecastVersion string, options ...Option) *Service {
	service := &Service{db: db, installer: inst, packagesRoot: packagesRoot, tilecastVersion: tilecastVersion}
	for _, option := range options {
		option(service)
	}
	return service
}

// ResolveCustom resolves a repository URL to a verified artifact without
// persisting or pulling anything. Studio shows the answer as the install
// review.
func (s *Service) ResolveCustom(ctx context.Context, repoURL string) (Resolution, error) {
	repo, err := github.ParseRepositoryURL(repoURL)
	if err != nil {
		return Resolution{}, ErrInvalidRepository
	}
	if s.github == nil || s.registry == nil {
		return Resolution{}, fmt.Errorf("package resolution is not configured: %w", ErrUpstream)
	}
	if _, err := s.github.Repo(ctx, repo); err != nil {
		return Resolution{}, mapGitHubError(err)
	}
	release, err := s.github.LatestRelease(ctx, repo)
	if err != nil {
		return Resolution{}, mapGitHubError(err)
	}
	raw, err := s.github.Manifest(ctx, repo, release.Tag)
	if err != nil {
		return Resolution{}, mapGitHubError(err)
	}
	manifest, err := packagemanifest.Parse(raw)
	if err != nil {
		return Resolution{}, fmt.Errorf("%w: %v", ErrManifestInvalid, err)
	}
	digest, err := s.registry.Resolve(ctx, manifest.Distribution.OCI, release.Tag)
	if err != nil {
		return Resolution{}, mapRegistryError(manifest.Distribution.OCI, release.Tag, err)
	}
	signer, trustState, err := s.provenance(ctx, repo, digest)
	if err != nil {
		return Resolution{}, err
	}
	return Resolution{
		Manifest:      manifest,
		ManifestJSON:  bytes.Clone(raw),
		Digest:        digest,
		RegistryRef:   manifest.Distribution.OCI,
		ReleaseTag:    release.Tag,
		ReleaseName:   release.Name,
		PublishedAt:   release.PublishedAt,
		Owner:         repo.Owner,
		Repo:          repo.Name,
		RepositoryURL: repo.URL(),
		Signer:        signer,
		Trust:         trustState,
		Compatible:    packagemanifest.SatisfiesTilecastRange(manifest.Tilecast.Version, s.tilecastVersion),
	}, nil
}

func mapGitHubError(err error) error {
	switch {
	case errors.Is(err, github.ErrNotFound):
		return ErrRepositoryNotFound
	case errors.Is(err, github.ErrPrivate):
		return ErrRepositoryPrivate
	case errors.Is(err, github.ErrNoRelease):
		return ErrNoRelease
	case errors.Is(err, github.ErrNoManifest):
		return ErrNoManifest
	default:
		return fmt.Errorf("%w: %v", ErrUpstream, err)
	}
}

func mapRegistryError(ref, tag string, err error) error {
	switch {
	case errors.Is(err, registry.ErrUnknownTag):
		return fmt.Errorf("%w for release %s", ErrNoPublishedPackage, tag)
	case errors.Is(err, registry.ErrInvalidTag):
		return fmt.Errorf("%w: release %s", ErrTagUnusable, tag)
	default:
		return fmt.Errorf("%w: %v", ErrUpstream, err)
	}
}

// provenance verifies the artifact digest against the repository's
// attestations. The first verifying bundle wins. No verifying bundle
// falls back to an unsigned development install when allowed, and
// refuses otherwise.
func (s *Service) provenance(ctx context.Context, repo github.Repository, digest string) (string, installer.TrustState, error) {
	if s.attest == nil {
		return "", "", fmt.Errorf("provenance verification is not configured: %w", ErrTrustUnavailable)
	}
	bundles, err := s.github.Attestations(ctx, repo, digest)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	for _, bundleJSON := range bundles {
		signer, err := s.attest.Verify(bundleJSON, digest, repo.Owner, repo.Name)
		if err == nil {
			return signer, installer.TrustVerified, nil
		}
		if errors.Is(err, trust.ErrTrustRootUnavailable) {
			return "", "", ErrTrustUnavailable
		}
	}
	if !s.allowUnsigned {
		return "", "", ErrPackageUnsigned
	}
	return "", installer.TrustUnsignedDevelopment, nil
}

// InstallCustom resolves a repository URL, persists the custom source,
// pulls and verifies the artifact, and activates it. An installed
// package answers ErrAlreadyInstalled: updates go through ApplyUpdate.
func (s *Service) InstallCustom(ctx context.Context, repoURL string, userID uuid.UUID) (installer.InstalledPackage, error) {
	resolution, err := s.ResolveCustom(ctx, repoURL)
	if err != nil {
		return installer.InstalledPackage{}, err
	}
	if _, err := s.installer.Get(ctx, resolution.Manifest.PackageID); err == nil {
		return installer.InstalledPackage{}, ErrAlreadyInstalled
	} else if !errors.Is(err, installer.ErrNotFound) {
		return installer.InstalledPackage{}, err
	}
	if err := s.bindSource(ctx, resolution, userID); err != nil {
		return installer.InstalledPackage{}, err
	}
	ociManifest, contributions, err := s.materialize(ctx, resolution)
	if err != nil {
		return installer.InstalledPackage{}, err
	}
	installed, err := s.installer.Activate(ctx, Activation(resolution, ociManifest, contributions, userID))
	if err != nil {
		return installer.InstalledPackage{}, mapActivationError(err)
	}
	return installed, nil
}

// Activation builds the installer activation for a resolution: the
// published manifest and contributions, the pinned digest, and the
// provenance that approved them.
func Activation(resolution Resolution, ociManifest packagemanifest.Manifest, nested []packages.NestedContribution, userID uuid.UUID) installer.Activation {
	contributions := make([]installer.Contribution, 0, len(nested))
	for _, item := range nested {
		contributions = append(contributions, installer.Contribution{Kind: item.Kind, ID: item.ID, Path: item.Path})
	}
	kind := installer.SourceCustom
	reference := resolution.RepositoryURL + "@" + resolution.ReleaseTag
	if resolution.ReleaseTag == "" {
		kind = installer.SourceMarketplace
		reference = "marketplace:" + resolution.Manifest.PackageID + "@" + resolution.Manifest.PackageVersion
	}
	return installer.Activation{
		Manifest:          ociManifest,
		Digest:            resolution.Digest,
		SourceKind:        kind,
		SourceReference:   reference,
		RegistryReference: resolution.RegistryRef,
		SignerIdentity:    resolution.Signer,
		Trust:             resolution.Trust,
		InstalledBy:       userID,
		Contributions:     contributions,
	}
}

// bindSource persists the custom repository binding, rebinding the
// package when the operator explicitly installs from another repository.
// A repository already bound to a different package answers
// ErrSourceConflict: one repository supplies one package.
func (s *Service) bindSource(ctx context.Context, resolution Resolution, userID uuid.UUID) error {
	manifestJSON, err := json.Marshal(resolution.Manifest)
	if err != nil {
		return err
	}
	var bound string
	err = s.db.QueryRow(ctx, `SELECT package_id FROM custom_package_sources
		WHERE repository_owner=$1 AND repository_name=$2`,
		resolution.Owner, resolution.Repo).Scan(&bound)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if bound != "" && bound != resolution.Manifest.PackageID {
		return fmt.Errorf("%w: repository supplies %s", ErrSourceConflict, bound)
	}
	_, err = s.db.Exec(ctx, `INSERT INTO custom_package_sources(organization_id,
		package_id,repository_owner,repository_name,repository_url,manifest,
		resolved_digest,resolved_at,added_by)
		SELECT id,$1,$2,$3,$4,$5,$6,now(),$7 FROM organization_settings WHERE singleton
		ON CONFLICT (organization_id, package_id) DO UPDATE SET
		repository_owner=EXCLUDED.repository_owner,
		repository_name=EXCLUDED.repository_name,
		repository_url=EXCLUDED.repository_url,
		manifest=EXCLUDED.manifest,
		resolved_digest=EXCLUDED.resolved_digest,
		resolved_at=now()`,
		resolution.Manifest.PackageID, resolution.Owner, resolution.Repo,
		resolution.RepositoryURL, manifestJSON, resolution.Digest, userID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ErrSourceConflict
		}
		return err
	}
	return nil
}

// materialize pulls the resolved artifact by digest, verifies the layout,
// cross-checks the published manifest against the discovered one, and
// extracts content to the retained directory. It returns the published
// manifest and its contributions for activation.
func (s *Service) materialize(ctx context.Context, resolution Resolution) (packagemanifest.Manifest, []packages.NestedContribution, error) {
	layoutDir, contentDir, err := s.ensureContent(ctx, resolution.RegistryRef, resolution.Digest)
	if err != nil {
		return packagemanifest.Manifest{}, nil, err
	}
	verified, err := packages.VerifyLayout(layoutDir)
	if err != nil {
		return packagemanifest.Manifest{}, nil, fmt.Errorf("%w: %v", ErrArtifactInvalid, err)
	}
	// Identity, version, origin, and compatibility range must agree: the
	// review showed the discovered manifest, and activation runs the
	// published one. Anything else drifts display text only.
	if verified.Manifest.PackageID != resolution.Manifest.PackageID ||
		verified.Manifest.PackageVersion != resolution.Manifest.PackageVersion ||
		verified.Manifest.Distribution.OCI != resolution.Manifest.Distribution.OCI ||
		verified.Manifest.Tilecast.Version != resolution.Manifest.Tilecast.Version {
		return packagemanifest.Manifest{}, nil, ErrCrossCheck
	}
	contributions, err := packages.ReadContributions(contentDir, verified.Manifest)
	if err != nil {
		return packagemanifest.Manifest{}, nil, fmt.Errorf("%w: %v", ErrArtifactInvalid, err)
	}
	return verified.Manifest, contributions, nil
}

// ContentDir returns the extracted content directory for a retained
// artifact, pulling it first when this server has not retained it yet.
// The layout re-verifies on every call; content extraction is trusted
// from the verified pull.
func (s *Service) ContentDir(ctx context.Context, ref, digest string) (string, error) {
	layoutDir, contentDir, err := s.ensureContent(ctx, ref, digest)
	if err != nil {
		return "", err
	}
	if _, err := packages.VerifyLayout(layoutDir); err != nil {
		return "", fmt.Errorf("%w: %v", ErrArtifactInvalid, err)
	}
	return contentDir, nil
}

// ensureContent returns the verified layout and extracted content
// directories for a digest, pulling and extracting when this server has
// not retained them yet. Retained directories are content-addressed and
// never rewritten: a complete marker names the digest they hold.
func (s *Service) ensureContent(ctx context.Context, ref, digest string) (string, string, error) {
	if s.registry == nil {
		return "", "", fmt.Errorf("package artifacts are not configured: %w", ErrUpstream)
	}
	if err := os.MkdirAll(s.packagesRoot, 0o755); err != nil {
		return "", "", err
	}
	encoded := strings.ReplaceAll(digest, ":", "-")
	retained := filepath.Join(s.packagesRoot, encoded)
	if complete(retained, digest) {
		return filepath.Join(retained, "layout"), filepath.Join(retained, "content"), nil
	}
	staging, err := os.MkdirTemp(s.packagesRoot, "staging-*")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(staging)
	layoutDir := filepath.Join(staging, "layout")
	if err := s.registry.Pull(ctx, ref, digest, layoutDir); err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	verified, err := packages.VerifyLayout(layoutDir)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrArtifactInvalid, err)
	}
	contentDir := filepath.Join(staging, "content")
	if err := packages.ExtractContent(layoutDir, verified, contentDir); err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrArtifactInvalid, err)
	}
	// Publish atomically: a crash before the rename leaves no retained
	// directory, and a crash after leaves a complete one.
	os.RemoveAll(retained)
	if err := os.Rename(staging, retained); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(filepath.Join(retained, ".complete"), []byte(digest), 0o644); err != nil {
		os.RemoveAll(retained)
		return "", "", err
	}
	return filepath.Join(retained, "layout"), filepath.Join(retained, "content"), nil
}

func complete(retained, digest string) bool {
	raw, err := os.ReadFile(filepath.Join(retained, ".complete"))
	if err != nil {
		return false
	}
	return string(raw) == digest
}

// InstallMarketplace installs a cached marketplace listing by package
// ID. The listing digest is already pinned, so no tag resolves; the
// artifact still verifies provenance, pulls by digest, and cross-checks
// the published manifest against the listing. Marketplace installs keep
// no custom source: the catalog is the update plane.
func (s *Service) InstallMarketplace(ctx context.Context, packageID string, userID uuid.UUID) (installer.InstalledPackage, error) {
	if s.catalog == nil {
		return installer.InstalledPackage{}, catalog.ErrDisabled
	}
	listing, _, err := s.catalog.ListingFor(ctx, packageID)
	if err != nil {
		return installer.InstalledPackage{}, err
	}
	if _, err := s.installer.Get(ctx, packageID); err == nil {
		return installer.InstalledPackage{}, ErrAlreadyInstalled
	} else if !errors.Is(err, installer.ErrNotFound) {
		return installer.InstalledPackage{}, err
	}
	resolution, err := s.resolveListing(ctx, listing)
	if err != nil {
		return installer.InstalledPackage{}, err
	}
	ociManifest, contributions, err := s.materialize(ctx, resolution)
	if err != nil {
		return installer.InstalledPackage{}, err
	}
	installed, err := s.installer.Activate(ctx, Activation(resolution, ociManifest, contributions, userID))
	if err != nil {
		return installer.InstalledPackage{}, mapActivationError(err)
	}
	return installed, nil
}

// UpdateCheck resolves the latest artifact for an installed package. A
// custom package re-resolves its bound repository; a marketplace package
// refreshes the catalog first so the check reads a fresh listing.
func (s *Service) UpdateCheck(ctx context.Context, packageID string) (UpdateCheck, error) {
	installed, err := s.installer.Get(ctx, packageID)
	if err != nil {
		if errors.Is(err, installer.ErrNotFound) {
			return UpdateCheck{}, ErrNotInstalled
		}
		return UpdateCheck{}, err
	}
	check := UpdateCheck{Installed: installed, LastChecked: time.Now()}
	var resolution Resolution
	switch installed.SourceKind {
	case installer.SourceCustom:
		source, err := s.CustomSource(ctx, packageID)
		if err != nil {
			return UpdateCheck{}, err
		}
		resolution, err = s.ResolveCustom(ctx, source.RepositoryURL)
		if err != nil {
			return UpdateCheck{}, err
		}
	case installer.SourceMarketplace:
		if s.catalog == nil {
			return UpdateCheck{}, catalog.ErrDisabled
		}
		if err := s.catalog.Refresh(ctx); err != nil {
			return UpdateCheck{}, fmt.Errorf("%w: marketplace refresh failed", ErrUpstream)
		}
		listing, _, err := s.catalog.ListingFor(ctx, packageID)
		if err != nil {
			return UpdateCheck{}, err
		}
		resolution, err = s.resolveListing(ctx, listing)
		if err != nil {
			return UpdateCheck{}, err
		}
	default:
		return UpdateCheck{}, fmt.Errorf("package %s has no update plane", packageID)
	}
	// Both versions validated as SemVer before reaching their rows, so
	// an uncomparable pair is corrupt data, not a caller error.
	compare, ok := packagemanifest.CompareSemver(resolution.Manifest.PackageVersion, installed.Version)
	if !ok {
		return UpdateCheck{}, fmt.Errorf("installed version %q does not compare", installed.Version)
	}
	check.Available = compare > 0 || (compare == 0 && resolution.Digest != installed.Digest)
	check.UpToDate = !check.Available
	check.Resolution = resolution
	return check, nil
}

// ApplyUpdate activates the digest an update check approved. The check
// re-resolves fresh, so a digest that no longer matches answers
// ErrDigestMismatch instead of installing stale bytes. A digest that
// already matches the installation answers the current package without
// activating.
func (s *Service) ApplyUpdate(ctx context.Context, packageID, digest string, userID uuid.UUID) (UpdateResult, error) {
	check, err := s.UpdateCheck(ctx, packageID)
	if err != nil {
		return UpdateResult{}, err
	}
	if !check.Available {
		return UpdateResult{Installed: check.Installed}, nil
	}
	if check.Resolution.Digest != digest {
		return UpdateResult{}, ErrDigestMismatch
	}
	if check.Installed.SourceKind == installer.SourceCustom {
		if err := s.bindSource(ctx, check.Resolution, userID); err != nil {
			return UpdateResult{}, err
		}
	}
	ociManifest, contributions, err := s.materialize(ctx, check.Resolution)
	if err != nil {
		return UpdateResult{}, err
	}
	installed, err := s.installer.Activate(ctx, Activation(check.Resolution, ociManifest, contributions, userID))
	if err != nil {
		return UpdateResult{}, mapActivationError(err)
	}
	return UpdateResult{Installed: installed, Updated: true}, nil
}

// Rollback restores the previous activation.
func (s *Service) Rollback(ctx context.Context, packageID string, userID uuid.UUID) (installer.InstalledPackage, error) {
	installed, err := s.installer.Rollback(ctx, packageID, userID)
	if err != nil {
		return installer.InstalledPackage{}, mapActivationError(err)
	}
	return installed, nil
}

// Remove deletes the installation and its contribution rows. Package
// bytes stay retained: rollback snapshots and reinstalls reference them,
// and no collector runs in this release.
func (s *Service) Remove(ctx context.Context, packageID string, userID uuid.UUID) error {
	if err := s.installer.Remove(ctx, packageID, userID); err != nil {
		return mapActivationError(err)
	}
	return nil
}

func mapActivationError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrAlreadyInstalled
	}
	return err
}

// resolveListing resolves a marketplace listing through its pinned digest
// to a verified resolution. The listing carries identity and version for
// the cross-check; the published manifest supplies the rest.
func (s *Service) resolveListing(ctx context.Context, listing catalog.Listing) (Resolution, error) {
	repo, err := github.ParseRepositoryURL(listing.Repository)
	if err != nil {
		return Resolution{}, ErrNotGitHub
	}
	signer, trustState, err := s.provenance(ctx, repo, listing.Digest)
	if err != nil {
		return Resolution{}, err
	}
	return Resolution{
		Manifest: packagemanifest.Manifest{
			APIVersion:     packagemanifest.APIVersion,
			PackageID:      listing.PackageID,
			PackageVersion: listing.Version,
			Name:           listing.Name,
			Publisher:      packagemanifest.Publisher{ID: listing.Publisher.ID, Name: listing.Publisher.Name},
			Distribution:   packagemanifest.Distribution{OCI: listing.OCI},
			Tilecast:       packagemanifest.TilecastCompat{Version: listing.TilecastRange},
		},
		Digest:        listing.Digest,
		RegistryRef:   listing.OCI,
		Owner:         repo.Owner,
		Repo:          repo.Name,
		RepositoryURL: repo.URL(),
		Signer:        signer,
		Trust:         trustState,
		Compatible:    packagemanifest.SatisfiesTilecastRange(listing.TilecastRange, s.tilecastVersion),
	}, nil
}

// CustomSource reports the persisted binding for a package.
func (s *Service) CustomSource(ctx context.Context, packageID string) (CustomSource, error) {
	var source CustomSource
	var manifestJSON []byte
	err := s.db.QueryRow(ctx, `SELECT package_id,repository_owner,repository_name,
		repository_url,manifest,resolved_digest,resolved_at,added_at
		FROM custom_package_sources WHERE package_id=$1`, packageID).Scan(
		&source.PackageID, &source.Owner, &source.Name, &source.RepositoryURL,
		&manifestJSON, &source.ResolvedDigest, &source.ResolvedAt, &source.AddedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CustomSource{}, ErrNotInstalled
		}
		return CustomSource{}, err
	}
	if err := json.Unmarshal(manifestJSON, &source.Manifest); err != nil {
		return CustomSource{}, fmt.Errorf("custom source manifest is corrupt: %w", err)
	}
	return source, nil
}

// ListCustomSources reports every persisted binding in package ID order.
func (s *Service) ListCustomSources(ctx context.Context) ([]CustomSource, error) {
	rows, err := s.db.Query(ctx, `SELECT package_id,repository_owner,repository_name,
		repository_url,manifest,resolved_digest,resolved_at,added_at
		FROM custom_package_sources ORDER BY package_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CustomSource{}
	for rows.Next() {
		var source CustomSource
		var manifestJSON []byte
		if err := rows.Scan(&source.PackageID, &source.Owner, &source.Name,
			&source.RepositoryURL, &manifestJSON, &source.ResolvedDigest,
			&source.ResolvedAt, &source.AddedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(manifestJSON, &source.Manifest); err != nil {
			return nil, fmt.Errorf("custom source manifest is corrupt: %w", err)
		}
		out = append(out, source)
	}
	return out, rows.Err()
}

// CustomEntries joins custom sources with installation state for the
// plugin store. The source manifest names the entry; the installed row,
// when present, marks it installed.
func (s *Service) CustomEntries(ctx context.Context) ([]CustomEntry, error) {
	rows, err := s.db.Query(ctx, `SELECT s.package_id,s.repository_url,s.manifest,
		p.package_version IS NOT NULL,COALESCE(p.package_version,'')
		FROM custom_package_sources s
		LEFT JOIN installed_packages p USING (organization_id, package_id)
		ORDER BY s.package_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CustomEntry{}
	for rows.Next() {
		var entry CustomEntry
		var manifestJSON []byte
		if err := rows.Scan(&entry.PackageID, &entry.RepositoryURL,
			&manifestJSON, &entry.Installed, &entry.InstalledVersion); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(manifestJSON, &entry.Manifest); err != nil {
			return nil, fmt.Errorf("custom source manifest is corrupt: %w", err)
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}
