package layouts

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound = errors.New("layout not found")
	ErrConflict = errors.New("layout revision conflict")
	ErrInUse    = errors.New("layout is in use")
)

type Layout struct {
	ID                    uuid.UUID    `json:"id"`
	Name                  string       `json:"name"`
	Description           string       `json:"description"`
	Orientation           string       `json:"orientation"`
	CanvasWidth           int          `json:"canvasWidth"`
	CanvasHeight          int          `json:"canvasHeight"`
	Draft                 Document     `json:"draft"`
	DraftRevision         int64        `json:"draftRevision"`
	PublishedRevisionID   *uuid.UUID   `json:"publishedRevisionId,omitempty"`
	PublishedRevision     *int64       `json:"publishedRevision,omitempty"`
	PublishedAt           *time.Time   `json:"publishedAt,omitempty"`
	HasUnpublishedChanges bool         `json:"hasUnpublishedChanges"`
	CreatedAt             time.Time    `json:"createdAt"`
	UpdatedAt             time.Time    `json:"updatedAt"`
	PreviewImageURL       string       `json:"previewImageUrl,omitempty"`
	PreviewCaptureVersion *int         `json:"previewCaptureVersion,omitempty"`
	Dependencies          []Dependency `json:"dependencies"`
	Usage                 Usage        `json:"usage"`
}

type Usage struct {
	Screens   []UsageItem `json:"screens"`
	Schedules []UsageItem `json:"schedules"`
	Campaigns []UsageItem `json:"campaigns"`
}
type UsageItem struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type Summary struct {
	ID                    uuid.UUID  `json:"id"`
	Name                  string     `json:"name"`
	Description           string     `json:"description"`
	Orientation           string     `json:"orientation"`
	CanvasWidth           int        `json:"canvasWidth"`
	CanvasHeight          int        `json:"canvasHeight"`
	DraftRevision         int64      `json:"draftRevision"`
	PublishedRevision     *int64     `json:"publishedRevision,omitempty"`
	PublishedAt           *time.Time `json:"publishedAt,omitempty"`
	HasUnpublishedChanges bool       `json:"hasUnpublishedChanges"`
	CreatedAt             time.Time  `json:"createdAt"`
	UpdatedAt             time.Time  `json:"updatedAt"`
	PreviewImageURL       string     `json:"previewImageUrl,omitempty"`
	PreviewCaptureVersion *int       `json:"previewCaptureVersion,omitempty"`
}

type PreviewImage struct {
	Data        []byte
	ContentType string
	Width       int
	Height      int
	UpdatedAt   time.Time
}

type ListResult struct {
	Items    []Summary `json:"items"`
	Total    int       `json:"total"`
	Page     int       `json:"page"`
	PageSize int       `json:"pageSize"`
}

type Revision struct {
	ID             uuid.UUID  `json:"id"`
	LayoutID       uuid.UUID  `json:"layoutId"`
	Revision       int64      `json:"revision"`
	Document       Document   `json:"document"`
	DocumentSHA256 string     `json:"documentSha256"`
	PublishedBy    *uuid.UUID `json:"publishedBy,omitempty"`
	PublishedAt    time.Time  `json:"publishedAt"`
}

type RevisionList struct {
	Items    []Revision `json:"items"`
	Total    int        `json:"total"`
	Page     int        `json:"page"`
	PageSize int        `json:"pageSize"`
}

type Document struct {
	SchemaVersion int         `json:"schemaVersion"`
	Canvas        Canvas      `json:"canvas"`
	Placements    []Placement `json:"placements"`
}

type Canvas struct {
	Width               int        `json:"width"`
	Height              int        `json:"height"`
	Orientation         string     `json:"orientation"`
	BackgroundColor     string     `json:"backgroundColor"`
	BackgroundAssetID   *uuid.UUID `json:"backgroundAssetId,omitempty"`
	BackgroundVariantID *uuid.UUID `json:"backgroundVariantId,omitempty"`
	SafeAreaPercent     float64    `json:"safeAreaPercent"`
}

type Placement struct {
	ID         uuid.UUID       `json:"id"`
	Type       string          `json:"type"`
	Name       string          `json:"name"`
	X          float64         `json:"x"`
	Y          float64         `json:"y"`
	Width      float64         `json:"width"`
	Height     float64         `json:"height"`
	Layer      int             `json:"layer"`
	Opacity    float64         `json:"opacity"`
	Visible    bool            `json:"visible"`
	Locked     bool            `json:"locked"`
	GroupID    *uuid.UUID      `json:"groupId,omitempty"`
	WidgetID   *uuid.UUID      `json:"widgetId,omitempty"`
	AssetID    *uuid.UUID      `json:"assetId,omitempty"`
	VariantID  *uuid.UUID      `json:"variantId,omitempty"`
	PlaylistID *uuid.UUID      `json:"playlistId,omitempty"`
	Overrides  json.RawMessage `json:"overrides,omitempty"`
	Primitive  *Primitive      `json:"primitive,omitempty"`
	Playback   *Playback       `json:"playback,omitempty"`
}

type Primitive struct {
	Kind            string   `json:"kind"`
	Text            string   `json:"text,omitempty"`
	FontFamily      string   `json:"fontFamily,omitempty"`
	FontSize        float64  `json:"fontSize,omitempty"`
	FontWeight      int      `json:"fontWeight,omitempty"`
	TextAlign       string   `json:"textAlign,omitempty"`
	VerticalAlign   string   `json:"verticalAlign,omitempty"`
	Color           string   `json:"color,omitempty"`
	BackgroundColor string   `json:"backgroundColor,omitempty"`
	LineHeight      float64  `json:"lineHeight,omitempty"`
	LetterSpacing   float64  `json:"letterSpacing,omitempty"`
	Padding         float64  `json:"padding,omitempty"`
	BorderWidth     float64  `json:"borderWidth,omitempty"`
	BorderColor     string   `json:"borderColor,omitempty"`
	CornerRadius    float64  `json:"cornerRadius,omitempty"`
	MaximumLines    int      `json:"maximumLines,omitempty"`
	Overflow        string   `json:"overflow,omitempty"`
	AutoFit         bool     `json:"autoFit,omitempty"`
	MinimumFontSize float64  `json:"minimumFontSize,omitempty"`
	FillColor       string   `json:"fillColor,omitempty"`
	StrokeColor     string   `json:"strokeColor,omitempty"`
	StrokeWidth     float64  `json:"strokeWidth,omitempty"`
	Binding         *Binding `json:"binding,omitempty"`
}

type Binding struct {
	DataSourceID  uuid.UUID `json:"dataSourceId"`
	Field         string    `json:"field"`
	Prefix        string    `json:"prefix,omitempty"`
	Suffix        string    `json:"suffix,omitempty"`
	FallbackText  string    `json:"fallbackText,omitempty"`
	HideWhenEmpty bool      `json:"hideWhenEmpty,omitempty"`
	Format        string    `json:"format,omitempty"`
}

type Playback struct {
	Fit          string  `json:"fit,omitempty"`
	Muted        bool    `json:"muted,omitempty"`
	Loop         bool    `json:"loop,omitempty"`
	Fallback     string  `json:"fallback,omitempty"`
	CornerRadius float64 `json:"cornerRadius,omitempty"`
}

type Dependency struct {
	Type string    `json:"type"`
	ID   uuid.UUID `json:"id"`
}
