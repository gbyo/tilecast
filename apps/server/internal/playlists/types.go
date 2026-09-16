package playlists

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

var (
	ErrNotFound     = errors.New("playlist not found")
	ErrConflict     = errors.New("playlist conflict")
	ErrInvalidAsset = errors.New("asset is not ready for playback")
	ErrInvalidItem  = errors.New("playlist item is invalid")
)

type Playlist struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	// Revision is the currently published runtime revision. DraftRevision is
	// the independent working-copy revision returned by the authoring API.
	Revision              int64         `json:"revision"`
	DraftRevision         int64         `json:"draftRevision,omitempty"`
	PublishedRevision     int64         `json:"publishedRevision,omitempty"`
	HasUnpublishedChanges bool          `json:"hasUnpublishedChanges"`
	CreatedAt             time.Time     `json:"createdAt"`
	UpdatedAt             time.Time     `json:"updatedAt"`
	Items                 []Item        `json:"items"`
	ItemCount             int           `json:"itemCount"`
	Warnings              []string      `json:"warnings"`
	LayoutUsage           []LayoutUsage `json:"layoutUsage"`
	// Usage names the screens and schedules that play this playlist, so Studio can walk from a
	// Data Source through its Widgets and playlists to the screens actually displaying it. It
	// mirrors the Layout usage shape and is populated on the detail read only.
	Usage Usage `json:"usage"`
	// DataSourceIDs are the Data Sources this playlist reaches through its items: the ones its
	// Widgets read, plus the ones any Layout it embeds depends on. A Layout already stores its own
	// dependencies, but a playlist's are only discoverable by looking through each item, which
	// Studio cannot do without one detail request per item. Only the IDs are returned; the caller
	// already reads the Data Source list to resolve names and refresh status. Detail read only.
	DataSourceIDs []uuid.UUID `json:"dataSourceIds"`
	SourceType    string      `json:"sourceType"`
	TagRule       *TagRule    `json:"tagRule,omitempty"`
}

type PlaylistTag struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Color string    `json:"color"`
}

type TagRule struct {
	Match           string        `json:"match"`
	ImageDurationMS int64         `json:"imageDurationMs"`
	Tags            []PlaylistTag `json:"tags"`
}

type TagRuleInput struct {
	Enabled         bool        `json:"enabled"`
	Match           string      `json:"match"`
	ImageDurationMS int64       `json:"imageDurationMs"`
	TagIDs          []uuid.UUID `json:"tagIds"`
}

type LayoutUsage struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Published bool      `json:"published"`
}

type UsageItem struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type Usage struct {
	Screens   []UsageItem `json:"screens"`
	Schedules []UsageItem `json:"schedules"`
	Campaigns []UsageItem `json:"campaigns"`
}

