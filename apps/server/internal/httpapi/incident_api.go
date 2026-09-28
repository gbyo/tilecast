package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

type incidentRecord struct {
	ID             uuid.UUID  `json:"id"`
	IncidentType   string     `json:"incidentType"`
	Severity       string     `json:"severity"`
	Status         string     `json:"status"`
	Title          string     `json:"title"`
	Description    string     `json:"description"`
	OpenedAt       time.Time  `json:"openedAt"`
	LastSeenAt     time.Time  `json:"lastSeenAt"`
	RecoveredAt    *time.Time `json:"recoveredAt,omitempty"`
	ResolvedAt     *time.Time `json:"resolvedAt,omitempty"`
	AcknowledgedAt *time.Time `json:"acknowledgedAt,omitempty"`
	AcknowledgedBy string     `json:"acknowledgedBy,omitempty"`
	AssignedTo     *uuid.UUID `json:"assignedTo,omitempty"`
	AssignedToName string     `json:"assignedToName,omitempty"`

	PrimaryScreenID   *uuid.UUID `json:"primaryScreenId,omitempty"`
	PrimaryScreenName string     `json:"primaryScreenName,omitempty"`
	LocationName      string     `json:"locationName,omitempty"`
	GroupName         string     `json:"groupName,omitempty"`
	DeviceModel       string     `json:"deviceModel,omitempty"`
	PlayerVersion     string     `json:"playerVersion,omitempty"`
	AffectedScreens   int64      `json:"affectedScreens"`

	FailureCode string `json:"failureCode,omitempty"`
	// Empty when the evidence does not establish a cause. The dashboard says
	// "Unknown cause" rather than offering a guess as fact.
	ProbableCause    string `json:"probableCause,omitempty"`
	RecoveryMode     string `json:"recoveryMode,omitempty"`
	ResolutionReason string `json:"resolutionReason,omitempty"`
	ResolutionNotes  string `json:"resolutionNotes,omitempty"`
	RelatedType      string `json:"relatedType,omitempty"`
	RelatedID        string `json:"relatedId,omitempty"`
	OccurrenceCount  int64  `json:"occurrenceCount"`
}

type incidentTimelineEntry struct {
	ID         uuid.UUID `json:"id"`
	Role       string    `json:"role"`
	OccurredAt time.Time `json:"occurredAt"`
	ActorName  string    `json:"actorName,omitempty"`
	Summary    string    `json:"summary"`
}

type incidentDetail struct {
	incidentRecord
	Timeline []incidentTimelineEntry `json:"timeline"`
	Screens  []incidentScreenRef     `json:"screens"`
	// Everything that happened on this screen while the incident was live, so
	// the operator can see the evidence rather than take the incident's word.
	RelatedEvents []screenEventRecord   `json:"relatedEvents"`
	ProofSessions []proofOfPlayRecord   `json:"proofSessions"`
	AuditChanges  []auditActivityRecord `json:"auditChanges"`
	// How the incident ended, in words, or an honest statement that it has not.
	RecoveryPath string `json:"recoveryPath"`
}

type incidentScreenRef struct {
	ScreenID   uuid.UUID `json:"screenId"`
	ScreenName string    `json:"screenName"`
}

const incidentSelectSQL = `
	SELECT i.id,i.incident_type,i.severity,i.status,i.title,i.description,
	       i.opened_at,i.last_seen_at,i.recovered_at,i.resolved_at,i.acknowledged_at,
	       COALESCE(ack.name,''),i.assigned_to,COALESCE(assignee.name,''),
	       i.primary_screen_id,COALESCE(s.name,''),COALESCE(l.name,''),COALESCE(g.name,''),
	       i.device_model,i.player_version,
	       1 + (SELECT count(*) FROM incident_screens x WHERE x.incident_id=i.id),
	       i.failure_code,i.probable_cause,COALESCE(i.recovery_mode,''),
	       i.resolution_reason,i.resolution_notes,i.related_type,i.related_id,i.occurrence_count
	FROM incidents i
	LEFT JOIN users ack ON ack.id=i.acknowledged_by
	LEFT JOIN users assignee ON assignee.id=i.assigned_to
	LEFT JOIN screens s ON s.id=i.primary_screen_id
	LEFT JOIN locations l ON l.id=i.location_id
	LEFT JOIN screen_groups g ON g.id=i.group_id`

