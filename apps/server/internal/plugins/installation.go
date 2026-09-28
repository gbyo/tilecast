package plugins

// Plugin installation lifecycle.
//
// Installing a plugin records that this organization uses a capability the
// release already contains; it never fetches or runs anything. Removing one
// deletes only that record, and only once the plugin's own resources are gone:
// the Remove action is never a way to delete a site's forms, meters, or rules.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var (
	ErrPluginNotFound       = errors.New("plugin not found")
	ErrPluginNotInstallable = errors.New("plugin is not installable")
	ErrPluginNotInstalled   = plugin.ErrNotInstalled
)

// InUseError reports why a plugin cannot be removed yet.
type InUseError struct {
	PluginID  string
	Name      string
	Resources []InUseResource
}

// InUseResource is one kind of plugin-owned resource that still exists.
// Resolution tells Studio what the operator does about it: delete it, switch
// it off, or wait for it to clear.
type InUseResource struct {
	Kind       string `json:"kind"`
	Count      int    `json:"count"`
	Label      string `json:"label"`
	Resolution string `json:"resolution"`
}

func (e *InUseError) Error() string {
	if len(e.Resources) == 0 {
		return e.Name + " cannot be removed while it is in use."
	}
	first := e.Resources[0]
	return fmt.Sprintf("%s cannot be removed while %d %s remain.", e.Name, first.Count, first.Label)
}

// UnsupportedInstallation is an installation row naming a plugin this release
// does not know, typically restored from a newer release. It is preserved and
// ignored: nothing runs for it and nothing projects it.
type UnsupportedInstallation struct {
	PluginID    string    `json:"pluginId"`
	InstalledAt time.Time `json:"installedAt"`
	// Retired marks a plugin that an earlier release shipped and this release
	// removed, as opposed to one from a newer release.
	Retired bool `json:"retired,omitempty"`
}

// IsInstalled is the top-level runtime gate: the plugin must be known to this
// release and recorded as installed. Feature data alone never activates it.
func (s *Service) IsInstalled(ctx context.Context, id string) (bool, error) {
	if _, known := s.lookup(id); !known {
		return false, nil
	}
	return isInstalled(ctx, s.db, id)
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func isInstalled(ctx context.Context, db queryRower, id string) (bool, error) {
	var installed bool
	err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plugin_installations WHERE plugin_id=$1)`, id).Scan(&installed)
	return installed, err
}

// RequireInstalled returns ErrPluginNotInstalled for a plugin that is not
// installed, so a mutation route cannot configure — and thereby implicitly
// install — a plugin nobody chose to add.
func (s *Service) RequireInstalled(ctx context.Context, id string) error {
	installed, err := s.IsInstalled(ctx, id)
	if err != nil {
		return err
	}
	if !installed {
		return ErrPluginNotInstalled
	}
	return nil
}

// LockInstallation confirms a plugin is installed inside the caller's
// transaction and holds a share lock on its installation row until commit. A
// write that creates plugin-owned resources takes it so a concurrent Remove,
// which locks the row for update before counting blockers, cannot slip between
// the check and the insert.
func LockInstallation(ctx context.Context, tx pgx.Tx, id string) error {
	if _, known := Lookup(id); !known {
		return ErrPluginNotFound
	}
	return lockInstallationRow(ctx, tx, id)
}

func (s *Service) lockInstallation(ctx context.Context, tx pgx.Tx, id string) error {
	if _, known := s.lookup(id); !known {
		return ErrPluginNotFound
	}
	return lockInstallationRow(ctx, tx, id)
}

func lockInstallationRow(ctx context.Context, tx pgx.Tx, id string) error {
	var locked string
	err := tx.QueryRow(ctx, `SELECT plugin_id FROM plugin_installations WHERE plugin_id=$1 FOR SHARE`, id).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrPluginNotInstalled
	}
	return err
}

// Installed reports whether a known plugin is installed. Background workers in
// other packages call it as their top-level gate.
func Installed(ctx context.Context, db queryRower, id string) (bool, error) {
	if _, known := Lookup(id); !known {
		return false, nil
	}
	return isInstalled(ctx, db, id)
}

// installedSetDB is satisfied by pools and transactions for one-shot reads.
type installedSetDB interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// InstalledSet returns the IDs of every installed plugin. Callers combine
// it with contentdefs source metadata to compute effective availability:
// the release catalog knows what contributions exist, and this set knows
// which plugin-owned ones are currently usable.
func InstalledSet(ctx context.Context, db installedSetDB) (map[string]bool, error) {
	installed := map[string]bool{}
	rows, err := db.Query(ctx, `SELECT plugin_id FROM plugin_installations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		installed[id] = true
	}
	return installed, rows.Err()
}

