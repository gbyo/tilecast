package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

func (s *server) ingestPlayerActivityWithCleanup(w http.ResponseWriter, r *http.Request) {
	s.ingestPlayerActivity(w, r)
	go s.cleanupActivityBounded(activityContextWithoutCancel(r.Context()), 500)
}

type activityRetentionSettings struct {
	RawEventDays           int `json:"rawEventDays"`
	PlaybackSessionDays    int `json:"playbackSessionDays"`
	ScreenStateDays        int `json:"screenStateDays"`
	AuditLogDays           int `json:"auditLogDays"`
	DiagnosticMetadataDays int `json:"diagnosticMetadataDays"`
	// Rollups are the only telemetry that accumulates; the snapshot is one row
	// per screen and raw samples are never stored.
	TelemetryRollupDays int       `json:"telemetryRollupDays"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

func (s *server) getActivityRetention(w http.ResponseWriter, r *http.Request) {
	var value activityRetentionSettings
	if err := s.db.QueryRow(r.Context(), `SELECT raw_event_days,playback_session_days,screen_state_days,audit_log_days,diagnostic_metadata_days,telemetry_rollup_days,updated_at FROM activity_retention_settings WHERE singleton=TRUE`).Scan(&value.RawEventDays, &value.PlaybackSessionDays, &value.ScreenStateDays, &value.AuditLogDays, &value.DiagnosticMetadataDays, &value.TelemetryRollupDays, &value.UpdatedAt); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": value})
}

func (s *server) updateActivityRetention(w http.ResponseWriter, r *http.Request) {
	var input activityRetentionSettings
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "activity_retention_invalid", err.Error())
		return
	}
	if input.RawEventDays < 7 || input.RawEventDays > 365 || input.PlaybackSessionDays < 30 || input.PlaybackSessionDays > 2555 || input.ScreenStateDays < 30 || input.ScreenStateDays > 2555 || input.AuditLogDays < 90 || input.AuditLogDays > 3650 || input.DiagnosticMetadataDays < 7 || input.DiagnosticMetadataDays > 180 ||
		input.TelemetryRollupDays < 7 || input.TelemetryRollupDays > 400 {
		writeError(w, http.StatusUnprocessableEntity, "activity_retention_out_of_bounds", "Activity retention values exceed deployment hard limits.")
		return
	}
	user := activitySession(r).User
	if _, err := s.db.Exec(r.Context(), `UPDATE activity_retention_settings SET raw_event_days=$1,playback_session_days=$2,screen_state_days=$3,audit_log_days=$4,diagnostic_metadata_days=$5,telemetry_rollup_days=$6,updated_by=$7,updated_at=now() WHERE singleton=TRUE`, input.RawEventDays, input.PlaybackSessionDays, input.ScreenStateDays, input.AuditLogDays, input.DiagnosticMetadataDays, input.TelemetryRollupDays, user.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	metadata := map[string]any{"rawEventDays": input.RawEventDays, "playbackSessionDays": input.PlaybackSessionDays, "screenStateDays": input.ScreenStateDays, "auditLogDays": input.AuditLogDays, "diagnosticMetadataDays": input.DiagnosticMetadataDays, "telemetryRollupDays": input.TelemetryRollupDays}
	encoded, _ := json.Marshal(metadata)
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,result,request_id,summary,metadata) VALUES($1,$2,'settings.activity_retention_changed','settings','activity-retention','Activity retention','success',$3,'Activity retention changed',$4::jsonb)`, uuid.New(), user.ID, middleware.GetReqID(r.Context()), string(encoded))
	go s.cleanupActivityBounded(activityContextWithoutCancel(r.Context()), 500)
	s.getActivityRetention(w, r)
}

func (s *server) runActivityRetentionWorker() {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		<-timer.C
		s.cleanupActivityBounded(context.Background(), 500)
		timer.Reset(6 * time.Hour)
	}
}

