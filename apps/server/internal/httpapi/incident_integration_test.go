package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func activityEvent(sequence int64, eventType string, at time.Time) playerActivityEventInput {
	return playerActivityEventInput{
		ID: uuid.New(), Sequence: sequence, EventType: eventType,
		OccurredAt: at, PlayerTimezone: "UTC",
	}
}

func readIncidents(t *testing.T, env activityTestEnvironment, query string) []incidentRecord {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/incidents"+query, nil)
	request = requestWithTestPrincipal(request, env.owner)
	response := httptest.NewRecorder()
	env.server.listIncidents(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list incidents status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data struct {
			Items []incidentRecord `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data.Items
}

func actOnIncident(t *testing.T, env activityTestEnvironment, id uuid.UUID, input incidentActionInput) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(input)
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/activity/incidents/"+id.String(), bytes.NewReader(body))
	request = requestWithTestPrincipal(request, env.owner)
	response := httptest.NewRecorder()
	env.server.updateIncident(response, request)
	return response
}

// The behaviour the previous model got wrong: a screen that flaps repeatedly is
// one problem, not one problem per event.
func TestRepeatedFailuresBecomeOneIncident(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-time.Hour)
		events := []playerActivityEventInput{}
		for index := 0; index < 5; index++ {
			events = append(events, activityEvent(int64(index+1), "renderer.failure", start.Add(time.Duration(index)*time.Minute)))
		}
		postActivityBatch(t, env, playerActivityBatchInput{Events: events}, http.StatusAccepted)

		incidents := readIncidents(t, env, "")
		playback := filterIncidents(incidents, incidentPlayback)
		if len(playback) != 1 {
			t.Fatalf("five renderer failures produced %d playback incidents, want 1", len(playback))
		}
		if playback[0].OccurrenceCount != 5 {
			t.Fatalf("occurrence count = %d, want 5", playback[0].OccurrenceCount)
		}
		if !playback[0].LastSeenAt.After(playback[0].OpenedAt) {
			t.Fatal("a repeat must move last seen forward without reopening the incident")
		}
	})
}

func TestIncidentRecoversAutomaticallyAndReopensIfTheConditionReturns(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-time.Hour)
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			activityEvent(1, "safe_mode.entered", start),
			activityEvent(2, "safe_mode.exited", start.Add(10*time.Minute)),
		}}, http.StatusAccepted)

		recovered := filterIncidents(readIncidents(t, env, "?status=all"), incidentSafeMode)
		if len(recovered) != 1 || recovered[0].Status != "recovered" {
			t.Fatalf("safe mode incident = %+v, want one recovered", recovered)
		}
		if recovered[0].RecoveryMode != "automatic" {
			t.Fatalf("recovery mode = %q, want automatic", recovered[0].RecoveryMode)
		}
		// Recovered is not resolved: the record keeps the condition having ended
		// by itself distinct from a person having closed the matter, because the
		// recovery figures are counted from that difference.
		if recovered[0].ResolvedAt != nil {
			t.Fatal("an automatic recovery must not resolve the incident on the operator's behalf")
		}
		// It is logged, not queued: an incident that ended on its own asks
		// nothing of an operator and so leaves the active list.
		if active := filterIncidents(readIncidents(t, env, ""), incidentSafeMode); len(active) != 0 {
			t.Fatalf("recovered incident still active: %+v", active)
		}
		if got := actOnIncident(t, env, recovered[0].ID, incidentActionInput{Action: "acknowledge"}); got.Code != http.StatusConflict {
			t.Fatalf("acknowledging a recovered incident status=%d, want 409", got.Code)
		}

		// The condition returns. That is a second outage, not a continuation of
		// the first, or time-to-recover would measure one impossible outage.
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			activityEvent(3, "safe_mode.entered", start.Add(20*time.Minute)),
		}}, http.StatusAccepted)
		after := filterIncidents(readIncidents(t, env, "?status=all"), incidentSafeMode)
		if len(after) != 2 {
			t.Fatalf("a returning condition produced %d incidents, want 2", len(after))
		}
		// Only the returned condition is a live problem; the first outage stays
		// in the record as the closed thing it is.
		if active := filterIncidents(readIncidents(t, env, ""), incidentSafeMode); len(active) != 1 || active[0].Status != "open" {
			t.Fatalf("active safe mode incidents = %+v, want only the new one", active)
		}
	})
}

func TestHealthyHeartbeatRecoversStalePlaybackIncident(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-time.Hour)
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			activityEvent(1, "renderer.failure", start),
		}}, http.StatusAccepted)

		active := filterIncidents(readIncidents(t, env, ""), incidentPlayback)
		if len(active) != 1 || active[0].Status != "open" {
			t.Fatalf("renderer failure produced %+v, want one open playback incident", active)
		}

		// Some player versions recover in their status heartbeat without emitting
		// renderer.recovered/presentation.recovered. Current healthy status is the
		// authoritative evidence that the old failure is no longer happening.
		if _, err := env.pool.Exec(context.Background(), `
			INSERT INTO screen_player_status(screen_id,playback_state,last_playback_error,safe_mode,foreground_state)
			VALUES($1,'playing','',FALSE,'foreground')
			ON CONFLICT(screen_id) DO UPDATE SET
				playback_state='playing',last_playback_error='',safe_mode=FALSE,foreground_state='foreground'`,
			env.screenID); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/player/heartbeat", nil)
		env.server.recordHeartbeatActivity(request, env.screenID, heartbeatActivitySnapshot{
			state: heartbeatActivityState{PlaybackState: "playing", PlaybackError: "renderer failed"},
		}, time.Now().UTC())

		recovered := filterIncidents(readIncidents(t, env, "?status=all"), incidentPlayback)
		if len(recovered) != 1 || recovered[0].Status != "recovered" || recovered[0].RecoveryMode != "automatic" {
			t.Fatalf("healthy heartbeat left playback incident %+v, want one automatic recovery", recovered)
		}
		if active := filterIncidents(readIncidents(t, env, ""), incidentPlayback); len(active) != 0 {
			t.Fatalf("recovered playback incident still active: %+v", active)
		}

		var recoveryEvents int64
		if err := env.pool.QueryRow(context.Background(), `
			SELECT count(*) FROM player_activity_events
			WHERE screen_id=$1 AND event_type='renderer.recovered'`, env.screenID).Scan(&recoveryEvents); err != nil {
			t.Fatal(err)
		}
		if recoveryEvents != 1 {
			t.Fatalf("renderer recovery events = %d, want 1", recoveryEvents)
		}

		// Healthy heartbeats after recovery must stay quiet rather than adding a
		// synthetic recovery event on every status report.
		env.server.recordHeartbeatActivity(request, env.screenID, heartbeatActivitySnapshot{
			state: heartbeatActivityState{PlaybackState: "playing"},
		}, time.Now().UTC().Add(time.Second))
		if err := env.pool.QueryRow(context.Background(), `
			SELECT count(*) FROM player_activity_events
			WHERE screen_id=$1 AND event_type='renderer.recovered'`, env.screenID).Scan(&recoveryEvents); err != nil {
			t.Fatal(err)
		}
		if recoveryEvents != 1 {
			t.Fatalf("healthy follow-up heartbeat produced %d recovery events, want 1 total", recoveryEvents)
		}
	})
}

func TestIncidentActionsFollowTheLifecycle(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-time.Hour)
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			activityEvent(1, "storage.pressure", start),
		}}, http.StatusAccepted)
		incident := filterIncidents(readIncidents(t, env, ""), incidentStorage)[0]

		if got := actOnIncident(t, env, incident.ID, incidentActionInput{Action: "acknowledge"}); got.Code != http.StatusOK {
			t.Fatalf("acknowledge status=%d body=%s", got.Code, got.Body.String())
		}
		acknowledged := filterIncidents(readIncidents(t, env, ""), incidentStorage)[0]
		if acknowledged.Status != "acknowledged" || acknowledged.AcknowledgedBy != "Activity Owner" {
			t.Fatalf("after acknowledging: %+v", acknowledged)
		}

		if got := actOnIncident(t, env, incident.ID, incidentActionInput{
			Action: "resolve", Reason: "Cache limit raised", Notes: "Increased the cache to 32 GB.",
		}); got.Code != http.StatusOK {
			t.Fatalf("resolve status=%d body=%s", got.Code, got.Body.String())
		}
		resolved := filterIncidents(readIncidents(t, env, "?status=resolved"), incidentStorage)[0]
		if resolved.Status != "resolved" || resolved.ResolvedAt == nil {
			t.Fatalf("after resolving: %+v", resolved)
		}
		// A person closed this one, which must stay distinguishable from the
		// condition having ended by itself.
		if resolved.RecoveryMode != "manual" {
			t.Fatalf("recovery mode = %q, want manual", resolved.RecoveryMode)
		}
		if resolved.ResolutionNotes != "Increased the cache to 32 GB." {
			t.Fatalf("resolution notes = %q", resolved.ResolutionNotes)
		}

		// Resolving twice is not applicable, and says so rather than silently
		// succeeding.
		if got := actOnIncident(t, env, incident.ID, incidentActionInput{Action: "resolve"}); got.Code != http.StatusConflict {
			t.Fatalf("second resolve status=%d, want 409", got.Code)
		}

		if got := actOnIncident(t, env, incident.ID, incidentActionInput{Action: "reopen"}); got.Code != http.StatusOK {
			t.Fatalf("reopen status=%d body=%s", got.Code, got.Body.String())
		}
		reopened := filterIncidents(readIncidents(t, env, ""), incidentStorage)[0]
		if reopened.Status != "open" || reopened.ResolvedAt != nil || reopened.RecoveryMode != "" {
			t.Fatalf("a reopened incident must clear its closure: %+v", reopened)
		}

		// Every applied action is auditable administrator history — and only the
		// applied ones: the rejected second resolve changed nothing, so auditing
		// it would record a change that never happened.
		var audited int64
		if err := env.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM audit_logs WHERE resource_type='incident' AND resource_id=$1`,
			incident.ID.String()).Scan(&audited); err != nil {
			t.Fatal(err)
		}
		if audited != 3 {
			t.Fatalf("audit rows = %d, want one each for acknowledge, resolve and reopen", audited)
		}
	})
}

