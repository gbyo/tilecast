package pluginharness_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/apps/server/internal/plugindelivery"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	"github.com/tilecast/tilecast/apps/server/pluginharness/eventplugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Event conformance (docs/plugin-events.md) with the test publisher and the
// test subscriber, the real plugin host, the real delivery queue, and the
// real core producers. The clock is stepped; no test waits for a retry.

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type env struct {
	h          *pluginharness.Harness
	clock      *clock
	publisher  *eventplugins.Publisher
	subscriber *eventplugins.Subscriber
}

func newEnv(t *testing.T) env {
	t.Helper()
	c := &clock{now: time.Now().UTC().Truncate(time.Second)}
	publisher, subscriber := eventplugins.NewPublisher(), eventplugins.NewSubscriber()
	h := pluginharness.New(t, subscriber, pluginharness.Clock(c), pluginharness.Alongside(publisher))
	if _, err := h.Pool.Exec(h.Ctx, `TRUNCATE plugin_deliveries, plugin_delivery_status, plugin_event_schemas, screen_connectivity`); err != nil {
		t.Fatal(err)
	}
	return env{h: h, clock: c, publisher: publisher, subscriber: subscriber}
}

// publish asks the publisher to publish from a timer callback, as a real
// plugin does, and returns the result the plugin saw.
func (e env) publish(t *testing.T, event, subject string, payload map[string]any) eventplugins.PublishResult {
	t.Helper()
	encoded, _ := json.Marshal(eventplugins.Publication{Event: event, Subject: subject, Payload: payload})
	before := len(e.publisher.Results())
	if _, _, err := e.h.Plugins.ScheduleTimer(e.h.Ctx, eventplugins.PublisherID, "publish:"+uuid.NewString(), e.clock.Now(), encoded); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5 && len(e.publisher.Results()) == before; i++ {
		e.h.Deliver()
	}
	results := e.publisher.Results()
	if len(results) == before {
		t.Fatal("the publisher's timer did not run")
	}
	return results[len(results)-1]
}

func (e env) drain(t *testing.T) {
	t.Helper()
	for i := 0; i < 50; i++ {
		if e.h.Deliver() == 0 {
			return
		}
	}
	t.Fatal("deliveries did not drain")
}

