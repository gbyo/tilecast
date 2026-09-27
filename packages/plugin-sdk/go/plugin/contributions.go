package plugin

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Status is the plugin-specific part of a catalog entry. Installed,
// configured, and active are separate questions, and the core answers the
// first one: a plugin reports only what its own data says.
type Status struct {
	// Configured means the plugin has been set up at all.
	Configured bool
	// Active means the plugin is doing something right now.
	Active bool
	// InstanceCount is the number of the plugin's instances, in the manifest's
	// instanceNoun.
	InstanceCount int
	// Attention holds bounded, advisory notes. They never block installation
	// or configuration.
	Attention []Attention
}

type Attention struct {
	Code    string
	Message string
}

// Resolution tells Studio what an operator does about a removal blocker.
type Resolution string

const (
	// ResolveDelete: delete the resources through the plugin's own page.
	ResolveDelete Resolution = "delete"
	// ResolveDisable: switch the resource off rather than deleting it.
	ResolveDisable Resolution = "disable"
	// ResolveWait: the resource clears by itself once other blockers are gone.
	ResolveWait Resolution = "wait"
)

// Blocker is one kind of plugin-owned resource that still exists.
type Blocker struct {
	Kind       string
	Count      int
	Singular   string
	Plural     string
	Resolution Resolution
}

// Label is the noun for Count.
func (b Blocker) Label() string {
	if b.Count == 1 {
		return b.Singular
	}
	return b.Plural
}

// ManifestEntry is one element of the Player manifest's discriminated
// `plugins` array. Config is marshalled as the entry's `config` object.
type ManifestEntry struct {
	ID      uuid.UUID `json:"id"`
	Type    string    `json:"type"`
	Version int       `json:"version"`
	Config  any       `json:"config"`
}

// AssetResolver is implemented by a ManifestEntry Config that references
// media. The host calls ResolveAssets during manifest assembly, after the
// screen's own content assets, so a referenced image becomes an ordinary
// manifest asset the Player verifies and caches. Returning keep=false drops
// the entry, for example a mark whose only content was an image that is no
// longer available.
type AssetResolver interface {
	ResolveAssets(ctx context.Context, assets Assets) (keep bool, err error)
}

// Assets resolves media for manifest assembly.
type Assets interface {
	// Image selects the ready image variant for an asset and adds it to the
	// manifest. ok is false when the asset is missing, not ready, or not an
	// image; the caller degrades rather than failing the manifest.
	Image(ctx context.Context, assetID uuid.UUID) (image ResolvedImage, ok bool, err error)
}

type ResolvedImage struct {
	AssetID       uuid.UUID
	VariantID     uuid.UUID
	AvailableFrom *time.Time
	ExpiresAt     *time.Time
}

// HeartbeatSection handles one optional section of a Player heartbeat. The
// screen is the authenticated device's own screen, never a value from the
// request. Handle returns fields to add to the heartbeat response's data, or
// nil. An error is logged and costs the heartbeat nothing: liveness and
// playback state are recorded regardless.
type HeartbeatSection struct {
	Name   string
	Handle func(ctx context.Context, screenID uuid.UUID, raw json.RawMessage) (response map[string]any, err error)
}
