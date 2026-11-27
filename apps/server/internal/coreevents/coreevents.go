// Package coreevents is the closed vocabulary of core Server events that
// Plugin Manifest API 3 plugins subscribe to (docs/plugin-events.md), and
// the transactional sink that core domain services emit them through.
//
// A producer emits an event in the transaction that makes the state change.
// The event exists exactly when the change commits: a rolled-back change
// emits nothing. The package imports no plugin code; the plugin service
// implements Sink and queues one delivery for each subscriber.
//
// Each payload is a stable public contract. A changed payload is a new
// event version. TestCorePayloadsAreFrozen fails when a field changes under
// a published version.
package coreevents

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Event is one occurrence of a core event.
type Event struct {
	// Name is one of plugin.CoreEvents.
	Name string
	// Subject is the order key: events of one subject reach a plugin in the
	// order they were emitted. It names the object, for example
	// "screen:<id>", never the event.
	Subject    string
	OccurredAt time.Time
	// Payload is one of the payload types of this package.
	Payload any
	// Owner, when set, restricts delivery to one plugin. feed.stale@1
	// reaches only the plugin that owns the feed.
	Owner string
}

// Sink receives core events inside the producer's transaction.
type Sink interface {
	Emit(ctx context.Context, tx pgx.Tx, event Event) error
}

// Emit sends an event to a sink. A nil sink drops it, so a producer wired
// without plugins (tests, tools) needs no special case.
func Emit(ctx context.Context, tx pgx.Tx, sink Sink, event Event) error {
	if sink == nil {
		return nil
	}
	return sink.Emit(ctx, tx, event)
}

// Subjects. Each names the object whose events must stay in order.
func ScreenSubject(id uuid.UUID) string   { return "screen:" + id.String() }
func TakeoverSubject(id uuid.UUID) string { return "takeover:" + id.String() }
func IncidentSubject(id uuid.UUID) string { return "incident:" + id.String() }
func ScheduleSubject(id uuid.UUID) string { return "schedule:" + id.String() }
func FeedSubject(id uuid.UUID) string     { return "feed:" + id.String() }

// Screen connectivity states of screen.status.changed@1.
const (
	// ScreenReachable: the Server heard from the screen within the offline
	// threshold of internal/devices (the status online, recent, or stale).
	ScreenReachable = "reachable"
	// ScreenOffline: no contact for longer than the offline threshold.
	ScreenOffline = "offline"
)

// ScreenStatus is the payload of screen.status.changed@1. One outage is one
// change to offline and one change back to reachable; a heartbeat is never
// an event.
type ScreenStatus struct {
	ScreenID       uuid.UUID  `json:"screenId"`
	Status         string     `json:"status"`
	PreviousStatus string     `json:"previousStatus"`
	LastContactAt  *time.Time `json:"lastContactAt"`
	ChangedAt      time.Time  `json:"changedAt"`
}

// Takeover end reasons.
const (
	TakeoverCancelled = "cancelled"
	TakeoverExpired   = "expired"
)

// Takeover is the payload of takeover.started@1, takeover.ended@1, and
// takeover.suspended@1. It counts screens instead of listing them, so a
// fleet-wide Takeover stays a small event.
type Takeover struct {
	TakeoverID uuid.UUID `json:"takeoverId"`
	Class      string    `json:"class"`
	// ScreenCount is the number of screens the Takeover targets.
	ScreenCount int `json:"screenCount"`
	// EffectiveScreenCount is the number of screens that show it now under
	// the precedence rule.
	EffectiveScreenCount int       `json:"effectiveScreenCount"`
	ActivatedAt          time.Time `json:"activatedAt"`
	ExpiresAt            time.Time `json:"expiresAt"`
	// Reason is cancelled or expired on takeover.ended@1, and empty
	// otherwise.
	Reason string `json:"reason,omitempty"`
	// SuspendedBy is the Takeover whose activation suspended this one, on
	// takeover.suspended@1.
	SuspendedBy *uuid.UUID `json:"suspendedBy,omitempty"`
	At          time.Time  `json:"at"`
}

// Incident reasons.
const (
	// IncidentDetected: a condition opened a new incident.
	IncidentDetected = "detected"
	// IncidentReopened: an operator reopened a closed incident.
	IncidentReopened = "reopened"
	// IncidentAutomatic: the condition ended on its own.
	IncidentAutomatic = "automatic"
	// IncidentResolved and IncidentIgnored: an operator closed it.
	IncidentResolved = "resolved"
	IncidentIgnored  = "ignored"
)

// Incident is the payload of incident.opened@1 and incident.recovered@1.
// A recurrence of an open incident is no event. It carries identifiers and
// codes, never the title or the description.
type Incident struct {
	IncidentID  uuid.UUID  `json:"incidentId"`
	Type        string     `json:"type"`
	Severity    string     `json:"severity"`
	FailureCode string     `json:"failureCode"`
	ScreenID    *uuid.UUID `json:"screenId"`
	RelatedType string     `json:"relatedType"`
	RelatedID   string     `json:"relatedId"`
	Reason      string     `json:"reason"`
	At          time.Time  `json:"at"`
}

// Schedule changes.
const (
	ScheduleCreated  = "created"
	ScheduleUpdated  = "updated"
	ScheduleEnabled  = "enabled"
	ScheduleDisabled = "disabled"
	ScheduleDeleted  = "deleted"
)

// Schedule is the payload of schedule.changed@1.
type Schedule struct {
	ScheduleID uuid.UUID `json:"scheduleId"`
	Change     string    `json:"change"`
	Enabled    bool      `json:"enabled"`
	// TargetsChanged is true when the screens, groups, or locations that
	// the schedule targets changed.
	TargetsChanged bool      `json:"targetsChanged"`
	At             time.Time `json:"at"`
}

// FeedStale is the payload of feed.stale@1: a feed dataset crossed into the
// stale state that Content Health reports.
type FeedStale struct {
	DatasetID              uuid.UUID  `json:"datasetId"`
	Feed                   string     `json:"feed"`
	InstanceID             *uuid.UUID `json:"instanceId"`
	PublishedAt            *time.Time `json:"publishedAt"`
	ExpectedRefreshSeconds int        `json:"expectedRefreshSeconds"`
	StaleSince             time.Time  `json:"staleSince"`
}

// Payloads maps each core event to its payload type, for documentation and
// the frozen-payload test.
var Payloads = map[string]any{
	plugin.CoreScreenStatusChanged: ScreenStatus{},
	plugin.CoreTakeoverStarted:     Takeover{},
	plugin.CoreTakeoverEnded:       Takeover{},
	plugin.CoreTakeoverSuspended:   Takeover{},
	plugin.CoreIncidentOpened:      Incident{},
	plugin.CoreIncidentRecovered:   Incident{},
	plugin.CoreScheduleChanged:     Schedule{},
	plugin.CoreFeedStale:           FeedStale{},
}
