package media

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"

	"github.com/google/uuid"
)

type AssetStatus string

const (
	StatusUploading  AssetStatus = "uploading"
	StatusUploaded   AssetStatus = "uploaded"
	StatusQueued     AssetStatus = "queued"
	StatusInspecting AssetStatus = "inspecting"
	StatusProcessing AssetStatus = "processing"
	StatusReady      AssetStatus = "ready"
	StatusFailed     AssetStatus = "failed"
	StatusDeleting   AssetStatus = "deleting"
	StatusDeleted    AssetStatus = "deleted"
)

var assetTransitions = map[AssetStatus]map[AssetStatus]bool{
	StatusUploading:  {StatusUploaded: true, StatusFailed: true},
	StatusUploaded:   {StatusQueued: true, StatusFailed: true, StatusDeleting: true},
	StatusQueued:     {StatusInspecting: true, StatusProcessing: true, StatusFailed: true, StatusDeleting: true},
	StatusInspecting: {StatusProcessing: true, StatusReady: true, StatusFailed: true, StatusDeleting: true},
	StatusProcessing: {StatusReady: true, StatusFailed: true, StatusDeleting: true},
	StatusReady:      {StatusDeleting: true},
	StatusFailed:     {StatusQueued: true, StatusDeleting: true},
	StatusDeleting:   {StatusDeleted: true, StatusFailed: true},
}

func CanTransitionAsset(from, to AssetStatus) bool { return assetTransitions[from][to] }

type UploadStatus string

const (
	UploadPending    UploadStatus = "pending"
	UploadUploading  UploadStatus = "uploading"
	UploadFinalizing UploadStatus = "finalizing"
	UploadFinalized  UploadStatus = "finalized"
	UploadFailed     UploadStatus = "failed"
	UploadExpired    UploadStatus = "expired"
	UploadCancelled  UploadStatus = "cancelled"
)

var uploadTransitions = map[UploadStatus]map[UploadStatus]bool{
	UploadPending:    {UploadUploading: true, UploadFinalizing: true, UploadCancelled: true, UploadExpired: true, UploadFailed: true},
	UploadUploading:  {UploadUploading: true, UploadFinalizing: true, UploadCancelled: true, UploadExpired: true, UploadFailed: true},
	UploadFinalizing: {UploadFinalized: true, UploadFailed: true},
}

func CanTransitionUpload(from, to UploadStatus) bool { return uploadTransitions[from][to] }

var (
	ErrNotFound           = errors.New("media resource not found")
	ErrForbidden          = errors.New("media action forbidden")
	ErrUploadTooLarge     = errors.New("upload too large")
	ErrOffsetMismatch     = errors.New("upload offset mismatch")
	ErrUploadIncomplete   = errors.New("upload incomplete")
	ErrUploadExpired      = errors.New("upload expired")
	ErrUploadUnavailable  = errors.New("upload unavailable")
	ErrInsufficientSpace  = errors.New("insufficient storage")
	ErrUnsupportedType    = errors.New("unsupported media type")
	ErrInspectionFailed   = errors.New("media inspection failed")
	ErrNotReady           = errors.New("media not ready")
	ErrVariantUnavailable = errors.New("media variant unavailable")
)

