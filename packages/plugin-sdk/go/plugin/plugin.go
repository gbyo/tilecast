// Package plugin is the Go half of the Tilecast Plugin API v1.
//
// A bundled first-party plugin is a Go package under plugins/<name>/ that
// returns a Plugin from its New constructor. The only required method is
// Manifest. Everything else is an optional contribution interface: a plugin
// implements exactly the ones it needs, and the host discovers them with a
// type assertion. A plugin that has no Player surface does not implement
// ManifestProjector; one with no removal rules does not implement
// RemovalGuard.
//
// Plugins depend on this package and on stable third-party libraries (pgx,
// uuid). They never import Tilecast Server internals; the Go toolchain
// enforces that, because apps/server/internal is not importable from the
// plugins module. Everything a plugin needs from core arrives as a Host
// service in Init.
//
// Bundled plugins are trusted code compiled into the Tilecast release. This
// API is an architectural boundary, not a sandbox.
package plugin

import (
	"context"
	"io/fs"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Plugin is the one interface every plugin implements.
type Plugin interface {
	Manifest() Manifest
}

// Initializer receives host services before any other contribution is used.
// A plugin keeps the Host it is given; Init runs once per process.
type Initializer interface {
	Init(ctx context.Context, host Host) error
}

// Migrator contributes Goose SQL migrations. Files are named with a version
// from the single global Tilecast sequence (reserve one with
// `npm run plugins:migration`), so plugin migrations run with core
// migrations during a release upgrade and share one schema version for
// backup and restore. Installing a plugin never runs a migration.
type Migrator interface {
	Migrations() fs.FS
}

// StatusReporter answers the catalog's plugin-specific questions. It is asked
// whether or not the plugin is installed: feature data without an
// installation is reported to the operator as having no effect.
type StatusReporter interface {
	Status(ctx context.Context) (Status, error)
}

// RemovalGuard lists plugin-owned resources that must be deleted before the
// installation record can go. It runs inside the Remove transaction after the
// installation row is locked. Removal never deletes plugin data.
type RemovalGuard interface {
	RemovalBlockers(ctx context.Context, tx pgx.Tx) ([]Blocker, error)
}

// RouteProvider registers dashboard API routes. Each pattern must start with
// one of the manifest's api.basePaths.
type RouteProvider interface {
	Routes(router Router)
}

// ManifestProjector contributes Player manifest entries for one screen. The
// host calls it only while the plugin is installed. Every entry type must be
// listed in the manifest's runtime.manifestTypes.
type ManifestProjector interface {
	ProjectManifest(ctx context.Context, screenID uuid.UUID) ([]ManifestEntry, error)
}

// AssetDependent reports screens whose manifests draw an asset through this
// plugin, so a media change reaches them even though no playlist names it.
type AssetDependent interface {
	ScreensUsingAsset(ctx context.Context, tx pgx.Tx, assetID uuid.UUID) ([]uuid.UUID, error)
}

// WorkerProvider contributes long-running background workers. The host starts
// them after migrations and stops them at shutdown. The manifest must declare
// capabilities.backgroundWorkers.
type WorkerProvider interface {
	Workers() []Worker
}

// MaintenanceProvider contributes bounded tasks that run on the host's
// periodic maintenance pass, for example expiring retained history.
type MaintenanceProvider interface {
	Maintenance() []MaintenanceTask
}

// HeartbeatConsumer handles optional sections of the authenticated Player
// heartbeat. Each section name must be declared in capabilities.heartbeat.
type HeartbeatConsumer interface {
	HeartbeatSections() []HeartbeatSection
}

// Worker is a background loop. Run returns when ctx is cancelled.
type Worker struct {
	Name string
	Run  func(ctx context.Context) error
}

// MaintenanceTask removes or compacts plugin-owned data in bounded batches and
// reports how many rows it changed.
type MaintenanceTask struct {
	Name string
	Run  func(ctx context.Context) (int64, error)
}

// Bundle is the manifest and migrations a plugin package embeds. Plugins embed
// Bundle in their own type so Manifest and Migrations come for free.
type Bundle struct {
	manifest   Manifest
	migrations fs.FS
}

// NewBundle parses the embedded manifest. It panics on an invalid manifest:
// the file is compiled into the release, so an error is a build defect that
// pluginctl and the conformance tests report first.
//
// migrations is the plugin package's embedded file system, for example
//
//	//go:embed migrations/*.sql
//	var migrations embed.FS
//
// and NewBundle narrows it to the directory the manifest declares. Pass nil
// when the plugin has no migrations.
func NewBundle(manifestJSON []byte, migrations fs.FS) Bundle {
	manifest, err := ParseManifest(manifestJSON)
	if err != nil {
		panic(err)
	}
	switch {
	case migrations != nil && manifest.Migrations == "":
		panic("plugin " + manifest.ID + ": migrations are embedded but the manifest does not declare them")
	case migrations == nil && manifest.Migrations != "":
		panic("plugin " + manifest.ID + ": the manifest declares migrations but none are embedded")
	case migrations != nil:
		migrations, err = fs.Sub(migrations, strings.TrimPrefix(manifest.Migrations, "./"))
		if err != nil {
			panic(err)
		}
	}
	return Bundle{manifest: manifest, migrations: migrations}
}

func (b Bundle) Manifest() Manifest { return b.manifest }

// Migrations returns the plugin's migration files, or nil when it has none.
func (b Bundle) Migrations() fs.FS { return b.migrations }
