package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/apps/server/internal/plugindelivery"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Server events of Plugin Manifest API 3 (docs/plugin-events.md). The
// Service is the coreevents.Sink of core domain services, and it serves
// events.publish@1. Both fan an occurrence out to the delivery queue in the
// producer's transaction: one delivery of kind "event" for each installed
// subscriber, with its own stable delivery ID and the occurrence's ID.

// Event publication failures for the service registry.
var (
	ErrEventUndeclared    = errors.New("the plugin does not declare this event")
	ErrEventInvalid       = errors.New("invalid event")
	ErrEventSchemaChanged = errors.New("the event's payload schema changed under the same version")
)

// eventMetadata is the queue metadata of an event delivery.
type eventMetadata struct {
	OccurrenceID uuid.UUID `json:"occurrenceId"`
	OccurredAt   time.Time `json:"occurredAt"`
	Publisher    string    `json:"publisher"`
}

// subscribers lists the hosted plugins that take an event name, in catalog
// order. owner, when set, keeps only that plugin.
func (s *Service) subscribers(name, owner string) []hostedPlugin {
	var out []hostedPlugin
	for _, hosted := range s.hosted {
		if owner != "" && hosted.manifest.ID != owner {
			continue
		}
		if _, ok := hosted.plugin.(plugin.EventHandler); ok && hosted.manifest.Subscribes(name) {
			out = append(out, hosted)
		}
	}
	return out
}

// Emit implements coreevents.Sink. With no subscriber it does no database
// work, so a core write pays nothing for events nobody receives.
func (s *Service) Emit(ctx context.Context, tx pgx.Tx, event coreevents.Event) error {
	if !plugin.IsCoreEvent(event.Name) {
		return fmt.Errorf("unknown core event %q", event.Name)
	}
	targets := s.subscribers(event.Name, event.Owner)
	if len(targets) == 0 {
		return nil
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return err
	}
	if len(payload) > plugin.MaxEventPayloadBytes {
		return fmt.Errorf("core event %s payload is %d bytes", event.Name, len(payload))
	}
	_, _, err = s.fanout(ctx, tx, event.Name, event.Subject, payload, event.OccurredAt, "core", targets)
	return err
}

func (s *Service) fanout(ctx context.Context, tx pgx.Tx, name, subject string, payload []byte, occurredAt time.Time, publisher string, targets []hostedPlugin) (uuid.UUID, int, error) {
	occurrence := uuid.New()
	metadata, err := json.Marshal(eventMetadata{OccurrenceID: occurrence, OccurredAt: occurredAt.UTC(), Publisher: publisher})
	if err != nil {
		return uuid.Nil, 0, err
	}
	now := s.clock.Now()
	queued := 0
	for _, target := range targets {
		ok, err := plugindelivery.Enqueue(ctx, tx, plugindelivery.Item{
			PluginID: target.manifest.ID, DefinitionVersion: target.manifest.DefinitionVersion,
			Kind: plugindelivery.KindEvent, Source: name, Subject: subject,
			Payload: payload, Metadata: metadata, DueAt: now,
		})
		if err != nil {
			return uuid.Nil, 0, err
		}
		if ok {
			queued++
		}
	}
	return occurrence, queued, nil
}

// checkEventSchema records the fingerprint of a published version the
// first time, and reports whether the declared schema still matches it.
func checkEventSchema(ctx context.Context, tx pgx.Tx, pluginID string, event plugin.PublishedEvent) (bool, error) {
	fingerprint := eventFingerprint(event.Fields)
	var stored string
	err := tx.QueryRow(ctx, `INSERT INTO plugin_event_schemas(plugin_id,event_name,version,fingerprint) VALUES($1,$2,$3,$4)
		ON CONFLICT (plugin_id,event_name,version) DO UPDATE SET plugin_id=EXCLUDED.plugin_id
		RETURNING fingerprint`, pluginID, event.Name, event.Version, fingerprint).Scan(&stored)
	return stored == fingerprint, err
}

