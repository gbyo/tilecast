package plugins

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	bundled "github.com/tilecast/tilecast/plugins"
)

// The SDK's sentinel errors, so a plugin and the legacy built-ins in this
// package answer with the same API errors.
var (
	ErrNotFound = plugin.ErrNotFound
	ErrInvalid  = plugin.ErrInvalid
)

type Notifier interface{ ManifestChanged(uuid.UUID, int64) }

// ManifestInvalidator is implemented by the playlist service so plugin
// mutations use the same transactional dependency-version traversal as media,
// layouts, schedules, and presentation overrides.
type ManifestInvalidator interface {
	InvalidatePluginInTx(context.Context, pgx.Tx, string, uuid.UUID, string, func(uuid.UUID, int64)) error
}

type Service struct {
	db                   *pgxpool.Pool
	notifier             Notifier
	invalidator          ManifestInvalidator
	logger               *slog.Logger
	clock                plugin.Clock
	takeovers            plugin.Takeovers
	managedPresentations plugin.ManagedPresentations
	backgroundJobs       plugin.BackgroundJobs
	publicURL            string

	bundle      []plugin.Plugin
	definitions []Definition
	hosted      []hostedPlugin
}

// NewService hosts the plugins bundled with this release, or the ones given
// with WithPlugins, and initializes each of them.
func NewService(db *pgxpool.Pool, notifier Notifier, options ...Option) *Service {
	s := &Service{db: db, notifier: notifier, logger: slog.Default(), clock: systemClock{}}
	for _, option := range options {
		option(s)
	}
	if s.bundle == nil {
		s.bundle = bundled.Bundled()
	}
	s.host()
	return s
}

func (s *Service) SetManifestInvalidator(invalidator ManifestInvalidator) {
	s.invalidator = invalidator
}

