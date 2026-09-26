package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Portable typed-dataset types. A plugin-owned Data Source provider writes
// the same cached payload shape core Data Sources write, so Widgets, Layout
// bindings, and Players cannot tell who projected it. The JSON encoding is
// identical to the core media types on purpose: an existing cached payload
// must keep decoding after the projecting code moves into a plugin.

// DataSourceField is one selectable output field a Data Source exposes.
type DataSourceField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Currency string `json:"currency,omitempty"`
}

// TypedRecord is one stringified row of a projected dataset.
type TypedRecord struct {
	ID     string            `json:"id"`
	Values map[string]string `json:"values"`
}

// TypedPoint is one time-series point of a projected dataset.
type TypedPoint struct {
	At     time.Time         `json:"at"`
	Values map[string]string `json:"values"`
}

// TypedDataset is one named dataset of a cached projection payload.
type TypedDataset struct {
	ID              string            `json:"id"`
	Kind            string            `json:"kind"`
	Fields          []DataSourceField `json:"fields,omitempty"`
	Records         []TypedRecord     `json:"records,omitempty"`
	Points          []TypedPoint      `json:"points,omitempty"`
	Values          map[string]string `json:"values,omitempty"`
	CachedAt        *time.Time        `json:"cachedAt,omitempty"`
	StaleAt         *time.Time        `json:"staleAt,omitempty"`
	Attribution     string            `json:"attribution,omitempty"`
	Timezone        string            `json:"timezone,omitempty"`
	Units           map[string]string `json:"units,omitempty"`
	UsingCachedData bool              `json:"usingCachedData"`
	Unavailable     bool              `json:"unavailable"`
}

// TypedDatasetPayload is the cached provider-neutral projection the host
// stores per Data Source and delivers to Widgets and Players.
type TypedDatasetPayload struct {
	Datasets []TypedDataset `json:"datasets"`
}

// DataSourceRecord is the plugin-visible shape of a provider-owned core
// Data Source row. It carries only what a provider needs to manage its own
// instances; listing, previewing, and binding stay core behavior.
type DataSourceRecord struct {
	ID            uuid.UUID
	Provider      string
	Name          string
	Description   string
	Configuration json.RawMessage
	// CreatedBy is uuid.Nil when the row has no creator.
	CreatedBy  uuid.UUID
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// DataSourceCreate provisions one provider-owned Data Source row.
type DataSourceCreate struct {
	Provider      string
	Name          string
	Description   string
	CreatedBy     uuid.UUID
	Configuration json.RawMessage
	// SeedRefresh states the initial cached projection. A provider that
	// projects eagerly (Forms does, on every mutation) seeds an empty
	// payload and rewrites it immediately; a provider with nothing to show
	// yet leaves SeedRefresh nil for a bare refresh row.
	SeedRefresh *RefreshSeed
}

// RefreshSeed is the initial cached state of a new Data Source.
type RefreshSeed struct {
	Payload      TypedDatasetPayload
	ItemCount    int
	NextRefresh  *time.Time
}

// ProjectionWrite replaces a Data Source's cached payload and reschedules
// its next refresh boundary. A nil NextRefresh parks the source far in the
// future; the provider's worker wakes it explicitly instead.
type ProjectionWrite struct {
	Payload      TypedDatasetPayload
	DatasetCount int
	NextRefresh  *time.Time
}

// DataSourceRefresh is the projection status callers show in Studio.
type DataSourceRefresh struct {
	Payload      TypedDatasetPayload
	LastSuccess  *time.Time
	NextRefresh  *time.Time
	UsingCached  bool
	ErrorCode    *string
}

// DataSourceUsage summarizes where a Data Source's datasets are consumed.
// Dataset scopes the report to one named dataset (a Form view); an empty
// dataset reports source-level usage instead.
type DataSourceUsage struct {
	Widgets int
	Layouts int
	Names   []string
}

// DataSources is the narrow Host service for plugin-owned Data Source
// providers. The plugin owns its domain tables and projection content;
// core owns the data_sources row mechanics, the cached projection storage,
// usage accounting, and manifest invalidation. Methods taking a pgx.Tx run
// inside the caller's transaction.
type DataSources interface {
	CreateInTx(ctx context.Context, tx pgx.Tx, input DataSourceCreate) (DataSourceRecord, error)
	// Get returns a live provider-owned row, or ErrNotFound when it is
	// missing, soft-deleted, or owned by another provider.
	Get(ctx context.Context, id uuid.UUID, provider string) (DataSourceRecord, error)
	// ListLive returns every live row of one provider, ordered by name,
	// for provider-level listings the plugin scopes itself.
	ListLive(ctx context.Context, provider string) ([]DataSourceRecord, error)
	UpdateMetadataInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, provider, name string, description *string) error
	Configuration(ctx context.Context, id uuid.UUID, provider string) (json.RawMessage, error)
	// ConfigurationInTx reads the stored configuration inside the caller's
	// transaction, for flows that rewrite it atomically with domain rows.
	ConfigurationInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, provider string) (json.RawMessage, error)
	SetConfigurationInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, provider string, configuration json.RawMessage) error
	RefreshState(ctx context.Context, id uuid.UUID) (DataSourceRefresh, error)
	WriteProjectionInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, write ProjectionWrite) error
	// InvalidateDataSourceInTx runs the normal Data Source revision path
	// for the row, returning the after-commit notification. Call it inside
	// the transaction that changed the projection, then run the returned
	// func after commit.
	InvalidateDataSourceInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) (AfterCommit, error)
	// ClaimDueInTx returns up to limit live rows of one provider whose
	// refresh boundary has arrived, locking them SKIP LOCKED so concurrent
	// workers take disjoint sets.
	ClaimDueInTx(ctx context.Context, tx pgx.Tx, provider string, limit int) ([]uuid.UUID, error)
	Usage(ctx context.Context, id uuid.UUID, dataset string) (DataSourceUsage, error)
	CountLive(ctx context.Context, provider string) (int, error)
	CountLiveInTx(ctx context.Context, tx pgx.Tx, provider string) (int, error)
}

