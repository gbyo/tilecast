package media

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// PluginSourceGate confirms a plugin-owned contribution may be created.
// The plugins package implements it; content packages hold it as an
// injected boundary so media never imports plugin implementation details
// (plugins imports media, so the reverse import would be a cycle).
type PluginSourceGate interface {
	// LockPluginSource confirms the plugin is installed inside the
	// caller's transaction and holds a share lock on its installation
	// row until commit, so a concurrent plugin removal cannot slip
	// between the availability check and the insert. It returns an error
	// wrapping plugin.ErrNotInstalled when the plugin is not installed;
	// any other error is a real failure and is reported as one.
	LockPluginSource(ctx context.Context, tx pgx.Tx, pluginID string) error
}

// PackageSourceGate confirms a package-contributed Widget or Data Source
// may be created. The installer implements it; media holds it as an
// injected boundary because the installer depends on media.
type PackageSourceGate interface {
	// LockPackageContribution revalidates, inside the caller's
	// transaction, that the package is installed at digest (when digest
	// is not empty) and still contributes the named contribution of
	// kind. It holds a share lock on the installation row until commit,
	// so a concurrent removal, update, or rollback, which lock the row
	// for update before they count content, cannot commit between the
	// check and the insert. It reports false when the package or the
	// contribution is gone or was replaced; an error is a real failure.
	LockPackageContribution(ctx context.Context, tx pgx.Tx, packageID, kind, contributionID, digest string) (bool, error)
}

// PluginUnavailableError reports that a plugin-owned provider cannot be
// used because its plugin is not installed. Persisted rows are preserved;
// only new creation (and projection elsewhere) is refused.
type PluginUnavailableError struct {
	Kind     string
	Provider string
	PluginID string
	// Package marks PluginID as an external package identity whose
	// installation, or whose contribution, is gone.
	Package bool
}

func (e *PluginUnavailableError) Error() string {
	if e.Package {
		return fmt.Sprintf("%s %q requires package %q to be installed and still contribute it", e.Kind, e.Provider, e.PluginID)
	}
	return fmt.Sprintf("%s %q requires plugin %q, which is not installed", e.Kind, e.Provider, e.PluginID)
}

// SetPluginSourceGate installs the plugin installation gate used when
// creating plugin-owned content. Nil fails closed: plugin-owned creation
// is refused when no gate is wired.
func (s *Service) SetPluginSourceGate(gate PluginSourceGate) { s.pluginGate = gate }

// SetPackageSourceGate installs the installation gate used when creating
// package-contributed content. Nil fails closed: package-owned creation is
// refused when no gate is wired.
func (s *Service) SetPackageSourceGate(gate PackageSourceGate) { s.packageGate = gate }

// lockPackageContribution turns the package gate's answer into the creation
// result. A package that is gone, or no longer contributes the definition
// the caller resolved, reports the provider as unavailable.
func (s *Service) lockPackageContribution(ctx context.Context, tx pgx.Tx, kind, label, provider string, source contentdefs.ExtensionSource) error {
	if s.packageGate == nil {
		return &PluginUnavailableError{Kind: label, Provider: provider, PluginID: source.PackageID, Package: true}
	}
	available, err := s.packageGate.LockPackageContribution(ctx, tx, source.PackageID, kind, provider, source.Digest)
	if err != nil {
		return fmt.Errorf("lock package %q for %s %q: %w", source.PackageID, label, provider, err)
	}
	if !available {
		return &PluginUnavailableError{Kind: label, Provider: provider, PluginID: source.PackageID, Package: true}
	}
	return nil
}

// lockedSource turns the gate's answer into the creation result: only a
// plugin that is not installed becomes PluginUnavailableError. Database
// failures and cancellations stay errors, so they are never reported to
// the author as a missing plugin.
func lockedSource(err error, kind, provider, pluginID string) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, plugin.ErrNotInstalled):
		return &PluginUnavailableError{Kind: kind, Provider: provider, PluginID: pluginID}
	default:
		return fmt.Errorf("lock plugin %q for %s %q: %w", pluginID, kind, provider, err)
	}
}

// inertRecheckSeconds is how long the refresh worker waits before it looks
// again at a Data Source whose plugin is not installed.
const inertRecheckSeconds = 300

// pluginSourceInert reports whether a Data Source row must stay inert
// because its provider belongs to a plugin that is not installed. Core
// providers and unknown provider IDs are never inert here. Without a gate
// the answer fails closed: plugin-owned rows stay inert.
func (s *Service) pluginSourceInert(ctx context.Context, tx pgx.Tx, provider string) (bool, error) {
	definition, ok := s.definitions.DataSource(provider)
	if !ok {
		return false, nil
	}
	source := definition.Source.Normalized()
	if source.Kind != contentdefs.SourceKindPlugin {
		return false, nil
	}
	if s.pluginGate == nil {
		return true, nil
	}
	err := s.pluginGate.LockPluginSource(ctx, tx, source.PluginID)
	switch {
	case err == nil:
		return false, nil
	case errors.Is(err, plugin.ErrNotInstalled):
		return true, nil
	default:
		return false, fmt.Errorf("check plugin %q for Data Source provider %q: %w", source.PluginID, provider, err)
	}
}

// lockDataSourceProvider locks the owning plugin's or package's installation
// row when the provider is a plugin- or package-owned Data Source
// definition. It must run
// inside the creation transaction before the insert.
func (s *Service) lockDataSourceProvider(ctx context.Context, tx pgx.Tx, provider string) error {
	definition, ok := s.definitions.DataSource(provider)
	if !ok {
		return nil
	}
	source := definition.Source.Normalized()
	if source.Kind == contentdefs.SourceKindPackage {
		return s.lockPackageContribution(ctx, tx, packagemanifest.ContributionDataSource, "data source provider", provider, source)
	}
	if source.Kind != contentdefs.SourceKindPlugin {
		return nil
	}
	if s.pluginGate == nil {
		return &PluginUnavailableError{Kind: "data source provider", Provider: provider, PluginID: source.PluginID}
	}
	return lockedSource(s.pluginGate.LockPluginSource(ctx, tx, source.PluginID), "data source provider", provider, source.PluginID)
}

// lockWidgetSource locks the owning plugin's or package's installation row
// when the provider is a plugin- or package-owned Widget definition. It must run inside the
// creation transaction before the insert.
func (s *Service) lockWidgetSource(ctx context.Context, tx pgx.Tx, provider string) error {
	definition, ok := s.definitions.Widget(provider)
	if !ok {
		return nil
	}
	source := definition.Source.Normalized()
	if source.Kind == contentdefs.SourceKindPackage {
		return s.lockPackageContribution(ctx, tx, packagemanifest.ContributionWidget, "widget provider", provider, source)
	}
	if source.Kind != contentdefs.SourceKindPlugin {
		return nil
	}
	if s.pluginGate == nil {
		return &PluginUnavailableError{Kind: "widget provider", Provider: provider, PluginID: source.PluginID}
	}
	return lockedSource(s.pluginGate.LockPluginSource(ctx, tx, source.PluginID), "widget provider", provider, source.PluginID)
}