func scanIncident(scan proofScanner) (incidentRecord, error) {
	var item incidentRecord
	err := scan(&item.ID, &item.IncidentType, &item.Severity, &item.Status, &item.Title, &item.Description,
		&item.OpenedAt, &item.LastSeenAt, &item.RecoveredAt, &item.ResolvedAt, &item.AcknowledgedAt,
		&item.AcknowledgedBy, &item.AssignedTo, &item.AssignedToName,
		&item.PrimaryScreenID, &item.PrimaryScreenName, &item.LocationName, &item.GroupName,
		&item.DeviceModel, &item.PlayerVersion, &item.AffectedScreens,
		&item.FailureCode, &item.ProbableCause, &item.RecoveryMode,
		&item.ResolutionReason, &item.ResolutionNotes, &item.RelatedType, &item.RelatedID, &item.OccurrenceCount)
	return item, err
}

// Statuses an operator would call "still a problem". Recovered is not one of
// them: the condition ended, so the incident is a record of what happened
// rather than work waiting on someone. It stays readable in the full list and
// in analytics, and asks nothing of anybody.
var incidentActiveStatuses = []string{"open", "acknowledged"}

func (s *server) listIncidents(w http.ResponseWriter, r *http.Request) {
	// A screen that stopped reporting sends no event, so current state has to
	// be swept before the list is read or the outage would not appear at all.
	if err := s.syncOfflineIncidents(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	clauses := []string{"TRUE"}
	args := []any{}
	// Placeholder numbering is derived from the argument list, so filters can
	// be added in any order without renumbering by hand.
	add := func(format string, value any) {
		args = append(args, value)
		clauses = append(clauses, fmt.Sprintf(format, len(args)))
	}

	switch status := queryValue(r, "status"); status {
	case "", "active":
		add("i.status = ANY($%d)", incidentActiveStatuses)
	case "all":
	default:
		if !containsActivityValue(status, "open", "acknowledged", "recovered", "resolved", "ignored") {
			writeError(w, http.StatusUnprocessableEntity, "incident_status_invalid", "Status is invalid.")
			return
		}
		add("i.status = $%d", status)
	}

	for _, filter := range []struct {
		key        string
		expression string
		allowed    []string
	}{
		{"severity", "i.severity = $%d", []string{"info", "warning", "error", "critical"}},
		{"type", "i.incident_type = $%d", []string{incidentConnectivity, incidentPlayback, incidentStorage, incidentSafeMode, incidentUpdate}},
	} {
		value := queryValue(r, filter.key)
		if value == "" {
			continue
		}
		if !containsActivityValue(value, filter.allowed...) {
			writeError(w, http.StatusUnprocessableEntity, "incident_"+filter.key+"_invalid", "Filter value is invalid.")
			return
		}
		add(filter.expression, value)
	}

	for _, filter := range []struct{ key, expression string }{
		{"screen", "i.primary_screen_id = $%d"},
		{"group", "i.group_id = $%d"},
		{"location", "i.location_id = $%d"},
		{"assignee", "i.assigned_to = $%d"},
	} {
		value := queryValue(r, filter.key)
		if value == "" {
			continue
		}
		parsed, err := uuid.Parse(value)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "incident_"+filter.key+"_invalid", "Filter value is invalid.")
			return
		}
		add(filter.expression, parsed)
	}

	if value := queryValue(r, "failureCode"); value != "" {
		add("i.failure_code = $%d", safeActivityText(value, 96))
	}
	if value := queryValue(r, "search"); value != "" {
		// Title, description and screen name: what an operator would type.
		add("(i.title ILIKE $%[1]d OR i.description ILIKE $%[1]d OR COALESCE(s.name,'') ILIKE $%[1]d)",
			"%"+safeActivityText(value, 120)+"%")
	}

	// A date range needs an explicit basis: an incident opened last week and
	// resolved today belongs to a different set under each one, so guessing
	// would silently change which incidents the reader is looking at.
	if from, to := queryValue(r, "from"), queryValue(r, "to"); from != "" || to != "" {
		basis := queryValue(r, "dateBasis")
		if basis == "" {
			basis = "opened"
		}
		column, ok := map[string]string{
			"opened": "i.opened_at", "recovered": "i.recovered_at", "resolved": "i.resolved_at",
		}[basis]
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "incident_date_basis_invalid", "Date basis must be opened, recovered, or resolved.")
			return
		}
		window, err := parseActivityWindow(r)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
			return
		}
		add(column+" >= $%d", window.From)
		add(column+" < $%d", window.To)
	}

	rows, err := s.db.Query(r.Context(), incidentSelectSQL+` WHERE `+strings.Join(clauses, " AND ")+`
		ORDER BY CASE WHEN i.status IN('open','acknowledged') THEN 0 ELSE 1 END,
		         CASE i.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
		         i.opened_at,
		         i.last_seen_at DESC
		LIMIT 200`, args...)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := []incidentRecord{}
	for rows.Next() {
		item, err := scanIncident(rows.Scan)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items}})
}

