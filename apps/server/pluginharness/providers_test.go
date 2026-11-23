package pluginharness_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	"github.com/tilecast/tilecast/apps/server/pluginharness/eventplugins"
	"github.com/tilecast/tilecast/apps/server/pluginharness/providerplugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Provider slot conformance (docs/plugin-providers.md): the test channel
// and checker on the real plugin host, the real notification outbox, the
// real Content Health sweep, and the real incidents table.

type providerEnv struct {
	h          *pluginharness.Harness
	clock      *clock
	channel    *providerplugins.ChannelPlugin
	checker    *providerplugins.CheckerPlugin
	subscriber *eventplugins.Subscriber
	notify     *pluginharness.Notifications
}

var enabled = pluginharness.NotificationPolicy{"notifications.enabled": true, "notifications.minimum_severity": "warning"}

func newProviderEnv(t *testing.T) providerEnv {
	t.Helper()
	c := &clock{now: time.Now().UTC().Truncate(time.Second)}
	channel, checker, subscriber := providerplugins.NewChannel(), providerplugins.NewChecker(), eventplugins.NewSubscriber()
	h := pluginharness.New(t, channel, pluginharness.Clock(c), pluginharness.Alongside(checker, subscriber))
	if _, err := h.Pool.Exec(h.Ctx, `TRUNCATE plugin_deliveries, plugin_delivery_status, notification_deliveries, notification_webhooks,
		incidents, plugin_content_check_state, playlists, assets, layouts CASCADE`); err != nil {
		t.Fatal(err)
	}
	h.Install()
	return providerEnv{h: h, clock: c, channel: channel, checker: checker, subscriber: subscriber, notify: h.Notifications(enabled)}
}

func (e providerEnv) incident(t *testing.T, severity string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := e.h.Pool.Exec(e.h.Ctx, `INSERT INTO incidents(id,incident_type,severity,status,title,description,opened_at,last_seen_at,dedupe_key)
		VALUES($1,'connectivity',$2,'open','Screen offline','Lobby stopped responding.',now(),now(),$3)`, id, severity, "test:"+id.String()); err != nil {
		t.Fatal(err)
	}
	return id
}

func (e providerEnv) scan(t *testing.T) {
	t.Helper()
	if _, err := e.notify.ScanIncidents(e.h.Ctx); err != nil {
		t.Fatal(err)
	}
}

func (e providerEnv) deliver(t *testing.T) int {
	t.Helper()
	sent, err := e.notify.DeliverDue(e.h.Ctx)
	if err != nil {
		t.Fatal(err)
	}
	return sent
}

type deliveryRow struct {
	Channel, Target, Status string
	Attempts                int
	LastError               string
	Due                     time.Time
}

