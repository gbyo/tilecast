package plugin

import (
	"context"

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

// DemoSeeder contributes sample data to Demo Mode, the disposable, pre-seeded
// installation used for development, screenshots, and browser tests. The host
// installs the plugin before it calls SeedDemo, and never calls it outside
// Demo Mode.
type DemoSeeder interface {
	SeedDemo(ctx context.Context, demo Demo) error
}

// Demo describes the demo installation a plugin seeds into.
type Demo struct {
	// Scenario is the demo scenario's name.
	Scenario string
	// OwnerID is the demo Owner, used as the author of seeded data.
	OwnerID uuid.UUID
	// Timezone is the scenario's IANA timezone.
	Timezone string
	// Locations are the scenario's locations by stable name, for example
	// "high_school". A plugin skips a location the scenario does not have.
	Locations map[string]uuid.UUID
}