type Asset struct {
	ID                 uuid.UUID      `json:"id"`
	Name               string         `json:"name"`
	Description        string         `json:"description"`
	Type               string         `json:"type"`
	OriginalFilename   string         `json:"originalFilename"`
	DeclaredMIMEType   string         `json:"declaredMimeType"`
	DetectedMIMEType   string         `json:"detectedMimeType"`
	SHA256             string         `json:"sha256"`
	OriginalSize       int64          `json:"originalSize"`
	Width              *int           `json:"width,omitempty"`
	Height             *int           `json:"height,omitempty"`
	Duration           *float64       `json:"durationSeconds,omitempty"`
	FrameRate          *float64       `json:"frameRate,omitempty"`
	VideoCodec         *string        `json:"videoCodec,omitempty"`
	AudioCodec         *string        `json:"audioCodec,omitempty"`
	AudioChannels      *int           `json:"audioChannels,omitempty"`
	Metadata           map[string]any `json:"metadata"`
	ProcessingStatus   AssetStatus    `json:"processingStatus"`
	ProcessingProgress *float64       `json:"processingProgress,omitempty"`
	ErrorCode          *string        `json:"errorCode,omitempty"`
	ErrorMessage       *string        `json:"errorMessage,omitempty"`
	Creator            *Creator       `json:"creator,omitempty"`
	CreatedAt          time.Time      `json:"createdAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
	AvailableFrom      *time.Time     `json:"availableFrom,omitempty"`
	ExpiresAt          *time.Time     `json:"expiresAt,omitempty"`
	ArchivedAt         *time.Time     `json:"archivedAt,omitempty"`
	Variants           []Variant      `json:"variants"`
	ThumbnailURL       *string        `json:"thumbnailUrl,omitempty"`
	Website            *WebsiteConfig `json:"website,omitempty"`
	Widget             *Widget        `json:"widget,omitempty"`
	PlaylistUsage      int            `json:"playlistUsage"`
	LayoutUsage        []LayoutUsage  `json:"layoutUsage"`
	// PlaylistsUsing names the playlists containing this asset. The list read reports only the
	// PlaylistUsage count, because resolving identities per row would add a second per-asset
	// query to a paged endpoint; the detail read populates this so Studio can link through.
	PlaylistsUsing []PlaylistUsage `json:"playlistsUsing,omitempty"`
	FolderID       *uuid.UUID      `json:"folderId,omitempty"`
	Tags           []ContentTag    `json:"tags"`
	CollectionIDs  []uuid.UUID     `json:"collectionIds"`
}

type LayoutUsage struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Published bool      `json:"published"`
}

type PlaylistUsage struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type ContentFolder struct {
	ID          uuid.UUID  `json:"id"`
	ParentID    *uuid.UUID `json:"parentId,omitempty"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	AssetCount  int        `json:"assetCount"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

type ContentCollection struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	AssetCount  int       `json:"assetCount"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type ContentTag struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Color      string    `json:"color"`
	AssetCount int       `json:"assetCount,omitempty"`
}

type BulkOrganizeInput struct {
	AssetIDs            []uuid.UUID
	SetFolder           bool
	FolderID            *uuid.UUID
	AddTagIDs           []uuid.UUID
	RemoveTagIDs        []uuid.UUID
	AddCollectionIDs    []uuid.UUID
	RemoveCollectionIDs []uuid.UUID
}

// Widget is the visual configuration attached to a widget asset (assets.type='widget').
type Widget struct {
	Provider            string          `json:"provider"`
	PresetID            *string         `json:"presetId,omitempty"`
	ConfigVersion       int             `json:"configVersion"`
	Configuration       json.RawMessage `json:"configuration"`
	AuthorConfiguration json.RawMessage `json:"authorConfiguration,omitempty"`
	ManagedDataSourceID *uuid.UUID      `json:"managedDataSourceId,omitempty"`
}

type WidgetInput struct {
	Provider      string          `json:"provider"`
	PresetID      *string         `json:"presetId,omitempty"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Configuration json.RawMessage `json:"configuration"`
}

// DataSource is a reusable, non-visual data connection. It is a top-level record
// (not an asset) and can never be placed in a playlist or Layout as content.
type DataSource struct {
	ID            uuid.UUID       `json:"id"`
	Provider      string          `json:"provider"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	ConfigVersion int             `json:"configVersion"`
	Configuration json.RawMessage `json:"configuration"`
	Creator       *Creator        `json:"creator,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

type DataSourceInput struct {
	Provider      string          `json:"provider"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Configuration json.RawMessage `json:"configuration"`
}

// DataSourceField describes one field a Data Source exposes, for Widget field selection.
type DataSourceField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Currency string `json:"currency,omitempty"`
}

type TypedRecord struct {
	ID     string            `json:"id"`
	Values map[string]string `json:"values"`
}

type TypedRecordData struct {
	Fields          []DataSourceField `json:"fields"`
	Records         []TypedRecord     `json:"records"`
	CachedAt        *time.Time        `json:"cachedAt,omitempty"`
	StaleAt         *time.Time        `json:"staleAt,omitempty"`
	UsingCachedData bool              `json:"usingCachedData"`
	Unavailable     bool              `json:"unavailable"`
	DateSelection   *DateSelection    `json:"dateSelection,omitempty"`
	DateField       string            `json:"dateField,omitempty"`
	Attribution     string            `json:"attribution,omitempty"`
}

// TypedDatasetPayload is the cached provider-neutral boundary used by live
// sources that expose more than one named dataset.
type TypedDatasetPayload struct {
	Datasets []TypedDataset `json:"datasets"`
}

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

type TypedPoint struct {
	At     time.Time         `json:"at"`
	Values map[string]string `json:"values"`
}

// DataSourceWidgetUsage / DataSourceBindingUsage report where a Data Source is consumed.
type DataSourceWidgetUsage struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Provider string    `json:"provider"`
}