type Item struct {
	ID                   uuid.UUID  `json:"id"`
	AssetID              uuid.UUID  `json:"assetId"`
	LayoutID             *uuid.UUID `json:"layoutId,omitempty"`
	Position             int        `json:"position"`
	DurationMS           *int64     `json:"durationMs,omitempty"`
	FitMode              string     `json:"fitMode"`
	Transition           string     `json:"transition"`
	AudioEnabled         bool       `json:"audioEnabled"`
	Volume               float64    `json:"volume"`
	VideoStartOffsetMS   *int64     `json:"videoStartOffsetMs,omitempty"`
	VideoEndOffsetMS     *int64     `json:"videoEndOffsetMs,omitempty"`
	DeliveryPolicy       string     `json:"deliveryPolicy"`
	UsePlayerDefaults    bool       `json:"usePlayerDefaults"`
	AssetName            string     `json:"assetName"`
	AssetType            string     `json:"assetType"`
	WidgetProvider       string     `json:"widgetProvider,omitempty"`
	AssetStatus          string     `json:"assetStatus"`
	AssetDurationSeconds *float64   `json:"assetDurationSeconds,omitempty"`
	ThumbnailURL         string     `json:"thumbnailUrl"`
	VariantID            *uuid.UUID `json:"variantId,omitempty"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
	AvailableFrom        *time.Time `json:"availableFrom,omitempty"`
	ExpiresAt            *time.Time `json:"expiresAt,omitempty"`
	Dynamic              bool       `json:"dynamic"`
}

type ItemInput struct {
	AssetID            uuid.UUID  `json:"assetId"`
	LayoutID           *uuid.UUID `json:"layoutId"`
	DurationMS         *int64     `json:"durationMs"`
	FitMode            string     `json:"fitMode"`
	Transition         string     `json:"transition"`
	AudioEnabled       *bool      `json:"audioEnabled"`
	Volume             *float64   `json:"volume"`
	VideoStartOffsetMS *int64     `json:"videoStartOffsetMs"`
	VideoEndOffsetMS   *int64     `json:"videoEndOffsetMs"`
	DeliveryPolicy     string     `json:"deliveryPolicy"`
	UsePlayerDefaults  bool       `json:"usePlayerDefaults"`
}

// BulkItemInput describes one authoring-level update applied to a selection of
// static playlist items. An empty itemIds array targets every item.
type BulkItemInput struct {
	ItemIDs    []uuid.UUID `json:"itemIds"`
	Transition *string     `json:"transition"`
	DurationMS *int64      `json:"durationMs"`
}

type ListResult struct {
	Items    []Playlist `json:"items"`
	Total    int        `json:"total"`
	Page     int        `json:"page"`
	PageSize int        `json:"pageSize"`
}

type Assignment struct {
	ScreenID                      uuid.UUID            `json:"screenId"`
	PlaylistID                    *uuid.UUID           `json:"playlistId,omitempty"`
	PlaylistName                  *string              `json:"playlistName,omitempty"`
	PlaylistRevision              *int64               `json:"playlistRevision,omitempty"`
	LayoutID                      *uuid.UUID           `json:"layoutId,omitempty"`
	LayoutName                    *string              `json:"layoutName,omitempty"`
	LayoutRevision                *int64               `json:"layoutRevision,omitempty"`
	PresentationType              *string              `json:"presentationType,omitempty"`
	ManifestVersion               int64                `json:"manifestVersion"`
	PlayerActiveManifestVersion   *int64               `json:"playerActiveManifestVersion,omitempty"`
	PlayerPendingManifestVersion  *int64               `json:"playerPendingManifestVersion,omitempty"`
	SynchronizationStatus         string               `json:"synchronizationStatus"`
	DownloadQueueCount            *int                 `json:"downloadQueueCount,omitempty"`
	DownloadedBytes               *int64               `json:"downloadedBytes,omitempty"`
	RequiredBytes                 *int64               `json:"requiredBytes,omitempty"`
	CacheUsedBytes                *int64               `json:"cacheUsedBytes,omitempty"`
	CacheLimitBytes               *int64               `json:"cacheLimitBytes,omitempty"`
	CurrentItemID                 *uuid.UUID           `json:"currentItemId,omitempty"`
	CurrentAssetID                *uuid.UUID           `json:"currentAssetId,omitempty"`
	PlaybackState                 *string              `json:"playbackState,omitempty"`
	LastSyncError                 *string              `json:"lastSynchronizationError,omitempty"`
	LastPlaybackError             *string              `json:"lastPlaybackError,omitempty"`
	CurrentScheduleID             *uuid.UUID           `json:"currentScheduleId,omitempty"`
	CurrentPlaylistID             *uuid.UUID           `json:"currentPlaylistId,omitempty"`
	SelectionSource               *string              `json:"selectionSource,omitempty"`
	NextTransitionAt              *time.Time           `json:"nextTransitionAt,omitempty"`
	DeviceClockOffsetSeconds      *int64               `json:"deviceClockOffsetSeconds,omitempty"`
	ScheduleEvaluationError       *string              `json:"scheduleEvaluationError,omitempty"`
	ScheduleManifestVersion       *int64               `json:"scheduleManifestVersion,omitempty"`
	Groups                        []AssignmentGroup    `json:"groups"`
	RelevantSchedules             []AssignmentSchedule `json:"relevantSchedules"`
	ClockSkewWarningSeconds       int                  `json:"clockSkewWarningSeconds"`
	CurrentWebsiteAssetID         *uuid.UUID           `json:"currentWebsiteAssetId,omitempty"`
	WebsiteState                  *string              `json:"websiteState,omitempty"`
	WebsiteLoadStartedAt          *time.Time           `json:"websiteLoadStartedAt,omitempty"`
	WebsiteLoadCompletedAt        *time.Time           `json:"websiteLoadCompletedAt,omitempty"`
	WebsiteFailureCategory        *string              `json:"websiteFailureCategory,omitempty"`
	WebsiteBlockedNavigationCount *int                 `json:"websiteBlockedNavigationCount,omitempty"`
	WebsiteCurrentHost            *string              `json:"websiteCurrentHost,omitempty"`
	WebsiteFallbackShown          *bool                `json:"websiteFallbackShown,omitempty"`
	WebsiteRendererRecoveryCount  *int                 `json:"websiteRendererRecoveryCount,omitempty"`
	ActiveTakeoverID              *uuid.UUID           `json:"activeTakeoverId,omitempty"`
	TakeoverState                 *string              `json:"takeoverState,omitempty"`
	TakeoverPreparationProgress   *int                 `json:"takeoverPreparationProgress,omitempty"`
	PlaybackDisabled              bool                 `json:"playbackDisabled"`
	LastCommandID                 *uuid.UUID           `json:"lastCommandId,omitempty"`
	LastCommandState              *string              `json:"lastCommandState,omitempty"`
	LastCommandResult             *string              `json:"lastCommandResult,omitempty"`
	LastCommandCompletedAt        *time.Time           `json:"lastCommandCompletedAt,omitempty"`
	ActiveConfigRevision          *int64               `json:"activeConfigRevision,omitempty"`
	ConfigurationError            *string              `json:"configurationError,omitempty"`
}
type AssignmentGroup struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}
type AssignmentSchedule struct {
	ID               uuid.UUID `json:"id"`
	Name             string    `json:"name"`
	PlaylistName     string    `json:"playlistName"`
	PresentationType string    `json:"presentationType"`
	Priority         int       `json:"priority"`
	Enabled          bool      `json:"enabled"`
}

type Manifest struct {
	SchemaVersion          int                           `json:"schemaVersion"`
	ManifestVersion        int64                         `json:"manifestVersion"`
	ScreenID               uuid.UUID                     `json:"screenId"`
	GeneratedAt            time.Time                     `json:"generatedAt"`
	Mode                   string                        `json:"mode"`
	Playlist               *ManifestPlaylist             `json:"playlist,omitempty"`
	DirectFallbackPlaylist *ManifestPlaylist             `json:"directFallbackPlaylist,omitempty"`
	Playlists              []ManifestPlaylist            `json:"playlists"`
	Schedules              []ManifestSchedule            `json:"schedules"`
	Assets                 []ManifestAsset               `json:"assets"`
	Branding               *ManifestBranding             `json:"branding,omitempty"`
	ServerTime             time.Time                     `json:"serverTime"`
	PrefetchHorizonDays    int                           `json:"prefetchHorizonDays"`
	ActivationGraceSeconds int                           `json:"activationGraceSeconds"`
	Websites               []ManifestWebsite             `json:"websites"`
	Widgets                []ManifestWidget              `json:"widgets"`
	DataSources            []ManifestDataSource          `json:"dataSources"`
	Plugins                []plugins.ManifestPlugin      `json:"plugins"`
	PresentationOverride   *ManifestPresentationOverride `json:"presentationOverride,omitempty"`
	Takeover               *ManifestTakeover             `json:"takeover,omitempty"`
	// LegacyTakeover mirrors Takeover under the pre-rename `emergency` key. A
	// Player built before the takeover rename looks only for that key, and an
	// override it cannot see is the one failure this feature must not have, so
	// the alias is emitted unconditionally rather than negotiated by version.
	// Remove it once no fielded Player predates the rename.
	LegacyTakeover       *ManifestTakeover  `json:"emergency,omitempty"`
	SyncGroup            *ManifestSyncGroup `json:"syncGroup,omitempty"`
	Canvas               *ManifestCanvas    `json:"canvas,omitempty"`
	Viewport             *ManifestViewport  `json:"viewport,omitempty"`
	Layout               *ManifestLayout    `json:"layout,omitempty"`
	DirectFallbackLayout *ManifestLayout    `json:"directFallbackLayout,omitempty"`
	Layouts              []ManifestLayout   `json:"layouts"`
}
type ManifestBranding struct {
	LogoAssetID   *uuid.UUID `json:"logoAssetId,omitempty"`
	LogoVariantID *uuid.UUID `json:"logoVariantId,omitempty"`
}
type ManifestPresentationOverride struct {
	ID          uuid.UUID  `json:"id"`
	ContentType string     `json:"contentType"`
	ContentID   uuid.UUID  `json:"contentId"`
	ContentName string     `json:"contentName"`
	StartedAt   time.Time  `json:"startedAt"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	PlaylistID  *uuid.UUID `json:"playlistId,omitempty"`
	LayoutID    *uuid.UUID `json:"layoutId,omitempty"`
	WakeDisplay bool       `json:"wakeDisplay"`
}
type ManifestLayout struct {
	ID             uuid.UUID        `json:"id"`
	RevisionID     uuid.UUID        `json:"revisionId"`
	Revision       int64            `json:"revision"`
	DocumentSHA256 string           `json:"documentSha256"`
	Document       layouts.Document `json:"document"`
}
type ManifestSyncGroup struct {
	ID            uuid.UUID `json:"id"`
	PlaybackEpoch time.Time `json:"playbackEpoch"`
}