func (e providerEnv) rows(t *testing.T, channel string) []deliveryRow {
	t.Helper()
	rows, err := e.h.Pool.Query(e.h.Ctx, `SELECT channel,target,status,attempts,COALESCE(last_error,''),next_attempt_at FROM notification_deliveries WHERE channel=$1 ORDER BY created_at`, channel)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []deliveryRow
	for rows.Next() {
		var row deliveryRow
		if err := rows.Scan(&row.Channel, &row.Target, &row.Status, &row.Attempts, &row.LastError, &row.Due); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	return out
}

func (e providerEnv) makeDue(t *testing.T) {
	t.Helper()
	if _, err := e.h.Pool.Exec(e.h.Ctx, `UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='pending'`); err != nil {
		t.Fatal(err)
	}
}

func TestPluginChannelFollowsNotificationPolicy(t *testing.T) {
	e := newProviderEnv(t)
	e.notify.SetPolicy(pluginharness.NotificationPolicy{"notifications.enabled": false})
	e.incident(t, "error")
	e.scan(t)
	if rows := e.rows(t, "plugin"); len(rows) != 0 {
		t.Fatalf("notifications off still queued %v", rows)
	}
	e.notify.SetPolicy(pluginharness.NotificationPolicy{"notifications.enabled": true, "notifications.minimum_severity": "error"})
	e.incident(t, "warning")
	e.scan(t)
	if rows := e.rows(t, "plugin"); len(rows) != 0 {
		t.Fatalf("below the minimum severity still queued %v", rows)
	}
	// Quiet hours all day: a person's email would wait, a machine channel
	// does not.
	e.notify.SetPolicy(pluginharness.NotificationPolicy{"notifications.enabled": true, "notifications.minimum_severity": "warning",
		"notifications.quiet_hours_enabled": true, "notifications.quiet_hours_start": "00:00", "notifications.quiet_hours_end": "23:59"})
	id := e.incident(t, "error")
	e.scan(t)
	e.scan(t)
	rows := e.rows(t, "plugin")
	if len(rows) != 1 || rows[0].Target != "harness_channel:push" || time.Until(rows[0].Due) > time.Minute {
		t.Fatalf("one transition, one immediate plugin delivery: %v", rows)
	}
	if e.deliver(t) != 1 {
		t.Fatal("not delivered")
	}
	got := e.channel.Received()
	if len(got) != 1 || got[0].Channel != "push" || got[0].EventKey != "incident:"+id.String()+":opened" ||
		got[0].Category != "incident" || got[0].Severity != "error" || got[0].StudioURL != pluginharness.PublicURL+"/activity/incidents" {
		t.Fatalf("notification %+v", got)
	}
	if !e.channel.RanWithoutOperator() {
		t.Fatal("the channel ran with an operator")
	}
	if rows := e.rows(t, "plugin"); rows[0].Status != "sent" {
		t.Fatalf("row %+v", rows[0])
	}
}

func TestPluginChannelRecoveryFollowsNotify(t *testing.T) {
	e := newProviderEnv(t)
	id := e.incident(t, "error")
	e.scan(t)
	if _, err := e.h.Pool.Exec(e.h.Ctx, `UPDATE incidents SET status='recovered',recovered_at=now(),recovery_mode='automatic' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	e.scan(t)
	e.deliver(t)
	got := e.channel.Received()
	if len(got) != 2 || got[1].EventKey != "incident:"+id.String()+":recovered" || got[1].Severity != "info" || !strings.HasPrefix(got[1].Subject, "Recovered: ") {
		t.Fatalf("recovery %+v", got)
	}
}

func TestDisabledChannelGetsNoDelivery(t *testing.T) {
	e := newProviderEnv(t)
	e.channel.SetReady(false)
	e.incident(t, "critical")
	e.scan(t)
	if rows := e.rows(t, "plugin"); len(rows) != 0 {
		t.Fatalf("an unready channel got %v", rows)
	}
	status := e.h.StatusOf(providerplugins.ChannelID)
	if len(status.Providers.Channels) != 1 || status.Providers.Channels[0].Ready {
		t.Fatalf("status %+v", status.Providers)
	}
}

func TestPluginChannelDeliveryOutcomes(t *testing.T) {
	e := newProviderEnv(t)
	attempts := 0
	e.channel.SetOutcome(func(plugin.Notification) error {
		attempts++
		if attempts == 1 {
			return errors.New("ntfy is down: token tk_secret in the error text")
		}
		return nil
	})
	e.incident(t, "error")
	e.scan(t)
	e.deliver(t)
	rows := e.rows(t, "plugin")
	if rows[0].Status != "pending" || rows[0].Attempts != 1 || strings.Contains(rows[0].LastError, "tk_secret") {
		t.Fatalf("temporary failure %+v: retried, plugin text never stored", rows[0])
	}
	e.makeDue(t)
	e.deliver(t)
	if rows := e.rows(t, "plugin"); rows[0].Status != "sent" || len(e.channel.Received()) != 2 {
		t.Fatalf("retry %+v", rows[0])
	}

	e.channel.SetOutcome(func(plugin.Notification) error {
		return plugin.PermanentNotificationError(errors.New("topic refused"))
	})
	e.incident(t, "error")
	e.scan(t)
	e.deliver(t)
	if rows := e.rows(t, "plugin"); rows[1].Status != "failed" || rows[1].Attempts != 1 {
		t.Fatalf("permanent failure %+v", rows[1])
	}

	e.channel.SetOutcome(func(plugin.Notification) error { return plugin.ErrChannelUnavailable })
	e.incident(t, "error")
	e.scan(t)
	e.deliver(t)
	if rows := e.rows(t, "plugin"); rows[2].Status != "cancelled" {
		t.Fatalf("unavailable at delivery %+v", rows[2])
	}
}

func TestRemovedChannelDeliveriesEndSafely(t *testing.T) {
	e := newProviderEnv(t)
	e.incident(t, "error")
	e.scan(t)
	// A channel that a definition upgrade removed.
	if _, err := e.h.Pool.Exec(e.h.Ctx, `INSERT INTO notification_deliveries(id,event_key,category,severity,channel,target,subject,status,next_attempt_at)
		VALUES($1,'incident:x:opened','incident','error','plugin','harness_channel:retired','x','pending',now())`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if err := e.h.Remove(); err != nil {
		t.Fatal(err)
	}
	e.deliver(t)
	for _, row := range e.rows(t, "plugin") {
		if row.Status != "cancelled" {
			t.Fatalf("a delivery to a removed channel did not end: %+v", row)
		}
	}
	if len(e.channel.Received()) != 0 {
		t.Fatal("a removed plugin received a notification")
	}
	e.incident(t, "error")
	e.scan(t)
	if len(e.rows(t, "plugin")) != 2 {
		t.Fatal("a removed plugin's channel got a new delivery")
	}
}

func TestExistingNotificationTargetsAreUnchanged(t *testing.T) {
	e := newProviderEnv(t)
	if _, err := e.h.Pool.Exec(e.h.Ctx, `INSERT INTO notification_webhooks(id,organization_id,name,url,signing_secret,enabled) VALUES($1,$2,'Chat','https://hooks.example/x','whsec',TRUE)`, uuid.New(), e.h.OrgID); err != nil {
		t.Fatal(err)
	}
	e.incident(t, "error")
	e.scan(t)
	if len(e.rows(t, "webhook")) != 1 || len(e.rows(t, "plugin")) != 1 || len(e.rows(t, "email")) != 0 {
		t.Fatal("one transition reaches the webhook and the channel; no email without a mail server")
	}
	e.deliver(t)
	if e.notify.Webhooks.Count() != 1 || len(e.channel.Received()) != 1 {
		t.Fatal("both targets delivered")
	}
}

func TestPluginsCannotSendNotifications(t *testing.T) {
	for _, capability := range services.All() {
		if strings.HasPrefix(capability.ID, "notifications") {
			t.Fatalf("service %s lets a plugin create notifications", capability.ID)
		}
	}
	// The hook's argument has no recipient: core chose them.
	encoded, _ := json.Marshal(plugin.Notification{})
	for _, field := range []string{"recipient", "user", "email", "address", "to"} {
		if strings.Contains(strings.ToLower(string(encoded)), `"`+field) {
			t.Fatalf("notification carries %s", field)
		}
	}
}

