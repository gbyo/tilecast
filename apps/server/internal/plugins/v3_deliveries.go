package plugins

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/plugindelivery"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// The plugin side of the delivery engine (docs/plugin-delivery.md): which
// hosted plugin takes which kind of item, how a callback is invoked, and the
// Owner operations on parked items.

// Delivery loop timings. The engine's semantics are constants of
// internal/plugindelivery.
const (
	deliveryTick  = 2 * time.Second
	deliverySweep = time.Minute
)

// ErrDeliveryNotParked answers a retry or discard of a delivery that is not
// a parked delivery of the plugin.
var ErrDeliveryNotParked = plugindelivery.ErrNotParked

// deliveryDirectory resolves delivery targets from the hosted plugins.
type deliveryDirectory struct{ service *Service }

func (d deliveryDirectory) Target(pluginID string) (plugindelivery.Target, bool) {
	hosted, ok := d.service.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 {
		return nil, false
	}
	return deliveryTarget{service: d.service, hosted: hosted}, true
}

type deliveryTarget struct {
	service *Service
	hosted  hostedPlugin
}

func (t deliveryTarget) DefinitionVersion() int { return t.hosted.manifest.DefinitionVersion }

func (t deliveryTarget) Accepts(kind, source string) bool {
	switch kind {
	case plugindelivery.KindTimer:
		_, ok := t.hosted.plugin.(plugin.TimerHandler)
		return ok && declaresService(t.hosted.manifest, "timers.schedule@1")
	case plugindelivery.KindEvent:
		_, ok := t.hosted.plugin.(plugin.EventHandler)
		return ok && t.hosted.manifest.Subscribes(source)
	}
	return false
}

// errNotAccepted is a Deliver call for a kind the plugin does not take. The
// engine checks Accepts first, so it is a defect, and it fails the attempt.
var errNotAccepted = errors.New("plugin does not take this delivery")

// Deliver runs the callback in the system context: no operator, the job
// time limit of the engine.
func (t deliveryTarget) Deliver(ctx context.Context, delivery plugindelivery.Delivery) error {
	ctx, done := t.service.systemInvocation(ctx, t.hosted.manifest.ID)
	defer done()
	switch delivery.Kind {
	case plugindelivery.KindTimer:
		handler, ok := t.hosted.plugin.(plugin.TimerHandler)
		if !ok {
			return errNotAccepted
		}
		return handler.HandleTimer(ctx, plugin.Timer{
			ID: delivery.ID.String(), Key: delivery.Source, Payload: delivery.Payload,
			DueAt: delivery.DueAt, Attempt: delivery.Attempt,
		})
	case plugindelivery.KindEvent:
		handler, ok := t.hosted.plugin.(plugin.EventHandler)
		if !ok {
			return errNotAccepted
		}
		event, err := eventDelivery(delivery)
		if err != nil {
			return err
		}
		return handler.HandleEvent(ctx, event)
	}
	return errNotAccepted
}

func (s *Service) deliveryEngine() *plugindelivery.Engine {
	s.deliveriesOnce.Do(func() {
		if s.deliveries == nil {
			s.deliveries = plugindelivery.NewEngine(s.db, deliveryDirectory{service: s}, s.clock, s.logger, s.deliveryOptions...)
		}
	})
	return s.deliveries
}

// WithDeliveryOptions configures the delivery engine. Tests shorten the
// call time limit with it.
func WithDeliveryOptions(options ...plugindelivery.Option) Option {
	return func(s *Service) { s.deliveryOptions = append(s.deliveryOptions, options...) }
}

// RunDeliveries runs every delivery that can run now and waits for them.
// It reports how many ran. Tests call it with a stepped clock.
func (s *Service) RunDeliveries(ctx context.Context) (int, error) {
	return s.deliveryEngine().RunDue(ctx)
}

// SweepDeliveries expires old deliveries and removes deliveries that can
// never run.
func (s *Service) SweepDeliveries(ctx context.Context) (plugindelivery.Swept, error) {
	return s.deliveryEngine().Sweep(ctx)
}

