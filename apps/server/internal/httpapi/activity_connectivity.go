package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

type heartbeatActivityState struct {
	ManifestVersion    *int64
	ScheduleID         *uuid.UUID
	SelectionSource    string
	CommandID          *uuid.UUID
	CommandState       string
	TakeoverID         *uuid.UUID
	TakeoverState      string
	UpdateDeploymentID *uuid.UUID
	UpdateState        string
	SafeMode           bool
	WatchdogFailure    string
	WatchdogRecoveryAt *time.Time
	ForegroundState    string
	SleepResult        string
	WakeResult         string
	PlaybackState      string
	CurrentItemID      *uuid.UUID
	CurrentAssetID     *uuid.UUID
	PlaybackError      string
	CacheUsedBytes     *int64
	CacheLimitBytes    *int64
}

type heartbeatActivitySnapshot struct {
	previousHeartbeat *time.Time
	state             heartbeatActivityState
}

func (s *server) playerHeartbeatWithActivity(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	snapshot := s.captureHeartbeatActivity(r.Context(), principal.ScreenID)

	wrapped := &auditStatusWriter{ResponseWriter: w}
	s.playerHeartbeat(wrapped, r)
	status := wrapped.status
	if status == 0 {
		status = http.StatusOK
	}
	if status >= 300 {
		return
	}
	s.recordHeartbeatActivity(r, principal.ScreenID, snapshot, time.Now().UTC())
}

func (s *server) playerLivenessWithActivity(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	snapshot := s.captureHeartbeatActivity(r.Context(), principal.ScreenID)
	wrapped := &auditStatusWriter{ResponseWriter: w}
	s.playerLiveness(wrapped, r)
	status := wrapped.status
	if status == 0 {
		status = http.StatusOK
	}
	if status < 300 {
		s.recordHeartbeatActivity(r, principal.ScreenID, snapshot, time.Now().UTC())
	}
}

func (s *server) captureHeartbeatActivity(ctx context.Context, screenID uuid.UUID) heartbeatActivitySnapshot {
	var snapshot heartbeatActivitySnapshot
	_ = s.db.QueryRow(ctx, `SELECT last_heartbeat_at FROM screens WHERE id=$1`, screenID).Scan(&snapshot.previousHeartbeat)
	snapshot.state, _ = s.readHeartbeatActivityState(ctx, screenID)
	return snapshot
}