type DataSourceBindingUsage struct {
	LayoutID   uuid.UUID `json:"layoutId"`
	LayoutName string    `json:"layoutName"`
	Field      string    `json:"field"`
}

// DataSourceDetail is the full detail view for one Data Source.
type DataSourceDetail struct {
	DataSource
	Status        string                   `json:"status"`
	Diagnostics   DataSourceDiagnostics    `json:"diagnostics"`
	Fields        []DataSourceField        `json:"fields"`
	DateSelection *DateSelection           `json:"dateSelection,omitempty"`
	CachedRecords int                      `json:"cachedRecordCount"`
	WidgetUsage   []DataSourceWidgetUsage  `json:"widgetUsage"`
	BindingUsage  []DataSourceBindingUsage `json:"bindingUsage"`
}

type YouTubeConfig struct {
	URL                  string     `json:"url"`
	Kind                 string     `json:"kind"`
	VideoID              string     `json:"videoId,omitempty"`
	PlaylistID           string     `json:"playlistId,omitempty"`
	StartSeconds         int        `json:"startSeconds"`
	EndSeconds           *int       `json:"endSeconds,omitempty"`
	Loop                 bool       `json:"loop"`
	Muted                bool       `json:"muted"`
	Volume               int        `json:"volume"`
	Captions             bool       `json:"captions"`
	CaptionLanguage      string     `json:"captionLanguage,omitempty"`
	Controls             bool       `json:"controls"`
	FailureBehavior      string     `json:"failureBehavior"`
	FallbackImageAssetID *uuid.UUID `json:"fallbackImageAssetId,omitempty"`
	PlaylistPlaybackMode string     `json:"playlistPlaybackMode"`
	FixedDurationSeconds *int       `json:"fixedDurationSeconds,omitempty"`
}

type CalendarFeed struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type CalendarFields struct {
	Title              bool `json:"title"`
	StartTime          bool `json:"startTime"`
	EndTime            bool `json:"endTime"`
	Date               bool `json:"date"`
	Location           bool `json:"location"`
	DescriptionExcerpt bool `json:"descriptionExcerpt"`
}

type CalendarConfig struct {
	Calendars              []CalendarFeed `json:"calendars"`
	DisplayMode            string         `json:"displayMode"`
	MaxEvents              int            `json:"maxEvents"`
	Fields                 CalendarFields `json:"fields"`
	FilterKeyword          string         `json:"filterKeyword,omitempty"`
	FilterCalendars        []string       `json:"filterCalendars,omitempty"`
	Timezone               string         `json:"timezone"`
	RefreshIntervalSeconds int            `json:"refreshIntervalSeconds"`
	StalenessLimitHours    int            `json:"stalenessLimitHours"`
	EmptyState             string         `json:"emptyState"`
}

type CalendarEvent struct {
	ID                 string    `json:"id"`
	Calendar           string    `json:"calendar"`
	Title              string    `json:"title"`
	Start              time.Time `json:"start"`
	End                time.Time `json:"end"`
	AllDay             bool      `json:"allDay"`
	Location           string    `json:"location,omitempty"`
	DescriptionExcerpt string    `json:"descriptionExcerpt,omitempty"`
}

type CalendarPreparedData struct {
	Events          []CalendarEvent `json:"events"`
	CachedAt        time.Time       `json:"cachedAt"`
	StaleAt         time.Time       `json:"staleAt"`
	UsingCachedData bool            `json:"usingCachedData"`
	Unavailable     bool            `json:"unavailable"`
}

type CalendarPlayerConfig struct {
	DisplayMode string               `json:"displayMode"`
	MaxEvents   int                  `json:"maxEvents"`
	Fields      CalendarFields       `json:"fields"`
	Timezone    string               `json:"timezone"`
	EmptyState  string               `json:"emptyState"`
	Data        CalendarPreparedData `json:"data"`
}

type DataSourceDiagnostics struct {
	DataSourceID        uuid.UUID  `json:"dataSourceId"`
	LastSuccessfulAt    *time.Time `json:"lastSuccessfulRefresh,omitempty"`
	LastAttemptedAt     *time.Time `json:"lastAttemptedRefresh,omitempty"`
	HTTPResultCategory  *string    `json:"httpResultCategory,omitempty"`
	ParseStatus         string     `json:"parseStatus"`
	AvailableEventCount int        `json:"availableEventCount"`
	AvailableItemCount  int        `json:"availableItemCount"`
	UsingCachedData     bool       `json:"usingCachedData"`
	CacheUpdatedAt      *time.Time `json:"cacheUpdatedAt,omitempty"`
	CacheExpiresAt      *time.Time `json:"cacheExpiresAt,omitempty"`
	ErrorCode           *string    `json:"errorCode,omitempty"`
}