func TestIncidentIgnoreAndAssign(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			activityEvent(1, "decoder.failure", time.Now().UTC().Add(-time.Hour)),
		}}, http.StatusAccepted)
		incident := filterIncidents(readIncidents(t, env, ""), incidentPlayback)[0]

		if got := actOnIncident(t, env, incident.ID, incidentActionInput{
			Action: "assign", AssignedTo: env.owner.User.ID.String(),
		}); got.Code != http.StatusOK {
			t.Fatalf("assign status=%d body=%s", got.Code, got.Body.String())
		}
		if got := actOnIncident(t, env, incident.ID, incidentActionInput{Action: "assign"}); got.Code != http.StatusUnprocessableEntity {
			t.Fatalf("assign without a user status=%d, want 422", got.Code)
		}
		assigned := filterIncidents(readIncidents(t, env, ""), incidentPlayback)[0]
		if assigned.AssignedToName != "Activity Owner" {
			t.Fatalf("assigned to %q", assigned.AssignedToName)
		}

		if got := actOnIncident(t, env, incident.ID, incidentActionInput{
			Action: "ignore", Reason: "Known hardware fault, screen is being replaced",
		}); got.Code != http.StatusOK {
			t.Fatalf("ignore status=%d body=%s", got.Code, got.Body.String())
		}
		// An ignored incident leaves the active list rather than being deleted.
		if remaining := filterIncidents(readIncidents(t, env, ""), incidentPlayback); len(remaining) != 0 {
			t.Fatalf("ignored incident still active: %+v", remaining)
		}
		if all := filterIncidents(readIncidents(t, env, "?status=all"), incidentPlayback); len(all) != 1 {
			t.Fatalf("ignored incident was lost: %+v", all)
		}
	})
}