func (s *server) recordHeartbeatActivity(r *http.Request, screenID uuid.UUID, snapshot heartbeatActivitySnapshot, now time.Time) {
	ctx := activityContextWithoutCancel(r.Context())
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := lockActivityScreen(ctx, tx, screenID); err != nil {
		s.logger.Error("activity screen lock failed", "screen_id", screenID, "error", err)
		return
	}
	// Read the post-heartbeat status only after taking the per-screen lock. A
	// HTTP heartbeat and a WebSocket status can update the same row concurrently;
	// reading it before the lock lets the second request derive the first
	// request's transition a second time.
	after, _ := readHeartbeatActivityStateTx(ctx, tx, screenID)

	if snapshot.previousHeartbeat == nil {
		var openUpInterval bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screen_state_intervals WHERE screen_id=$1 AND ended_at IS NULL AND state IN('online','healthy'))`, screenID).Scan(&openUpInterval); err == nil && !openUpInterval {
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{
				ID: uuid.New(), EventType: "player.connected", Category: "connectivity", Severity: "info",
				OccurredAt: now, PlayerTimezone: "UTC", Result: "success", Priority: 8,
			})
		}
	} else if gap := now.Sub(snapshot.previousHeartbeat.UTC()); gap > 3*time.Minute {
		gapAt := snapshot.previousHeartbeat.UTC().Add(3 * time.Minute)
		var gapAlreadyRecorded bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM player_activity_events WHERE screen_id=$1 AND event_type='heartbeat.gap_detected' AND occurred_at=$2)`, screenID, gapAt).Scan(&gapAlreadyRecorded); err == nil && !gapAlreadyRecorded {
			// Close at the last confirmed heartbeat first: the gap event below would
			// otherwise close the same sessions at the end of the grace period.
			_, _ = tx.Exec(ctx, `UPDATE playback_sessions SET ended_at=$2,result='unknown',actual_duration_ms=GREATEST(0,EXTRACT(EPOCH FROM ($2-started_at))*1000)::bigint,metadata=metadata||'{"closedReason":"heartbeat_gap"}'::jsonb,updated_at=now() WHERE screen_id=$1 AND ended_at IS NULL AND started_at<$3`, screenID, snapshot.previousHeartbeat.UTC(), now)
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{
				ID: uuid.New(), EventType: "heartbeat.gap_detected", Category: "connectivity", Severity: "warning",
				OccurredAt: gapAt, PlayerTimezone: "UTC", Result: "unknown",
				DurationMS: durationPointer(gap.Milliseconds()), FailureCode: "heartbeat_gap",
				FailureMessage: "Player stopped reporting within the expected heartbeat window.", Priority: 9,
				Metadata: map[string]any{"lastHeartbeatAt": snapshot.previousHeartbeat.UTC(), "restoredAt": now},
			})
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{
				ID: uuid.New(), EventType: "connection.restored", Category: "connectivity", Severity: "info",
				OccurredAt: now, PlayerTimezone: "UTC", Result: "recovered", DurationMS: durationPointer(gap.Milliseconds()), Priority: 8,
			})
		}
	}

	s.recordHeartbeatStateTransitions(r, tx, screenID, snapshot.state, after, now)
	// Incidents are action queues, not a historical echo of the last bad event.
	// A player that currently reports healthy playback is authoritative evidence
	// that any still-open playback incident has ended, even if the player did not
	// emit one of the older explicit renderer/presentation recovery events.
	s.reconcilePlaybackIncidentFromHeartbeat(r, tx, screenID, after, now)
	s.anchorHeartbeatStateInterval(r, tx, screenID, after, now)
	// The expectation is materialized at the moment the selection becomes
	// effective, so compliance is always measured against the plan that was in
	// force at the time rather than whatever is configured today.
	if err := s.syncExpectedWindowFromStatus(r, tx, screenID, after, now); err != nil {
		s.logger.Error("activity expectation sync failed", "screen_id", screenID, "error", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("activity heartbeat transition commit failed", "screen_id", screenID, "error", err)
	}
}