// CatalogPlugin is one registry definition joined with this installation's
// state. Installed, configured, and active are separate questions: an installed
// Emergency Alerts plugin with monitoring switched off is valid, and a plugin is
// never "enabled" by being installed.
type CatalogPlugin struct {
	ID          string `json:"id"`
	Version     int    `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Icon        string `json:"icon"`

	ManagementPath string `json:"managementPath"`

	InstanceNounSingular string `json:"instanceNounSingular"`
	InstanceNounPlural   string `json:"instanceNounPlural"`

	Requirements  []Requirement `json:"requirements"`
	Capabilities  []string      `json:"capabilities"`
	Documentation string        `json:"documentation,omitempty"`

	Installed   bool `json:"installed"`
	Installable bool `json:"installable"`

	Configured    bool `json:"configured"`
	Active        bool `json:"active"`
	InstanceCount int  `json:"instanceCount"`

	Attention []PluginAttention `json:"attention"`
}

// PluginAttention is a bounded, advisory status note. It never blocks
// installation or configuration.
type PluginAttention struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Catalog struct {
	Items []CatalogPlugin `json:"items"`
	// UnsupportedInstallations are installation rows this release does not
	// recognize. They are preserved and inert.
	UnsupportedInstallations []UnsupportedInstallation `json:"unsupportedInstallations"`
}

// ManifestPlugin is one entry of the manifest's discriminated `plugins`
// array: a screen may be delivered a Countdown Bar and an Emergency Alerts
// ticker at the same time. It is the SDK's ManifestEntry,
// so plugins in plugins/ and the remaining built-ins here share one shape.
type ManifestPlugin = plugin.ManifestEntry

// pluginStatus is the plugin-specific part of a catalog entry.
type pluginStatus struct {
	configured bool
	active     bool
	count      int
	attention  []PluginAttention
}

// Catalog reports every plugin this release can run with its installation and
// status. A plugin that is not installed still appears: the catalog is the list
// of what Tilecast can do, and Studio decides how to separate installed from
// available.
func (s *Service) Catalog(ctx context.Context) (Catalog, error) {
	installed, unsupported, err := s.installations(ctx)
	if err != nil {
		return Catalog{}, err
	}
	statuses, err := s.pluginStatuses(ctx)
	if err != nil {
		return Catalog{}, err
	}
	items := []CatalogPlugin{}
	for _, hosted := range s.hosted {
		status, reported, err := reportedStatus(ctx, hosted)
		if err != nil {
			return Catalog{}, err
		}
		if !reported {
			status = statuses[hosted.manifest.ID]
		}
		items = append(items, catalogEntry(hosted.definition, installed[hosted.manifest.ID], status))
	}
	return Catalog{Items: items, UnsupportedInstallations: unsupported}, nil
}

// CatalogItem reports one known plugin in the catalog shape.
func (s *Service) CatalogItem(ctx context.Context, id string) (CatalogPlugin, error) {
	catalog, err := s.Catalog(ctx)
	if err != nil {
		return CatalogPlugin{}, err
	}
	for _, item := range catalog.Items {
		if item.ID == id {
			return item, nil
		}
	}
	return CatalogPlugin{}, ErrPluginNotFound
}

// reportedStatus asks a plugin that reports its own status.
func reportedStatus(ctx context.Context, hosted hostedPlugin) (pluginStatus, bool, error) {
	reporter, ok := hosted.plugin.(plugin.StatusReporter)
	if !ok {
		return pluginStatus{}, false, nil
	}
	reported, err := reporter.Status(ctx)
	if err != nil {
		return pluginStatus{}, true, fmt.Errorf("plugin %s: status: %w", hosted.manifest.ID, err)
	}
	status := pluginStatus{configured: reported.Configured, active: reported.Active, count: reported.InstanceCount}
	for _, note := range reported.Attention {
		status.attention = append(status.attention, PluginAttention{Code: note.Code, Message: note.Message})
	}
	return status, true, nil
}

func catalogEntry(d Definition, installed bool, status pluginStatus) CatalogPlugin {
	requirements := append([]Requirement{}, d.Requirements...)
	capabilities := append([]string{}, d.Capabilities...)
	attention := []PluginAttention{}
	if installed {
		attention = append(attention, status.attention...)
	} else if status.count > 0 {
		// Feature data without an installation does nothing at runtime. Say so,
		// rather than letting the data look like a working feature.
		attention = append(attention, PluginAttention{
			Code:    "data_without_installation",
			Message: fmt.Sprintf("%d %s exist but %s is not installed, so they have no effect.", status.count, nounFor(d, status.count), d.Name),
		})
	}
	return CatalogPlugin{
		ID: d.ID, Version: d.Version, Name: d.Name, Description: d.Description,
		Category: d.Category, Icon: d.Icon, ManagementPath: d.ManagementPath,
		InstanceNounSingular: d.InstanceNounSingular, InstanceNounPlural: d.InstanceNounPlural,
		Requirements: requirements, Capabilities: capabilities, Documentation: d.Documentation,
		Installed: installed, Installable: d.Installable,
		Configured: status.configured, Active: status.active, InstanceCount: status.count,
		Attention: attention,
	}
}

func nounFor(d Definition, count int) string {
	if count == 1 {
		return d.InstanceNounSingular
	}
	return d.InstanceNounPlural
}

// pluginStatuses reads each plugin's own tables. The rules are deliberately
// plugin-specific; see docs/plugins.md for what configured and active mean for
// each one.
func (s *Service) pluginStatuses(ctx context.Context) (map[string]pluginStatus, error) {
	statuses := map[string]pluginStatus{}

	// Emergency Alerts is active when its monitor is switched on, and its rules
	// are its instances. A monitor with areas chosen but no rule is configured
	// but will never respond, which is worth pointing out.

	var forms pluginStatus
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM data_sources WHERE provider='form' AND deleted_at IS NULL`).
		Scan(&forms.count); err != nil {
		return nil, err
	}
	forms.configured = forms.count > 0
	forms.active = forms.count > 0
	statuses[FormsID] = forms
	return statuses, nil
}

