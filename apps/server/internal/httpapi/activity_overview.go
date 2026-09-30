package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *server) activityOverview(w http.ResponseWriter, r *http.Request) {
	window, err := parseActivityWindow(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
		return
	}
	var data activityOverviewData
	data.Range.From, data.Range.To = window.From, window.To
	// Marshal empty lists as [] rather than null; the dashboard indexes into
	// these collections directly.
	data.Timeline = []activityTimelineItem{}
	fleet, err := s.fleetHealth(r.Context(), time.Now().UTC())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	data.Fleet = &fleet
	// Counted as reporting gaps rather than playback gaps, and narrowed to the
	// states a connectivity gap actually produces. The previous count also
	// included renderer and storage impairment, which the drill-down could not
	// show and the fleet-health section reports as impaired instead.
	if err := s.db.QueryRow(r.Context(), `SELECT count(DISTINCT i.screen_id) FROM screen_state_intervals i JOIN screens s ON s.id=i.screen_id WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND i.started_at<$2 AND COALESCE(i.ended_at,$2)>$1 AND (i.state IN('offline','unknown') OR (i.state='degraded' AND COALESCE(i.reason_code,'')='heartbeat_gap'))`, window.From, window.To).Scan(&data.Cards.ScreensWithReportingGaps); err != nil {
		s.internalError(w, r, err)
		return
	}
	durations, err := s.playbackDurations(r.Context(), window.From, window.To)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	data.Cards.ConfirmedScreenPlaybackMS, data.Cards.ContentExposureMS = durations.ConfirmedScreenMS, durations.ContentExposureMS
	// An interruption is an unexpected ending, not merely a partial result. A
	// scheduled changeover ends playback early and is exactly what was asked for.
	if err := s.db.QueryRow(r.Context(), `
		SELECT count(*) FILTER(WHERE result='failed'),
		       count(*) FILTER(WHERE terminal_reason = ANY($3))
		FROM playback_sessions p JOIN screens s ON s.id=p.screen_id WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND p.started_at>=$1 AND p.started_at<$2`,
		window.From, window.To, interruptedTerminalReasons()).Scan(&data.Cards.PlaybackFailures, &data.Cards.InterruptedPlays); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM player_activity_events e JOIN screens s ON s.id=e.screen_id WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND e.occurred_at>=$1 AND e.occurred_at<$2 AND e.event_type='takeover.active'`, window.From, window.To).Scan(&data.Cards.TakeoverActivations); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM player_activity_events e JOIN screens s ON s.id=e.screen_id WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND e.occurred_at>=$1 AND e.occurred_at<$2 AND e.category='updates' AND e.result='failed'`, window.From, window.To).Scan(&data.Cards.FailedPlayerUpdates); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM audit_logs WHERE created_at>=$1 AND created_at<$2 AND result='success'`, window.From, window.To).Scan(&data.Cards.RecentAdminChanges); err != nil {
		s.internalError(w, r, err)
		return
	}

	timelineRows, err := s.db.Query(r.Context(), `
		SELECT e.id::text,e.occurred_at,'screen',e.severity,
		       CASE WHEN e.content_id IS NOT NULL THEN replace(e.event_type,'.',' ')||' · '||e.content_id ELSE replace(e.event_type,'.',' ') END,
		       e.screen_id,COALESCE(e.presentation_id,'')
		FROM player_activity_events e JOIN screens s ON s.id=e.screen_id
		WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND e.occurred_at>=$1 AND e.occurred_at<$2 AND (e.severity IN('warning','error','critical') OR e.event_type IN('presentation.started','presentation.recovered','schedule.became_active','takeover.active','update.installation_failed'))
		UNION ALL
		SELECT id::text,created_at,'audit',CASE WHEN result='failure' THEN 'error' ELSE 'info' END,
		       COALESCE(NULLIF(summary,''),replace(action,'.',' ')),NULL,COALESCE(resource_id,'')
		FROM audit_logs WHERE created_at>=$1 AND created_at<$2 AND result IN('success','failure')
		ORDER BY 2 DESC LIMIT 40`, window.From, window.To)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer timelineRows.Close()
	for timelineRows.Next() {
		var item activityTimelineItem
		if err := timelineRows.Scan(&item.ID, &item.Timestamp, &item.Domain, &item.Severity, &item.Description, &item.ScreenID, &item.ResourceID); err != nil {
			s.internalError(w, r, err)
			return
		}
		data.Timeline = append(data.Timeline, item)
	}
	if err := timelineRows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": data})
}

func (s *server) screenActivity(w http.ResponseWriter, r *http.Request) {
	role, ok := activityRole(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	screenID, err := uuid.Parse(strings.TrimPrefix(r.URL.Path, "/api/v1/activity/screens/"))
	if err != nil {
		writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
		return
	}
	var operational bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM screens WHERE id=$1 AND enabled=TRUE AND deleted_at IS NULL AND archived_at IS NULL)`, screenID).Scan(&operational); err != nil {
		s.internalError(w, r, err)
		return
	}
	if !operational {
		writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
		return
	}
	data := screenActivityData{ScreenID: screenID, RecentProof: []proofOfPlayRecord{}, RecentEvents: []screenEventRecord{}}
	row := s.db.QueryRow(r.Context(), proofSelectSQL+` WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND p.screen_id=$1 AND p.ended_at IS NULL ORDER BY p.started_at DESC LIMIT 1`, screenID)
	item, err := scanProof(row.Scan, role)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.internalError(w, r, err)
		return
	}
	if err == nil {
		data.CurrentPresentation = &item
	}
	rows, err := s.db.Query(r.Context(), proofSelectSQL+` WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND p.screen_id=$1 ORDER BY p.started_at DESC LIMIT 10`, screenID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanProof(rows.Scan, role)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		data.RecentProof = append(data.RecentProof, item)
	}
	if err := rows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	if activityCanSeeSensitive(role) {
		eventRows, err := s.db.Query(r.Context(), `
			SELECT e.id,e.occurred_at,e.received_at,e.screen_id,s.name,NULL::uuid,'',e.sequence,e.event_type,e.category,e.severity,e.result,e.manifest_version,
			       COALESCE(e.presentation_type,''),COALESCE(e.presentation_id,''),COALESCE(e.content_type,''),COALESCE(e.content_id,''),
			       COALESCE(e.failure_code,''),COALESCE(e.failure_message,''),e.metadata
			FROM player_activity_events e JOIN screens s ON s.id=e.screen_id WHERE s.enabled=TRUE AND s.deleted_at IS NULL AND s.archived_at IS NULL AND e.screen_id=$1 ORDER BY e.occurred_at DESC,e.sequence DESC LIMIT 10`, screenID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		defer eventRows.Close()
		for eventRows.Next() {
			var item screenEventRecord
			var presentationType, presentationID, contentType, contentID string
			var raw []byte
			if err := eventRows.Scan(&item.ID, &item.Timestamp, &item.ReceivedAt, &item.ScreenID, &item.ScreenName, &item.GroupID, &item.GroupName, &item.Sequence, &item.EventType, &item.Category, &item.Severity, &item.Result, &item.ManifestVersion, &presentationType, &presentationID, &contentType, &contentID, &item.FailureCode, &item.FailureMessage, &raw); err != nil {
				s.internalError(w, r, err)
				return
			}
			item.RelatedType, item.RelatedID = activityRelatedResource(presentationType, presentationID, contentType, contentID)
			item.Description = screenEventDescription(item.EventType, item.ScreenName, item.RelatedType)
			item.Details = activityMetadata(raw, item.Severity == "error", role)
			data.RecentEvents = append(data.RecentEvents, item)
		}
		if err := eventRows.Err(); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM screen_state_intervals WHERE screen_id=$1 AND state IN('offline','degraded','unknown') AND started_at>now()-interval '30 days'`, screenID).Scan(&data.PlaybackGaps); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.QueryRow(r.Context(), `SELECT max(started_at) FROM screen_state_intervals WHERE screen_id=$1 AND state='healthy'`, screenID).Scan(&data.LastHealthyPlayback); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.QueryRow(r.Context(), `SELECT max(occurred_at) FROM player_activity_events WHERE screen_id=$1 AND event_type IN('manifest.activated','presentation.activated') AND result IN('completed','success','playing')`, screenID).Scan(&data.LastSuccessfulManifestActivation); err != nil {
		s.internalError(w, r, err)
		return
	}
	if len(data.RecentEvents) > 0 && (data.RecentEvents[0].Severity == "warning" || data.RecentEvents[0].Severity == "error" || data.RecentEvents[0].Severity == "critical") {
		item := data.RecentEvents[0]
		data.CurrentIssue = &activityAttentionItem{ScreenID: screenID, ScreenName: item.ScreenName, Kind: item.EventType, Severity: item.Severity, Description: item.Description, OccurredAt: item.Timestamp}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": data})
}

func activityRelatedResource(presentationType, presentationID, contentType, contentID string) (string, string) {
	if contentID != "" {
		return contentType, contentID
	}
	return presentationType, presentationID
}

func screenEventDescription(eventType, screenName, relatedType string) string {
	label := strings.ReplaceAll(eventType, ".", " ")
	if relatedType != "" {
		return screenName + " · " + label + " (" + strings.ReplaceAll(relatedType, "_", " ") + ")"
	}
	return screenName + " · " + label
}

func optionalTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

func optionalDate(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.Format("2006-01-02")
}

func optionalInt64(value *int64) string {
	if value == nil {
		return ""
	}
	return strconv.FormatInt(*value, 10)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func marshalActivityDetails(value map[string]any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