// A screen that stops reporting sends nothing, so an event-only model would
// never show the outage operators most need to see.
func TestOfflineScreensOpenAndRecoverConnectivityIncidents(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET last_heartbeat_at=now()-$2::interval-interval '5 minutes' WHERE id=$1`,
			env.screenID, fleetHeartbeatGrace); err != nil {
			t.Fatal(err)
		}

		incidents := filterIncidents(readIncidents(t, env, ""), incidentConnectivity)
		if len(incidents) != 1 || incidents[0].Status != "open" {
			t.Fatalf("offline screen produced %+v, want one open connectivity incident", incidents)
		}
		// Opened when reporting stopped, not when the sweep noticed, so
		// time-to-recover measures the outage rather than the poll interval.
		if time.Since(incidents[0].OpenedAt) < 4*time.Minute {
			t.Fatalf("incident opened at %v, want the moment the grace period lapsed", incidents[0].OpenedAt)
		}

		// The sweep is idempotent: reading twice must not open a second one.
		if again := filterIncidents(readIncidents(t, env, ""), incidentConnectivity); len(again) != 1 {
			t.Fatalf("repeated sweeps produced %d incidents, want 1", len(again))
		}

		if _, err := env.pool.Exec(ctx, `UPDATE screens SET last_heartbeat_at=now() WHERE id=$1`, env.screenID); err != nil {
			t.Fatal(err)
		}
		recovered := filterIncidents(readIncidents(t, env, "?status=all"), incidentConnectivity)
		if len(recovered) != 1 || recovered[0].Status != "recovered" || recovered[0].RecoveryMode != "automatic" {
			t.Fatalf("reporting screen left %+v, want an automatic recovery", recovered)
		}
		// The screen is back, so the outage is history rather than something
		// still needing attention.
		if active := filterIncidents(readIncidents(t, env, ""), incidentConnectivity); len(active) != 0 {
			t.Fatalf("recovered connectivity incident still active: %+v", active)
		}
	})
}

func TestIncidentAnalyticsSeparatesAutomaticAndManualRecovery(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		opened := time.Now().UTC().Add(-2 * time.Hour)
		insert := func(key string, recoveredAfter time.Duration, mode string, resolved bool) {
			t.Helper()
			recovered := opened.Add(recoveredAfter)
			var resolvedAt *time.Time
			if resolved {
				resolvedAt = &recovered
			}
			if _, err := env.pool.Exec(ctx, `
				INSERT INTO incidents(id,incident_type,severity,status,title,opened_at,last_seen_at,recovered_at,resolved_at,recovery_mode,primary_screen_id,dedupe_key)
				VALUES($1,'playback','error',$2,'Playback is failing',$3,$4,$5,$6,$7,$8,$9)`,
				uuid.New(), map[bool]string{true: "resolved", false: "recovered"}[resolved],
				opened, recovered, recovered, resolvedAt, mode, env.screenID, key); err != nil {
				t.Fatal(err)
			}
		}
		insert("a", 10*time.Minute, "automatic", false)
		insert("b", 20*time.Minute, "automatic", false)
		insert("c", 60*time.Minute, "manual", true)

		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/incidents/analytics?range=7d", nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.incidentAnalytics(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("analytics status=%d body=%s", response.Code, response.Body.String())
		}
		var envelope struct {
			Data incidentAnalytics `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		data := envelope.Data
		if data.AutomaticRecoveries != 2 || data.ManualRecoveries != 1 {
			t.Fatalf("recoveries: automatic=%d manual=%d", data.AutomaticRecoveries, data.ManualRecoveries)
		}
		if data.MeanTimeToRecoverSeconds == nil || data.MedianTimeToRecoverSeconds == nil {
			t.Fatal("time to recover must be reported when incidents recovered")
		}
		// Mean 30 minutes, median 20: the pair is the point, because one long
		// outage drags the mean away from the typical case.
		if *data.MeanTimeToRecoverSeconds != 1800 {
			t.Fatalf("mean time to recover = %v seconds, want 1800", *data.MeanTimeToRecoverSeconds)
		}
		if *data.MedianTimeToRecoverSeconds != 1200 {
			t.Fatalf("median time to recover = %v seconds, want 1200", *data.MedianTimeToRecoverSeconds)
		}
		if data.LongestIncidentSeconds == nil || *data.LongestIncidentSeconds != 3600 {
			t.Fatalf("longest incident = %v", data.LongestIncidentSeconds)
		}
		if len(data.ByScreen) == 0 || data.ByScreen[0].Label != "Cafeteria TV" {
			t.Fatalf("by-screen breakdown = %+v", data.ByScreen)
		}
	})
}

