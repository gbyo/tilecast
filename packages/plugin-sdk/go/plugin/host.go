package plugin

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Host is the set of stable core services a plugin may use. The host binds
// every service to the plugin it is given to, so Installation answers for
// this plugin and audit and manifest events carry its identity.
//
// Host is a struct rather than an interface so the core can add services
// without breaking existing plugins, and a plugin test can fill in only the
// services it exercises.
type Host struct {
	DB                   DB
	Logger               *slog.Logger
	Installation         Installation
	Audit                Audit
	Manifests            Manifests
	Targets              Targets
	Takeovers            Takeovers
	ManagedPresentations ManagedPresentations
	BackgroundJobs       BackgroundJobs
	Instance             Instance
	Screens              Screens
	Organization         Organization
	Clock                Clock
	DataSources          DataSources
	Users                Users
	PluginAssets         PluginAssets
}

// DB is the Tilecast PostgreSQL database. Plugins own their tables and query
// them directly. Core tables are reached through the other services; a
// plugin that needs a core fact the services do not offer should grow the
// SDK rather than reading core tables.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Installation is the top-level runtime gate. Configuration routes refuse a
// plugin that is not installed rather than installing it implicitly, and
// background work does nothing while it is not installed.
type Installation interface {
	Installed(ctx context.Context) (bool, error)
	// Require returns ErrNotInstalled when the plugin is not installed.
	Require(ctx context.Context) error
	// LockInTx confirms the installation inside tx and holds a share lock on
	// it until commit, so a concurrent Remove cannot slip between the check
	// and a write that creates plugin-owned resources.
	LockInTx(ctx context.Context, tx pgx.Tx) error
}

// Audit writes the organization's audit log.
type Audit interface {
	RecordInTx(ctx context.Context, tx pgx.Tx, event AuditEvent) error
}

type AuditEvent struct {
	// UserID is the acting user, or uuid.Nil for the system.
	UserID       uuid.UUID
	Action       string
	ResourceType string
	ResourceID   string
	ResourceName string
	Metadata     map[string]any
}

// AfterCommit publishes change notifications. Call it only after the
// transaction that produced it has committed.
type AfterCommit func()

// Manifests invalidates Player manifests through the one core revision and
// notification path. There is no parallel plugin revision system.
type Manifests interface {
	// InvalidateResourceInTx bumps every screen whose manifest can contain
	// the plugin resource.
	InvalidateResourceInTx(ctx context.Context, tx pgx.Tx, resourceID uuid.UUID, reason string) (AfterCommit, error)
	// InvalidateAllInTx bumps every active screen.
	InvalidateAllInTx(ctx context.Context, tx pgx.Tx, reason string) (AfterCommit, error)
	InvalidateScreensInTx(ctx context.Context, tx pgx.Tx, screenIDs []uuid.UUID, reason string) (AfterCommit, error)
}

// ScreenTargets is the union of explicitly selected screens and all members
// of the selected display groups. IDs are unique within each slice.
type ScreenTargets struct {
	ScreenIDs []uuid.UUID
	GroupIDs  []uuid.UUID
}

// Targets checks screen targeting against the organization's screens, sync
// groups, and locations. See Target for the shape and the pure validation.
type Targets interface {
	// ValidateInTx reports ErrInvalid when a target does not exist, is an
	// archived screen, or is a deleted group.
	ValidateInTx(ctx context.Context, tx pgx.Tx, target Target) error
	ValidateScreenTargetsInTx(ctx context.Context, tx pgx.Tx, targets ScreenTargets) error
	ResolveScreensInTx(ctx context.Context, tx pgx.Tx, targets ScreenTargets) ([]uuid.UUID, error)
	AppliesToScreen(ctx context.Context, screenID uuid.UUID, targets ScreenTargets) (bool, error)
}

type TakeoverRequest struct {
	Name          string
	Description   string
	PlaylistID    uuid.UUID
	Targets       ScreenTargets
	ActivatedBy   uuid.UUID
	ActivatedAt   time.Time
	ExpiresAt     time.Time
	AuditAction   string
	AuditMetadata map[string]any
}

type TakeoverResult struct {
	ID            uuid.UUID
	AffectedCount int
	ScreenIDs     []uuid.UUID
}

// ErrTakeoverInactive is returned by Takeovers.CancelInTx when the takeover
// is already inactive. Reconcilers tolerate it: a poll clearing an alert
// whose takeover another Takeover already replaced still has to mark the
// alert cleared, and the desired end state already holds.
var ErrTakeoverInactive = errors.New("takeover is no longer active")

type Takeovers interface {
	ValidatePlaylist(ctx context.Context, playlistID uuid.UUID, targets ScreenTargets, userSelectable bool) error
	MaximumDuration() time.Duration
	ActivateInTx(ctx context.Context, tx pgx.Tx, request TakeoverRequest) (TakeoverResult, AfterCommit, error)
	CancelInTx(ctx context.Context, tx pgx.Tx, takeoverID uuid.UUID, actorID uuid.UUID, reason string) (AfterCommit, error)
	RefreshInTx(ctx context.Context, tx pgx.Tx, takeoverID uuid.UUID, reason string) (AfterCommit, error)
}

type ManagedPresentationRequest struct {
	Name                    string
	Description             string
	DataSourceProvider      string
	DataSourceConfiguration string
	CachedPayload           string
	CacheCategory           string
	CacheExpiresAt          time.Time
	WidgetProvider          string
	WidgetConfiguration     func(dataSourceID uuid.UUID) string
	CreatedBy               uuid.UUID
}

type ManagedPresentation struct {
	DataSourceID uuid.UUID
	WidgetID     uuid.UUID
	PlaylistID   uuid.UUID
}

type ManagedPresentations interface {
	EnsureInTx(ctx context.Context, tx pgx.Tx, existing ManagedPresentation, request ManagedPresentationRequest) (ManagedPresentation, error)
	UpdateDataInTx(ctx context.Context, tx pgx.Tx, dataSourceID uuid.UUID, configuration, cachedPayload, cacheCategory string, cacheExpiresAt time.Time) (bool, error)
	PlaylistName(ctx context.Context, playlistID uuid.UUID) (string, error)
}

type BackgroundJobs interface{ Allowed() bool }
type Instance interface{ PublicURL() string }

// Screens answers fleet questions plugins ask for status and advice.
type Screens interface {
	// PairedPlatforms counts screens that are not archived, by platform.
	PairedPlatforms(ctx context.Context) (map[string]int, error)
}

type Organization interface {
	// ID is the installation's single organization.
	ID(ctx context.Context) (uuid.UUID, error)
}

// Clock is the server clock. Tests replace it.
type Clock interface {
	Now() time.Time
}