type ManifestCanvas struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type ManifestViewport struct {
	X           int `json:"x"`
	Y           int `json:"y"`
	Width       int `json:"width"`
	Height      int `json:"height"`
	Rotation    int `json:"rotation"`
	Order       int `json:"order"`
	BezelLeft   int `json:"bezelLeft,omitempty"`
	BezelTop    int `json:"bezelTop,omitempty"`
	BezelRight  int `json:"bezelRight,omitempty"`
	BezelBottom int `json:"bezelBottom,omitempty"`
}

// ManifestWidget is a renderable widget projected into the manifest. Its configuration
// carries display settings only; a data-driven widget references a Data Source by id and
// never embeds the cached dataset.
type ManifestWidget struct {
	AssetID       uuid.UUID           `json:"assetId"`
	Name          string              `json:"name"`
	Provider      string              `json:"provider,omitempty"`
	PresetID      *string             `json:"-"`
	ConfigVersion int                 `json:"configVersion,omitempty"`
	Configuration json.RawMessage     `json:"configuration,omitempty"`
	Presentation  *WidgetPresentation `json:"presentation,omitempty"`
}

// ManifestDataSource is a Data Source projected into the manifest exactly once and shared
// across every widget or Layout binding that consumes it. Its configuration carries the
// bounded cached dataset plus the date-selection policy the Player applies locally.
type ManifestDataSource struct {
	ID            uuid.UUID       `json:"id"`
	Name          string          `json:"name"`
	Provider      string          `json:"provider,omitempty"`
	ConfigVersion int             `json:"configVersion,omitempty"`
	Configuration json.RawMessage `json:"configuration,omitempty"`
	DataDocument  *DataDocument   `json:"dataDocument,omitempty"`
}
type ManifestTakeover struct {
	ID          uuid.UUID `json:"id"`
	PlaylistID  uuid.UUID `json:"playlistId"`
	ActivatedAt time.Time `json:"activatedAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
}
type ManifestWebsite struct {
	AssetID                uuid.UUID  `json:"assetId"`
	Name                   string     `json:"name"`
	URL                    string     `json:"url"`
	AllowedHosts           []string   `json:"allowedHosts"`
	JavaScriptEnabled      bool       `json:"javascriptEnabled"`
	DOMStorageEnabled      bool       `json:"domStorageEnabled"`
	CookiePolicy           string     `json:"cookiePolicy"`
	ReloadPolicy           string     `json:"reloadPolicy"`
	RefreshIntervalSeconds *int       `json:"refreshIntervalSeconds,omitempty"`
	LoadTimeoutSeconds     int        `json:"loadTimeoutSeconds"`
	ZoomPercent            int        `json:"zoomPercent"`
	ScrollX                int        `json:"scrollX"`
	ScrollY                int        `json:"scrollY"`
	CustomUserAgent        string     `json:"customUserAgent,omitempty"`
	BackgroundColor        string     `json:"backgroundColor"`
	FailureBehavior        string     `json:"failureBehavior"`
	FallbackImageAssetID   *uuid.UUID `json:"fallbackImageAssetId,omitempty"`
	FallbackVariantID      *uuid.UUID `json:"fallbackVariantId,omitempty"`
}
type ManifestSchedule struct {
	ID            uuid.UUID              `json:"id"`
	PlaylistID    *uuid.UUID             `json:"playlistId,omitempty"`
	LayoutID      *uuid.UUID             `json:"layoutId,omitempty"`
	DisplayAction *displaycontrol.Action `json:"displayAction,omitempty"`
	Type          string                 `json:"type"`
	Timezone      string                 `json:"timezone"`
	Priority      int                    `json:"priority"`
	Specificity   int                    `json:"specificity"`
	StartDate     *string                `json:"startDate,omitempty"`
	EndDate       *string                `json:"endDate,omitempty"`
	OneTimeStart  *time.Time             `json:"oneTimeStart,omitempty"`
	OneTimeEnd    *time.Time             `json:"oneTimeEnd,omitempty"`
	DailyStart    *string                `json:"dailyStart,omitempty"`
	DailyEnd      *string                `json:"dailyEnd,omitempty"`
	DaysOfWeek    []int                  `json:"daysOfWeek,omitempty"`
}
type ManifestPlaylist struct {
	ID       uuid.UUID      `json:"id"`
	Revision int64          `json:"revision"`
	Name     string         `json:"name"`
	Items    []ManifestItem `json:"items"`
}
type ManifestItem struct {
	ID                 uuid.UUID  `json:"id"`
	AssetID            uuid.UUID  `json:"assetId"`
	LayoutID           *uuid.UUID `json:"layoutId,omitempty"`
	VariantID          *uuid.UUID `json:"variantId,omitempty"`
	AssetType          string     `json:"assetType"`
	DurationMS         *int64     `json:"durationMs,omitempty"`
	FitMode            string     `json:"fitMode"`
	Transition         string     `json:"transition"`
	AudioEnabled       bool       `json:"audioEnabled"`
	Volume             float64    `json:"volume"`
	VideoStartOffsetMS *int64     `json:"videoStartOffsetMs,omitempty"`
	VideoEndOffsetMS   *int64     `json:"videoEndOffsetMs,omitempty"`
	DeliveryPolicy     string     `json:"deliveryPolicy"`
	UsePlayerDefaults  bool       `json:"usePlayerDefaults,omitempty"`
	AvailableFrom      *time.Time `json:"availableFrom,omitempty"`
	ExpiresAt          *time.Time `json:"expiresAt,omitempty"`
}
type ManifestAsset struct {
	AssetID         uuid.UUID  `json:"assetId"`
	VariantID       uuid.UUID  `json:"variantId"`
	MIMEType        string     `json:"mimeType"`
	SHA256          string     `json:"sha256"`
	FileSize        int64      `json:"fileSize"`
	Width           *int       `json:"width,omitempty"`
	Height          *int       `json:"height,omitempty"`
	DurationSeconds *float64   `json:"durationSeconds,omitempty"`
	DownloadPath    string     `json:"downloadPath"`
	AvailableFrom   *time.Time `json:"availableFrom,omitempty"`
	ExpiresAt       *time.Time `json:"expiresAt,omitempty"`
}

type PlayerStatus struct {
	ActiveManifestVersion         *int64     `json:"activeManifestVersion,omitempty"`
	PendingManifestVersion        *int64     `json:"pendingManifestVersion,omitempty"`
	AssignedPlaylistID            *uuid.UUID `json:"assignedPlaylistId,omitempty"`
	CurrentItemID                 *uuid.UUID `json:"currentItemId,omitempty"`
	CurrentAssetID                *uuid.UUID `json:"currentAssetId,omitempty"`
	PlaybackState                 string     `json:"playbackState,omitempty"`
	DownloadQueueCount            *int       `json:"downloadQueueCount,omitempty"`
	DownloadedBytes               *int64     `json:"downloadedBytes,omitempty"`
	RequiredBytes                 *int64     `json:"requiredBytes,omitempty"`
	CacheUsedBytes                *int64     `json:"cacheUsedBytes,omitempty"`
	CacheLimitBytes               *int64     `json:"cacheLimitBytes,omitempty"`
	LastSyncError                 string     `json:"lastSynchronizationError,omitempty"`
	LastPlaybackError             string     `json:"lastPlaybackError,omitempty"`
	CurrentScheduleID             *uuid.UUID `json:"currentScheduleId,omitempty"`
	CurrentPlaylistID             *uuid.UUID `json:"currentPlaylistId,omitempty"`
	SelectionSource               string     `json:"selectionSource,omitempty"`
	NextTransitionAt              *time.Time `json:"nextTransitionAt,omitempty"`
	DeviceClockOffsetSeconds      *int64     `json:"deviceClockOffsetSeconds,omitempty"`
	ScheduleEvaluationError       string     `json:"scheduleEvaluationError,omitempty"`
	ScheduleManifestVersion       *int64     `json:"scheduleManifestVersion,omitempty"`
	CurrentWebsiteAssetID         *uuid.UUID `json:"currentWebsiteAssetId,omitempty"`
	WebsiteState                  string     `json:"websiteState,omitempty"`
	WebsiteLoadStartedAt          *time.Time `json:"websiteLoadStartedAt,omitempty"`
	WebsiteLoadCompletedAt        *time.Time `json:"websiteLoadCompletedAt,omitempty"`
	WebsiteFailureCategory        string     `json:"websiteFailureCategory,omitempty"`
	WebsiteBlockedNavigationCount *int       `json:"websiteBlockedNavigationCount,omitempty"`
	WebsiteCurrentHost            string     `json:"websiteCurrentHost,omitempty"`
	WebsiteFallbackShown          *bool      `json:"websiteFallbackShown,omitempty"`
	WebsiteRendererRecoveryCount  *int       `json:"websiteRendererRecoveryCount,omitempty"`
	CurrentWidgetID               *uuid.UUID `json:"currentWidgetId,omitempty"`
	WidgetProvider                string     `json:"widgetProvider,omitempty"`
	WidgetState                   string     `json:"widgetState,omitempty"`
	WidgetError                   string     `json:"widgetError,omitempty"`
	ActiveTakeoverID              *uuid.UUID `json:"activeTakeoverId,omitempty"`
	TakeoverState                 string     `json:"takeoverState,omitempty"`
	TakeoverPreparationProgress   *int       `json:"takeoverPreparationProgress,omitempty"`
	PlaybackDisabled              *bool      `json:"playbackDisabled,omitempty"`
	LastCommandID                 *uuid.UUID `json:"lastCommandId,omitempty"`
	LastCommandState              string     `json:"lastCommandState,omitempty"`
	LastCommandResult             string     `json:"lastCommandResult,omitempty"`
	LastCommandCompletedAt        *time.Time `json:"lastCommandCompletedAt,omitempty"`
	ActiveConfigRevision          *int64     `json:"activeConfigRevision,omitempty"`
	ConfigurationError            string     `json:"configurationError,omitempty"`
}

type Notifier interface {
	ManifestChanged(screenID uuid.UUID, version int64)
}

// PresentationOverride is the small cross-package contract used to project a
// Quick Present record into an ordinary player manifest. Persistence and
// validation live in the presentations package; this package owns content
// graph projection so the Player receives no second content protocol.
type PresentationOverride struct {
	ID          uuid.UUID
	TargetType  string
	TargetID    uuid.UUID
	ContentType string
	ContentID   uuid.UUID
	ContentName string
	StartedAt   time.Time
	ExpiresAt   *time.Time
	WakeDisplay bool
}

type PresentationOverrideProjector interface {
	ActiveForScreen(context.Context, uuid.UUID) (*PresentationOverride, error)
	ReconcileExpired(context.Context) error
}