// Every path that derives a state interval for one screen takes the same
// transaction-scoped advisory lock. A heartbeat and a WebSocket status/event
// can arrive at the same instant; serializing the derivation prevents both
// requests from observing an empty open interval and creating duplicates.
func lockActivityScreen(ctx context.Context, tx pgx.Tx, screenID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('tilecast.activity.screen.' || $1::text, 0))`, screenID)
	return err
}

// anchorHeartbeatStateInterval keeps the screen state timeline usable for every
// player, whatever activity events it reports. Players do not share one event
// vocabulary: the Linux player reports content and connection events, while the
// interval derivation recognises the Android player's presentation events. The
// heartbeat is the one signal every player sends, so each authenticated contact
// opens an up-state interval when none is open. Valid status metadata replaces a
// stale impaired interval once it shows the player is playing again.
// Without this a player that never emits a recognised event is never measured,
// and one renderer failure would leave a screen impaired forever.
func (s *server) anchorHeartbeatStateInterval(r *http.Request, tx pgx.Tx, screenID uuid.UUID, status heartbeatActivityState, now time.Time) {
	ctx := activityContextWithoutCancel(r.Context())
	state := "online"
	if heartbeatConfirmsHealthy(status) {
		state = "healthy"
	}
	var open string
	switch err := tx.QueryRow(ctx, `SELECT state FROM screen_state_intervals WHERE screen_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`, screenID).Scan(&open); {
	case err == nil:
		// An up interval already covers this heartbeat, and an interval we
		// cannot contradict is left for the event derivation to close.
		if open == "online" || open == "healthy" || state != "healthy" {
			return
		}
		if _, err := tx.Exec(ctx, `UPDATE screen_state_intervals SET ended_at=$2 WHERE screen_id=$1 AND ended_at IS NULL`, screenID, now); err != nil {
			return
		}
	case errors.Is(err, pgx.ErrNoRows):
	default:
		return
	}
	_, _ = tx.Exec(ctx, `
		INSERT INTO screen_state_intervals(id,screen_id,state,started_at,metadata)
		SELECT $1,$2,$3,$4,'{"source":"heartbeat"}'::jsonb
		WHERE NOT EXISTS(SELECT 1 FROM screen_state_intervals WHERE screen_id=$2 AND ended_at IS NULL)
		ON CONFLICT DO NOTHING`, uuid.New(), screenID, state, now)
}

// heartbeatConfirmsHealthy reports whether the heartbeat itself is evidence the
// player is playing correctly, using only the fields the status authority keeps.
func heartbeatConfirmsHealthy(status heartbeatActivityState) bool {
	if status.PlaybackState != "playing" || status.PlaybackError != "" || status.SafeMode {
		return false
	}
	if status.ForegroundState != "" && status.ForegroundState != "foreground" {
		return false
	}
	return !storagePressure(status)
}

// reconcilePlaybackIncidentFromHeartbeat closes a stale playback incident when
// the current player-status authority says playback is healthy. Incident
// derivation normally closes playback problems from explicit recovery events,
// but not every player/version emits those events. Without this reconciliation,
// a renderer/decoder failure can remain in Needs attention indefinitely after
// playback has resumed.
//
// We emit the same recovery event the incident model already understands so the
// automatic recovery is preserved in Activity history and recovery analytics.
// The active-incident existence check keeps healthy heartbeats from producing a
// synthetic recovery event on every status report.
func (s *server) reconcilePlaybackIncidentFromHeartbeat(r *http.Request, tx pgx.Tx, screenID uuid.UUID, status heartbeatActivityState, now time.Time) {
	if !heartbeatConfirmsHealthy(status) {
		return
	}
	ctx := activityContextWithoutCancel(r.Context())
	key := incidentDedupeKey(screenID, incidentPlayback)
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM incidents WHERE dedupe_key=$1 AND status IN('open','acknowledged')
	)`, key).Scan(&active); err != nil {
		s.logger.Error("playback incident reconciliation failed", "screen_id", screenID, "error", err)
		return
	}
	if !active {
		return
	}
	s.recordServerTransition(r, tx, screenID, playerActivityEventInput{
		ID: uuid.New(), EventType: "renderer.recovered", Category: "reliability", Severity: "info",
		OccurredAt: now, Result: "recovered", Priority: 8,
	})
}

func (s *server) readHeartbeatActivityState(ctx context.Context, screenID uuid.UUID) (heartbeatActivityState, error) {
	var value heartbeatActivityState
	err := s.db.QueryRow(ctx, `
		SELECT active_manifest_version,current_schedule_id,COALESCE(selection_source,''),
		       last_command_id,COALESCE(last_command_state,''),active_takeover_id,COALESCE(takeover_state,''),
		       current_update_deployment_id,COALESCE(update_state,''),safe_mode,COALESCE(last_watchdog_failure,''),last_watchdog_recovery_at,
		       COALESCE(foreground_state,''),COALESCE(last_sleep_request_result,''),COALESCE(last_wake_result,''),
		       COALESCE(playback_state,''),current_item_id,current_asset_id,COALESCE(last_playback_error,''),cache_used_bytes,cache_limit_bytes
		FROM screen_player_status WHERE screen_id=$1`, screenID).Scan(
		&value.ManifestVersion, &value.ScheduleID, &value.SelectionSource,
		&value.CommandID, &value.CommandState, &value.TakeoverID, &value.TakeoverState,
		&value.UpdateDeploymentID, &value.UpdateState, &value.SafeMode, &value.WatchdogFailure, &value.WatchdogRecoveryAt,
		&value.ForegroundState, &value.SleepResult, &value.WakeResult,
		&value.PlaybackState, &value.CurrentItemID, &value.CurrentAssetID, &value.PlaybackError, &value.CacheUsedBytes, &value.CacheLimitBytes,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return heartbeatActivityState{}, nil
	}
	return value, err
}

