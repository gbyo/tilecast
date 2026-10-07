package plugins

// Plugin store: the normalized, server-provided view of every plugin source
// Studio can browse. Release-owned entries ("included") always appear;
// marketplace entries join the same list from the official catalog, and
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
	StoreSourceCustom      = "custom"
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
	Version          string   `json:"version"`
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	PublisherID      string   `json:"publisherId"`
	PublisherName    string   `json:"publisherName"`
	License          string   `json:"license"`
	TilecastRange    string   `json:"tilecastRange"`
	Digest           string   `json:"digest"`
	Repository       string   `json:"repository"`
	Documentation    string   `json:"documentation,omitempty"`
	Issues           string   `json:"issues,omitempty"`
	Categories       []string `json:"categories,omitempty"`
	Featured         bool     `json:"featured,omitempty"`
	Compatible       bool     `json:"compatible"`
	Installed        bool     `json:"installed"`
	InstalledVersion string   `json:"installedVersion,omitempty"`
	UpdateAvailable  bool     `json:"updateAvailable"`
}

// StoreEntry is one normalized plugin-store row: the package identity and
// provenance every source shares, plus the source-owned detail. Exactly one
// of Plugin, Marketplace, and Custom is present.
type StoreEntry struct {
	PackageID   string            `json:"packageId"`
	Source      StoreSource       `json:"source"`
	Plugin      *CatalogPlugin    `json:"plugin,omitempty"`
	Marketplace *MarketplaceEntry `json:"marketplace,omitempty"`
	Custom      *CustomEntry      `json:"custom,omitempty"`
}

// MarketplaceStatus describes the cached catalog behind marketplace
// entries: when it last refreshed, whether it serves last-known-good
// data after a failed refresh, and the last refresh error, if any.
type MarketplaceStatus struct {
	LastFetchedAt *time.Time `json:"lastFetchedAt,omitempty"`
	Stale         bool       `json:"stale"`
	Error         string     `json:"error,omitempty"`
}

// MarketplaceSnapshot is the cached listings plus their cache state.
type MarketplaceSnapshot struct {
	Listings []catalog.Listing
	Status   MarketplaceStatus
}

// MarketplaceSource serves the cached marketplace snapshot. A nil source
// disables marketplace entries; the store shows release-owned entries only.
type MarketplaceSource func(ctx context.Context) (MarketplaceSnapshot, error)

// CustomSnapshot is one custom repository binding: the last verified
// manifest and digest. Installation state joins in the store, next to the
// marketplace join, so both external sources read one versions map.
type CustomSnapshot struct {
	PackageID     string
	Manifest      packagemanifest.Manifest
	RepositoryURL string
	Digest        string
}

// CustomEntry is one custom-repository package joined with this
// installation's state. Unlike a marketplace entry it carries no curated
// listing metadata and no update flag: freshness needs a live
// re-resolution, which an update check performs on demand.
type CustomEntry struct {
	Version          string `json:"version"`
	Name             string `json:"name"`
	Description      string `json:"description"`
	PublisherID      string `json:"publisherId"`
	PublisherName    string `json:"publisherName"`
	License          string `json:"license"`
	TilecastRange    string `json:"tilecastRange"`
	Digest           string `json:"digest"`
	Compatible       bool   `json:"compatible"`
	Installed        bool   `json:"installed"`
	InstalledVersion string `json:"installedVersion,omitempty"`
}

// CustomSource serves the custom repository bindings. A nil source
// disables custom entries.
type CustomSource func(ctx context.Context) ([]CustomSnapshot, error)

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

// WithCustomSource joins custom repository bindings into the store.
func WithCustomSource(source CustomSource) Option {
	return func(s *Service) { s.custom = source }
}

// MarketplaceSnapshotFrom adapts the cached marketplace document to the
// store's snapshot.
func MarketplaceSnapshotFrom(cached catalog.Cached, now time.Time) MarketplaceSnapshot {
	_ = now
	status := MarketplaceStatus{Stale: cached.Stale()}
	if cached.LastError != "" {
		status.Error = "The marketplace catalog could not be refreshed."
	}
	if !cached.FetchedAt.IsZero() {
		fetched := cached.FetchedAt
		status.LastFetchedAt = &fetched
	}
	return MarketplaceSnapshot{Listings: cached.Document.Listings, Status: status}
}