type StructuredFields struct {
	Title       bool `json:"title"`
	Subtitle    bool `json:"subtitle"`
	Date        bool `json:"date"`
	Author      bool `json:"author"`
	Description bool `json:"description"`
	Image       bool `json:"image"`
	Link        bool `json:"link"`
}

type StructuredMapping struct {
	RootList    string            `json:"rootList"`
	Title       string            `json:"title"`
	Subtitle    string            `json:"subtitle"`
	Date        string            `json:"date"`
	ImageURL    string            `json:"imageUrl"`
	Link        string            `json:"link"`
	ValueFields map[string]string `json:"valueFields,omitempty"`
	// ValueFieldTypes records what each mapped value holds, keyed by the same label as
	// ValueFields. A Widget field picker only offers fields of the type it needs, so a
	// column of timestamps reported as text is a column no time-based Widget can use.
	// An entry with no type stays text, which is what Sources saved before this stored.
	ValueFieldTypes map[string]string `json:"valueFieldTypes,omitempty"`
}

type StructuredFilter struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

type StructuredSourceConfig struct {
	URL                    string             `json:"url,omitempty"`
	UploadedContent        string             `json:"uploadedContent,omitempty"`
	Uploaded               bool               `json:"uploaded,omitempty"`
	Presentation           string             `json:"presentation"`
	MaxItems               int                `json:"maxItems"`
	Fields                 StructuredFields   `json:"fields"`
	FilterKeyword          string             `json:"filterKeyword,omitempty"`
	Sort                   string             `json:"sort"`
	Mapping                *StructuredMapping `json:"mapping,omitempty"`
	Delimiter              string             `json:"delimiter,omitempty"`
	Filters                []StructuredFilter `json:"filters,omitempty"`
	RefreshIntervalSeconds int                `json:"refreshIntervalSeconds"`
	StalenessLimitHours    int                `json:"stalenessLimitHours"`
	EmptyState             string             `json:"emptyState"`
	DateSelection          DateSelection      `json:"dateSelection"`
}

type DateSelection struct {
	Enabled         bool   `json:"enabled"`
	DateFormat      string `json:"dateFormat"`
	Timezone        string `json:"timezone"`
	Mode            string `json:"mode"`
	CustomStartDate string `json:"customStartDate,omitempty"`
	CustomEndDate   string `json:"customEndDate,omitempty"`
	ExcludePast     bool   `json:"excludePast"`
	NoMatchBehavior string `json:"noMatchBehavior"`
	FallbackText    string `json:"fallbackText,omitempty"`
}

type ManualColumn struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Currency string `json:"currency,omitempty"`
}

type ManualRow struct {
	ID     string            `json:"id"`
	Values map[string]string `json:"values"`
}

type ManualSourceConfig struct {
	Columns       []ManualColumn `json:"columns"`
	Rows          []ManualRow    `json:"rows"`
	DateField     string         `json:"dateField,omitempty"`
	DateSelection DateSelection  `json:"dateSelection"`
}

type WeatherSourceConfig struct {
	LocationLabel          string  `json:"locationLabel"`
	Latitude               float64 `json:"latitude"`
	Longitude              float64 `json:"longitude"`
	Timezone               string  `json:"timezone"`
	Units                  string  `json:"units"`
	ForecastDays           int     `json:"forecastDays"`
	Contact                string  `json:"contact"`
	RefreshIntervalSeconds int     `json:"refreshIntervalSeconds"`
	StalenessLimitHours    int     `json:"stalenessLimitHours"`
}

type TransitSourceConfig struct {
	StaticURL              string   `json:"staticUrl"`
	TripUpdatesURL         string   `json:"tripUpdatesUrl"`
	ServiceAlertsURL       string   `json:"serviceAlertsUrl,omitempty"`
	StopIDs                []string `json:"stopIds"`
	RouteIDs               []string `json:"routeIds,omitempty"`
	Timezone               string   `json:"timezone"`
	MaximumDepartures      int      `json:"maximumDepartures"`
	RealtimeRefreshSeconds int      `json:"realtimeRefreshSeconds"`
	StaticRefreshHours     int      `json:"staticRefreshHours"`
	StalenessLimitMinutes  int      `json:"stalenessLimitMinutes"`
}