func (s *server) getIncident(w http.ResponseWriter, r *http.Request) {
	role, ok := activityRole(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	id, err := incidentIDFromPath(r.URL.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, "incident_not_found", "Incident was not found.")
		return
	}
	record, err := scanIncident(s.db.QueryRow(r.Context(), incidentSelectSQL+` WHERE i.id=$1`, id).Scan)
	if err != nil {
		writeError(w, http.StatusNotFound, "incident_not_found", "Incident was not found.")
		return
	}
	detail := incidentDetail{incidentRecord: record, Timeline: []incidentTimelineEntry{}, Screens: []incidentScreenRef{}}
	timelineRows, err := s.db.Query(r.Context(), `
		SELECT e.id,e.role,e.occurred_at,COALESCE(u.name,''),e.summary
		FROM incident_events e LEFT JOIN users u ON u.id=e.actor_id
		WHERE e.incident_id=$1 ORDER BY e.occurred_at DESC,e.id DESC LIMIT 100`, id)
	if err == nil {
		defer timelineRows.Close()
		for timelineRows.Next() {
			var entry incidentTimelineEntry
			if timelineRows.Scan(&entry.ID, &entry.Role, &entry.OccurredAt, &entry.ActorName, &entry.Summary) == nil {
				detail.Timeline = append(detail.Timeline, entry)
			}
		}
	}
	screenRows, err := s.db.Query(r.Context(), `
		SELECT x.screen_id,COALESCE(s.name,'') FROM incident_screens x
		JOIN screens s ON s.id=x.screen_id WHERE x.incident_id=$1 ORDER BY s.name LIMIT 200`, id)
	if err == nil {
		defer screenRows.Close()
		for screenRows.Next() {
			var ref incidentScreenRef
			if screenRows.Scan(&ref.ScreenID, &ref.ScreenName) == nil {
				detail.Screens = append(detail.Screens, ref)
			}
		}
	}
	s.attachIncidentEvidence(r, &detail, role)
	detail.RecoveryPath = incidentRecoveryPath(record)
	writeJSON(w, http.StatusOK, map[string]any{"data": detail})
}

type incidentActionInput struct {
	Action     string `json:"action"`
	AssignedTo string `json:"assignedTo,omitempty"`
	Reason     string `json:"reason,omitempty"`
	Notes      string `json:"notes,omitempty"`
}