func validateTargets(ctx context.Context, tx pgx.Tx, scope string, ids []uuid.UUID) error {
	if scope == "all" {
		return nil
	}
	table := map[string]string{"screens": "screens", "sync_groups": "screen_groups", "locations": "locations"}[scope]
	var count int
	query := `SELECT count(*) FROM ` + table + ` WHERE id=ANY($1)`
	if table == "screens" {
		query += ` AND archived_at IS NULL`
	} else if table == "screen_groups" {
		query += ` AND deleted_at IS NULL`
	}
	if err := tx.QueryRow(ctx, query, ids).Scan(&count); err != nil {
		return err
	}
	if count != len(ids) {
		return fmt.Errorf("%w: one or more targets do not exist", ErrInvalid)
	}
	return nil
}

type note struct {
	id      uuid.UUID
	version int64
}

func bumpAllScreens(ctx context.Context, tx pgx.Tx, reason string) ([]note, error) {
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason)
		SELECT id,1,$1 FROM screens WHERE archived_at IS NULL
		ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,
		manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$1
		RETURNING screen_id,manifest_version`, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := []note{}
	for rows.Next() {
		var n note
		if err = rows.Scan(&n.id, &n.version); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

func bumpScreens(ctx context.Context, tx pgx.Tx, screenIDs []uuid.UUID, reason string) ([]note, error) {
	if len(screenIDs) == 0 {
		return []note{}, nil
	}
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason)
		SELECT id,1,$2 FROM screens WHERE id=ANY($1) AND organization_id=(SELECT id FROM organization_settings WHERE singleton) AND deleted_at IS NULL AND archived_at IS NULL
		ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,
		manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2
		RETURNING screen_id,manifest_version`, screenIDs, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := []note{}
	for rows.Next() {
		var n note
		if err = rows.Scan(&n.id, &n.version); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

func (s *Service) notify(notes []note) {
	if s.notifier == nil {
		return
	}
	for _, n := range notes {
		s.notifier.ManifestChanged(n.id, n.version)
	}
}

func (s *Service) bumpPlugin(ctx context.Context, tx pgx.Tx, pluginType string, pluginID uuid.UUID, reason string) ([]note, error) {
	if s.invalidator == nil {
		return bumpAllScreens(ctx, tx, reason)
	}
	notes := []note{}
	err := s.invalidator.InvalidatePluginInTx(ctx, tx, pluginType, pluginID, reason, func(id uuid.UUID, version int64) {
		notes = append(notes, note{id: id, version: version})
	})
	return notes, err
}

// ManifestForScreen projects every enabled instance of every installed built-in
// plugin that applies to one screen, in a stable order. Installation is checked
// first: configuration left behind for a plugin that is not installed — after a
// restore, a downgrade, or a manual edit — never reaches a Player. Bars from
// different plugins travel in one array and carry their own priority, so the
// player decides what occupies the bar from the manifest alone rather than from
// the order the server happened to query in.
func (s *Service) ManifestForScreen(ctx context.Context, screenID uuid.UUID) ([]ManifestPlugin, error) {
	installed, _, err := s.installations(ctx)
	if err != nil {
		return nil, err
	}
	out := []ManifestPlugin{}
	for _, hosted := range s.hosted {
		id := hosted.manifest.ID
		if !installed[id] {
			continue
		}
		var items []ManifestPlugin
		if projector, ok := hosted.plugin.(plugin.ManifestProjector); ok {
			items, err = projector.ProjectManifest(ctx, screenID)
			if err == nil {
				err = checkManifestTypes(hosted.manifest, items)
			}
		}
		if err != nil {
			return nil, err
		}
		out = append(out, items...)
	}
	return out, nil
}

// checkManifestTypes keeps a projector to the entry types its manifest
// declares, so a Player's renderer registry and the server always agree on
// which plugin a manifest entry belongs to.
func checkManifestTypes(manifest plugin.Manifest, items []ManifestPlugin) error {
	declared := map[string]bool{}
	for _, kind := range manifest.ManifestTypes() {
		declared[kind] = true
	}
	for _, item := range items {
		if !declared[item.Type] || item.Version < 1 {
			return fmt.Errorf("plugin %s projected undeclared manifest entry type %q version %d", manifest.ID, item.Type, item.Version)
		}
	}
	return nil
}