// DirectoryUser is the safe public shape of a core user: identity and role
// only. Credentials, password hashes, MFA state, sessions, and unrelated
// account metadata are never exposed to plugins.
type DirectoryUser struct {
	ID       uuid.UUID
	Name     string
	Username string
	Role     string
	Active   bool
}

// Users is the read-only Host directory service. The plugin keeps owning
// its own grant semantics and capability inheritance; core only supplies
// user facts.
type Users interface {
	Get(ctx context.Context, id uuid.UUID) (DirectoryUser, error)
	// GetInTx reads one user inside the caller's transaction, for flows
	// that record the acting user's name atomically with domain rows.
	GetInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (DirectoryUser, error)
	// SearchActive finds active users by name or username prefix. A
	// non-positive limit selects the default page size; results are
	// bounded by the host.
	SearchActive(ctx context.Context, query string, limit int) ([]DirectoryUser, error)
	ListByRole(ctx context.Context, role string) ([]DirectoryUser, error)
}

// PrivateAsset is a plugin-managed upload: record-scoped content that is
// never part of the Media library, never appears in Media pickers, and is
// delivered only through the owning plugin's authorized endpoints.
type PrivateAsset struct {
	ID uuid.UUID
}

// PluginAssets is the narrow Host service for private plugin-managed
// uploads. Core owns bytes, storage, processing, and delivery; the plugin
// owns which record an asset belongs to, who may see it, and replacement
// semantics, and authorizes every call against its own records before
// reaching this service.
type PluginAssets interface {
	// IngestPrivate stores image bytes as a private asset stamped with the
	// plugin's private origin. Input problems report ErrInvalid; an
	// over-limit upload reports ErrTooLarge.
	IngestPrivate(ctx context.Context, userID uuid.UUID, filename, mimeType string, data []byte) (PrivateAsset, error)
	// DiscardPrivate soft-deletes a private asset and queues storage
	// cleanup. A missing or already-deleted asset is a no-op; anything
	// that is not a private asset reports ErrInvalid and is left alone.
	DiscardPrivate(ctx context.Context, assetID uuid.UUID) error
	// ClaimPrivateInTx confirms a private asset exists, is still live, and
	// is used by no playlist, Widget, or Layout, for binding inside the
	// caller's transaction. References from the plugin's own records are
	// the plugin's business: it checks its own tables itself.
	ClaimPrivateInTx(ctx context.Context, tx pgx.Tx, assetID uuid.UUID) error
	// ServePrivate streams the asset's best variant to an authorized
	// response. The plugin authorizes the viewer first; this method only
	// serves private assets and reports ErrNotFound otherwise.
	ServePrivate(w http.ResponseWriter, r *http.Request, assetID uuid.UUID) error
}

// ErrTooLarge reports an upload beyond the installation's size limit.
var ErrTooLarge = errors.New("upload exceeds the size limit")

// DataSourceTraits are the generic compatibility traits a provider
// contributes. Core keeps matching Widgets and Layout bindings against
// them; the provider only declares what its output is.
type DataSourceTraits struct {
	RecordBased           bool
	Temporal              bool
	Numeric               bool
	SupportsDateSelection bool
	ProducesFields        bool
}

// DataSourceProvider is the generic contribution of a plugin-owned Data
// Source provider. Core owns storage, compatibility matching, the creation
// gallery, and the generic editor shell; the contribution supplies the
// provider behavior core must not hardcode: its identity, traits, stored
// configuration shape, field discovery, and canonical authoring surface.
type DataSourceProvider interface {
	// ProviderID is the stored provider identifier, for example "form".
	// It never changes: existing rows and Widget bindings already use it.
	ProviderID() string
	Traits() DataSourceTraits
	// NormalizeConfiguration validates a stored configuration shape
	// strictly, returning the normalized form. It is pure: no database.
	NormalizeConfiguration(raw json.RawMessage) (json.RawMessage, error)
	// FieldsFromConfig derives the selectable output fields from a stored
	// configuration, for Widget field discovery without an extra query.
	FieldsFromConfig(raw json.RawMessage) []DataSourceField
	// Catalog returns the gallery label, group, and description.
	Catalog() (label, group, description string)
	// CanonicalEditor is the Studio route managing one instance, with
	// ":id" marking the instance segment, for example
	// "/plugins/forms/:id". The generic Data Source UI redirects there
	// instead of opening its own editor.
	CanonicalEditor() string
	// CanonicalCreator is the Studio route creating an instance, for
	// example "/plugins/forms/new". Empty when creation has no separate
	// route.
	CanonicalCreator() string
	// ManagedExternally reports the provider is authored through its own
	// plugin API, so generic create, update, and duplicate refuse and
	// point at the canonical editor.
	ManagedExternally() bool
	// ExternalMessage is the refusal a generic path answers with when the
	// provider is managed externally. Action is "create", "update", or
	// "duplicate". The text is user-visible and versioned like any API
	// error, so it lives with the provider that owns the wording.
	ExternalMessage(action string) string
	// HiddenFromGallery keeps the provider out of the generic Data Source
	// creation gallery. Its output still behaves like an ordinary typed
	// Data Source to Widgets and Layout bindings.
	HiddenFromGallery() bool
}