func readHeartbeatActivityStateTx(ctx context.Context, tx pgx.Tx, screenID uuid.UUID) (heartbeatActivityState, error) {
	var value heartbeatActivityState
	err := tx.QueryRow(ctx, `
		SELECT active_manifest_version,current_schedule_id,COALESCE(selection_source,''),
		       last_command_id,COALESCE(last_command_state,''),active_takeover_id,COALESCE(takeover_state,''),
		       current_update_deployment_id,COALESCE(update_state,''),safe_mode,COALESCE(last_watchdog_failure,''),last_watchdog_recovery_at,
		       COALESCE(foreground_state,''),COALESCE(last_sleep_request_result,''),COALESCE(last_wake_result,''),
		       COALESCE(playback_state,''),current_item_id,current_asset_id,COALESCE(last_playback_error,''),cache_used_bytes,cache_limit_bytes
		FROM screen_player_status WHERE screen_id=$1`, screenID).Scan(
		&value.ManifestVersion, &value.ScheduleID, &value.SelectionSource,
		&value.CommandID, &value.CommandState, &value.TakeoverID, &value.TakeoverState,
		&value.UpdateDeploymentID, &value.UpdateState, &value.SafeMode, &value.WatchdogFailure, &value.WatchdogRecoveryAt,
		&value.ForegroundState, &value.SleepResult, &value.WakeResult,
		&value.PlaybackState, &value.CurrentItemID, &value.CurrentAssetID, &value.PlaybackError, &value.CacheUsedBytes, &value.CacheLimitBytes,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return heartbeatActivityState{}, nil
	}
	return value, err
}