type CAPAlertsSourceConfig struct {
	URL                    string   `json:"url"`
	FeedMode               string   `json:"feedMode"`
	PreferredLanguage      string   `json:"preferredLanguage,omitempty"`
	MinimumSeverity        string   `json:"minimumSeverity"`
	IncludeAreaKeywords    []string `json:"includeAreaKeywords,omitempty"`
	ExcludeAreaKeywords    []string `json:"excludeAreaKeywords,omitempty"`
	MaximumAlerts          int      `json:"maximumAlerts"`
	RefreshIntervalSeconds int      `json:"refreshIntervalSeconds"`
	StalenessLimitHours    int      `json:"stalenessLimitHours"`
}

type AirQualitySourceConfig struct {
	LocationLabel          string   `json:"locationLabel"`
	Latitude               float64  `json:"latitude"`
	Longitude              float64  `json:"longitude"`
	Timezone               string   `json:"timezone"`
	AQIStandard            string   `json:"aqiStandard"`
	Pollutants             []string `json:"pollutants"`
	ForecastHours          int      `json:"forecastHours"`
	NonCommercialAccepted  bool     `json:"nonCommercialAccepted"`
	RefreshIntervalSeconds int      `json:"refreshIntervalSeconds"`
	StalenessLimitHours    int      `json:"stalenessLimitHours"`
}

type WidgetVisualConfig struct {
	ForegroundColor string `json:"foregroundColor"`
	BackgroundColor string `json:"backgroundColor"`
	TextScale       *int   `json:"textScale,omitempty"`
	ContentPadding  *int   `json:"contentPadding,omitempty"`
	EmptyState      string `json:"emptyState,omitempty"`
}

type SpotlightWidgetConfig struct {
	WidgetVisualConfig
	DataSourceID  uuid.UUID  `json:"dataSourceId"`
	TitleField    string     `json:"titleField"`
	SubtitleField string     `json:"subtitleField,omitempty"`
	BodyField     string     `json:"bodyField,omitempty"`
	BadgeField    string     `json:"badgeField,omitempty"`
	DateField     string     `json:"dateField,omitempty"`
	ImageAssetID  *uuid.UUID `json:"imageAssetId,omitempty"`
}

type StatGridMetric struct {
	Label      string `json:"label,omitempty"`
	LabelField string `json:"labelField,omitempty"`
	ValueField string `json:"valueField"`
	Format     string `json:"format,omitempty"`
	Precision  int    `json:"precision,omitempty"`
	Prefix     string `json:"prefix,omitempty"`
	Suffix     string `json:"suffix,omitempty"`
}

type StatGridWidgetConfig struct {
	WidgetVisualConfig
	DataSourceID uuid.UUID        `json:"dataSourceId"`
	Metrics      []StatGridMetric `json:"metrics"`
	Columns      int              `json:"columns"`
}

type ChartSeries struct {
	Field string `json:"field"`
	Label string `json:"label,omitempty"`
	Color string `json:"color,omitempty"`
}

type ChartWidgetConfig struct {
	WidgetVisualConfig
	DataSourceID  uuid.UUID     `json:"dataSourceId"`
	Dataset       string        `json:"dataset,omitempty"`
	ChartType     string        `json:"chartType"`
	CategoryField string        `json:"categoryField,omitempty"`
	TimeField     string        `json:"timeField,omitempty"`
	Series        []ChartSeries `json:"series"`
	ShowLegend    bool          `json:"showLegend"`
	ShowAxes      bool          `json:"showAxes"`
	Minimum       *float64      `json:"minimum,omitempty"`
	Maximum       *float64      `json:"maximum,omitempty"`
}

type ProgressWidgetConfig struct {
	WidgetVisualConfig
	DataSourceID   uuid.UUID `json:"dataSourceId"`
	ValueField     string    `json:"valueField"`
	TargetField    string    `json:"targetField,omitempty"`
	StaticTarget   *float64  `json:"staticTarget,omitempty"`
	Label          string    `json:"label,omitempty"`
	LabelField     string    `json:"labelField,omitempty"`
	ShowPercent    bool      `json:"showPercent"`
	CompletionText string    `json:"completionText,omitempty"`
}

type TimelineWidgetConfig struct {
	WidgetVisualConfig
	DataSourceID uuid.UUID `json:"dataSourceId"`
	DateField    string    `json:"dateField"`
	TitleField   string    `json:"titleField"`
	BodyField    string    `json:"bodyField,omitempty"`
	StatusField  string    `json:"statusField,omitempty"`
	Orientation  string    `json:"orientation"`
	MaximumItems int       `json:"maximumItems"`
}

type WorldClockZone struct {
	Label    string `json:"label"`
	Timezone string `json:"timezone"`
}