// updateIncident applies one operator action. Every action is appended to the
// incident timeline with its actor, so who closed a problem and why is never a
// matter of memory.
func (s *server) updateIncident(w http.ResponseWriter, r *http.Request) {
	principal, ok := activityPrincipal(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	id, err := incidentIDFromPath(r.URL.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, "incident_not_found", "Incident was not found.")
		return
	}
	var input incidentActionInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "incident_action_invalid", err.Error())
		return
	}
	actor := principal.User
	input.Reason = safeActivityText(input.Reason, 240)
	input.Notes = safeActivityText(input.Notes, 2000)

	var summary string
	var assignee *uuid.UUID
	if input.AssignedTo != "" {
		parsed, err := uuid.Parse(input.AssignedTo)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "incident_assignee_invalid", "Assigned user is invalid.")
			return
		}
		assignee = &parsed
	}

	var statement string
	args := []any{id}
	switch input.Action {
	case "acknowledge":
		statement = `UPDATE incidents SET status=CASE WHEN status='open' THEN 'acknowledged' ELSE status END,
			acknowledged_at=COALESCE(acknowledged_at,now()),acknowledged_by=COALESCE(acknowledged_by,$2),updated_at=now()
			WHERE id=$1 AND status IN('open','acknowledged')`
		args = append(args, actor.ID)
		summary = "Acknowledged"
	case "assign":
		if assignee == nil {
			writeError(w, http.StatusUnprocessableEntity, "incident_assignee_required", "Assigning an incident requires a user.")
			return
		}
		statement = `UPDATE incidents SET assigned_to=$2,updated_at=now() WHERE id=$1 AND status<>'resolved'`
		args = append(args, *assignee)
		summary = "Assigned"
	case "note":
		if input.Notes == "" {
			writeError(w, http.StatusUnprocessableEntity, "incident_note_required", "A note requires text.")
			return
		}
		statement = `UPDATE incidents SET updated_at=now() WHERE id=$1`
		summary = input.Notes
	case "resolve":
		// A person closing the matter is a manual recovery, and stays distinct
		// from the condition having ended on its own.
		statement = `UPDATE incidents SET status='resolved',resolved_at=now(),
			recovery_mode=COALESCE(recovery_mode,'manual'),
			resolution_reason=COALESCE(NULLIF($2,''),resolution_reason),
			resolution_notes=COALESCE(NULLIF($3,''),resolution_notes),updated_at=now()
			WHERE id=$1 AND status<>'resolved'`
		args = append(args, input.Reason, input.Notes)
		summary = "Resolved"
	case "ignore":
		statement = `UPDATE incidents SET status='ignored',
			resolution_reason=COALESCE(NULLIF($2,''),resolution_reason),updated_at=now()
			WHERE id=$1 AND status<>'ignored'`
		args = append(args, input.Reason)
		summary = "Ignored"
	case "reopen":
		// Clearing the closure fields matters: leaving recovered_at set would
		// make the next recovery measure from the wrong outage.
		statement = `UPDATE incidents SET status='open',resolved_at=NULL,recovered_at=NULL,
			recovery_mode=NULL,recovery_event_id=NULL,last_seen_at=now(),updated_at=now()
			WHERE id=$1 AND status IN('recovered','resolved','ignored')`
		summary = "Reopened"
	default:
		writeError(w, http.StatusUnprocessableEntity, "incident_action_unknown", "Action must be acknowledge, assign, note, resolve, ignore, or reopen.")
		return
	}
	if input.Reason != "" && input.Action != "note" {
		summary += ": " + input.Reason
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	tag, err := tx.Exec(r.Context(), statement, args...)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "incident_action_not_applicable", "That action does not apply to this incident's current status.")
		return
	}
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO incident_events(id,incident_id,role,occurred_at,actor_id,summary)
		VALUES($1,$2,'action',now(),$3,$4)`,
		uuid.New(), id, actor.ID, safeActivityText(summary, 240)); err != nil {
		s.internalError(w, r, err)
		return
	}
	// Operator actions on an incident are administrator history, so they land
	// in the audit log alongside every other change.
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,request_id,summary)
		VALUES($1,$2,$3,'incident',$4,'success',$5,$6)`,
		uuid.New(), actor.ID, "incident."+input.Action, id.String(),
		middleware.GetReqID(r.Context()), safeActivityText(summary, 240)); err != nil {
		s.internalError(w, r, err)
		return
	}
	record, err := scanIncident(tx.QueryRow(r.Context(), incidentSelectSQL+` WHERE i.id=$1`, id).Scan)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": record})
}

func incidentIDFromPath(path string) (uuid.UUID, error) {
	trimmed := strings.TrimPrefix(path, "/api/v1/activity/incidents/")
	if trimmed == "" || strings.Contains(trimmed, "/") {
		return uuid.Nil, errors.New("incident id is required")
	}
	return uuid.Parse(trimmed)
}

// incidentWindow bounds the evidence gathered for an incident: from when it
// opened until it ended, or until now while it is still live. A little slack
// on each side catches the event that caused it and the one that ended it.
func incidentWindow(record incidentRecord) (time.Time, time.Time) {
	from := record.OpenedAt.Add(-2 * time.Minute)
	to := time.Now().UTC().Add(time.Minute)
	if ended := record.RecoveredAt; ended != nil {
		to = ended.Add(2 * time.Minute)
	}
	if record.ResolvedAt != nil && record.ResolvedAt.After(to) {
		to = record.ResolvedAt.Add(2 * time.Minute)
	}
	if record.LastSeenAt.After(to) {
		to = record.LastSeenAt.Add(2 * time.Minute)
	}
	return from, to
}

