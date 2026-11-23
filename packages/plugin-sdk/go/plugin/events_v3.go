package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
)

// Server events of Plugin Manifest API 3 (docs/plugin-events.md). A plugin
// subscribes to core events from a closed vocabulary and to the events
// other plugins publish. A plugin event's full name is
// plugin.<plugin id>.<name>@<version>. These are Server events; they are
// not the Player plugin events of Plugin API v2.

// Core events. The vocabulary is closed: a manifest cannot name another
// core event.
const (
	CoreScreenStatusChanged = "screen.status.changed@1"
	CoreTakeoverStarted     = "takeover.started@1"
	CoreTakeoverEnded       = "takeover.ended@1"
	CoreTakeoverSuspended   = "takeover.suspended@1"
	CoreIncidentOpened      = "incident.opened@1"
	CoreIncidentRecovered   = "incident.recovered@1"
	CoreScheduleChanged     = "schedule.changed@1"
	// CoreFeedStale reaches only the plugin that owns the feed.
	CoreFeedStale = "feed.stale@1"
)

// CoreEvents is the closed core vocabulary, in documentation order.
var CoreEvents = []string{
	CoreScreenStatusChanged,
	CoreTakeoverStarted, CoreTakeoverEnded, CoreTakeoverSuspended,
	CoreIncidentOpened, CoreIncidentRecovered,
	CoreScheduleChanged,
	CoreFeedStale,
}

// IsCoreEvent reports whether name is in the closed core vocabulary.
func IsCoreEvent(name string) bool {
	for _, core := range CoreEvents {
		if core == name {
			return true
		}
	}
	return false
}

// Event declaration bounds.
const (
	MaxPublishedEvents    = 16
	MaxEventSubscriptions = 32
	MaxEventFields        = 16
	MaxEventVersion       = 999
	// MaxEventPayloadBytes bounds the encoded JSON payload of one event.
	MaxEventPayloadBytes = 4096
	// MaxEventSubjectBytes bounds the subject a publisher names.
	MaxEventSubjectBytes = 128
)

var (
	eventNamePattern     = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	pluginEventPattern   = regexp.MustCompile(`^plugin\.([a-z][a-z0-9_]{0,79})\.([a-z][a-z0-9_]{0,39})@([1-9][0-9]{0,2})$`)
	eventSubjectForbids  = func(r rune) bool { return r < 0x20 || r == 0x7f }
	eventDescriptionMax  = 200
	eventTitleMax        = 80
	eventSubscriptionMax = 160
)

// Events declares the events a plugin publishes and the events it receives.
type Events struct {
	Publishes  []PublishedEvent `json:"publishes,omitempty"`
	Subscribes []string         `json:"subscribes,omitempty"`
}

// PublishedEvent is one event the plugin publishes with events.publish@1.
// A payload contract never changes under a version: a changed payload is a
// new version.
type PublishedEvent struct {
	Name        string               `json:"name"`
	Version     int                  `json:"version"`
	Title       string               `json:"title"`
	Description string               `json:"description,omitempty"`
	Fields      []configschema.Field `json:"fields"`
}

// Reference is the name a subscriber uses: <name>@<version> without the
// plugin prefix.
func (e PublishedEvent) Reference() string { return e.Name + "@" + strconv.Itoa(e.Version) }

// PluginEventName is the full name of a plugin event.
func PluginEventName(pluginID, name string, version int) string {
	return "plugin." + pluginID + "." + name + "@" + strconv.Itoa(version)
}

// ParsedEventName is a parsed plugin event name.
type ParsedEventName struct {
	Plugin  string
	Name    string
	Version int
}

// ParsePluginEventName parses plugin.<plugin>.<name>@<version>.
func ParsePluginEventName(full string) (ParsedEventName, bool) {
	match := pluginEventPattern.FindStringSubmatch(full)
	if match == nil {
		return ParsedEventName{}, false
	}
	version, _ := strconv.Atoi(match[3])
	return ParsedEventName{Plugin: match[1], Name: match[2], Version: version}, true
}

// PublishedEvent returns the declaration of one published name and version.
func (m Manifest) PublishedEvent(name string, version int) (PublishedEvent, bool) {
	if m.Events == nil {
		return PublishedEvent{}, false
	}
	for _, event := range m.Events.Publishes {
		if event.Name == name && event.Version == version {
			return event, true
		}
	}
	return PublishedEvent{}, false
}

// Subscribes reports whether the plugin subscribes to a full event name.
func (m Manifest) Subscribes(full string) bool {
	if m.APIVersion < 3 || m.Events == nil {
		return false
	}
	for _, name := range m.Events.Subscribes {
		if name == full {
			return true
		}
	}
	return false
}

// ValidEventSubject reports whether a publisher's subject is 1 to 128
// bytes of UTF-8 without control characters.
func ValidEventSubject(subject string) bool {
	return subject != "" && len(subject) <= MaxEventSubjectBytes && !strings.ContainsFunc(subject, eventSubjectForbids) &&
		strings.ToValidUTF8(subject, "�") == subject
}

