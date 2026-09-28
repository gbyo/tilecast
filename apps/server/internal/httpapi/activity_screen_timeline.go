package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// One screen's diagnostic history, merged into a single ordered stream. Before
// this, answering "what happened to this screen at 09:14" meant reading the
// event list, the proof-of-play list, the state timeline and the audit log
// separately and lining them up by eye.
type screenTimelineEntry struct {
	ID        string    `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	// The filter domain, matching the Screen Events categories plus the
	// derived sources that have no event of their own.
	Domain      string `json:"domain"`
	Kind        string `json:"kind"` // interval, session, or point
	Severity    string `json:"severity"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// Set when the entry covers a span rather than an instant.
	EndedAt    *time.Time `json:"endedAt,omitempty"`
	DurationMS *int64     `json:"durationMs,omitempty"`
	Result     string     `json:"result,omitempty"`
	// Where the entry leads, so the timeline is navigable.
	LinkType string `json:"linkType,omitempty"`
	LinkID   string `json:"linkId,omitempty"`
}

type screenTimelineResponse struct {
	Range struct {
		From time.Time `json:"from"`
		To   time.Time `json:"to"`
	} `json:"range"`
	Status  screenCurrentStatus   `json:"status"`
	Entries []screenTimelineEntry `json:"entries"`
}

// What is true about the screen right now, so the reader does not have to
// reconstruct it from the timeline below.
type screenCurrentStatus struct {
	CurrentPresentation    string     `json:"currentPresentation,omitempty"`
	CurrentItem            string     `json:"currentItem,omitempty"`
	CurrentIncident        string     `json:"currentIncident,omitempty"`
	CurrentIncidentID      *uuid.UUID `json:"currentIncidentId,omitempty"`
	LastHealthyPlayback    *time.Time `json:"lastHealthyPlayback,omitempty"`
	LastManifestActivation *time.Time `json:"lastManifestActivation,omitempty"`
	LastHeartbeatAt        *time.Time `json:"lastHeartbeatAt,omitempty"`
	PlayerVersion          string     `json:"playerVersion,omitempty"`
	// The same four-state classification the fleet-health section uses, so a
	// screen cannot read as healthy on one page and impaired on another.
	Health       string `json:"health"`
	HealthReason string `json:"healthReason"`
}

// The domains the timeline can be filtered by. `state` and `incidents` are
// derived rather than reported, so they are not activity-event categories.
var screenTimelineDomains = []string{
	"playback", "connectivity", "reliability", "scheduling",
	"commands", "updates", "takeovers", "manifest", "state", "incidents", "audit",
}