// attachIncidentEvidence gathers what actually happened on the screen while the
// incident was live. Commands and updates are activity events with their own
// categories, so they arrive through the same stream rather than needing
// separate joins.
func (s *server) attachIncidentEvidence(r *http.Request, detail *incidentDetail, role string) {
	detail.RelatedEvents = []screenEventRecord{}
	detail.ProofSessions = []proofOfPlayRecord{}
	detail.AuditChanges = []auditActivityRecord{}
	if detail.PrimaryScreenID == nil {
		return
	}
	screenID := *detail.PrimaryScreenID
	from, to := incidentWindow(detail.incidentRecord)

	if activityCanSeeSensitive(role) {
		eventRows, err := s.db.Query(r.Context(), `
			SELECT e.id,e.occurred_at,e.received_at,e.screen_id,s.name,NULL::uuid,'',e.sequence,e.event_type,e.category,e.severity,e.result,e.manifest_version,
			       COALESCE(e.presentation_type,''),COALESCE(e.presentation_id,''),COALESCE(e.content_type,''),COALESCE(e.content_id,''),
			       COALESCE(e.failure_code,''),COALESCE(e.failure_message,''),e.metadata
			FROM player_activity_events e JOIN screens s ON s.id=e.screen_id
			WHERE e.screen_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3
			ORDER BY e.occurred_at DESC,e.sequence DESC LIMIT 100`, screenID, from, to)
		if err == nil {
			defer eventRows.Close()
			for eventRows.Next() {
				var item screenEventRecord
				var presentationType, presentationID, contentType, contentID string
				var raw []byte
				if eventRows.Scan(&item.ID, &item.Timestamp, &item.ReceivedAt, &item.ScreenID, &item.ScreenName, &item.GroupID, &item.GroupName, &item.Sequence, &item.EventType, &item.Category, &item.Severity, &item.Result, &item.ManifestVersion, &presentationType, &presentationID, &contentType, &contentID, &item.FailureCode, &item.FailureMessage, &raw) == nil {
					item.RelatedType, item.RelatedID = activityRelatedResource(presentationType, presentationID, contentType, contentID)
					item.Description = screenEventDescription(item.EventType, item.ScreenName, item.RelatedType)
					item.Details = activityMetadata(raw, item.Severity == "error", role)
					detail.RelatedEvents = append(detail.RelatedEvents, item)
				}
			}
		}
	}

	proofRows, err := s.db.Query(r.Context(), proofSelectSQL+`
		WHERE p.screen_id=$1 AND p.started_at<$3 AND COALESCE(p.ended_at,$3)>$2
		ORDER BY p.started_at DESC LIMIT 50`, screenID, from, to)
	if err == nil {
		defer proofRows.Close()
		for proofRows.Next() {
			if item, err := scanProof(proofRows.Scan, role); err == nil {
				detail.ProofSessions = append(detail.ProofSessions, item)
			}
		}
	}

	auditRows, err := s.db.Query(r.Context(), `
		SELECT a.id,a.created_at,a.user_id,COALESCE(u.name,'System'),COALESCE(u.username,''),
		       a.action,a.resource_type,COALESCE(a.resource_id,''),COALESCE(a.resource_name,''),
		       a.result,COALESCE(host(a.ip_address),''),COALESCE(a.request_id,''),COALESCE(a.summary,''),
		       a.metadata,a.metadata_sensitive
		FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
		WHERE a.created_at>=$2 AND a.created_at<$3
		  AND (a.resource_id=$1::text OR (a.resource_type='incident' AND a.resource_id=$4::text))
		ORDER BY a.created_at DESC LIMIT 50`, screenID, from, to, detail.ID)
	if err == nil {
		defer auditRows.Close()
		for auditRows.Next() {
			var item auditActivityRecord
			var raw []byte
			var sensitive bool
			if auditRows.Scan(&item.ID, &item.Timestamp, &item.ActorID, &item.ActorName, &item.ActorUsername,
				&item.Action, &item.ResourceType, &item.ResourceID, &item.ResourceName, &item.Result,
				&item.IPAddress, &item.RequestID, &item.Summary, &raw, &sensitive) == nil {
				item.Metadata = activityMetadata(raw, sensitive, role)
				if !activityCanSeeSensitive(role) {
					item.IPAddress, item.RequestID = "", ""
				}
				detail.AuditChanges = append(detail.AuditChanges, item)
			}
		}
	}
}

// incidentRecoveryPath states how the incident ended, using only what was
// recorded. An incident that has not ended says so rather than being described
// with a recovery that has not happened.
func incidentRecoveryPath(record incidentRecord) string {
	switch {
	case record.Status == "ignored":
		return "Ignored without a recovery being recorded."
	case record.RecoveredAt != nil && record.RecoveryMode == "automatic":
		return firstNonEmpty(record.ResolutionReason, "The condition ended on its own.")
	case record.RecoveredAt != nil:
		return firstNonEmpty(record.ResolutionReason, "The condition ended.")
	case record.ResolvedAt != nil:
		return firstNonEmpty(record.ResolutionReason, "Closed by an operator without an automatic recovery.")
	default:
		return "Not recovered yet."
	}
}