// Store reports every plugin source as normalized store entries, joined
// with installation and status. A plugin that is not installed still
// appears: the store is the list of what Tilecast can do, and Studio
// decides how to separate installed from available. Marketplace failures
// never fail the store: the release-owned entries still serve, with the
// failure recorded on the marketplace status. Custom bindings are local
// database rows, so a custom failure fails the store like any other local
// read.
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
	var versions map[string]string
	versionMap := func() (map[string]string, error) {
		if versions == nil {
			loaded, err := s.installedPackageVersions(ctx)
			if err != nil {
				return nil, err
			}
			versions = loaded
		}
		return versions, nil
	}
	if s.marketplace != nil {
		snapshot, err := s.marketplace(ctx)
		if err != nil {
			s.logger.ErrorContext(ctx, "marketplace snapshot failed", "error", err)
			store.Marketplace = MarketplaceStatus{
				Stale: true,
				Error: "The marketplace catalog cache could not be read.",
			}
		} else {
			store.Marketplace = snapshot.Status
			if len(snapshot.Listings) > 0 {
				versions, err = versionMap()
				if err != nil {
					return Store{}, err
				}
				items = appendMarketplaceItems(items, versions, snapshot.Listings)
			}
		}
	}
	if s.custom != nil {
		snapshots, err := s.custom(ctx)
		if err != nil {
			return Store{}, err
		}
		if len(snapshots) > 0 {
			versions, err = versionMap()
			if err != nil {
				return Store{}, err
			}
			items = appendCustomItems(items, versions, snapshots)
		}
	}
	store.Items = items
	return store, nil
}

func appendMarketplaceItems(items []StoreEntry, versions map[string]string, listings []catalog.Listing) []StoreEntry {
	for _, listing := range listings {
		installedVersion, ok := versions[listing.PackageID]
		entry := marketplaceEntry(listing, installedVersion, ok)
		items = append(items, StoreEntry{
			PackageID:   listing.PackageID,
			Source:      StoreSource{Kind: StoreSourceMarketplace, CatalogID: MarketplaceCatalogID},
			Marketplace: &entry,
		})
	}
	return items
}

func appendCustomItems(items []StoreEntry, versions map[string]string, snapshots []CustomSnapshot) []StoreEntry {
	for _, snapshot := range snapshots {
		installedVersion, ok := versions[snapshot.PackageID]
		entry := customEntry(snapshot, installedVersion, ok)
		items = append(items, StoreEntry{
			PackageID: snapshot.PackageID,
			Source:    StoreSource{Kind: StoreSourceCustom, Repository: snapshot.RepositoryURL},
			Custom:    &entry,
		})
	}
	return items
}

func customEntry(snapshot CustomSnapshot, installedVersion string, installed bool) CustomEntry {
	return CustomEntry{
		Version:          snapshot.Manifest.PackageVersion,
		Name:             snapshot.Manifest.Name,
		Description:      snapshot.Manifest.Description,
		PublisherID:      snapshot.Manifest.Publisher.ID,
		PublisherName:    snapshot.Manifest.Publisher.Name,
		License:          snapshot.Manifest.License,
		TilecastRange:    snapshot.Manifest.Tilecast.Version,
		Digest:           snapshot.Digest,
		Compatible:       packagemanifest.SatisfiesTilecastRange(snapshot.Manifest.Tilecast.Version, version.Display()),
		Installed:        installed,
		InstalledVersion: installedVersion,
	}
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

	var marketplaceErr error
	if s.marketplace != nil {
		snapshot, err := s.marketplace(ctx)
		if err != nil {
			s.logger.ErrorContext(ctx, "marketplace snapshot failed", "error", err)
			marketplaceErr = err
		} else {
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
		}
	}

	if s.custom != nil {
		snapshots, err := s.custom(ctx)
		if err != nil {
			return StoreEntry{}, err
		}
		for _, snapshot := range snapshots {
			if snapshot.PackageID != id {
				continue
			}
			versions, err := s.installedPackageVersions(ctx)
			if err != nil {
				return StoreEntry{}, err
			}
			installedVersion, ok := versions[id]
			entry := customEntry(snapshot, installedVersion, ok)
			return StoreEntry{
				PackageID: snapshot.PackageID,
				Source:    StoreSource{Kind: StoreSourceCustom, Repository: snapshot.RepositoryURL},
				Custom:    &entry,
			}, nil
		}
	}
	if marketplaceErr != nil {
		return StoreEntry{}, marketplaceErr
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
		Categories:       listing.Categories,
		Featured:         listing.Featured,
		Compatible:       packagemanifest.SatisfiesTilecastRange(listing.TilecastRange, version.Display()),
		Installed:        installed,
		InstalledVersion: installedVersion,
		UpdateAvailable:  installed && catalog.UpdateAvailable(installedVersion, listing.Version),
	}
}