func (s *server) screenTimeline(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/activity/screens/")
	screenID, err := uuid.Parse(strings.TrimSuffix(path, "/timeline"))
	if err != nil {
		writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
		return
	}
	window, err := parseActivityWindow(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
		return
	}
	domain := queryValue(r, "domain")
	if domain != "" && !containsActivityValue(domain, screenTimelineDomains...) {
		writeError(w, http.StatusUnprocessableEntity, "timeline_domain_invalid", "Domain is invalid.")
		return
	}
	var operational bool
	if err := s.db.QueryRow(r.Context(), `
		SELECT EXISTS(
			SELECT 1 FROM screens
			WHERE id=$1 AND enabled=TRUE AND deleted_at IS NULL AND archived_at IS NULL
		)`, screenID).Scan(&operational); err != nil {
		s.internalError(w, r, err)
		return
	}
	if !operational {
		writeError(w, http.StatusNotFound, "screen_not_found", "Screen was not found.")
		return
	}

	response := screenTimelineResponse{Entries: []screenTimelineEntry{}}
	response.Range.From, response.Range.To = window.From, window.To
	response.Status = s.screenCurrentStatus(r, screenID)

	role, ok := activityRole(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	for _, source := range []func(*http.Request, uuid.UUID, activityWindow, string) []screenTimelineEntry{
		s.timelineFromEvents, s.timelineFromStateIntervals,
		s.timelineFromPlayback, s.timelineFromIncidents, s.timelineFromAudit,
	} {
		response.Entries = append(response.Entries, source(r, screenID, window, role)...)
	}
	if domain != "" {
		filtered := response.Entries[:0]
		for _, entry := range response.Entries {
			if entry.Domain == domain {
				filtered = append(filtered, entry)
			}
		}
		response.Entries = filtered
	}
	// Newest first, and stable on ties so repeated reads do not reshuffle.
	sortTimeline(response.Entries)
	if len(response.Entries) > 400 {
		response.Entries = response.Entries[:400]
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": response})
}

func sortTimeline(entries []screenTimelineEntry) {
	for index := 1; index < len(entries); index++ {
		for position := index; position > 0; position-- {
			left, right := entries[position-1], entries[position]
			if left.Timestamp.After(right.Timestamp) ||
				(left.Timestamp.Equal(right.Timestamp) && left.ID <= right.ID) {
				break
			}
			entries[position-1], entries[position] = right, left
		}
	}
}

func (s *server) screenCurrentStatus(r *http.Request, screenID uuid.UUID) screenCurrentStatus {
	var status screenCurrentStatus
	var signals fleetScreenSignals
	_ = s.db.QueryRow(r.Context(), `
		SELECT s.last_heartbeat_at,s.player_version,
		       p.screen_id IS NOT NULL,COALESCE(p.playback_state,''),COALESCE(p.last_playback_error,''),
		       COALESCE(p.safe_mode,FALSE),COALESCE(p.playback_disabled,FALSE),COALESCE(p.foreground_state,''),
		       p.cache_used_bytes,p.cache_limit_bytes,p.active_manifest_version,COALESCE(p.last_sync_error,'')
		FROM screens s LEFT JOIN screen_player_status p ON p.screen_id=s.id
		WHERE s.id=$1`, screenID).Scan(
		&status.LastHeartbeatAt, &status.PlayerVersion,
		&signals.HasStatus, &signals.PlaybackState, &signals.PlaybackError,
		&signals.SafeMode, &signals.PlaybackDisable, &signals.ForegroundState,
		&signals.CacheUsedBytes, &signals.CacheLimitBytes, &signals.ActiveManifest, &signals.SyncError)
	signals.LastHeartbeatAt = status.LastHeartbeatAt
	// The same classifier the fleet-health section uses, so the two pages
	// cannot disagree about whether this screen is healthy.
	status.Health, status.HealthReason = classifyFleetScreen(time.Now().UTC(), signals)

	_ = s.db.QueryRow(r.Context(), `
		SELECT COALESCE(NULLIF(presentation_name,''),COALESCE(presentation_id,''))
		FROM playback_sessions WHERE screen_id=$1 AND session_type='presentation' AND ended_at IS NULL
		ORDER BY started_at DESC LIMIT 1`, screenID).Scan(&status.CurrentPresentation)
	_ = s.db.QueryRow(r.Context(), `
		SELECT COALESCE(NULLIF(content_name,''),COALESCE(content_id,''))
		FROM playback_sessions WHERE screen_id=$1 AND session_type<>'presentation' AND ended_at IS NULL
		ORDER BY started_at DESC LIMIT 1`, screenID).Scan(&status.CurrentItem)
	_ = s.db.QueryRow(r.Context(), `
		SELECT id,title FROM incidents
		WHERE primary_screen_id=$1 AND status IN('open','acknowledged')
		ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,opened_at LIMIT 1`,
		screenID).Scan(&status.CurrentIncidentID, &status.CurrentIncident)
	_ = s.db.QueryRow(r.Context(), `SELECT max(started_at) FROM screen_state_intervals WHERE screen_id=$1 AND state='healthy'`, screenID).Scan(&status.LastHealthyPlayback)
	_ = s.db.QueryRow(r.Context(), `SELECT max(occurred_at) FROM player_activity_events WHERE screen_id=$1 AND event_type IN('manifest.activated','presentation.activated') AND result IN('completed','success','playing')`, screenID).Scan(&status.LastManifestActivation)
	return status
}

func (s *server) timelineFromEvents(r *http.Request, screenID uuid.UUID, window activityWindow, role string) []screenTimelineEntry {
	entries := []screenTimelineEntry{}
	// Raw events carry sensitive failure text, so unprivileged readers see the
	// shape of the history without the diagnostics.
	rows, err := s.db.Query(r.Context(), `
		SELECT e.id::text,e.occurred_at,e.category,e.event_type,e.severity,e.result,
		       COALESCE(e.failure_message,''),COALESCE(e.content_type,''),COALESCE(e.content_id,''),e.duration_ms
		FROM player_activity_events e
		WHERE e.screen_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3
		ORDER BY e.occurred_at DESC,e.sequence DESC LIMIT 300`, screenID, window.From, window.To)
	if err != nil {
		return entries
	}
	defer rows.Close()
	for rows.Next() {
		var entry screenTimelineEntry
		var eventType, failure, contentType, contentID string
		if rows.Scan(&entry.ID, &entry.Timestamp, &entry.Domain, &eventType, &entry.Severity,
			&entry.Result, &failure, &contentType, &contentID, &entry.DurationMS) != nil {
			continue
		}
		entry.Kind = eventType
		entry.Title = humanizeEventType(eventType)
		if activityCanSeeSensitive(role) {
			entry.Description = failure
		}
		entry.LinkType, entry.LinkID = contentType, contentID
		entries = append(entries, entry)
	}
	return entries
}

func (s *server) timelineFromStateIntervals(r *http.Request, screenID uuid.UUID, window activityWindow, _ string) []screenTimelineEntry {
	entries := []screenTimelineEntry{}
	rows, err := s.db.Query(r.Context(), `
		SELECT i.id::text,i.started_at,i.ended_at,i.state,COALESCE(i.reason_code,'')
		FROM screen_state_intervals i
		WHERE i.screen_id=$1 AND i.started_at<$3 AND COALESCE(i.ended_at,$3)>$2
		ORDER BY i.started_at DESC LIMIT 100`, screenID, window.From, window.To)
	if err != nil {
		return entries
	}
	defer rows.Close()
	for rows.Next() {
		var entry screenTimelineEntry
		var state, reason string
		if rows.Scan(&entry.ID, &entry.Timestamp, &entry.EndedAt, &state, &reason) != nil {
			continue
		}
		entry.Domain, entry.Kind = "state", state
		entry.Title = stateIntervalTitle(state)
		entry.Severity = stateIntervalSeverity(state)
		if reason != "" {
			entry.Description = humanizeEventType(reason)
		}
		if entry.EndedAt != nil {
			milliseconds := entry.EndedAt.Sub(entry.Timestamp).Milliseconds()
			entry.DurationMS = &milliseconds
		}
		entries = append(entries, entry)
	}
	return entries
}

func (s *server) timelineFromPlayback(r *http.Request, screenID uuid.UUID, window activityWindow, _ string) []screenTimelineEntry {
	entries := []screenTimelineEntry{}
	rows, err := s.db.Query(r.Context(), `
		SELECT p.id::text,p.started_at,p.ended_at,p.session_type,p.result,COALESCE(p.terminal_reason,''),
		       COALESCE(NULLIF(p.presentation_name,''),COALESCE(p.presentation_id,'')),
		       COALESCE(NULLIF(p.content_name,''),COALESCE(p.content_id,'')),
		       p.actual_duration_ms,COALESCE(p.content_type,''),COALESCE(p.content_id,'')
		FROM playback_sessions p
		WHERE p.screen_id=$1 AND p.started_at<$3 AND COALESCE(p.ended_at,$3)>$2
		ORDER BY p.started_at DESC LIMIT 150`, screenID, window.From, window.To)
	if err != nil {
		return entries
	}
	defer rows.Close()
	for rows.Next() {
		var entry screenTimelineEntry
		var sessionType, terminal, presentation, content, contentType, contentID string
		if rows.Scan(&entry.ID, &entry.Timestamp, &entry.EndedAt, &sessionType, &entry.Result,
			&terminal, &presentation, &content, &entry.DurationMS, &contentType, &contentID) != nil {
			continue
		}
		entry.Domain, entry.Kind = "playback", "session."+sessionType
		if sessionType == sessionTypePresentation {
			entry.Title = firstNonEmpty(presentation, "Presentation")
		} else {
			entry.Title = firstNonEmpty(content, presentation, "Content")
		}
		if terminal != "" {
			entry.Description = "Ended: " + strings.ReplaceAll(terminal, "_", " ")
		}
		entry.Severity = "info"
		if entry.Result == "failed" {
			entry.Severity = "error"
		}
		entry.LinkType, entry.LinkID = contentType, contentID
		entries = append(entries, entry)
	}
	return entries
}

func (s *server) timelineFromIncidents(r *http.Request, screenID uuid.UUID, window activityWindow, _ string) []screenTimelineEntry {
	entries := []screenTimelineEntry{}
	rows, err := s.db.Query(r.Context(), `
		SELECT i.id::text,i.title,i.severity,i.status,i.opened_at,i.recovered_at,i.resolved_at
		FROM incidents i
		WHERE i.primary_screen_id=$1
		  AND (i.opened_at<$3 AND COALESCE(i.resolved_at,i.recovered_at,$3)>=$2)
		ORDER BY i.opened_at DESC LIMIT 60`, screenID, window.From, window.To)
	if err != nil {
		return entries
	}
	defer rows.Close()
	for rows.Next() {
		var id, title, severity, status string
		var openedAt time.Time
		var recoveredAt, resolvedAt *time.Time
		if rows.Scan(&id, &title, &severity, &status, &openedAt, &recoveredAt, &resolvedAt) != nil {
			continue
		}
		// Opening, recovering and resolving are three separate moments in the
		// history, not one row that has to be interpreted.
		entries = append(entries, screenTimelineEntry{
			ID: "incident-open-" + id, Timestamp: openedAt, Domain: "incidents",
			Kind: "incident.opened", Severity: severity, Title: title,
			Description: "Incident opened", LinkType: "incident", LinkID: id,
		})
		if recoveredAt != nil && !recoveredAt.Before(window.From) && recoveredAt.Before(window.To) {
			entries = append(entries, screenTimelineEntry{
				ID: "incident-recovered-" + id, Timestamp: *recoveredAt, Domain: "incidents",
				Kind: "incident.recovered", Severity: "info", Title: title,
				Description: "Condition ended", LinkType: "incident", LinkID: id,
			})
		}
		if resolvedAt != nil && !resolvedAt.Before(window.From) && resolvedAt.Before(window.To) {
			entries = append(entries, screenTimelineEntry{
				ID: "incident-resolved-" + id, Timestamp: *resolvedAt, Domain: "incidents",
				Kind: "incident.resolved", Severity: "info", Title: title,
				Description: "Closed by an operator", LinkType: "incident", LinkID: id,
			})
		}
	}
	return entries
}

func (s *server) timelineFromAudit(r *http.Request, screenID uuid.UUID, window activityWindow, _ string) []screenTimelineEntry {
	entries := []screenTimelineEntry{}
	rows, err := s.db.Query(r.Context(), `
		SELECT a.id::text,a.created_at,a.action,a.result,COALESCE(a.summary,''),COALESCE(u.name,'System')
		FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
		WHERE a.created_at>=$2 AND a.created_at<$3 AND a.resource_id=$1::text
		ORDER BY a.created_at DESC LIMIT 60`, screenID, window.From, window.To)
	if err != nil {
		return entries
	}
	defer rows.Close()
	for rows.Next() {
		var entry screenTimelineEntry
		var action, result, summary, actor string
		if rows.Scan(&entry.ID, &entry.Timestamp, &action, &result, &summary, &actor) != nil {
			continue
		}
		entry.Domain, entry.Kind = "audit", action
		entry.Title = firstNonEmpty(summary, humanizeEventType(action))
		entry.Description = "By " + actor
		entry.Result = result
		entry.Severity = "info"
		if result == "failure" {
			entry.Severity = "error"
		}
		entries = append(entries, entry)
	}
	return entries
}

func humanizeEventType(value string) string {
	words := strings.ReplaceAll(strings.ReplaceAll(value, ".", " "), "_", " ")
	if words == "" {
		return words
	}
	return strings.ToUpper(words[:1]) + words[1:]
}

func stateIntervalTitle(state string) string {
	switch state {
	case "online":
		return "Online"
	case "offline":
		return "Offline"
	case "healthy":
		return "Healthy playback"
	case "degraded":
		return "Impaired"
	case "safe_mode":
		return "Safe mode"
	default:
		return "Unknown state"
	}
}

func stateIntervalSeverity(state string) string {
	switch state {
	case "offline":
		return "error"
	case "degraded", "safe_mode":
		return "warning"
	default:
		return "info"
	}
}
