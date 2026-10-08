// Package contributions joins installed package contributions into the
// effective content catalog. The Server verifies the package, validates
// each nested manifest against the supported definition contract,
// restricts Data Sources to definition-driven adapters, and executes
// the existing trusted adapters. Packages supply data, never executable
// Server code (docs/content-extension-model.md §13).
package contributions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// externalAdapters are the Data Source adapters an installed package may
// name. Each is definition-driven: http_records fetches through the
// source-fetch policy from the definition's pinned template, and the
// manual adapters project the author's saved configuration. Provider-keyed
// adapters (weather, transit, calendar, cap_alerts, air_quality,
// structured feeds) dispatch on release provider IDs an external
// definition can never carry, so naming one would silently execute the
// wrong fetch.
var externalAdapters = map[string]bool{
	"http_records":   true,
	"manual_object":  true,
	"manual_records": true,
}

// Service rebuilds the effective catalog from installed packages.
type Service struct {
	// mu serializes Rebuild so a slow rebuild that listed packages before a
	// concurrent mutation committed cannot replace the catalog after the
	// newer rebuild already did.
	mu               sync.Mutex
	db               *pgxpool.Pool
	installer        *installer.Service
	release          *contentdefs.Catalog
	provider         *contentdefs.Provider
	contentDir       func(ctx context.Context, ref, digest string) (string, error)
	localContentDir  func(ctx context.Context, ref, digest string) (string, error)
	adapterAllowed   func(adapterID string) bool
	validateAdapters func(catalog *contentdefs.Catalog) error
	logger           *slog.Logger
	// payloads snapshots one verified player bundle per installed
	// Widget contribution. Like the catalog it swaps atomically, so
	// manifest compilation never blocks on a rebuild.
	payloads atomic.Pointer[payloadSnapshot]
}

// payloadKey identifies one Widget contribution's player bundle.
type payloadKey struct {
	packageID string
	nestedID  string
}

type payloadSnapshot struct {
	bundles map[payloadKey]contentdefs.WidgetPayload
}

// Option configures a Service.
type Option func(*Service)

// WithLogger sets the rebuild skip log. The default discards it.
func WithLogger(logger *slog.Logger) Option {
	return func(s *Service) { s.logger = logger }
}

// WithLocalContentDir sets the content lookup RebuildLocal uses. It must
// never reach the network.
func WithLocalContentDir(lookup func(ctx context.Context, ref, digest string) (string, error)) Option {
	return func(s *Service) { s.localContentDir = lookup }
}

// NewService composes installed package contributions over the release
// catalog into the provider. Content comes from the pipeline's retained
// bytes; adapter checks come from the media service, which owns the
// trusted adapter registry.
func NewService(
	db *pgxpool.Pool,
	inst *installer.Service,
	release *contentdefs.Catalog,
	provider *contentdefs.Provider,
	contentDir func(ctx context.Context, ref, digest string) (string, error),
	adapterAllowed func(adapterID string) bool,
	validateAdapters func(catalog *contentdefs.Catalog) error,
	options ...Option,
) *Service {
	service := &Service{
		db: db, installer: inst, release: release, provider: provider,
		contentDir: contentDir, adapterAllowed: adapterAllowed,
		validateAdapters: validateAdapters,
		logger:           slog.Default(),
	}
	for _, option := range options {
		option(service)
	}
	return service
}

// SkippedPackage is one installed package whose contributions did not
// join the catalog: retained bytes unreadable or definitions invalid.
// The installation stays; only its definitions are absent until a later
// rebuild succeeds.
type SkippedPackage struct {
	PackageID string
	Err       error
}

func (s SkippedPackage) Error() string {
	return fmt.Sprintf("package %s: %v", s.PackageID, s.Err)
}

func (s SkippedPackage) Unwrap() error { return s.Err }

// SkipsOnly reports whether err is nil or only package skips, as opposed
// to a hard rebuild failure. Boot warns and serves degraded on skips;
// anything else fails fast.
func SkipsOnly(err error) bool {
	if err == nil {
		return true
	}
	// errors.Join trees match the slice-unwrap interface; a single
	// SkippedPackage unwraps one error, never a slice, so it falls
	// through to the leaf check below.
	var joined interface{ Unwrap() []error }
	if errors.As(err, &joined) {
		for _, leaf := range joined.Unwrap() {
			if !SkipsOnly(leaf) {
				return false
			}
		}
		return true
	}
	var skip SkippedPackage
	return errors.As(err, &skip)
}