// PublishEvent publishes one occurrence of a declared event of the calling
// plugin. event is <name>@<version>. The payload must match the declared
// schema exactly and encode to at most 4 KiB. It returns the occurrence ID
// and the number of subscribers that received a delivery.
func (s *Service) PublishEvent(ctx context.Context, pluginID, event, subject string, payload json.RawMessage) (uuid.UUID, int, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 || !declaresService(hosted.manifest, "events.publish@1") {
		return uuid.Nil, 0, ErrPluginNotFound
	}
	name, version, ok := splitEventReference(event)
	if !ok {
		return uuid.Nil, 0, ErrEventUndeclared
	}
	declared, ok := hosted.manifest.PublishedEvent(name, version)
	if !ok {
		return uuid.Nil, 0, ErrEventUndeclared
	}
	if !plugin.ValidEventSubject(subject) {
		return uuid.Nil, 0, fmt.Errorf("%w: a subject is 1 to %d bytes without control characters", ErrEventInvalid, plugin.MaxEventSubjectBytes)
	}
	var input map[string]any
	if err := json.Unmarshal(payload, &input); err != nil || input == nil {
		return uuid.Nil, 0, fmt.Errorf("%w: the payload is a JSON object", ErrEventInvalid)
	}
	normalized, err := configschema.Normalize(ctx, declared.Fields, input, nil)
	if err != nil {
		return uuid.Nil, 0, fmt.Errorf("%w: %v", ErrEventInvalid, err)
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return uuid.Nil, 0, err
	}
	if len(encoded) > plugin.MaxEventPayloadBytes {
		return uuid.Nil, 0, fmt.Errorf("%w: the payload is %d bytes; the limit is %d", ErrEventInvalid, len(encoded), plugin.MaxEventPayloadBytes)
	}
	full := plugin.PluginEventName(pluginID, name, version)
	var occurrence uuid.UUID
	var queued int
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var installed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plugin_installations WHERE plugin_id=$1)`, pluginID).Scan(&installed); err != nil {
			return err
		}
		if !installed {
			return ErrPluginNotFound
		}
		matches, err := checkEventSchema(ctx, tx, pluginID, declared)
		if err != nil {
			return err
		}
		if !matches {
			return ErrEventSchemaChanged
		}
		occurrence, queued, err = s.fanout(ctx, tx, full, "plugin."+pluginID+":"+subject, encoded, s.clock.Now(), pluginID, s.subscribers(full, ""))
		return err
	})
	if errors.Is(err, ErrEventSchemaChanged) {
		s.logger.Error("plugin event schema changed under the same version; publish refused", "plugin", pluginID, "event", full)
	}
	return occurrence, queued, err
}

func splitEventReference(reference string) (string, int, bool) {
	name, version, ok := strings.Cut(reference, "@")
	if !ok {
		return "", 0, false
	}
	var number int
	if _, err := fmt.Sscanf(version, "%d", &number); err != nil || fmt.Sprint(number) != version {
		return "", 0, false
	}
	return name, number, true
}

// Subscription states of the Status page.
const (
	SubscriptionActive   = "active"
	SubscriptionInactive = "inactive"
)

// Reasons a subscription is inactive.
const (
	// The publishing plugin is not part of this release.
	ReasonPublisherUnknown = "publisher_unknown"
	// The publishing plugin is part of this release but not installed.
	ReasonPublisherNotInstalled = "publisher_not_installed"
	// The publisher is installed but does not declare this name and version.
	ReasonEventNotDeclared = "event_not_declared"
	// feed.stale@1 reaches only a plugin's own feeds, and it has none.
	ReasonNoOwnFeeds = "no_own_feeds"
)

// SubscriptionStatus is one subscription of a plugin.
type SubscriptionStatus struct {
	Event  string `json:"event"`
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
	// Publisher is "core" or the publishing plugin's ID.
	Publisher string `json:"publisher"`
	// PublisherName is the publishing plugin's name when this release
	// includes it.
	PublisherName string `json:"publisherName,omitempty"`
}

// PublishedEventStatus is one event a plugin publishes.
type PublishedEventStatus struct {
	Event       string `json:"event"`
	Title       string `json:"title"`
	Subscribers int    `json:"subscribers"`
	// SchemaChanged is true when the declared payload differs from the one
	// this installation recorded for the same version.
	SchemaChanged bool `json:"schemaChanged"`
}

func (s *Service) eventStatus(ctx context.Context, hosted hostedPlugin, installed map[string]bool) ([]SubscriptionStatus, []PublishedEventStatus, error) {
	subscriptions := []SubscriptionStatus{}
	published := []PublishedEventStatus{}
	if hosted.manifest.Events == nil {
		return subscriptions, published, nil
	}
	for _, name := range hosted.manifest.Events.Subscribes {
		status := SubscriptionStatus{Event: name, State: SubscriptionActive, Publisher: "core"}
		if parsed, ok := plugin.ParsePluginEventName(name); ok {
			status.Publisher = parsed.Plugin
			publisher, known := s.hostedPlugin(parsed.Plugin)
			if known {
				status.PublisherName = publisher.manifest.Name
			}
			switch {
			case !known || publisher.manifest.APIVersion < 3:
				status.State, status.Reason = SubscriptionInactive, ReasonPublisherUnknown
			case !installed[parsed.Plugin]:
				status.State, status.Reason = SubscriptionInactive, ReasonPublisherNotInstalled
			default:
				if _, declared := publisher.manifest.PublishedEvent(parsed.Name, parsed.Version); !declared {
					status.State, status.Reason = SubscriptionInactive, ReasonEventNotDeclared
				}
			}
		} else if name == plugin.CoreFeedStale && len(hosted.manifest.Feeds) == 0 {
			status.State, status.Reason = SubscriptionInactive, ReasonNoOwnFeeds
		}
		subscriptions = append(subscriptions, status)
	}
	for _, event := range hosted.manifest.Events.Publishes {
		full := plugin.PluginEventName(hosted.manifest.ID, event.Name, event.Version)
		item := PublishedEventStatus{Event: full, Title: event.Title}
		for _, subscriber := range s.subscribers(full, "") {
			if installed[subscriber.manifest.ID] {
				item.Subscribers++
			}
		}
		var stored string
		err := s.db.QueryRow(ctx, `SELECT fingerprint FROM plugin_event_schemas WHERE plugin_id=$1 AND event_name=$2 AND version=$3`,
			hosted.manifest.ID, event.Name, event.Version).Scan(&stored)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, err
		}
		item.SchemaChanged = stored != "" && stored != eventFingerprint(event.Fields)
		published = append(published, item)
	}
	return subscriptions, published, nil
}

// eventDelivery turns a queued event into the hook's argument.
func eventDelivery(delivery plugindelivery.Delivery) (plugin.Event, error) {
	var metadata eventMetadata
	if err := json.Unmarshal(delivery.Metadata, &metadata); err != nil {
		return plugin.Event{}, err
	}
	subject := delivery.Subject
	if metadata.Publisher != "core" {
		// The stored subject of a plugin event carries the publisher, so
		// two publishers never share an order. The hook sees the subject
		// the publisher named.
		subject = strings.TrimPrefix(subject, "plugin."+metadata.Publisher+":")
	}
	return plugin.Event{
		DeliveryID: delivery.ID.String(), OccurrenceID: metadata.OccurrenceID.String(),
		Name: delivery.Source, Subject: subject, OccurredAt: metadata.OccurredAt,
		Payload: json.RawMessage(delivery.Payload), Attempt: delivery.Attempt,
	}, nil
}

// EventReview is what the install review shows about a plugin's events.
type EventReview struct {
	Publishes  []PublishedEventReview  `json:"publishes"`
	Subscribes []SubscribedEventReview `json:"subscribes"`
}

// PublishedEventReview is one event the plugin publishes.
type PublishedEventReview struct {
	Event  string `json:"event"`
	Title  string `json:"title"`
	Fields int    `json:"fields"`
}

// SubscribedEventReview is one event the plugin receives and who publishes
// it: "core", or a plugin ID.
type SubscribedEventReview struct {
	Event     string `json:"event"`
	Publisher string `json:"publisher"`
	// PublisherName is the publishing plugin's name when this release
	// includes it.
	PublisherName string `json:"publisherName,omitempty"`
}

func eventReview(m plugin.Manifest) EventReview {
	review := EventReview{Publishes: []PublishedEventReview{}, Subscribes: []SubscribedEventReview{}}
	if m.APIVersion < 3 || m.Events == nil {
		return review
	}
	for _, event := range m.Events.Publishes {
		review.Publishes = append(review.Publishes, PublishedEventReview{
			Event: plugin.PluginEventName(m.ID, event.Name, event.Version), Title: event.Title, Fields: len(event.Fields)})
	}
	for _, name := range m.Events.Subscribes {
		publisher := "core"
		if parsed, ok := plugin.ParsePluginEventName(name); ok {
			publisher = parsed.Plugin
		}
		review.Subscribes = append(review.Subscribes, SubscribedEventReview{Event: name, Publisher: publisher})
	}
	return review
}

// namePublishers fills in the name of each publishing plugin the registry
// includes, once every definition exists.
func namePublishers(definitions []Definition) {
	names := make(map[string]string, len(definitions))
	for _, definition := range definitions {
		names[definition.ID] = definition.Name
	}
	for i := range definitions {
		for j := range definitions[i].Events.Subscribes {
			subscription := &definitions[i].Events.Subscribes[j]
			if subscription.Publisher != "core" {
				subscription.PublisherName = names[subscription.Publisher]
			}
		}
	}
}

func (r EventReview) clone() EventReview {
	return EventReview{
		Publishes:  append([]PublishedEventReview{}, r.Publishes...),
		Subscribes: append([]SubscribedEventReview{}, r.Subscribes...),
	}
}
