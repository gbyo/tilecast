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
		if definition.PlayerFacing {
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
	if definition.PlayerFacing {
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
// through the plugin's own UI before its installation can go. A plugin that
// implements RemovalGuard answers for itself.
func (s *Service) removalBlockers(ctx context.Context, tx pgx.Tx, id string) ([]InUseResource, error) {
	hosted, ok := s.hostedPlugin(id)
	if !ok {
		return nil, ErrPluginNotFound
	}
	guard, ok := hosted.plugin.(plugin.RemovalGuard)
	if !ok {
		return legacyRemovalBlockers(ctx, tx, id)
	}
	blockers, err := guard.RemovalBlockers(ctx, tx)
	if err != nil {
		return nil, fmt.Errorf("plugin %s: removal blockers: %w", id, err)
	}
	resources := []InUseResource{}
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

// legacyRemovalBlockers covers the built-in plugins that have not moved into
// plugins/ yet. Every table named here is a literal owned by this release.
func legacyRemovalBlockers(ctx context.Context, tx pgx.Tx, id string) ([]InUseResource, error) {
	count := func(query string) (int, error) {
		var n int
		err := tx.QueryRow(ctx, query).Scan(&n)
		return n, err
	}
	resources := []InUseResource{}
	add := func(kind, one, many, resolution, query string) error {
		n, err := count(query)
		if err != nil {
			return err
		}
		if n > 0 {
			label := many
			if n == 1 {
				label = one
			}
			resources = append(resources, InUseResource{Kind: kind, Count: n, Label: label, Resolution: resolution})
		}
		return nil
	}
	var err error
	switch id {
	case BrandBugID:
		err = add("brand_bug_instance", "mark", "marks", "delete", `SELECT count(*) FROM brand_bug_instances`)
	case NoiseMeterID:
		err = add("noise_meter_instance", "meter", "meters", "delete", `SELECT count(*) FROM noise_meter_instances`)
	case FormsID:
		err = add("form", "form", "forms", "delete", `SELECT count(*) FROM data_sources WHERE provider='form' AND deleted_at IS NULL`)
	case EmergencyAlertsID:
		if err = add("alert_monitor", "enabled monitor", "enabled monitors", "disable", `SELECT count(*) FROM alert_monitor WHERE enabled`); err != nil {
			return nil, err
		}
		if err = add("alert_rule", "alert rule", "alert rules", "delete", `SELECT count(*) FROM alert_rules`); err != nil {
			return nil, err
		}
		err = add("alert_activation", "active alert", "active alerts", "wait", `SELECT count(*) FROM alert_activations WHERE cleared_at IS NULL`)
	}
	if err != nil {
		return nil, err
	}
	return resources, nil
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