func (s *server) recordHeartbeatStateTransitions(r *http.Request, tx pgx.Tx, screenID uuid.UUID, before, after heartbeatActivityState, now time.Time) {
	if !sameInt64(before.ManifestVersion, after.ManifestVersion) && after.ManifestVersion != nil {
		s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "manifest.activated", Category: "manifest", Severity: "info", OccurredAt: now, ManifestVersion: after.ManifestVersion, Result: "success", Priority: 8})
	}
	if !sameUUID(before.ScheduleID, after.ScheduleID) {
		if before.ScheduleID != nil {
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "schedule.ended", Category: "scheduling", Severity: "info", OccurredAt: now, Result: "success", ScheduleID: before.ScheduleID.String(), Priority: 7})
		}
		if after.ScheduleID != nil {
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "schedule.became_active", Category: "scheduling", Severity: "info", OccurredAt: now, Result: "success", ScheduleID: after.ScheduleID.String(), TriggerContext: "schedule", Priority: 8})
		} else if before.ScheduleID != nil && after.SelectionSource != "takeover" {
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "direct_assignment.resumed", Category: "scheduling", Severity: "info", OccurredAt: now, Result: "recovered", TriggerContext: after.SelectionSource, Priority: 7})
		}
	}
	if !sameUUID(before.CommandID, after.CommandID) || before.CommandState != after.CommandState {
		if after.CommandID != nil && after.CommandState != "" {
			eventType, severity, result := commandStateActivity(after.CommandState)
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: eventType, Category: "commands", Severity: severity, OccurredAt: now, Result: result, ContentType: "command", ContentID: after.CommandID.String(), Priority: activityPriority(severity)})
		}
	}
	if !sameUUID(before.TakeoverID, after.TakeoverID) || before.TakeoverState != after.TakeoverState {
		if after.TakeoverID != nil {
			eventType, severity, result := takeoverStateActivity(after.TakeoverState)
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: eventType, Category: "takeovers", Severity: severity, OccurredAt: now, Result: result, TakeoverID: after.TakeoverID.String(), ContentType: "takeover", ContentID: after.TakeoverID.String(), Priority: activityPriority(severity)})
		} else if before.TakeoverID != nil {
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "takeover.restored", Category: "takeovers", Severity: "info", OccurredAt: now, Result: "recovered", TakeoverID: before.TakeoverID.String(), Priority: 9})
		}
	}
	if !sameUUID(before.UpdateDeploymentID, after.UpdateDeploymentID) || before.UpdateState != after.UpdateState {
		if after.UpdateDeploymentID != nil && after.UpdateState != "" {
			eventType, severity, result := updateStateActivity(after.UpdateState)
			s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: eventType, Category: "updates", Severity: severity, OccurredAt: now, Result: result, ContentType: "update_deployment", ContentID: after.UpdateDeploymentID.String(), Priority: activityPriority(severity)})
		}
	}
	if before.SafeMode != after.SafeMode {
		eventType, result, severity := "safe_mode.exited", "recovered", "info"
		if after.SafeMode {
			eventType, result, severity = "safe_mode.entered", "failed", "error"
		}
		s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: eventType, Category: "reliability", Severity: severity, OccurredAt: now, Result: result, Priority: 9})
	}
	// `recovering` is a Player restoring itself after the platform discarded
	// it. It is on its way back to the foreground, so it is not a loss.
	if before.ForegroundState != after.ForegroundState && after.ForegroundState != "" && after.ForegroundState != "foreground" && after.ForegroundState != "recovering" {
		s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "foreground_playback.lost", Category: "reliability", Severity: "warning", OccurredAt: now, Result: "failed", FailureCode: after.ForegroundState, Priority: 8})
	}
	if before.WatchdogRecoveryAt == nil && after.WatchdogRecoveryAt != nil || before.WatchdogRecoveryAt != nil && after.WatchdogRecoveryAt != nil && !before.WatchdogRecoveryAt.Equal(*after.WatchdogRecoveryAt) {
		s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "watchdog.recovery", Category: "reliability", Severity: "warning", OccurredAt: after.WatchdogRecoveryAt.UTC(), Result: "recovered", FailureCode: after.WatchdogFailure, Priority: 9})
	}
	if before.SleepResult != after.SleepResult && after.SleepResult != "" {
		s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "sleep.request", Category: "reliability", Severity: "info", OccurredAt: now, Result: resultFromText(after.SleepResult), Metadata: map[string]any{"result": after.SleepResult}, Priority: 6})
	}
	if before.WakeResult != after.WakeResult && after.WakeResult != "" {
		s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "wake.request", Category: "reliability", Severity: "info", OccurredAt: now, Result: resultFromText(after.WakeResult), Metadata: map[string]any{"result": after.WakeResult}, Priority: 6})
	}
	if before.PlaybackError != after.PlaybackError && after.PlaybackError != "" {
		s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "renderer.failure", Category: "reliability", Severity: "error", OccurredAt: now, Result: "failed", FailureCode: "playback_error", FailureMessage: safeActivityText(after.PlaybackError, 240), Priority: 9})
	}
	if storagePressure(after) && !storagePressure(before) {
		s.recordServerTransition(r, tx, screenID, playerActivityEventInput{ID: uuid.New(), EventType: "storage.pressure", Category: "reliability", Severity: "warning", OccurredAt: now, Result: "failed", FailureCode: "cache_pressure", Metadata: map[string]any{"usedBytes": after.CacheUsedBytes, "limitBytes": after.CacheLimitBytes}, Priority: 8})
	}
}

func (s *server) recordServerTransition(r *http.Request, tx pgx.Tx, screenID uuid.UUID, event playerActivityEventInput) {
	if event.PlayerTimezone == "" {
		event.PlayerTimezone = "UTC"
	}
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	}
	if s.insertServerActivity(activityContextWithoutCancel(r.Context()), tx, screenID, event) == nil {
		_ = s.derivePlayerActivity(r, tx, screenID, event)
	}
}

