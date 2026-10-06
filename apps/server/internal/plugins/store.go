package plugins

// Plugin store: the normalized, server-provided view of every plugin source
// Studio can browse. Release-owned entries ("included") always appear;
// marketplace entries join the same list once a catalog is configured, and
// Studio renders all sources through one shape. The store is a read
// projection over the registry, the installation lifecycle, and the cached
// marketplace: it changes nothing about what installing, configuring, or
// removing a plugin means.

import (
	"context"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/catalog"
	"github.com/tilecast/tilecast/apps/server/internal/version"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Store source kinds. Custom-repository entries arrive with custom installs
// and extend StoreSource with a repository, never by replacing it.
const (
	StoreSourceIncluded    = "included"
	StoreSourceMarketplace = "marketplace"
)

// MarketplaceCatalogID identifies the default Tilecast marketplace catalog
// in store sources.
const MarketplaceCatalogID = "tilecast-marketplace"

// StoreSource says where a store entry comes from. Kind is the provenance
// Studio labels; CatalogID and Repository identify a marketplace listing or
// a custom repository.
type StoreSource struct {
	Kind       string `json:"kind"`
	CatalogID  string `json:"catalogId,omitempty"`
	Repository string `json:"repository,omitempty"`
}

// MarketplaceEntry is one curated package listing joined with this
// installation's state: compatibility with the running release, whether it
// is installed, and whether the listing carries a newer version.
type MarketplaceEntry struct {
	Version          string `json:"version"`
	Name             string `json:"name"`
	Description      string `json:"description"`
	PublisherID      string `json:"publisherId"`
	PublisherName    string `json:"publisherName"`
	License          string `json:"license"`
	TilecastRange    string `json:"tilecastRange"`
	Digest           string `json:"digest"`
	Repository       string `json:"repository"`
	Documentation    string `json:"documentation,omitempty"`
	Issues           string `json:"issues,omitempty"`
	Compatible       bool   `json:"compatible"`
	Installed        bool   `json:"installed"`
	InstalledVersion string `json:"installedVersion,omitempty"`
	UpdateAvailable  bool   `json:"updateAvailable"`
}

// StoreEntry is one normalized plugin-store row: the package identity and
// provenance every source shares, plus the source-owned detail. Exactly one
// of Plugin and Marketplace is present.
type StoreEntry struct {
	PackageID   string            `json:"packageId"`
	Source      StoreSource       `json:"source"`
	Plugin      *CatalogPlugin    `json:"plugin,omitempty"`
	Marketplace *MarketplaceEntry `json:"marketplace,omitempty"`
}

// MarketplaceStatus describes the cached catalog behind marketplace
// entries: whether one is configured, when it last refreshed, whether the
// document is stale, and the last refresh error, if any.
type MarketplaceStatus struct {
	Configured bool       `json:"configured"`
	FetchedAt  *time.Time `json:"fetchedAt,omitempty"`
	Stale      bool       `json:"stale"`
	Error      string     `json:"error,omitempty"`
}

// MarketplaceSnapshot is the cached listings plus their cache state.
type MarketplaceSnapshot struct {
	Listings []catalog.Listing
	Status   MarketplaceStatus
}

// MarketplaceSource serves the cached marketplace snapshot. A nil source
// disables marketplace entries; the store shows release-owned entries only.
type MarketplaceSource func(ctx context.Context) (MarketplaceSnapshot, error)

// Store is every plugin source Studio can browse, joined with this
// installation's state.
type Store struct {
	Items []StoreEntry `json:"items"`
	// UnsupportedInstallations are installation rows this release does not
	// recognize. They are preserved and inert.
	UnsupportedInstallations []UnsupportedInstallation `json:"unsupportedInstallations"`
	// Marketplace describes the cached catalog behind marketplace entries.
	Marketplace MarketplaceStatus `json:"marketplace"`
}

// WithMarketplaceSource joins cached marketplace listings into the store.
func WithMarketplaceSource(source MarketplaceSource) Option {
	return func(s *Service) { s.marketplace = source }
}

// MarketplaceSnapshotFrom adapts the cached marketplace document to the
// store's snapshot. Configured is always true here: an unconfigured
// catalog is a nil marketplace source, never this adapter.
func MarketplaceSnapshotFrom(cached catalog.Cached, now time.Time) MarketplaceSnapshot {
	status := MarketplaceStatus{Configured: true, Stale: cached.Stale(now), Error: cached.LastError}
	if !cached.FetchedAt.IsZero() {
		fetched := cached.FetchedAt
		status.FetchedAt = &fetched
	}
	return MarketplaceSnapshot{Listings: cached.Document.Listings, Status: status}
}

// Store reports every plugin source as normalized store entries, joined
// with installation and status. A plugin that is not installed still
// appears: the store is the list of what Tilecast can do, and Studio
// decides how to separate installed from available. Marketplace failures
// never fail the store: the release-owned entries still serve, with the
// failure recorded on the marketplace status.
func (s *Service) Store(ctx context.Context) (Store, error) {
	installed, unsupported, err := s.installations(ctx)
	if err != nil {
		return Store{}, err
	}
	items := []StoreEntry{}
	for _, hosted := range s.hosted {
		status, reported, err := reportedStatus(ctx, hosted)
		if err != nil {
			return Store{}, err
		}
		if !reported {
			// As in the catalog: a plugin that does not report its
			// own status has no plugin-specific state to show, and
			// the zero status stands in.
			status = pluginStatus{}
		}
		entry := catalogEntry(hosted.definition, installed[hosted.manifest.ID], status)
		items = append(items, StoreEntry{
			PackageID: hosted.manifest.ID,
			Source:    StoreSource{Kind: StoreSourceIncluded},
			Plugin:    &entry,
		})
	}
	store := Store{Items: items, UnsupportedInstallations: unsupported}
	if s.marketplace == nil {
		return store, nil
	}
	snapshot, err := s.marketplace(ctx)
	if err != nil {
		store.Marketplace = MarketplaceStatus{Configured: true, Stale: true, Error: err.Error()}
		return store, nil
	}
	store.Marketplace = snapshot.Status
	if len(snapshot.Listings) == 0 {
		return store, nil
	}
	versions, err := s.installedPackageVersions(ctx)
	if err != nil {
		return Store{}, err
	}
	for _, listing := range snapshot.Listings {
		installedVersion, ok := versions[listing.PackageID]
		entry := marketplaceEntry(listing, installedVersion, ok)
		items = append(items, StoreEntry{
			PackageID:   listing.PackageID,
			Source:      StoreSource{Kind: StoreSourceMarketplace, CatalogID: MarketplaceCatalogID},
			Marketplace: &entry,
		})
	}
	store.Items = items
	return store, nil
}

// installedPackageVersions maps installed package IDs to versions.
func (s *Service) installedPackageVersions(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.Query(ctx, `SELECT package_id,package_version FROM installed_packages`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	versions := map[string]string{}
	for rows.Next() {
		var id, version string
		if err := rows.Scan(&id, &version); err != nil {
			return nil, err
		}
		versions[id] = version
	}
	return versions, rows.Err()
}

// StoreEntry reports one store entry without depending on unrelated plugin
// status reporters. Unknown IDs answer ErrPluginNotFound, which the API
// renders as 404 plugin_not_found.
func (s *Service) StoreEntry(ctx context.Context, id string) (StoreEntry, error) {
	for _, hosted := range s.hosted {
		if hosted.manifest.ID != id {
			continue
		}
		installed, _, err := s.installations(ctx)
		if err != nil {
			return StoreEntry{}, err
		}
		status, reported, err := reportedStatus(ctx, hosted)
		if err != nil {
			return StoreEntry{}, err
		}
		if !reported {
			status = pluginStatus{}
		}
		entry := catalogEntry(hosted.definition, installed[hosted.manifest.ID], status)
		return StoreEntry{
			PackageID: hosted.manifest.ID,
			Source:    StoreSource{Kind: StoreSourceIncluded},
			Plugin:    &entry,
		}, nil
	}

	if s.marketplace == nil {
		return StoreEntry{}, ErrPluginNotFound
	}
	snapshot, err := s.marketplace(ctx)
	if err != nil {
		return StoreEntry{}, err
	}
	for _, listing := range snapshot.Listings {
		if listing.PackageID != id {
			continue
		}
		versions, err := s.installedPackageVersions(ctx)
		if err != nil {
			return StoreEntry{}, err
		}
		installedVersion, ok := versions[id]
		entry := marketplaceEntry(listing, installedVersion, ok)
		return StoreEntry{
			PackageID:   listing.PackageID,
			Source:      StoreSource{Kind: StoreSourceMarketplace, CatalogID: MarketplaceCatalogID},
			Marketplace: &entry,
		}, nil
	}
	return StoreEntry{}, ErrPluginNotFound
}

func marketplaceEntry(listing catalog.Listing, installedVersion string, installed bool) MarketplaceEntry {
	return MarketplaceEntry{
		Version:          listing.Version,
		Name:             listing.Name,
		Description:      listing.Description,
		PublisherID:      listing.Publisher.ID,
		PublisherName:    listing.Publisher.Name,
		License:          listing.License,
		TilecastRange:    listing.TilecastRange,
		Digest:           listing.Digest,
		Repository:       listing.Repository,
		Documentation:    listing.Documentation,
		Issues:           listing.Issues,
		Compatible:       packagemanifest.SatisfiesTilecastRange(listing.TilecastRange, version.Display()),
		Installed:        installed,
		InstalledVersion: installedVersion,
		UpdateAvailable:  installed && catalog.UpdateAvailable(installedVersion, listing.Version),
	}
}
