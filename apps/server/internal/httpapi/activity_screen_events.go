package httpapi

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

func (s *server) listScreenEvents(w http.ResponseWriter, r *http.Request) {
	role, ok := activityRole(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	window, err := parseActivityWindow(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
		return
	}
	page, err := parseActivityPage(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_page_invalid", err.Error())
		return
	}
	// Activity uses the same operational screen scope as fleet health and
	// uptime. Historical rows remain available in the database for audit, but
	// archived, deleted, or disabled screens must not re-enter live activity
	// views through a direct event query.
	clauses := []string{"s.enabled = TRUE", "s.deleted_at IS NULL", "s.archived_at IS NULL", "e.occurred_at >= $1", "e.occurred_at < $2"}
	args := []any{window.From, window.To}
	if err := appendActivityUUIDFilter(&clauses, &args, "e.screen_id = $%d", queryValue(r, "screen")); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_screen_invalid", err.Error())
		return
	}
	if err := appendActivityUUIDFilter(&clauses, &args, "EXISTS(SELECT 1 FROM screen_group_memberships gm WHERE gm.screen_id=e.screen_id AND gm.screen_group_id=$%d)", queryValue(r, "group")); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_group_invalid", err.Error())
		return
	}
	appendActivityFilter(&clauses, &args, "e.category = $%d", queryValue(r, "category"))
	appendActivityFilter(&clauses, &args, "e.severity = $%d", queryValue(r, "severity"))
	appendActivityFilter(&clauses, &args, "e.result = $%d", queryValue(r, "result"))
	if search := queryValue(r, "search"); search != "" {
		args = append(args, "%"+search+"%")
		p := len(args)
		clauses = append(clauses, fmt.Sprintf("(e.event_type ILIKE $%d OR s.name ILIKE $%d OR COALESCE(e.failure_message,'') ILIKE $%d OR COALESCE(e.content_id,'') ILIKE $%d OR COALESCE(e.presentation_id,'') ILIKE $%d)", p, p, p, p, p))
	}
	if page.Cursor != nil {
		args = append(args, page.Cursor.Time, page.Cursor.ID)
		clauses = append(clauses, fmt.Sprintf("(e.occurred_at,e.id)<($%d,$%d)", len(args)-1, len(args)))
	}
	args = append(args, page.Limit+1)
	rows, err := s.db.Query(r.Context(), `
		SELECT e.id,e.occurred_at,e.received_at,e.screen_id,s.name,
		       g.id,COALESCE(g.name,''),e.sequence,e.event_type,e.category,e.severity,e.result,e.manifest_version,
		       COALESCE(e.presentation_type,''),COALESCE(e.presentation_id,''),COALESCE(e.content_type,''),COALESCE(e.content_id,''),
		       COALESCE(e.failure_code,''),COALESCE(e.failure_message,''),e.metadata
		FROM player_activity_events e
		JOIN screens s ON s.id=e.screen_id
		LEFT JOIN LATERAL (
			SELECT sg.id,sg.name FROM screen_group_memberships gm JOIN screen_groups sg ON sg.id=gm.screen_group_id
			WHERE gm.screen_id=e.screen_id AND sg.deleted_at IS NULL ORDER BY sg.name LIMIT 1
		) g ON TRUE
		WHERE `+strings.Join(clauses, " AND ")+`
		ORDER BY e.occurred_at DESC,e.id DESC LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := make([]screenEventRecord, 0, page.Limit+1)
	for rows.Next() {
		var item screenEventRecord
		var presentationType, presentationID, contentType, contentID string
		var raw []byte
		if err := rows.Scan(&item.ID, &item.Timestamp, &item.ReceivedAt, &item.ScreenID, &item.ScreenName, &item.GroupID, &item.GroupName, &item.Sequence, &item.EventType, &item.Category, &item.Severity, &item.Result, &item.ManifestVersion, &presentationType, &presentationID, &contentType, &contentID, &item.FailureCode, &item.FailureMessage, &raw); err != nil {
			s.internalError(w, r, err)
			return
		}
		item.RelatedType, item.RelatedID = activityRelatedResource(presentationType, presentationID, contentType, contentID)
		item.Description = screenEventDescription(item.EventType, item.ScreenName, item.RelatedType)
		if !activityCanSeeSensitive(role) {
			item.FailureMessage = ""
		}
		item.Details = activityMetadata(raw, item.Severity == "error" || item.Severity == "critical", role)
		items = append(items, item)
	}
	result := screenEventPage{Items: items}
	if len(items) > page.Limit {
		last := items[page.Limit-1]
		result.Items = items[:page.Limit]
		result.NextCursor = encodeActivityCursor(activityCursor{Time: last.Timestamp, ID: last.ID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}