type WorldClockWidgetConfig struct {
	WidgetVisualConfig
	Zones       []WorldClockZone `json:"zones"`
	Format      string           `json:"format"`
	ShowSeconds bool             `json:"showSeconds"`
	ShowDate    bool             `json:"showDate"`
	Columns     int              `json:"columns"`
}

type CountdownWidgetConfig struct {
	Target           string `json:"target"`
	Timezone         string `json:"timezone"`
	Mode             string `json:"mode"`
	Recurrence       string `json:"recurrence"`
	Layout           string `json:"layout"`
	Label            string `json:"label,omitempty"`
	CompletionText   string `json:"completionText,omitempty"`
	CompletionAction string `json:"completionAction"`
	ShowDays         bool   `json:"showDays"`
	ShowHours        bool   `json:"showHours"`
	ShowMinutes      bool   `json:"showMinutes"`
	ShowSeconds      bool   `json:"showSeconds"`
	ForegroundColor  string `json:"foregroundColor"`
	BackgroundColor  string `json:"backgroundColor"`
	TextScale        *int   `json:"textScale,omitempty"`
	ContentPadding   *int   `json:"contentPadding,omitempty"`
}

type FieldFormat struct {
	Field     string `json:"field"`
	Label     string `json:"label,omitempty"`
	Format    string `json:"format,omitempty"`
	Precision int    `json:"precision,omitempty"`
	Prefix    string `json:"prefix,omitempty"`
	Suffix    string `json:"suffix,omitempty"`
	Alignment string `json:"alignment,omitempty"`
	Width     int    `json:"width,omitempty"`
}

type ClockWidgetConfig struct {
	Timezone        string `json:"timezone"`
	Format          string `json:"format"`
	ShowSeconds     bool   `json:"showSeconds"`
	ForegroundColor string `json:"foregroundColor"`
	BackgroundColor string `json:"backgroundColor"`
	TextScale       *int   `json:"textScale,omitempty"`
	ContentPadding  *int   `json:"contentPadding,omitempty"`
}
type DateWidgetConfig struct {
	Timezone        string `json:"timezone"`
	Format          string `json:"format"`
	ForegroundColor string `json:"foregroundColor"`
	BackgroundColor string `json:"backgroundColor"`
	TextScale       *int   `json:"textScale,omitempty"`
	ContentPadding  *int   `json:"contentPadding,omitempty"`
}
type QRCodeWidgetConfig struct {
	Value           string `json:"value"`
	Label           string `json:"label,omitempty"`
	ErrorCorrection string `json:"errorCorrection"`
	ForegroundColor string `json:"foregroundColor"`
	BackgroundColor string `json:"backgroundColor"`
	TextScale       *int   `json:"textScale,omitempty"`
	ContentPadding  *int   `json:"contentPadding,omitempty"`
}
type TickerWidgetConfig struct {
	DataSourceID    uuid.UUID `json:"dataSourceId"`
	Field           string    `json:"field"`
	Fields          []string  `json:"fields,omitempty"`
	Separator       string    `json:"separator"`
	FieldSeparator  string    `json:"fieldSeparator,omitempty"`
	Speed           string    `json:"speed"`
	Direction       string    `json:"direction"`
	EmptyState      string    `json:"emptyState,omitempty"`
	ForegroundColor string    `json:"foregroundColor"`
	BackgroundColor string    `json:"backgroundColor"`
	TextScale       *int      `json:"textScale,omitempty"`
	ContentPadding  *int      `json:"contentPadding,omitempty"`
}

type DisplayWidgetConfig struct {
	DataSourceID     uuid.UUID     `json:"dataSourceId"`
	Fields           []string      `json:"fields"`
	MaximumItems     int           `json:"maximumItems"`
	ForegroundColor  string        `json:"foregroundColor"`
	BackgroundColor  string        `json:"backgroundColor"`
	TextScale        *int          `json:"textScale,omitempty"`
	ContentPadding   *int          `json:"contentPadding,omitempty"`
	EmptyState       string        `json:"emptyState,omitempty"`
	PrimaryField     string        `json:"primaryField,omitempty"`
	SecondaryField   string        `json:"secondaryField,omitempty"`
	LeadingField     string        `json:"leadingField,omitempty"`
	TrailingField    string        `json:"trailingField,omitempty"`
	ShowDividers     bool          `json:"showDividers,omitempty"`
	RowSpacing       string        `json:"rowSpacing,omitempty"`
	Mode             string        `json:"mode,omitempty"`
	LabelField       string        `json:"labelField,omitempty"`
	ValueField       string        `json:"valueField,omitempty"`
	Columns          []FieldFormat `json:"columns,omitempty"`
	ShowHeader       bool          `json:"showHeader,omitempty"`
	AlternatingRows  bool          `json:"alternatingRows,omitempty"`
	DateField        string        `json:"dateField,omitempty"`
	TimeField        string        `json:"timeField,omitempty"`
	TitleField       string        `json:"titleField,omitempty"`
	LocationField    string        `json:"locationField,omitempty"`
	DescriptionField string        `json:"descriptionField,omitempty"`
	GroupByDay       bool          `json:"groupByDay,omitempty"`
}