// Content Health checks.

func (e providerEnv) sweep(t *testing.T) {
	t.Helper()
	e.clock.advance(time.Minute)
	if err := e.h.ContentHealth().Sweep(e.h.Ctx); err != nil {
		t.Fatal(err)
	}
}

func (e providerEnv) openConditions(t *testing.T) map[string]string {
	t.Helper()
	rows, err := e.h.Pool.Query(e.h.Ctx, `SELECT metadata->>'condition', description FROM incidents WHERE failure_code='plugin_check' AND status IN ('open','acknowledged')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var name, reason string
		if err := rows.Scan(&name, &reason); err != nil {
			t.Fatal(err)
		}
		out[name] = reason
	}
	return out
}

func (e providerEnv) coreEvents(t *testing.T, name string) int {
	t.Helper()
	var count int
	if err := e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM plugin_deliveries WHERE plugin_id=$1 AND source=$2`, eventplugins.SubscriberID, name).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func (e providerEnv) installChecker(t *testing.T) {
	t.Helper()
	e.h.InstallPlugin(providerplugins.CheckerID)
	e.h.InstallPlugin(eventplugins.SubscriberID)
}

func TestContentCheckSeesOnlyDeclaredKindsAsAPIModels(t *testing.T) {
	e := newProviderEnv(t)
	e.installChecker(t)
	playlist := e.h.ReadyPlaylist("Lunch menu")
	if _, err := e.h.Pool.Exec(e.h.Ctx, `INSERT INTO layouts(id,organization_id,name,orientation,canvas_width,canvas_height,draft_document,created_by)
		VALUES($1,$2,'Hall','landscape',1920,1080,'{"schemaVersion":1,"canvas":{"width":1920,"height":1080},"placements":[]}',$3)`, uuid.New(), e.h.OrgID, e.h.OwnerID); err != nil {
		t.Fatal(err)
	}
	e.sweep(t)
	kinds := map[string]int{}
	for _, item := range e.checker.Items() {
		kinds[item.Kind]++
		if item.Check != providerplugins.Check || item.ModelVersion != plugin.ContentItemModelVersion {
			t.Fatalf("item %+v", item)
		}
		encoded, _ := json.Marshal(item)
		for _, private := range []string{"createdBy", "creator", "usage", "password", "organization"} {
			if strings.Contains(string(encoded), `"`+private) {
				t.Fatalf("model carries %s: %s", private, encoded)
			}
		}
		if item.Kind == plugin.ContentKindPlaylist && (item.ID != playlist.String() || item.Name != "Lunch menu" || item.Playlist == nil || len(item.Playlist.Items) != 1) {
			t.Fatalf("playlist model %+v", item)
		}
	}
	if kinds[plugin.ContentKindLayout] != 0 || kinds[plugin.ContentKindPlaylist] != 1 || kinds[plugin.ContentKindMediaItem] != 1 {
		t.Fatalf("kinds %v: only declared kinds reach the check", kinds)
	}
}

func TestContentCheckConditionsBecomeCoreIncidents(t *testing.T) {
	e := newProviderEnv(t)
	e.installChecker(t)
	playlist := e.h.ReadyPlaylist("Lunch menu")
	respond := func(conditions ...plugin.Condition) {
		e.checker.SetRespond(func(item plugin.ContentItem) ([]plugin.Condition, error) {
			if item.Kind != plugin.ContentKindPlaylist {
				return nil, nil
			}
			return conditions, nil
		})
	}
	tooShort := plugin.Condition{Name: "too_short", Severity: "warning", Reason: "The playlist plays for less than a minute."}
	lowContrast := plugin.Condition{Name: "low_contrast", Severity: "error", Reason: "Text contrast is below 4.5:1."}
	respond(tooShort, lowContrast)
	e.sweep(t)
	if open := e.openConditions(t); len(open) != 2 || open["too_short"] != tooShort.Reason {
		t.Fatalf("open %v", open)
	}
	if e.coreEvents(t, plugin.CoreIncidentOpened) != 2 {
		t.Fatal("incident.opened@1 not emitted for each condition")
	}
	// Unchanged item: no call.
	e.checker.Reset()
	e.sweep(t)
	for _, item := range e.checker.Items() {
		if item.Kind == plugin.ContentKindPlaylist {
			t.Fatal("an unchanged item was checked again")
		}
	}
	// Changed item, one condition still reported: it stays one incident,
	// and the other recovers.
	rename(t, e, playlist, "Lunch menu (week 2)")
	respond(tooShort)
	e.sweep(t)
	if open := e.openConditions(t); len(open) != 1 || open["too_short"] == "" {
		t.Fatalf("open %v", open)
	}
	var count int
	_ = e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM incidents WHERE failure_code='plugin_check' AND metadata->>'condition'='too_short'`).Scan(&count)
	if count != 1 || e.coreEvents(t, plugin.CoreIncidentRecovered) != 1 {
		t.Fatalf("dedupe %d, recovered events %d", count, e.coreEvents(t, plugin.CoreIncidentRecovered))
	}

	// A failing check changes nothing and is tried again.
	rename(t, e, playlist, "Lunch menu (week 3)")
	e.checker.SetRespond(func(item plugin.ContentItem) ([]plugin.Condition, error) {
		if item.Kind == plugin.ContentKindPlaylist {
			return nil, errors.New("rendering service down")
		}
		return nil, nil
	})
	e.sweep(t)
	if open := e.openConditions(t); len(open) != 1 {
		t.Fatalf("a failing check recovered conditions: %v", open)
	}
	e.checker.Reset()
	e.sweep(t)
	retried := false
	for _, item := range e.checker.Items() {
		retried = retried || item.Kind == plugin.ContentKindPlaylist
	}
	if !retried {
		t.Fatal("a failed check was not tried again on the next sweep")
	}
	status := e.h.StatusOf(providerplugins.CheckerID)
	if check := status.Providers.Checks[0]; check.FailingItems != 1 || check.LastFailure != "check_failed" || check.OpenConditions != 1 {
		t.Fatalf("status %+v", check)
	}

	// Invalid results are failures too.
	for name, result := range map[string][]plugin.Condition{
		"duplicate": {tooShort, tooShort},
		"long":      {{Name: "x", Severity: "warning", Reason: strings.Repeat("a", plugin.MaxConditionReasonBytes+1)}},
		"severity":  {{Name: "x", Severity: "fatal", Reason: "r"}},
		"name":      {{Name: "Bad Name", Severity: "warning", Reason: "r"}},
	} {
		rename(t, e, playlist, "Lunch "+name)
		respond(result...)
		e.sweep(t)
		if open := e.openConditions(t); len(open) != 1 || open["too_short"] == "" {
			t.Fatalf("%s: an invalid result changed conditions: %v", name, open)
		}
	}

	// The resulting incident notifies through the existing policy.
	e.scan(t)
	e.deliver(t)
	found := false
	for _, n := range e.channel.Received() {
		found = found || (n.Category == "content_health" && strings.Contains(n.Subject, "Content lint"))
	}
	if !found {
		t.Fatalf("no content_health notification: %+v", e.channel.Received())
	}

	// Deleting the item recovers its conditions and forgets its state.
	if _, err := e.h.Pool.Exec(e.h.Ctx, `UPDATE playlists SET deleted_at=now() WHERE id=$1`, playlist); err != nil {
		t.Fatal(err)
	}
	e.sweep(t)
	if open := e.openConditions(t); len(open) != 0 {
		t.Fatalf("a deleted item keeps %v", open)
	}
	var states int
	_ = e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM plugin_content_check_state WHERE item_id=$1`, playlist).Scan(&states)
	if states != 0 {
		t.Fatal("a deleted item keeps check state")
	}
}