// LockPluginSource confirms a plugin-owned contribution may be created
// inside the caller's transaction: the plugin must be installed, and the
// installation row is share-locked until commit so a concurrent Remove,
// which locks the row for update before counting blockers, cannot slip
// between the check and the insert. Content packages call this through an
// injected gate so media never imports plugin implementation details.
func (s *Service) LockPluginSource(ctx context.Context, tx pgx.Tx, pluginID string) error {
	return s.lockInstallation(ctx, tx, pluginID)
}

// installations reads every installation row, split into known plugins and
// rows this release does not recognize.
func (s *Service) installations(ctx context.Context) (map[string]bool, []UnsupportedInstallation, error) {
	rows, err := s.db.Query(ctx, `SELECT plugin_id,installed_at FROM plugin_installations ORDER BY plugin_id`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	installed := map[string]bool{}
	unsupported := []UnsupportedInstallation{}
	for rows.Next() {
		var item UnsupportedInstallation
		if err = rows.Scan(&item.PluginID, &item.InstalledAt); err != nil {
			return nil, nil, err
		}
		if _, known := s.lookup(item.PluginID); known {
			installed[item.PluginID] = true
		} else {
			item.Retired = retiredPlugins[item.PluginID]
			unsupported = append(unsupported, item)
		}
	}
	return installed, unsupported, rows.Err()
}

// Install records a release-owned plugin as installed. It is idempotent and
// reports whether this call created the installation.
func (s *Service) Install(ctx context.Context, id string, userID uuid.UUID) (CatalogPlugin, bool, error) {
	definition, known := s.lookup(id)
	if !known {
		return CatalogPlugin{}, false, ErrPluginNotFound
	}
	if !definition.Installable {
		return CatalogPlugin{}, false, ErrPluginNotInstallable
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CatalogPlugin{}, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `INSERT INTO plugin_installations(organization_id,plugin_id,installed_by)
		SELECT id,$1,$2 FROM organization_settings WHERE singleton
		ON CONFLICT DO NOTHING`, id, nullableUser(userID))
	if err != nil {
		return CatalogPlugin{}, false, err
	}
	created := tag.RowsAffected() > 0
	var notes []note
	if created {
		if err = auditInstallation(ctx, tx, "plugin.installed", definition, userID); err != nil {
			return CatalogPlugin{}, false, err
		}
		if s.affectsPlayerContent(definition) {
			if notes, err = bumpAllScreens(ctx, tx, "plugin.installed"); err != nil {
				return CatalogPlugin{}, false, err
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return CatalogPlugin{}, false, err
	}
	s.notify(notes)
	item, err := s.CatalogItem(ctx, id)
	return item, created, err
}

// Remove deletes an installation record once the plugin holds no persistent
// resources. It is idempotent for a plugin that is not installed. An
// installation of a plugin this release does not know may also be removed; that
// deletes the row alone and never touches tables this release cannot reason
// about.
func (s *Service) Remove(ctx context.Context, id string, userID uuid.UUID) error {
	definition, known := s.lookup(id)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if !known {
		if !pluginIDPattern.MatchString(id) {
			return ErrPluginNotFound
		}
		tag, err := tx.Exec(ctx, `DELETE FROM plugin_installations WHERE plugin_id=$1`, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrPluginNotFound
		}
		if err = auditInstallation(ctx, tx, "plugin.removed", Definition{ID: id}, userID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	// Lock the installation row so a concurrent install/remove serializes here.
	var locked string
	err = tx.QueryRow(ctx, `SELECT plugin_id FROM plugin_installations WHERE plugin_id=$1 FOR UPDATE`, id).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	resources, err := s.removalBlockers(ctx, tx, id)
	if err != nil {
		return err
	}
	if len(resources) > 0 {
		return &InUseError{PluginID: id, Name: definition.Name, Resources: resources}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM plugin_installations WHERE plugin_id=$1`, id); err != nil {
		return err
	}
	if err = auditInstallation(ctx, tx, "plugin.removed", definition, userID); err != nil {
		return err
	}
	var notes []note
	if s.affectsPlayerContent(definition) {
		if notes, err = bumpAllScreens(ctx, tx, "plugin.removed"); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify(notes)
	return nil
}

// removalBlockers lists the plugin-owned resources that must be deleted
// through the plugin's own UI before its installation can go. Generic
// static-contribution blockers come first, in a deterministic order; a
// plugin that implements RemovalGuard answers for its own domain state
// after them. No plugin author counts generic contributed Widget rows.
func (s *Service) removalBlockers(ctx context.Context, tx pgx.Tx, id string) ([]InUseResource, error) {
	hosted, ok := s.hostedPlugin(id)
	if !ok {
		return nil, ErrPluginNotFound
	}
	resources := []InUseResource{}
	static, err := s.staticContributionBlockers(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	resources = append(resources, static...)
	guard, ok := hosted.plugin.(plugin.RemovalGuard)
	if !ok {
		return resources, nil
	}
	blockers, err := guard.RemovalBlockers(ctx, tx)
	if err != nil {
		return nil, fmt.Errorf("plugin %s: removal blockers: %w", id, err)
	}
	for _, blocker := range blockers {
		if blocker.Count <= 0 {
			continue
		}
		resolution := blocker.Resolution
		if resolution == "" {
			resolution = plugin.ResolveDelete
		}
		resources = append(resources, InUseResource{Kind: blocker.Kind, Count: blocker.Count, Label: blocker.Label(), Resolution: string(resolution)})
	}
	return resources, nil
}

// staticContributionBlockers counts persisted content using the plugin's
// static Widget contributions. Removal deletes only the installation
// record, never the content itself, so any remaining row blocks.
func (s *Service) staticContributionBlockers(ctx context.Context, tx pgx.Tx, id string) ([]InUseResource, error) {
	providers := s.catalog().PluginWidgetProviders(id)
	if len(providers) == 0 {
		return nil, nil
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM widgets widget
		JOIN assets asset ON asset.id=widget.asset_id AND asset.deleted_at IS NULL
		WHERE widget.provider=ANY($1)`, providers).Scan(&count); err != nil {
		return nil, fmt.Errorf("plugin %s: contributed Widget usage: %w", id, err)
	}
	if count == 0 {
		return nil, nil
	}
	blocker := plugin.Blocker{Kind: "widget", Count: count, Singular: "Widget", Plural: "Widgets", Resolution: plugin.ResolveDelete}
	return []InUseResource{{Kind: blocker.Kind, Count: blocker.Count, Label: blocker.Label(), Resolution: string(blocker.Resolution)}}, nil
}

// affectsPlayerContent reports whether installing or removing the plugin
// can change what a screen receives. Plugins with Plugin API runtime
// manifest entries do by definition; so does any plugin with static
// Widget contributions, because installing it can make preserved
// plugin-owned content usable again. (Declarative Data Source
// contributions join the same check when they land.)
func (s *Service) affectsPlayerContent(definition Definition) bool {
	if definition.PlayerFacing {
		return true
	}
	for _, contributor := range s.catalog().StaticWidgetContributors() {
		if contributor == definition.ID {
			return true
		}
	}
	return false
}

func auditInstallation(ctx context.Context, tx pgx.Tx, action string, definition Definition, userID uuid.UUID) error {
	name := definition.Name
	if name == "" {
		name = definition.ID
	}
	_, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,metadata)
		VALUES($1,$2,$3,'plugin',$4,$5,jsonb_build_object('definitionVersion',$6::int))`,
		uuid.New(), nullableUser(userID), action, definition.ID, name, definition.Version)
	return err
}

func nullableUser(userID uuid.UUID) *uuid.UUID {
	if userID == uuid.Nil {
		return nil
	}
	return &userID
}