func (s *server) insertServerActivity(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, event playerActivityEventInput) error {
	metadata, _ := json.Marshal(sanitizeActivityMap(event.Metadata, true))
	_, err := tx.Exec(ctx, `
		INSERT INTO player_activity_events(id,screen_id,sequence,origin,event_type,category,severity,occurred_at,player_timezone,manifest_version,presentation_type,presentation_id,presentation_revision,content_type,content_id,result,duration_ms,failure_code,failure_message,trigger_context,schedule_id,takeover_id,metadata,priority)
		VALUES($1,$2,NULL,'server',$3,$4,$5,$6,'UTC',$7,NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),NULLIF($11,''),NULLIF($12,''),$13,$14,NULLIF($15,''),NULLIF($16,''),NULLIF($17,''),NULLIF($18,''),NULLIF($19,''),$20::jsonb,$21)
		ON CONFLICT(id) DO NOTHING`, event.ID, screenID, event.EventType, event.Category, event.Severity, event.OccurredAt, event.ManifestVersion, event.PresentationType, event.PresentationID, event.PresentationRev, event.ContentType, event.ContentID, event.Result, event.DurationMS, event.FailureCode, event.FailureMessage, event.TriggerContext, event.ScheduleID, event.TakeoverID, string(metadata), event.Priority)
	return err
}

func commandStateActivity(state string) (string, string, string) {
	switch state {
	case "acknowledged":
		return "command.acknowledged", "info", "success"
	case "running":
		return "command.started", "info", "playing"
	case "succeeded":
		return "command.succeeded", "info", "completed"
	case "failed":
		return "command.failed", "error", "failed"
	case "expired", "cancelled":
		return "command.expired", "warning", "failed"
	default:
		return "command.created", "info", "success"
	}
}

func updateStateActivity(state string) (string, string, string) {
	switch state {
	case "downloading":
		return "update.download_started", "info", "playing"
	case "verifying", "ready":
		return "update.signature_verified", "info", "success"
	case "installing", "reconnecting":
		return "update.installation_started", "info", "playing"
	case "succeeded", "already_current":
		return "update.installation_completed", "info", "completed"
	case "failed", "incompatible":
		return "update.installation_failed", "error", "failed"
	default:
		return "update.assigned", "info", "success"
	}
}

func takeoverStateActivity(state string) (string, string, string) {
	switch state {
	case "notified":
		return "takeover.screen_notified", "warning", "success"
	case "preparing", "ready":
		return "takeover.content_preparing", "warning", "playing"
	case "active":
		return "takeover.active", "critical", "playing"
	case "failed", "offline":
		return "takeover.activation_failed", "critical", "failed"
	case "restored", "cancelled", "expired":
		return "takeover.restored", "info", "recovered"
	default:
		return "takeover.assigned", "warning", "success"
	}
}

func activityPriority(severity string) int16 {
	switch severity {
	case "critical":
		return 9
	case "error":
		return 9
	case "warning":
		return 8
	default:
		return 6
	}
}

func sameUUID(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func sameInt64(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func storagePressure(value heartbeatActivityState) bool {
	return value.CacheUsedBytes != nil && value.CacheLimitBytes != nil && *value.CacheLimitBytes > 0 && *value.CacheUsedBytes*100 >= *value.CacheLimitBytes*90
}

func resultFromText(value string) string {
	for _, failed := range []string{"failed", "unsupported", "denied", "error"} {
		if containsFold(value, failed) {
			return "failed"
		}
	}
	return "success"
}

func containsFold(value, fragment string) bool {
	return len(value) >= len(fragment) && (value == fragment || stringContainsFold(value, fragment))
}

func stringContainsFold(value, fragment string) bool {
	valueRunes := []rune(value)
	fragmentRunes := []rune(fragment)
	for index := 0; index+len(fragmentRunes) <= len(valueRunes); index++ {
		match := true
		for offset := range fragmentRunes {
			left := valueRunes[index+offset]
			right := fragmentRunes[offset]
			if left >= 'A' && left <= 'Z' {
				left += 'a' - 'A'
			}
			if right >= 'A' && right <= 'Z' {
				right += 'a' - 'A'
			}
			if left != right {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func durationPointer(value int64) *int64 { return &value }