// Validate decodes every Widget and Data Source contribution of a
// verified package directory. The pipeline runs this before activation
// so an invalid definition fails the install instead of installing an
// inert package. Plugin-kind contributions wait for the external plugin
// runtime and validate as inert.
func (s *Service) Validate(contentDir string, manifest packagemanifest.Manifest, digest string) error {
	_, _, _, err := s.decode(contentDir, manifest, digest)
	return err
}

// WidgetPayload answers the verified player bundle of one installed
// Widget contribution, or false when the package is not installed, the
// contribution is not a Widget, or the latest rebuild skipped it.
func (s *Service) WidgetPayload(packageID, nestedID string) (contentdefs.WidgetPayload, bool) {
	snapshot := s.payloads.Load()
	if snapshot == nil {
		return contentdefs.WidgetPayload{}, false
	}
	payload, ok := snapshot.bundles[payloadKey{packageID: packageID, nestedID: nestedID}]
	return payload, ok
}

// Rebuild recomposes the effective catalog from every installed package.
// Packages compose one at a time in package ID order: a package whose
// bytes are missing, whose definitions fail validation, or whose
// definitions collide with an earlier package is skipped with a log
// entry while every other package still joins. The returned error joins
// the skips, or is nil when nothing skipped.
func (s *Service) Rebuild(ctx context.Context) error {
	return s.rebuild(ctx, s.contentDir)
}

// RebuildLocal is Rebuild restricted to retained bytes: a package whose
// bytes this server does not hold is skipped, never pulled. Startup uses
// it so the registry cannot block or fail boot.
func (s *Service) RebuildLocal(ctx context.Context) error {
	if s.localContentDir == nil {
		return errors.New("contributions: no local content lookup configured")
	}
	return s.rebuild(ctx, s.localContentDir)
}

func (s *Service) rebuild(ctx context.Context, contentDir func(ctx context.Context, ref, digest string) (string, error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	installed, err := s.installer.List(ctx)
	if err != nil {
		return err
	}
	composed := s.release
	bundles := map[payloadKey]contentdefs.WidgetPayload{}
	var skipped []error
	for _, item := range installed {
		packageWidgets, packageSources, packageBundles, err := s.loadPackage(ctx, item, contentDir)
		if err != nil {
			skipped = append(skipped, err)
			continue
		}
		next, err := composed.WithExternal(packageWidgets, packageSources)
		if err != nil {
			skipped = append(skipped, SkippedPackage{PackageID: item.PackageID, Err: err})
			continue
		}
		composed = next
		for key, bundle := range packageBundles {
			bundles[key] = bundle
		}
	}
	if err := s.validateAdapters(composed); err != nil {
		return err
	}
	s.provider.Replace(composed)
	s.payloads.Store(&payloadSnapshot{bundles: bundles})
	for _, skip := range skipped {
		s.logger.Warn("package contributions skipped", "error", skip)
	}
	return errors.Join(skipped...)
}

// loadPackage reads one installed package's Widget and Data Source
// definitions from its retained bytes.
func (s *Service) loadPackage(ctx context.Context, item installer.InstalledPackage, contentDir func(ctx context.Context, ref, digest string) (string, error)) ([]contentdefs.WidgetDefinition, []contentdefs.DataSourceDefinition, map[payloadKey]contentdefs.WidgetPayload, error) {
	manifest, err := s.installer.Manifest(ctx, item.PackageID)
	if err != nil {
		return nil, nil, nil, SkippedPackage{PackageID: item.PackageID, Err: err}
	}
	dir, err := contentDir(ctx, item.RegistryReference, item.Digest)
	if err != nil {
		return nil, nil, nil, SkippedPackage{PackageID: item.PackageID, Err: err}
	}
	packageWidgets, packageSources, packageBundles, err := s.decode(dir, manifest, item.Digest)
	if err != nil {
		return nil, nil, nil, SkippedPackage{PackageID: item.PackageID, Err: err}
	}
	return packageWidgets, packageSources, packageBundles, nil
}

// decode reads and validates one package's Widget and Data Source
// definitions from extracted content. Contribution paths recheck
// containment after joining; manifests recheck identity, API version,
// and the adapter allowlist. Every Widget contribution also hashes its
// player bundle: a Widget without deliverable code cannot join the
// catalog as a component, so installs fail and rebuilds skip it.
func (s *Service) decode(contentDir string, manifest packagemanifest.Manifest, digest string) ([]contentdefs.WidgetDefinition, []contentdefs.DataSourceDefinition, map[payloadKey]contentdefs.WidgetPayload, error) {
	source := contentdefs.PackageSource(manifest.PackageID, manifest.PackageVersion, digest)
	var widgets []contentdefs.WidgetDefinition
	var sources []contentdefs.DataSourceDefinition
	bundles := map[payloadKey]contentdefs.WidgetPayload{}
	for _, contribution := range manifest.Contributions {
		if contribution.Type == packagemanifest.ContributionPlugin {
			// Plugin behavior waits for the external plugin
			// runtime. The contribution row stays inert; nothing
			// executes it.
			continue
		}
		file, ok := packages.NestedManifestFile(contribution.Type)
		if !ok {
			return nil, nil, nil, fmt.Errorf("package %s: unknown contribution type %q", manifest.PackageID, contribution.Type)
		}
		joined := filepath.Join(contentDir, contribution.Path, file)
		rel, err := filepath.Rel(contentDir, joined)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, nil, nil, fmt.Errorf("package %s: contribution path %q escapes the package", manifest.PackageID, contribution.Path)
		}
		raw, err := os.ReadFile(joined)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("package %s: contribution %q has no readable %s", manifest.PackageID, contribution.Path, file)
		}
		if len(raw) > packages.MaxNestedManifestBytes {
			return nil, nil, nil, fmt.Errorf("package %s: contribution %q exceeds the manifest size limit", manifest.PackageID, contribution.Path)
		}
		switch contribution.Type {
		case packagemanifest.ContributionWidget:
			definition, err := contentdefs.DecodePackageWidget(manifest.PackageID, raw, source)
			if err != nil {
				return nil, nil, nil, err
			}
			nestedID, _ := strings.CutPrefix(definition.ID, manifest.PackageID+".")
			payload, err := hashWidgetPayload(contentDir, contribution.Path, manifest.PackageID, nestedID, digest)
			if err != nil {
				return nil, nil, nil, err
			}
			bundles[payloadKey{packageID: manifest.PackageID, nestedID: nestedID}] = payload
			widgets = append(widgets, definition)
		case packagemanifest.ContributionDataSource:
			definition, err := contentdefs.DecodePackageDataSource(manifest.PackageID, raw, source)
			if err != nil {
				return nil, nil, nil, err
			}
			if !s.adapterAllowed(definition.AdapterID) {
				return nil, nil, nil, fmt.Errorf("package %s: Data Source %q uses unregistered adapter %q", manifest.PackageID, definition.ID, definition.AdapterID)
			}
			if !externalAdapters[definition.AdapterID] {
				return nil, nil, nil, fmt.Errorf("package %s: Data Source %q uses adapter %q, which cannot serve external definitions", manifest.PackageID, definition.ID, definition.AdapterID)
			}
			sources = append(sources, definition)
		default:
			return nil, nil, nil, fmt.Errorf("package %s: unknown contribution type %q", manifest.PackageID, contribution.Type)
		}
	}
	return widgets, sources, bundles, nil
}

