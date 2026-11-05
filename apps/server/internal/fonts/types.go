// Package fonts owns the organization font library: families an
// administrator adds from the Google Fonts catalog or uploads, stored as
// verified system-managed assets so Players download them like any other
// offline resource.
package fonts

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound           = errors.New("font not found")
	ErrExists             = errors.New("a font family with this name already exists")
	ErrInUse              = errors.New("font family is in use")
	ErrInvalid            = errors.New("font request is invalid")
	ErrCatalogDisabled    = errors.New("the font catalog is disabled on this server")
	ErrCatalogUnavailable = errors.New("the font catalog is unavailable")
	ErrTooLarge           = errors.New("font files exceed the size limit")
	ErrUnsupportedFile    = errors.New("font file type is not supported")
	ErrRightsRequired     = errors.New("confirm the right to use this font on displays")
)

// Source names where a family came from.
const (
	SourceGoogle = "google"
	SourceUpload = "upload"
)

// Bounds. A Google import is one request, so its total is bounded; an
// upload is one face per request.
const (
	MaxUploadBytes      = 15 << 20
	MaxImportFileBytes  = 8 << 20
	MaxImportTotalBytes = 64 << 20
	MaxImportFiles      = 400
	MaxFamilyNameLength = 100
)

type Face struct {
	ID           uuid.UUID `json:"id"`
	AssetID      uuid.UUID `json:"assetId"`
	VariantID    uuid.UUID `json:"variantId"`
	Style        string    `json:"style"`
	WeightMin    int       `json:"weightMin"`
	WeightMax    int       `json:"weightMax"`
	Subset       string    `json:"subset"`
	UnicodeRange string    `json:"unicodeRange"`
	MIMEType     string    `json:"mimeType"`
	FileSize     int64     `json:"fileSize"`
	FileURL      string    `json:"fileUrl"`
}

type Family struct {
	ID            uuid.UUID `json:"id"`
	Family        string    `json:"family"`
	Source        string    `json:"source"`
	SourceID      string    `json:"sourceId"`
	SourceVersion string    `json:"sourceVersion"`
	Category      string    `json:"category"`
	License       string    `json:"license"`
	Subsets       []string  `json:"subsets"`
	Faces         []Face    `json:"faces"`
	TotalBytes    int64     `json:"totalBytes"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// InUse names the Layouts that still reference a family a person tried to
// remove.
type InUse struct {
	Layouts []LayoutRef
	// Plugins names the plugin instances that use the family, by the label
	// the plugin recorded through Host.Fonts.
	Plugins []string
}

type LayoutRef struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

func (e *InUse) Error() string { return ErrInUse.Error() }
func (e *InUse) Unwrap() error { return ErrInUse }

// GoogleImport selects what to copy from one catalog family. An empty
// subset list means the family's default subset; an empty style list
// means normal. Weights apply only to families without a variable weight
// axis; an empty list means 400 when the family has it.
type GoogleImport struct {
	SourceID string   `json:"sourceId"`
	Subsets  []string `json:"subsets"`
	Styles   []string `json:"styles"`
	Weights  []int    `json:"weights"`
}

// UploadResult carries warnings a person should see after an upload.
type UploadResult struct {
	Family              Family `json:"family"`
	EmbeddingRestricted bool   `json:"embeddingRestricted"`
}
