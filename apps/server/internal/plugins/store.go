package plugins

// Plugin store: the normalized, server-provided view of every plugin source
// Studio can browse. In this release every entry is compiled into the
// release ("included"); marketplace and custom-repository entries join this
// same list once the package system exists, and Studio renders all sources
// through one shape. The store is a read projection over the registry and
// the installation lifecycle: it changes nothing about what installing,
// configuring, or removing a plugin means.

import "context"

// Store source kinds. Only StoreSourceIncluded exists in this release; the
// marketplace and custom-repository kinds arrive with the package system and
// extend StoreSource with a catalog ID or repository, never by replacing it.
const StoreSourceIncluded = "included"

// StoreSource says where a store entry comes from. Kind is the provenance
// Studio labels; CatalogID and Repository identify a marketplace listing or
// a custom repository once those sources exist.
type StoreSource struct {
	Kind       string `json:"kind"`
	CatalogID  string `json:"catalogId,omitempty"`
	Repository string `json:"repository,omitempty"`
}

// StoreEntry is one normalized plugin-store row: the package identity and
// provenance every source shares, plus the release-owned plugin detail this
// release contributes.
type StoreEntry struct {
	PackageID string        `json:"packageId"`
	Source    StoreSource   `json:"source"`
	Plugin    CatalogPlugin `json:"plugin"`
}

// Store is every plugin source Studio can browse, joined with this
// installation's state.
type Store struct {
	Items []StoreEntry `json:"items"`
	// UnsupportedInstallations are installation rows this release does not
	// recognize. They are preserved and inert.
	UnsupportedInstallations []UnsupportedInstallation `json:"unsupportedInstallations"`
}

// Store reports every plugin this release offers as normalized store
// entries, with installation and status. A plugin that is not installed
// still appears: the store is the list of what Tilecast can do, and Studio
// decides how to separate installed from available.
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
		items = append(items, StoreEntry{
			PackageID: hosted.manifest.ID,
			Source:    StoreSource{Kind: StoreSourceIncluded},
			Plugin:    catalogEntry(hosted.definition, installed[hosted.manifest.ID], status),
		})
	}
	return Store{Items: items, UnsupportedInstallations: unsupported}, nil
}

// StoreEntry reports one store entry. Unknown IDs answer ErrPluginNotFound,
// which the API renders as 404 plugin_not_found.
func (s *Service) StoreEntry(ctx context.Context, id string) (StoreEntry, error) {
	store, err := s.Store(ctx)
	if err != nil {
		return StoreEntry{}, err
	}
	for _, item := range store.Items {
		if item.PackageID == id {
			return item, nil
		}
	}
	return StoreEntry{}, ErrPluginNotFound
}
