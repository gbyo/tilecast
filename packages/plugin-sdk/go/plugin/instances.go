package plugin

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Plugin Manifest API 3 instance hooks. The host owns instance storage,
// revisions, targets, schedules, authorization, audit, resource usage,
// manifest invalidation, status counts, removal blockers, the API, and the
// Studio pages. A plugin implements at most two small hooks: it judges the
// domain meaning of one instance, and it maps one eligible instance to its
// Player state. The host decides which instances are eligible for a screen:
// enabled, targeted at the screen, inside its schedule, strongest priority
// first.

// HostedInstance is one host-owned instance as a hook sees it. Configuration is
// the normalized, non-secret configuration document of the kind's fields.
// Secrets are never part of it; a hook that needs one reads it through
// secrets.read@1.
type HostedInstance struct {
	ID            uuid.UUID
	Kind          string
	Name          string
	Enabled       bool
	Priority      int
	Revision      int64
	Target        Target
	Schedule      *InstanceSchedule
	Configuration map[string]any
}

// Decode copies the configuration into a plugin's own struct.
func (i HostedInstance) Decode(out any) error {
	data, err := json.Marshal(i.Configuration)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// InstanceSchedule is the host schedule of a window or weekly kind.
type InstanceSchedule struct {
	// Window kinds.
	StartsAt *time.Time `json:"startsAt,omitempty"`
	EndsAt   *time.Time `json:"endsAt,omitempty"`
	// Weekly kinds: the instance is projected on Days from StartTime to
	// EndTime in Timezone. Days are 0 (Sunday) through 6.
	Timezone  string `json:"timezone,omitempty"`
	Days      []int  `json:"days,omitempty"`
	StartTime string `json:"startTime,omitempty"`
	EndTime   string `json:"endTime,omitempty"`
}

// InstanceValidator judges the domain meaning of an instance after the host
// has validated every field against the kind's schema. It returns an error
// wrapping ErrInvalid for a refusal, whose text an operator reads. It must
// not read or write storage the host owns.
type InstanceValidator interface {
	ValidateInstance(ctx context.Context, instance HostedInstance) error
}

// ProjectionTarget is the screen a projection is for, with the plugin's
// non-secret settings that apply to it.
type ProjectionTarget struct {
	ScreenID             uuid.UUID
	OrganizationSettings map[string]any
	ScreenSettings       map[string]any
}

// InstanceProjection is what one eligible instance shows on one screen.
// State is the Plugin API 2 Player state; the host sets its ID to the
// instance ID and adds the library fonts the instance's font fields choose.
// Legacy is the optional Plugin API 1 entry for a Player without the
// Plugin API 2 host; it is needed only when the manifest declares
// player.v1ManifestTypes, and the host sets its ID to the instance ID.
// Leave both nil to show nothing on this screen.
type InstanceProjection struct {
	State  *PlayerState
	Legacy *ManifestEntry
}

// InstanceProjector maps one eligible instance to its Player state.
type InstanceProjector interface {
	ProjectInstance(ctx context.Context, instance HostedInstance, target ProjectionTarget) (InstanceProjection, error)
}

// DemoInstance is one instance a plugin contributes to Demo Mode. The host
// creates it through its own instance service, with every check a Studio
// write gets.
type DemoInstance struct {
	Kind          string
	Name          string
	Enabled       bool
	Priority      int
	Target        *Target
	Schedule      *InstanceSchedule
	Configuration map[string]any
}

// InstanceDemoSeeder contributes Demo Mode instances. A Plugin Manifest API
// 3 plugin implements it instead of writing host-owned storage itself.
type InstanceDemoSeeder interface {
	DemoInstances(ctx context.Context, demo Demo) ([]DemoInstance, error)
}