func (s *server) cleanupActivityBounded(ctx context.Context, batch int) {
	if batch < 1 || batch > 5000 {
		batch = 500
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, `INSERT INTO activity_retention_settings(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING`); err != nil {
		s.logger.Warn("activity retention defaults unavailable", "error", err)
		return
	}
	var rawDays, sessionDays, stateDays, auditDays, diagnosticDays, telemetryDays int
	if err := s.db.QueryRow(ctx, `SELECT raw_event_days,playback_session_days,screen_state_days,audit_log_days,diagnostic_metadata_days,telemetry_rollup_days FROM activity_retention_settings WHERE singleton=TRUE`).Scan(&rawDays, &sessionDays, &stateDays, &auditDays, &diagnosticDays, &telemetryDays); err != nil {
		s.logger.Warn("activity retention settings unavailable", "error", err)
		return
	}

	counts := map[string]int64{}
	exec := func(name, query string, args ...any) {
		tag, err := s.db.Exec(ctx, query, args...)
		if err != nil {
			s.logger.Warn("activity retention batch failed", "dataset", name, "error", err)
			return
		}
		counts[name] = tag.RowsAffected()
	}
	cutoff := `now()-($1::int * interval '1 day')`
	exec("playback_sessions", `WITH expired AS (SELECT id FROM playback_sessions WHERE ended_at IS NOT NULL AND ended_at<`+cutoff+` ORDER BY ended_at LIMIT $2::int) DELETE FROM playback_sessions p USING expired e WHERE p.id=e.id`, sessionDays, batch)
	exec("screen_state_intervals", `WITH expired AS (SELECT id FROM screen_state_intervals WHERE ended_at IS NOT NULL AND ended_at<`+cutoff+` ORDER BY ended_at LIMIT $2::int) DELETE FROM screen_state_intervals s USING expired e WHERE s.id=e.id`, stateDays, batch)
	exec("player_activity_events", `WITH expired AS (SELECT id FROM player_activity_events WHERE occurred_at<`+cutoff+` ORDER BY occurred_at LIMIT $2::int) DELETE FROM player_activity_events p USING expired e WHERE p.id=e.id`, rawDays, batch)
	exec("audit_logs", `WITH expired AS (SELECT id FROM audit_logs WHERE created_at<`+cutoff+` ORDER BY created_at LIMIT $2::int) DELETE FROM audit_logs a USING expired e WHERE a.id=e.id`, auditDays, batch)
	exec("player_diagnostics", `WITH targets AS (SELECT id FROM player_activity_events WHERE received_at<`+cutoff+` AND (metadata<>'{}'::jsonb OR failure_message IS NOT NULL) ORDER BY received_at LIMIT $2::int) UPDATE player_activity_events e SET metadata='{}'::jsonb,failure_message=NULL FROM targets t WHERE e.id=t.id`, diagnosticDays, batch)
	// Rollups are the only telemetry that accumulates. The snapshot is one row
	// per screen and raw samples are never stored, so neither needs expiring.
	exec("telemetry_rollups", `WITH expired AS (SELECT screen_id,bucket_start FROM screen_telemetry_rollups WHERE bucket_start<`+cutoff+` ORDER BY bucket_start LIMIT $2::int) DELETE FROM screen_telemetry_rollups t USING expired e WHERE t.screen_id=e.screen_id AND t.bucket_start=e.bucket_start`, telemetryDays, batch)
	exec("audit_diagnostics", `WITH targets AS (SELECT id FROM audit_logs WHERE created_at<`+cutoff+` AND metadata_sensitive=TRUE AND metadata<>'{}'::jsonb ORDER BY created_at LIMIT $2::int) UPDATE audit_logs a SET metadata='{}'::jsonb FROM targets t WHERE a.id=t.id`, diagnosticDays, batch)

	total := int64(0)
	for _, count := range counts {
		total += count
	}
	if total > 0 {
		s.logger.Info("activity retention batch completed", "rows_changed", total, "playback_sessions", counts["playback_sessions"], "screen_state_intervals", counts["screen_state_intervals"], "player_activity_events", counts["player_activity_events"], "audit_logs", counts["audit_logs"], "telemetry_rollups", counts["telemetry_rollups"], "diagnostic_rows", counts["player_diagnostics"]+counts["audit_diagnostics"])
	}
}