// An empty range must not report zero seconds to recover, which would read as
// instant recovery rather than as no data.
func TestIncidentAnalyticsReportsNoDataRatherThanZero(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/incidents/analytics?range=24h", nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.incidentAnalytics(response, request)
		var envelope struct {
			Data incidentAnalytics `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.MeanTimeToRecoverSeconds != nil || envelope.Data.MedianTimeToRecoverSeconds != nil {
			t.Fatalf("empty range reported a recovery time: %+v", envelope.Data)
		}
	})
}

// A connectivity incident says reporting stopped. It does not know why, and
// must not present a guess as an established cause.
func TestIncidentsDoNotInventAProbableCause(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			activityEvent(1, "heartbeat.gap_detected", time.Now().UTC().Add(-time.Hour)),
		}}, http.StatusAccepted)
		incident := filterIncidents(readIncidents(t, env, ""), incidentConnectivity)[0]
		if incident.ProbableCause != "" {
			t.Fatalf("probable cause = %q, want none for a heartbeat gap", incident.ProbableCause)
		}

		// Where the player did establish the cause, it is stated.
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			activityEvent(2, "renderer.failure", time.Now().UTC().Add(-30*time.Minute)),
		}}, http.StatusAccepted)
		playback := filterIncidents(readIncidents(t, env, ""), incidentPlayback)[0]
		if playback.ProbableCause == "" {
			t.Fatal("a reported renderer failure is evidence of a cause and should be stated")
		}
	})
}

func filterIncidents(items []incidentRecord, incidentType string) []incidentRecord {
	matched := []incidentRecord{}
	for _, item := range items {
		if item.IncidentType == incidentType {
			matched = append(matched, item)
		}
	}
	return matched
}
