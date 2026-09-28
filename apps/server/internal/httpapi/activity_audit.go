package httpapi

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

type auditActivityRecord struct {
	ID            uuid.UUID      `json:"id"`
	Timestamp     time.Time      `json:"timestamp"`
	ActorID       *uuid.UUID     `json:"actorId,omitempty"`
	ActorName     string         `json:"actorName"`
	ActorUsername string         `json:"actorUsername,omitempty"`
	Action        string         `json:"action"`
	ResourceType  string         `json:"resourceType"`
	ResourceID    string         `json:"resourceId,omitempty"`
	ResourceName  string         `json:"resourceName,omitempty"`
	Result        string         `json:"result"`
	IPAddress     string         `json:"ipAddress,omitempty"`
	RequestID     string         `json:"requestId,omitempty"`
	Summary       string         `json:"summary"`
	Metadata      map[string]any `json:"metadata"`
}

type auditActivityPage struct {
	Items      []auditActivityRecord `json:"items"`
	NextCursor string                `json:"nextCursor,omitempty"`
}

func (s *server) listAuditActivity(w http.ResponseWriter, r *http.Request) {
	principal, ok := activityPrincipal(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	if principal.User.Role == "viewer" {
		writeError(w, http.StatusForbidden, "activity_audit_restricted", "Audit Log access requires Editor, Administrator, or Owner access.")
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

	clauses := []string{"a.created_at >= $1", "a.created_at < $2"}
	args := []any{window.From, window.To}
	if principal.User.Role == "editor" {
		clauses = append(clauses, "a.resource_type IN ('asset','media','source','widget','playlist','layout','campaign','schedule')")
	}
	if err := appendActivityUUIDFilter(&clauses, &args, "a.user_id = $%d", queryValue(r, "actor")); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_actor_invalid", err.Error())
		return
	}
	appendActivityFilter(&clauses, &args, "a.action = $%d", queryValue(r, "action"))
	appendActivityFilter(&clauses, &args, "a.resource_type = $%d", queryValue(r, "resourceType"))
	appendActivityFilter(&clauses, &args, "a.result = $%d", queryValue(r, "result"))
	if search := queryValue(r, "search"); search != "" {
		args = append(args, "%"+search+"%")
		placeholder := len(args)
		clauses = append(clauses, fmt.Sprintf("(COALESCE(a.summary,'') ILIKE $%d OR a.action ILIKE $%d OR a.resource_type ILIKE $%d OR COALESCE(a.resource_name,'') ILIKE $%d OR COALESCE(a.resource_id,'') ILIKE $%d OR COALESCE(u.name,'') ILIKE $%d OR COALESCE(u.username,'') ILIKE $%d)", placeholder, placeholder, placeholder, placeholder, placeholder, placeholder, placeholder))
	}
	if page.Cursor != nil {
		args = append(args, page.Cursor.Time, page.Cursor.ID)
		clauses = append(clauses, fmt.Sprintf("(a.created_at, a.id) < ($%d, $%d)", len(args)-1, len(args)))
	}
	args = append(args, page.Limit+1)
	query := `
		SELECT a.id,a.created_at,a.user_id,COALESCE(u.name,'System'),COALESCE(u.username,''),
		       a.action,a.resource_type,COALESCE(a.resource_id,''),COALESCE(a.resource_name,''),
		       a.result,COALESCE(host(a.ip_address),''),COALESCE(a.request_id,''),COALESCE(a.summary,''),
		       a.metadata,a.metadata_sensitive
		FROM audit_logs a
		LEFT JOIN users u ON u.id=a.user_id
		WHERE ` + strings.Join(clauses, " AND ") + `
		ORDER BY a.created_at DESC,a.id DESC
		LIMIT $` + fmt.Sprint(len(args))
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := make([]auditActivityRecord, 0, page.Limit+1)
	for rows.Next() {
		var item auditActivityRecord
		var raw []byte
		var sensitive bool
		if err := rows.Scan(&item.ID, &item.Timestamp, &item.ActorID, &item.ActorName, &item.ActorUsername, &item.Action, &item.ResourceType, &item.ResourceID, &item.ResourceName, &item.Result, &item.IPAddress, &item.RequestID, &item.Summary, &raw, &sensitive); err != nil {
			s.internalError(w, r, err)
			return
		}
		if item.ResourceName == "" {
			item.ResourceName = s.lookupAuditResourceName(r.Context(), item.ResourceType, item.ResourceID)
		}
		if item.Summary == "" {
			item.Summary = auditPlainLanguage(item.Action, item.ResourceType, item.ResourceName)
		}
		if !activityCanSeeSensitive(principal.User.Role) {
			item.IPAddress = ""
			item.RequestID = ""
		}
		item.Metadata = activityMetadata(raw, sensitive, principal.User.Role)
		items = append(items, item)
	}
	if rows.Err() != nil {
		s.internalError(w, r, rows.Err())
		return
	}
	result := auditActivityPage{Items: items}
	if len(items) > page.Limit {
		last := items[page.Limit-1]
		result.Items = items[:page.Limit]
		result.NextCursor = encodeActivityCursor(activityCursor{Time: last.Timestamp, ID: last.ID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func (s *server) exportAuditActivity(w http.ResponseWriter, r *http.Request) {
	role, ok := activityRole(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	if !activityCanExport(role) {
		writeError(w, http.StatusForbidden, "activity_export_restricted", "Activity exports require Owner or Administrator access.")
		return
	}
	copy := r.Clone(r.Context())
	query := copy.URL.Query()
	query.Set("limit", "250")
	query.Del("cursor")
	copy.URL.RawQuery = query.Encode()

	window, err := parseActivityWindow(copy)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
		return
	}
	clauses := []string{"a.created_at >= $1", "a.created_at < $2"}
	args := []any{window.From, window.To}
	if err := appendActivityUUIDFilter(&clauses, &args, "a.user_id = $%d", queryValue(copy, "actor")); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_actor_invalid", err.Error())
		return
	}
	appendActivityFilter(&clauses, &args, "a.action = $%d", queryValue(copy, "action"))
	appendActivityFilter(&clauses, &args, "a.resource_type = $%d", queryValue(copy, "resourceType"))
	appendActivityFilter(&clauses, &args, "a.result = $%d", queryValue(copy, "result"))
	if search := queryValue(copy, "search"); search != "" {
		args = append(args, "%"+search+"%")
		p := len(args)
		clauses = append(clauses, fmt.Sprintf("(COALESCE(a.summary,'') ILIKE $%d OR a.action ILIKE $%d OR a.resource_type ILIKE $%d OR COALESCE(a.resource_name,'') ILIKE $%d OR COALESCE(a.resource_id,'') ILIKE $%d OR COALESCE(u.name,'') ILIKE $%d)", p, p, p, p, p, p))
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT a.created_at,COALESCE(u.name,'System'),COALESCE(u.username,''),a.action,a.resource_type,
		       COALESCE(a.resource_id,''),COALESCE(a.resource_name,''),a.result,COALESCE(host(a.ip_address),''),
		       COALESCE(a.request_id,''),COALESCE(a.summary,''),a.metadata
		FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
		WHERE `+strings.Join(clauses, " AND ")+` ORDER BY a.created_at DESC,a.id DESC LIMIT 10000`, args...)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="tilecast-audit-log.csv"`)
	writer := csv.NewWriter(w)
	_ = writer.Write([]string{"Timestamp", "Actor", "Username", "Action", "Resource type", "Resource ID", "Resource name", "Result", "IP address", "Request ID", "Summary", "Metadata"})
	for rows.Next() {
		var created time.Time
		var actor, username, action, resourceType, resourceID, resourceName, result, ip, requestID, summary string
		var metadata []byte
		if rows.Scan(&created, &actor, &username, &action, &resourceType, &resourceID, &resourceName, &result, &ip, &requestID, &summary, &metadata) != nil {
			continue
		}
		if summary == "" {
			summary = auditPlainLanguage(action, resourceType, resourceName)
		}
		clean, _ := json.Marshal(activityMetadata(metadata, false, "owner"))
		_ = writer.Write([]string{created.UTC().Format(time.RFC3339), actor, username, action, resourceType, resourceID, resourceName, result, ip, requestID, summary, string(clean)})
	}
	writer.Flush()
}

func (s *server) lookupAuditResourceName(ctx context.Context, resourceType, resourceID string) string {
	id, err := uuid.Parse(resourceID)
	if err != nil {
		return ""
	}
	var query string
	switch resourceType {
	case "screen":
		query = `SELECT name FROM screens WHERE id=$1`
	case "screen_group", "group":
		query = `SELECT name FROM screen_groups WHERE id=$1`
	case "playlist":
		query = `SELECT name FROM playlists WHERE id=$1`
	case "layout":
		query = `SELECT name FROM layouts WHERE id=$1`
	case "schedule":
		query = `SELECT name FROM schedules WHERE id=$1`
	case "asset", "media", "source", "widget":
		query = `SELECT name FROM assets WHERE id=$1`
	case "user":
		query = `SELECT name FROM users WHERE id=$1`
	default:
		return ""
	}
	var name string
	_ = s.db.QueryRow(ctx, query, id).Scan(&name)
	return name
}

func auditPlainLanguage(action, resourceType, resourceName string) string {
	label := strings.TrimSpace(resourceName)
	if label == "" {
		label = strings.ReplaceAll(resourceType, "_", " ")
	}
	verb := action
	if index := strings.LastIndex(action, "."); index >= 0 {
		verb = action[index+1:]
	}
	verb = strings.ReplaceAll(verb, "_", " ")
	if verb == "" {
		verb = "changed"
	}
	return strings.ToUpper(verb[:1]) + verb[1:] + " " + label
}

func (s *server) recordHTTPAudit(r *http.Request, userID *uuid.UUID, action, resourceType, resourceID, resourceName, result, summary string, metadata map[string]any, sensitive bool) {
	encoded, _ := json.Marshal(sanitizeActivityMap(metadata, true))
	_, _ = s.db.Exec(activityContextWithoutCancel(r.Context()), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,result,ip_address,request_id,summary,metadata,metadata_sensitive)
		VALUES($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),$7,NULLIF($8,'')::inet,NULLIF($9,''),NULLIF($10,''),$11::jsonb,$12)`,
		uuid.New(), userID, action, resourceType, resourceID, resourceName, result, remoteIP(r.RemoteAddr), middleware.GetReqID(r.Context()), summary, string(encoded), sensitive)
}

type auditStatusWriter struct {
	http.ResponseWriter
	status int
}

func (w *auditStatusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *auditStatusWriter) Write(value []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(value)
}

func (s *server) auditAuthentication(next http.Handler, w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/v1/auth/login" && r.URL.Path != "/api/v1/auth/logout" {
		next.ServeHTTP(w, r)
		return
	}
	var username string
	var session *auth.Session
	if r.URL.Path == "/api/v1/auth/login" {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var input struct {
			Username string `json:"username"`
		}
		_ = json.Unmarshal(raw, &input)
		username = strings.ToLower(strings.TrimSpace(input.Username))
	} else if cookie, err := r.Cookie(s.cookieName); err == nil {
		if current, err := s.auth.Authenticate(r.Context(), cookie.Value); err == nil {
			session = &current
		}
	}
	wrapped := &auditStatusWriter{ResponseWriter: w}
	next.ServeHTTP(wrapped, r)
	status := wrapped.status
	if status == 0 {
		status = http.StatusOK
	}
	result := "success"
	if status >= 400 {
		result = "failure"
	}
	if r.URL.Path == "/api/v1/auth/login" {
		var userID *uuid.UUID
		var name string
		if result == "success" {
			var id uuid.UUID
			if s.db.QueryRow(activityContextWithoutCancel(r.Context()), `SELECT id,name FROM users WHERE lower(username)=$1`, username).Scan(&id, &name) == nil {
				userID = &id
			}
		}
		s.recordHTTPAudit(r, userID, "auth.login", "session", "", name, result, "User signed in", map[string]any{"username": username, "httpStatus": status}, true)
		return
	}
	if session != nil {
		metadata, _ := json.Marshal(map[string]any{"httpStatus": status})
		tag, _ := s.db.Exec(activityContextWithoutCancel(r.Context()), `
			UPDATE audit_logs SET resource_name=$2,result=$3,ip_address=NULLIF($4,'')::inet,request_id=NULLIF($5,''),summary='User signed out',metadata=metadata||$6::jsonb,metadata_sensitive=TRUE
			WHERE id=(SELECT id FROM audit_logs WHERE user_id=$1 AND action='auth.logout' AND created_at>now()-interval '1 minute' ORDER BY created_at DESC LIMIT 1)`,
			session.User.ID, session.User.Name, result, remoteIP(r.RemoteAddr), middleware.GetReqID(r.Context()), string(metadata))
		if tag.RowsAffected() == 0 {
			s.recordHTTPAudit(r, &session.User.ID, "auth.logout", "session", "", session.User.Name, result, "User signed out", map[string]any{"httpStatus": status}, true)
		}
	}
}