func rename(t *testing.T, e providerEnv, playlist uuid.UUID, name string) {
	t.Helper()
	if _, err := e.h.Pool.Exec(e.h.Ctx, `UPDATE playlists SET name=$2 WHERE id=$1`, playlist, name); err != nil {
		t.Fatal(err)
	}
}

func TestRemovingACheckerRecoversItsConditions(t *testing.T) {
	e := newProviderEnv(t)
	e.installChecker(t)
	e.h.ReadyPlaylist("Lunch menu")
	e.checker.SetRespond(func(item plugin.ContentItem) ([]plugin.Condition, error) {
		if item.Kind != plugin.ContentKindPlaylist {
			return nil, nil
		}
		return []plugin.Condition{{Name: "flagged", Severity: "warning", Reason: "Flagged."}}, nil
	})
	e.sweep(t)
	if len(e.openConditions(t)) != 1 {
		t.Fatal("no condition")
	}
	if err := e.h.RemovePlugin(providerplugins.CheckerID); err != nil {
		t.Fatal(err)
	}
	if len(e.openConditions(t)) != 0 {
		t.Fatal("a removed checker's condition stayed open")
	}
	var states int
	_ = e.h.Pool.QueryRow(e.h.Ctx, `SELECT count(*) FROM plugin_content_check_state WHERE plugin_id=$1`, providerplugins.CheckerID).Scan(&states)
	if states != 0 || e.coreEvents(t, plugin.CoreIncidentRecovered) != 1 {
		t.Fatalf("state %d, recovered events %d", states, e.coreEvents(t, plugin.CoreIncidentRecovered))
	}
	e.checker.Reset()
	e.sweep(t)
	if len(e.checker.Items()) != 0 {
		t.Fatal("a removed checker ran")
	}
}