type MetricWidgetConfig struct {
	DataSourceID    uuid.UUID `json:"dataSourceId"`
	ValueField      string    `json:"valueField"`
	Label           string    `json:"label,omitempty"`
	LabelField      string    `json:"labelField,omitempty"`
	SecondaryField  string    `json:"secondaryField,omitempty"`
	Format          string    `json:"format"`
	Precision       int       `json:"precision"`
	Prefix          string    `json:"prefix,omitempty"`
	Suffix          string    `json:"suffix,omitempty"`
	Alignment       string    `json:"alignment"`
	EmptyState      string    `json:"emptyState"`
	ForegroundColor string    `json:"foregroundColor"`
	BackgroundColor string    `json:"backgroundColor"`
	TextScale       *int      `json:"textScale,omitempty"`
	ContentPadding  *int      `json:"contentPadding,omitempty"`
}

type CardsWidgetConfig struct {
	DataSourceID    uuid.UUID `json:"dataSourceId"`
	TitleField      string    `json:"titleField"`
	SubtitleField   string    `json:"subtitleField,omitempty"`
	BodyField       string    `json:"bodyField,omitempty"`
	BadgeField      string    `json:"badgeField,omitempty"`
	Columns         int       `json:"columns"`
	MaximumItems    int       `json:"maximumItems"`
	Density         string    `json:"density"`
	EmptyState      string    `json:"emptyState"`
	ForegroundColor string    `json:"foregroundColor"`
	BackgroundColor string    `json:"backgroundColor"`
	TextScale       *int      `json:"textScale,omitempty"`
	ContentPadding  *int      `json:"contentPadding,omitempty"`
}

type WeatherWidgetConfig struct {
	DataSourceID      uuid.UUID `json:"dataSourceId"`
	ShowLocation      bool      `json:"showLocation"`
	ShowCurrent       bool      `json:"showCurrent"`
	ShowHumidity      bool      `json:"showHumidity"`
	ShowWind          bool      `json:"showWind"`
	ShowPrecipitation bool      `json:"showPrecipitation"`
	ForecastDays      int       `json:"forecastDays"`
	ForegroundColor   string    `json:"foregroundColor"`
	BackgroundColor   string    `json:"backgroundColor"`
	TextScale         *int      `json:"textScale,omitempty"`
	ContentPadding    *int      `json:"contentPadding,omitempty"`
}

type StructuredRecord struct {
	ID          string            `json:"id"`
	Title       string            `json:"title"`
	Subtitle    string            `json:"subtitle,omitempty"`
	Date        string            `json:"date,omitempty"`
	Author      string            `json:"author,omitempty"`
	Description string            `json:"description,omitempty"`
	Source      string            `json:"source,omitempty"`
	ImageURL    string            `json:"imageUrl,omitempty"`
	Link        string            `json:"link,omitempty"`
	Values      map[string]string `json:"values,omitempty"`
}

type StructuredPreparedData struct {
	Records         []StructuredRecord `json:"records"`
	CachedAt        time.Time          `json:"cachedAt"`
	StaleAt         time.Time          `json:"staleAt"`
	UsingCachedData bool               `json:"usingCachedData"`
	Unavailable     bool               `json:"unavailable"`
}

type StructuredPlayerConfig struct {
	Presentation  string                 `json:"presentation"`
	Fields        StructuredFields       `json:"fields"`
	EmptyState    string                 `json:"emptyState"`
	DateSelection DateSelection          `json:"dateSelection"`
	Data          StructuredPreparedData `json:"data"`
}

type StructuredPreview struct {
	Configuration StructuredPlayerConfig `json:"configuration"`
	Diagnostics   DataSourceDiagnostics  `json:"diagnostics"`
}

type CalendarPreview struct {
	Configuration CalendarPlayerConfig  `json:"configuration"`
	Diagnostics   DataSourceDiagnostics `json:"diagnostics"`
}