// hashWidgetPayload reads and hashes one Widget contribution's fixed
// player bundle. The bundle path is never author-declared, containment
// is rechecked after joining, and an oversized bundle fails like a
// missing one: the package cannot serve Players code it cannot name.
// The assembled sandbox frame over those same bytes is snapshotted
// beside the bundle, so manifest compilation names the exact executable
// document without reassembling it per manifest.
func hashWidgetPayload(contentDir, contributionPath, packageID, nestedID, digest string) (contentdefs.WidgetPayload, error) {
	joined := filepath.Join(contentDir, contributionPath, packages.WidgetPayloadRel)
	rel, err := filepath.Rel(contentDir, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return contentdefs.WidgetPayload{}, fmt.Errorf("package %s: contribution path %q escapes the package", packageID, contributionPath)
	}
	raw, err := os.ReadFile(joined)
	if err != nil {
		return contentdefs.WidgetPayload{}, fmt.Errorf("package %s: Widget %q has no player bundle at %s", packageID, nestedID, packages.WidgetPayloadRel)
	}
	if len(raw) == 0 || len(raw) > packages.MaxWidgetPayloadBytes {
		return contentdefs.WidgetPayload{}, fmt.Errorf("package %s: Widget %q has an unusable player bundle", packageID, nestedID)
	}
	sum := sha256.Sum256(raw)
	frame, err := sandbox.AssembleFrame(string(raw))
	if err != nil {
		return contentdefs.WidgetPayload{}, fmt.Errorf("package %s: Widget %q has an unusable player frame: %w", packageID, nestedID, err)
	}
	return contentdefs.WidgetPayload{
		PackageDigest:  digest,
		SHA256Hex:      hex.EncodeToString(sum[:]),
		Size:           int64(len(raw)),
		FrameSHA256Hex: frame.SHA256Hex,
		FrameSize:      frame.Size,
	}, nil
}