func (e env) queued(t *testing.T, pluginID string) int {
	t.Helper()
	var n int
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM plugin_deliveries WHERE plugin_id=$1`, pluginID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func subscription(status plugins.PluginStatus, event string) plugins.SubscriptionStatus {
	for _, item := range status.Subscriptions {
		if item.Event == event {
			return item
		}
	}
	return plugins.SubscriptionStatus{}
}

func TestPluginEventsReachSubscribersAsynchronously(t *testing.T) {
	e := newEnv(t)
	e.h.Install()
	e.h.InstallPlugin(eventplugins.PublisherID)
	result := e.publish(t, "signal@1", "room-1", map[string]any{"message": "  hello  ", "count": 2})
	if result.Err != nil || result.Occurrence.Deliveries != 1 || result.Occurrence.OccurrenceID == "" {
		t.Fatalf("publish = %+v", result)
	}
	// Delivery is asynchronous: the occurrence is queued, then delivered.
	if len(e.subscriber.Received()) != 0 {
		t.Fatal("an event was delivered inside the publisher's call")
	}
	e.drain(t)
	received := e.subscriber.Received(eventplugins.Signal)
	if len(received) != 1 {
		t.Fatalf("received %d", len(received))
	}
	got := received[0]
	if got.Event.Subject != "room-1" || got.Event.OccurrenceID != result.Occurrence.OccurrenceID || got.Event.DeliveryID == "" ||
		got.Event.Attempt != 1 || got.Principal || !got.Deadline {
		t.Fatalf("event = %+v", got)
	}
	var payload map[string]any
	if err := got.Event.Decode(&payload); err != nil || payload["message"] != "hello" || payload["count"] != float64(2) {
		t.Fatalf("payload = %v %v", payload, err)
	}
	// The publisher never names its own identity: an undeclared event, a
	// wrong version, or a payload that does not match is refused.
	for name, call := range map[string]func() eventplugins.PublishResult{
		"undeclared": func() eventplugins.PublishResult { return e.publish(t, "other@1", "s", map[string]any{"message": "x"}) },
		"version": func() eventplugins.PublishResult {
			return e.publish(t, "signal@2", "s", map[string]any{"message": "x"})
		},
		"unknown field": func() eventplugins.PublishResult {
			return e.publish(t, "signal@1", "s", map[string]any{"message": "x", "extra": 1})
		},
		"type":     func() eventplugins.PublishResult { return e.publish(t, "signal@1", "s", map[string]any{"message": 3}) },
		"required": func() eventplugins.PublishResult { return e.publish(t, "signal@1", "s", map[string]any{"count": 1}) },
		"subject": func() eventplugins.PublishResult {
			return e.publish(t, "signal@1", "a\nb", map[string]any{"message": "x"})
		},
	} {
		var failure *plugin.ServiceError
		if result := call(); !errors.As(result.Err, &failure) {
			t.Errorf("%s = %v", name, result.Err)
		}
	}
	// The 4 KiB bound applies to the encoded payload: {"message":"..."}.
	edge := strings.Repeat("x", plugin.MaxEventPayloadBytes-len(`{"message":""}`))
	if _, _, err := e.h.Plugins.PublishEvent(e.h.Ctx, eventplugins.PublisherID, "signal@1", "edge", json.RawMessage(`{"message":"`+edge+`"}`)); err != nil {
		t.Fatalf("4096 bytes = %v", err)
	}
	if _, _, err := e.h.Plugins.PublishEvent(e.h.Ctx, eventplugins.PublisherID, "signal@1", "edge", json.RawMessage(`{"message":"`+edge+`x"}`)); !errors.Is(err, plugins.ErrEventInvalid) {
		t.Fatalf("4097 bytes = %v", err)
	}
	// A plugin that does not publish cannot publish.
	if _, _, err := e.h.Plugins.PublishEvent(e.h.Ctx, eventplugins.SubscriberID, "signal@1", "s", json.RawMessage(`{"message":"x"}`)); !errors.Is(err, plugins.ErrPluginNotFound) {
		t.Fatalf("subscriber publishing = %v", err)
	}
}

func TestSubscriptionsFollowThePublisher(t *testing.T) {
	e := newEnv(t)
	e.h.Install()
	status := e.h.StatusOf(eventplugins.SubscriberID)
	for event, want := range map[string]string{
		eventplugins.Signal:            plugins.ReasonPublisherNotInstalled,
		eventplugins.Missing:           plugins.ReasonPublisherUnknown,
		eventplugins.BellPeriodStarted: plugins.ReasonPublisherUnknown,
		plugin.CoreFeedStale:           plugins.ReasonNoOwnFeeds,
		plugin.CoreIncidentOpened:      "",
	} {
		if got := subscription(status, event); got.Reason != want || (want == "") != (got.State == plugins.SubscriptionActive) {
			t.Errorf("%s = %+v", event, got)
		}
	}
	// The install of a subscriber to an absent publisher succeeded; once
	// the publisher is installed, the subscription works by itself.
	if _, _, err := e.h.Plugins.PublishEvent(e.h.Ctx, eventplugins.PublisherID, "signal@1", "s", json.RawMessage(`{"message":"early"}`)); !errors.Is(err, plugins.ErrPluginNotFound) {
		t.Fatalf("publish before install = %v", err)
	}
	e.h.InstallPlugin(eventplugins.PublisherID)
	status = e.h.StatusOf(eventplugins.SubscriberID)
	if got := subscription(status, eventplugins.Signal); got.State != plugins.SubscriptionActive {
		t.Fatalf("after install = %+v", got)
	}
	if got := subscription(status, eventplugins.SignalV2); got.Reason != plugins.ReasonEventNotDeclared {
		t.Fatalf("undeclared version = %+v", got)
	}
	if published := e.h.StatusOf(eventplugins.PublisherID).PublishedEvents; len(published) != 1 || published[0].Subscribers != 1 || published[0].SchemaChanged {
		t.Fatalf("published = %+v", published)
	}
	if result := e.publish(t, "signal@1", "s", map[string]any{"message": "now"}); result.Err != nil || result.Occurrence.Deliveries != 1 {
		t.Fatalf("publish = %+v", result)
	}
	e.drain(t)
	if len(e.subscriber.Received(eventplugins.Signal)) != 1 {
		t.Fatal("the subscription did not become active")
	}
	// A recorded schema that differs from the declaration refuses the
	// version and shows in the status.
	if _, err := e.h.Pool.Exec(e.h.Ctx, `UPDATE plugin_event_schemas SET fingerprint=repeat('0',64) WHERE plugin_id=$1`, eventplugins.PublisherID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.h.Plugins.PublishEvent(e.h.Ctx, eventplugins.PublisherID, "signal@1", "s", json.RawMessage(`{"message":"x"}`)); !errors.Is(err, plugins.ErrEventSchemaChanged) {
		t.Fatalf("changed schema = %v", err)
	}
	if published := e.h.StatusOf(eventplugins.PublisherID).PublishedEvents; !published[0].SchemaChanged {
		t.Fatalf("status = %+v", published)
	}
}

func TestEventOrderRetryRollbackAndCleanup(t *testing.T) {
	e := newEnv(t)
	e.h.Install()
	e.h.InstallPlugin(eventplugins.PublisherID)
	failed := false
	e.subscriber.Handle = func(_ context.Context, event plugin.Event) error {
		var payload map[string]any
		_ = event.Decode(&payload)
		if payload["message"] == "two" && !failed {
			failed = true
			return errors.New("not yet")
		}
		return nil
	}
	for _, message := range []string{"one", "two", "three"} {
		if _, _, err := e.h.Plugins.PublishEvent(e.h.Ctx, eventplugins.PublisherID, "signal@1", "same", json.RawMessage(`{"message":"`+message+`"}`)); err != nil {
			t.Fatal(err)
		}
	}
	e.drain(t)
	e.clock.advance(plugindelivery.RetryBase)
	e.drain(t)
	order := []string{}
	ids := map[string][]string{}
	for _, item := range e.subscriber.Received(eventplugins.Signal) {
		var payload map[string]string
		_ = item.Event.Decode(&payload)
		order = append(order, payload["message"])
		ids[payload["message"]] = append(ids[payload["message"]], item.Event.DeliveryID)
	}
	if fmt.Sprint(order) != "[one two two three]" {
		t.Fatalf("order = %v", order)
	}
	if two := ids["two"]; len(two) != 2 || two[0] != two[1] {
		t.Fatalf("the retry changed the delivery ID: %v", two)
	}
	// A core event in a rolled-back transaction is never delivered.
	tx, err := e.h.Pool.Begin(e.h.Ctx)
	if err != nil {
		t.Fatal(err)
	}
	screen := uuid.New()
	if err := e.h.Plugins.Emit(e.h.Ctx, tx, coreevents.Event{Name: plugin.CoreScreenStatusChanged, Subject: coreevents.ScreenSubject(screen),
		OccurredAt: e.clock.Now(), Payload: coreevents.ScreenStatus{ScreenID: screen, Status: coreevents.ScreenOffline}}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(e.h.Ctx); err != nil {
		t.Fatal(err)
	}
	if e.queued(t, eventplugins.SubscriberID) != 0 {
		t.Fatal("a rolled-back event was queued")
	}
	// An item of an event the plugin no longer subscribes to is removed.
	if err := pgx.BeginFunc(e.h.Ctx, e.h.Pool, func(tx pgx.Tx) error {
		_, err := plugindelivery.Enqueue(e.h.Ctx, tx, plugindelivery.Item{PluginID: eventplugins.SubscriberID, DefinitionVersion: 1,
			Kind: plugindelivery.KindEvent, Source: "plugin.harness_publisher.gone@1", Subject: "x", DueAt: e.clock.Now()})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if swept, err := e.h.Plugins.SweepDeliveries(e.h.Ctx); err != nil || swept.Reconciled != 1 {
		t.Fatalf("reconcile = %+v %v", swept, err)
	}
	// Removal deletes the subscriber's queue, and nothing more is queued.
	e.subscriber.Handle = func(context.Context, plugin.Event) error { return errors.New("down") }
	if _, _, err := e.h.Plugins.PublishEvent(e.h.Ctx, eventplugins.PublisherID, "signal@1", "same", json.RawMessage(`{"message":"queued"}`)); err != nil {
		t.Fatal(err)
	}
	if err := e.h.Remove(); err != nil {
		t.Fatal(err)
	}
	if e.queued(t, eventplugins.SubscriberID) != 0 {
		t.Fatal("removal kept the queue")
	}
	if _, deliveries, err := e.h.Plugins.PublishEvent(e.h.Ctx, eventplugins.PublisherID, "signal@1", "same", json.RawMessage(`{"message":"late"}`)); err != nil || deliveries != 0 {
		t.Fatalf("publish to a removed subscriber = %d %v", deliveries, err)
	}
}

func TestScreenStatusAndIncidentEventsOncePerOutage(t *testing.T) {
	e := newEnv(t)
	e.h.Install()
	screen := e.h.PairedScreen("Lobby", e.clock.Now())
	sweep := func(times int) {
		t.Helper()
		for i := 0; i < times; i++ {
			if err := e.h.Connectivity().Sweep(e.h.Ctx); err != nil {
				t.Fatal(err)
			}
		}
		e.drain(t)
	}
	sweep(2)
	if got := e.subscriber.Received(); len(got) != 0 {
		t.Fatalf("a first sighting emitted %v", got)
	}
	e.clock.advance(16 * time.Minute)
	sweep(3)
	offline := e.subscriber.Received(plugin.CoreScreenStatusChanged)
	opened := e.subscriber.Received(plugin.CoreIncidentOpened)
	if len(offline) != 1 || len(opened) != 1 {
		t.Fatalf("offline %d, opened %d", len(offline), len(opened))
	}
	var status coreevents.ScreenStatus
	var incident coreevents.Incident
	if err := offline[0].Event.Decode(&status); err != nil || status.ScreenID != screen || status.Status != coreevents.ScreenOffline ||
		status.PreviousStatus != coreevents.ScreenReachable || offline[0].Event.Subject != coreevents.ScreenSubject(screen) {
		t.Fatalf("status = %+v %v", status, err)
	}
	if err := opened[0].Event.Decode(&incident); err != nil || incident.Type != "connectivity" || incident.ScreenID == nil ||
		*incident.ScreenID != screen || incident.Reason != coreevents.IncidentDetected {
		t.Fatalf("incident = %+v %v", incident, err)
	}
	e.subscriber.Reset()
	e.h.Heartbeat(screen, e.clock.Now())
	sweep(3)
	online := e.subscriber.Received(plugin.CoreScreenStatusChanged)
	recovered := e.subscriber.Received(plugin.CoreIncidentRecovered)
	if len(online) != 1 || len(recovered) != 1 || len(e.subscriber.Received()) != 2 {
		t.Fatalf("online %d, recovered %d, all %d", len(online), len(recovered), len(e.subscriber.Received()))
	}
	if err := online[0].Event.Decode(&status); err != nil || status.Status != coreevents.ScreenReachable {
		t.Fatalf("status = %+v", status)
	}
	if err := recovered[0].Event.Decode(&incident); err != nil || incident.Reason != coreevents.IncidentAutomatic {
		t.Fatalf("recovered = %+v", incident)
	}
}

func TestTakeoverLifecycleEvents(t *testing.T) {
	e := newEnv(t)
	e.h.Install()
	lobby, gym := e.h.Screen("Lobby"), e.h.Screen("Gym")
	playlist := e.h.ReadyPlaylist("Takeover")
	weak := e.h.OperatorTakeover(plugin.TakeoverOperator, playlist, lobby, gym)
	// A stronger Takeover on one screen does not suspend the weaker one.
	partial := e.h.OperatorTakeover(plugin.TakeoverEmergency, playlist, lobby)
	e.drain(t)
	if got := e.subscriber.Received(plugin.CoreTakeoverSuspended); len(got) != 0 {
		t.Fatalf("a partial displacement was a suspension: %+v", got)
	}
	// One on the other screen does: the weak Takeover shows nowhere now.
	strong := e.h.OperatorTakeover(plugin.TakeoverEmergency, playlist, gym)
	e.drain(t)
	suspended := e.subscriber.Received(plugin.CoreTakeoverSuspended)
	if len(suspended) != 1 {
		t.Fatalf("suspended = %d", len(suspended))
	}
	var payload coreevents.Takeover
	if err := suspended[0].Event.Decode(&payload); err != nil || payload.TakeoverID != weak || payload.SuspendedBy == nil ||
		*payload.SuspendedBy != strong || payload.EffectiveScreenCount != 0 || payload.ScreenCount != 2 {
		t.Fatalf("suspended = %+v %v", payload, err)
	}
	// A new Takeover that a stronger one hides is started, not suspended.
	hidden := e.h.OperatorTakeover(plugin.TakeoverOperator, playlist, gym)
	e.drain(t)
	started := e.subscriber.Received(plugin.CoreTakeoverStarted)
	if len(started) != 4 || len(e.subscriber.Received(plugin.CoreTakeoverSuspended)) != 1 {
		t.Fatalf("started %d", len(started))
	}
	if err := started[3].Event.Decode(&payload); err != nil || payload.TakeoverID != hidden || payload.EffectiveScreenCount != 0 {
		t.Fatalf("hidden start = %+v", payload)
	}
	// Cancellation and expiry end Takeovers.
	tx, err := e.h.Pool.Begin(e.h.Ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.h.Takeovers().CancelInTx(e.h.Ctx, tx, strong, e.h.OwnerID, "done"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(e.h.Ctx); err != nil {
		t.Fatal(err)
	}
	expired, err := e.h.Takeovers().ExpireDue(e.h.Ctx, time.Now().UTC().Add(2*time.Hour))
	if err != nil || len(expired) != 3 {
		t.Fatalf("expired = %v %v", expired, err)
	}
	e.drain(t)
	reasons := map[uuid.UUID]string{}
	for _, item := range e.subscriber.Received(plugin.CoreTakeoverEnded) {
		var ended coreevents.Takeover
		_ = item.Event.Decode(&ended)
		reasons[ended.TakeoverID] = ended.Reason
	}
	if len(reasons) != 4 || reasons[strong] != coreevents.TakeoverCancelled || reasons[weak] != coreevents.TakeoverExpired ||
		reasons[partial] != coreevents.TakeoverExpired || reasons[hidden] != coreevents.TakeoverExpired {
		t.Fatalf("ended = %v", reasons)
	}
	if again, _ := e.h.Takeovers().ExpireDue(e.h.Ctx, time.Now().UTC().Add(3*time.Hour)); len(again) != 0 {
		t.Fatal("a Takeover expired twice")
	}
}

func TestScheduleChangedOnRealChangesOnly(t *testing.T) {
	e := newEnv(t)
	e.h.Install()
	service := e.h.Scheduling()
	screen := e.h.Screen("Lobby")
	playlist := e.h.ReadyPlaylist("Lunch")
	start, end := "07:00", "08:00"
	input := scheduling.Input{Name: "Lunch", PlaylistID: playlist, Type: scheduling.Weekly, Timezone: "UTC", Enabled: true,
		DailyStart: &start, DailyEnd: &end, DaysOfWeek: []int{1}, Targets: []scheduling.Target{{Type: "screen", ID: screen}}}
	record, err := service.Create(e.h.Ctx, e.h.OwnerID, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(e.h.Ctx, record.ID, e.h.OwnerID, input); err != nil {
		t.Fatal(err)
	}
	input.Name = "Lunch service"
	if _, err := service.Update(e.h.Ctx, record.ID, e.h.OwnerID, input); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetEnabled(e.h.Ctx, record.ID, e.h.OwnerID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetEnabled(e.h.Ctx, record.ID, e.h.OwnerID, false); err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(e.h.Ctx, record.ID, e.h.OwnerID); err != nil {
		t.Fatal(err)
	}
	e.drain(t)
	changes := []string{}
	for _, item := range e.subscriber.Received(plugin.CoreScheduleChanged) {
		var payload coreevents.Schedule
		_ = item.Event.Decode(&payload)
		if payload.ScheduleID != record.ID || item.Event.Subject != coreevents.ScheduleSubject(record.ID) {
			t.Fatalf("event = %+v", item.Event)
		}
		changes = append(changes, payload.Change)
	}
	if fmt.Sprint(changes) != "[created updated disabled deleted]" {
		t.Fatalf("changes = %v", changes)
	}
}

func TestFeedStaleReachesOnlyTheOwner(t *testing.T) {
	e := newEnv(t)
	e.h.Install()
	e.h.InstallPlugin(eventplugins.PublisherID)
	// The subscriber subscribes to feed.stale@1, but the feed belongs to
	// another plugin.
	dataset := uuid.New()
	err := pgx.BeginFunc(e.h.Ctx, e.h.Pool, func(tx pgx.Tx) error {
		return e.h.Plugins.Emit(e.h.Ctx, tx, coreevents.Event{Name: plugin.CoreFeedStale, Subject: coreevents.FeedSubject(dataset),
			OccurredAt: e.clock.Now(), Owner: eventplugins.PublisherID, Payload: coreevents.FeedStale{DatasetID: dataset, Feed: "items"}})
	})
	if err != nil {
		t.Fatal(err)
	}
	if e.queued(t, eventplugins.SubscriberID) != 0 {
		t.Fatal("feed.stale@1 reached a plugin that does not own the feed")
	}
	err = pgx.BeginFunc(e.h.Ctx, e.h.Pool, func(tx pgx.Tx) error {
		return e.h.Plugins.Emit(e.h.Ctx, tx, coreevents.Event{Name: plugin.CoreFeedStale, Subject: coreevents.FeedSubject(dataset),
			OccurredAt: e.clock.Now(), Owner: eventplugins.SubscriberID, Payload: coreevents.FeedStale{DatasetID: dataset, Feed: "items"}})
	})
	if err != nil || e.queued(t, eventplugins.SubscriberID) != 1 {
		t.Fatalf("owner delivery = %v", err)
	}
}