type WebsiteConfig struct {
	URL                    string     `json:"url"`
	DisplayURL             string     `json:"displayUrl"`
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
	CustomUserAgent        string     `json:"customUserAgent"`
	BackgroundColor        string     `json:"backgroundColor"`
	FailureBehavior        string     `json:"failureBehavior"`
	FallbackImageAssetID   *uuid.UUID `json:"fallbackImageAssetId,omitempty"`
	CreatedAt              time.Time  `json:"createdAt"`
	UpdatedAt              time.Time  `json:"updatedAt"`
}

type WebsiteInput struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	WebsiteConfig
	javascriptSet bool
	domStorageSet bool
}

type WebsiteDiagnostics struct {
	AssetID              uuid.UUID                `json:"assetId"`
	ConfiguredURL        string                   `json:"configuredUrl"`
	AllowedHosts         []string                 `json:"allowedHosts"`
	LastSuccessfulLoad   *time.Time               `json:"lastSuccessfulLoad,omitempty"`
	LastFailure          *time.Time               `json:"lastFailure,omitempty"`
	LastFailureCategory  *string                  `json:"lastFailureCategory,omitempty"`
	ReportingScreens     []WebsiteReportingScreen `json:"reportingScreens"`
	FallbackImageAssetID *uuid.UUID               `json:"fallbackImageAssetId,omitempty"`
}
type WebsiteReportingScreen struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	State string    `json:"state"`
	Host  *string   `json:"host,omitempty"`
}

type AssetInvalidator interface {
	AssetChanged(context.Context, uuid.UUID, string) error
	TagAssignmentsChanged(context.Context, []uuid.UUID, string) error
	DataSourceChanged(context.Context, uuid.UUID, string) error
}

type TransactionalAssetInvalidator interface {
	AssetChangedInTx(context.Context, pgx.Tx, uuid.UUID, string) ([]manifestchanges.Change, error)
	TagAssignmentsChangedInTx(context.Context, pgx.Tx, []uuid.UUID, string) ([]manifestchanges.Change, error)
	DataSourceChangedInTx(context.Context, pgx.Tx, uuid.UUID, string) ([]manifestchanges.Change, error)
	NotifyManifestChanges([]manifestchanges.Change)
}

type Creator struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type Variant struct {
	ID               uuid.UUID `json:"id"`
	Kind             string    `json:"kind"`
	MIMEType         string    `json:"mimeType"`
	FileSize         int64     `json:"fileSize"`
	SHA256           string    `json:"sha256"`
	Width            *int      `json:"width,omitempty"`
	Height           *int      `json:"height,omitempty"`
	Duration         *float64  `json:"durationSeconds,omitempty"`
	FrameRate        *float64  `json:"frameRate,omitempty"`
	VideoCodec       *string   `json:"videoCodec,omitempty"`
	AudioCodec       *string   `json:"audioCodec,omitempty"`
	PlayerCompatible bool      `json:"playerCompatible"`
	CreatedAt        time.Time `json:"createdAt"`
}

type Upload struct {
	ID               uuid.UUID    `json:"id"`
	OriginalFilename string       `json:"filename"`
	DeclaredMIMEType string       `json:"mimeType"`
	ExpectedSize     int64        `json:"sizeBytes"`
	CurrentOffset    int64        `json:"offset"`
	Status           UploadStatus `json:"status"`
	ExpiresAt        time.Time    `json:"expiresAt"`
	ResultingAssetID *uuid.UUID   `json:"assetId,omitempty"`
	UploadEndpoint   string       `json:"uploadEndpoint"`
	MaximumSize      int64        `json:"maximumSizeBytes"`
}

type ListOptions struct {
	Search, Type, WidgetProvider, Status, Sort string
	FolderID, CollectionID, TagID              *uuid.UUID
	Page, PageSize                             int
	Archived                                   bool
}

// DataSourceListOptions filters the Data Source library.
type DataSourceListOptions struct {
	Search, Provider, Sort string
	Page, PageSize         int
}

type DataSourceListResult struct {
	Items    []DataSourceListItem `json:"items"`
	Total    int                  `json:"total"`
	Page     int                  `json:"page"`
	PageSize int                  `json:"pageSize"`
}

// DataSourceListItem includes the refresh summary Studio needs to present and
// select a source without fetching every source's detail separately.
type DataSourceListItem struct {
	DataSource
	Status        string `json:"status"`
	CachedRecords int    `json:"cachedRecordCount"`
}
type ListResult struct {
	Items    []Asset `json:"items"`
	Total    int     `json:"total"`
	Page     int     `json:"page"`
	PageSize int     `json:"pageSize"`
}

type Delivery struct {
	AssetID   uuid.UUID
	VariantID uuid.UUID
	Path      string
	MIMEType  string
	Size      int64
	HashHex   string
}
