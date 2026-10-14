// Package externalplugins owns the generic external Player plugin state.
package externalplugins

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/targeting"
	externalplugin "github.com/tilecast/tilecast/packages/package-sdk/go/plugin"
)

const MaxStateBytes = 16 * 1024
const MaxValidity = 5 * time.Minute
const MaxEnabledInstances = 32

var ErrInvalid = errors.New("invalid external plugin state")
var ErrNotFound = errors.New("external plugin contribution not found")
var ErrConflict = errors.New("external plugin configuration changed")

// Payload is the verified execution metadata supplied by the package catalog.
type Payload struct {
	PackageID      string
	ContributionID string
	PackageDigest  string
	ExecutionEpoch uuid.UUID
	Descriptor     externalplugin.Manifest
	FrameSHA256Hex string
	FrameSize      int64
}

// Invocation values come from the host, never from guest JSON.
type Invocation struct {
	PackageID, Digest string
	Epoch             uuid.UUID
	Actor             *uuid.UUID
	ActorRole         string
}

type View struct {
	ContributionID        string                `json:"contributionId"`
	Enabled               bool                  `json:"enabled"`
	Configuration         json.RawMessage       `json:"configuration"`
	Targets               *targeting.Definition `json:"targets"`
	ConfigurationRevision int64                 `json:"configurationRevision"`
	State                 json.RawMessage       `json:"state"`
	ValidUntil            *time.Time            `json:"validUntil"`
	PublishedAt           *time.Time            `json:"publishedAt"`
}

type ConfigureInput struct {
	ContributionID                string               `json:"contributionId"`
	Enabled                       bool                 `json:"enabled"`
	Configuration                 json.RawMessage      `json:"configuration"`
	Targets                       targeting.Definition `json:"targets"`
	ExpectedConfigurationRevision int64                `json:"expectedConfigurationRevision"`
}

type PublishInput struct {
	ContributionID        string          `json:"contributionId"`
	ConfigurationRevision int64           `json:"configurationRevision"`
	State                 json.RawMessage `json:"state"`
	ValidUntil            time.Time       `json:"validUntil"`
}

// Entry is the external member of the Player manifest's plugin union. It
// carries only bounded Player data and verified execution metadata.
type Entry struct {
	ID                string                 `json:"id"`
	Type              string                 `json:"type"`
	Version           int                    `json:"version"`
	DefinitionVersion int                    `json:"definitionVersion"`
	Package           Package                `json:"package"`
	Runtime           externalplugin.Runtime `json:"runtime"`
	State             json.RawMessage        `json:"state"`
	ValidUntil        time.Time              `json:"validUntil"`
}
type Package struct {
	PackageID      string `json:"packageId"`
	PackageDigest  string `json:"packageDigest"`
	ContributionID string `json:"contributionId"`
	Frame          Frame  `json:"frame"`
}
type Frame struct {
	SHA256       string `json:"sha256"`
	FileSize     int64  `json:"fileSize"`
	DownloadPath string `json:"downloadPath"`
}