// RunDeliveryLoop delivers until ctx ends.
func (s *Service) RunDeliveryLoop(ctx context.Context) {
	var allowed func() bool
	if s.backgroundJobs != nil {
		allowed = s.backgroundJobs.Allowed
	}
	s.deliveryEngine().Run(ctx, deliveryTick, deliverySweep, allowed)
}

// PluginStatus is the operational state of a Plugin Manifest API 3 plugin
// that Studio's Status page shows. It never holds a payload, a secret, or
// an error text.
type PluginStatus struct {
	PluginID   string                `json:"pluginId"`
	Installed  bool                  `json:"installed"`
	Deliveries plugindelivery.Status `json:"deliveries"`
	// Subscriptions are the events the plugin receives, each active or
	// inactive with a reason.
	Subscriptions []SubscriptionStatus `json:"subscriptions"`
	// PublishedEvents are the events the plugin publishes.
	PublishedEvents []PublishedEventStatus `json:"publishedEvents"`
}

func (s *Service) v3Plugin(pluginID string) (hostedPlugin, error) {
	hosted, ok := s.hostedPlugin(pluginID)
	if !ok || hosted.manifest.APIVersion < 3 {
		return hostedPlugin{}, ErrPluginNotFound
	}
	return hosted, nil
}

// Status reads the operational state of one plugin.
func (s *Service) Status(ctx context.Context, pluginID string) (PluginStatus, error) {
	hosted, err := s.v3Plugin(pluginID)
	if err != nil {
		return PluginStatus{}, err
	}
	installed, err := s.installedPluginIDs(ctx)
	if err != nil {
		return PluginStatus{}, err
	}
	status := PluginStatus{PluginID: pluginID, Installed: installed[pluginID]}
	if status.Subscriptions, status.PublishedEvents, err = s.eventStatus(ctx, hosted, installed); err != nil {
		return PluginStatus{}, err
	}
	deliveries, err := plugindelivery.ReadStatus(ctx, s.db, pluginID, s.clock.Now())
	if err != nil {
		return PluginStatus{}, err
	}
	status.Deliveries = deliveries
	return status, nil
}

// RetryDelivery returns a parked delivery to its subject's queue. The
// caller authorizes the Owner; the audit event names the delivery, never
// its payload.
func (s *Service) RetryDelivery(ctx context.Context, pluginID string, id, userID uuid.UUID) (plugindelivery.Parked, error) {
	return s.parkedAction(ctx, pluginID, id, userID, "plugin.delivery.retried", func(tx pgx.Tx) (plugindelivery.Parked, error) {
		return plugindelivery.Retry(ctx, tx, pluginID, id, s.clock.Now())
	})
}

// DiscardDelivery deletes a parked delivery.
func (s *Service) DiscardDelivery(ctx context.Context, pluginID string, id, userID uuid.UUID) (plugindelivery.Parked, error) {
	return s.parkedAction(ctx, pluginID, id, userID, "plugin.delivery.discarded", func(tx pgx.Tx) (plugindelivery.Parked, error) {
		return plugindelivery.Discard(ctx, tx, pluginID, id)
	})
}

func (s *Service) parkedAction(ctx context.Context, pluginID string, id, userID uuid.UUID, action string, change func(pgx.Tx) (plugindelivery.Parked, error)) (plugindelivery.Parked, error) {
	hosted, err := s.v3Plugin(pluginID)
	if err != nil {
		return plugindelivery.Parked{}, err
	}
	var item plugindelivery.Parked
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if item, err = change(tx); err != nil {
			return err
		}
		return s.auditPluginResource(ctx, tx, action, "plugin_delivery", pluginID, item.ID, hosted.definition.Name, userID, map[string]any{
			"deliveryId": item.ID, "kind": item.Kind, "subject": item.Subject,
		})
	})
	return item, err
}

func (s *Service) installedPluginIDs(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.Query(ctx, `SELECT plugin_id FROM plugin_installations`)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}