func (m Manifest) validateEvents() error {
	if m.Events == nil {
		return nil
	}
	if len(m.Events.Publishes) > MaxPublishedEvents {
		return fmt.Errorf("events.publishes declares %d events; the limit is %d", len(m.Events.Publishes), MaxPublishedEvents)
	}
	seen := map[string]bool{}
	for _, event := range m.Events.Publishes {
		if !eventNamePattern.MatchString(event.Name) {
			return fmt.Errorf("invalid event name %q; use 1 to 40 lowercase letters, digits, and underscores", event.Name)
		}
		if event.Version < 1 || event.Version > MaxEventVersion {
			return fmt.Errorf("event %s needs a version from 1 to %d", event.Name, MaxEventVersion)
		}
		if seen[event.Reference()] {
			return fmt.Errorf("event %s is declared twice", event.Reference())
		}
		seen[event.Reference()] = true
		if err := bounded("event title", event.Title, eventTitleMax); err != nil {
			return err
		}
		if len(event.Description) > eventDescriptionMax {
			return fmt.Errorf("event %s description is longer than %d bytes", event.Reference(), eventDescriptionMax)
		}
		if len(event.Fields) == 0 || len(event.Fields) > MaxEventFields {
			return fmt.Errorf("event %s needs 1 to %d payload fields", event.Reference(), MaxEventFields)
		}
		if err := configschema.ValidateFields(event.Fields, configschema.ProfileEvent); err != nil {
			return fmt.Errorf("event %s payload: %v", event.Reference(), err)
		}
	}
	if len(m.Events.Subscribes) > MaxEventSubscriptions {
		return fmt.Errorf("events.subscribes names %d events; the limit is %d", len(m.Events.Subscribes), MaxEventSubscriptions)
	}
	subscribed := map[string]bool{}
	for _, name := range m.Events.Subscribes {
		if len(name) > eventSubscriptionMax {
			return fmt.Errorf("event subscription %q is too long", name)
		}
		if subscribed[name] {
			return fmt.Errorf("event %s is subscribed twice", name)
		}
		subscribed[name] = true
		if IsCoreEvent(name) {
			continue
		}
		if _, ok := ParsePluginEventName(name); ok {
			continue
		}
		if strings.HasPrefix(name, "plugin.") {
			return fmt.Errorf("invalid plugin event name %q; use plugin.<plugin id>.<name>@<version>", name)
		}
		return fmt.Errorf("unknown core event %q; core events are %s", name, strings.Join(CoreEvents, ", "))
	}
	return nil
}

// Event is one delivery of an event to a subscriber. Delivery is at least
// once: the same DeliveryID can arrive again after a crash, a timeout, or an
// error, also after the handler completed its side effect.
type Event struct {
	// DeliveryID is stable across every attempt of this delivery to this
	// plugin.
	DeliveryID string `json:"deliveryId"`
	// OccurrenceID identifies the occurrence. Every subscriber of one
	// occurrence receives the same OccurrenceID.
	OccurrenceID string    `json:"occurrenceId"`
	Name         string    `json:"name"`
	Subject      string    `json:"subject"`
	OccurredAt   time.Time `json:"occurredAt"`
	// Payload is the bounded JSON payload of the event's version.
	Payload json.RawMessage `json:"payload"`
	// Attempt is 1 for the first delivery.
	Attempt int `json:"attempt"`
}

// Decode copies the payload into a plugin's own struct.
func (e Event) Decode(out any) error { return json.Unmarshal(e.Payload, out) }

// EventHandler is implemented by a bundled Plugin Manifest API 3 plugin that
// subscribes to events. The host calls HandleEvent in the system context,
// with no operator, for at most 30 seconds. A returned error retries the
// delivery; after 8 failures the host parks it.
type EventHandler interface {
	HandleEvent(ctx context.Context, event Event) error
}

type eventPublish struct {
	Event   string `json:"event"`
	Subject string `json:"subject"`
	Payload any    `json:"payload"`
}

// PublishedOccurrence is the answer of PublishEvent.
type PublishedOccurrence struct {
	OccurrenceID string `json:"occurrenceId"`
	// Deliveries counts the subscribers that received a delivery.
	Deliveries int `json:"deliveries"`
}

// PublishEvent publishes one of the plugin's declared events through
// events.publish@1. event is <name>@<version>; the host adds the plugin
// identity. The host validates the payload against the declared schema and
// queues one delivery for each installed subscriber in one transaction.
func (s *Services) PublishEvent(ctx context.Context, event, subject string, payload any) (PublishedOccurrence, error) {
	var out PublishedOccurrence
	err := s.Call(ctx, "events.publish@1/publish", eventPublish{Event: event, Subject: subject, Payload: payload}, &out)
	return out, err
}
