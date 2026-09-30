package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

type settingsUpdate struct {
	Revision int64          `json:"revision"`
	Values   map[string]any `json:"values"`
}
type policyUpdate struct {
	Revision int64          `json:"revision"`
	Priority int            `json:"priority"`
	Values   map[string]any `json:"values"`
}

func (s *server) listUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `SELECT id,name,username,role,active,created_at,last_login_at FROM users ORDER BY lower(name),id`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := []auth.User{}
	for rows.Next() {
		var user auth.User
		if err := rows.Scan(&user.ID, &user.Name, &user.Username, &user.Role, &user.Active, &user.CreatedAt, &user.LastLoginAt); err != nil {
			s.internalError(w, r, err)
			return
		}
		items = append(items, user)
	}
	if err := rows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	enrolled, err := s.auth.EnrolledUserIDs(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	policy := s.mfaPolicy(r)
	entries := make([]map[string]any, 0, len(items))
	for _, user := range items {
		entries = append(entries, map[string]any{
			"id": user.ID, "name": user.Name, "username": user.Username, "role": user.Role,
			"active": user.Active, "createdAt": user.CreatedAt, "lastLoginAt": user.LastLoginAt,
			"mfaEnrolled": enrolled[user.ID],
			"mfaRequired": policy.AppliesTo(user.Role),
		})
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"items": entries, "total": len(entries)}})
}

func (s *server) getSettings(w http.ResponseWriter, r *http.Request) {
	document, err := s.settings.Organization(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": document})
}
func (s *server) updateSettings(w http.ResponseWriter, r *http.Request) {
	var body settingsUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	document, err := s.settings.UpdateOrganization(r.Context(), user.ID, body.Revision, body.Values)
	if err != nil {
		s.writeSettingsError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": document})
}
func (s *server) resetSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Revision int64  `json:"revision"`
		Category string `json:"category"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	current, err := s.settings.Organization(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	values := map[string]any{}
	for _, definition := range current.Definitions {
		if definition.Scope == settings.ScopePreference {
			continue
		}
		if body.Category != "" && definition.Category != body.Category {
			if value, ok := current.Values[definition.Key]; ok {
				values[definition.Key] = value
			}
		}
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	updated, err := s.settings.UpdateOrganization(r.Context(), user.ID, body.Revision, values)
	if err != nil {
		s.writeSettingsError(w, r, err)
		return
	}
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)VALUES($1,$2,'settings.category_reset','organization','singleton',jsonb_build_object('category',$3::text))`, uuid.New(), user.ID, body.Category)
	writeJSON(w, 200, map[string]any{"data": updated})
}
func (s *server) getPreferences(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	d, err := s.settings.Preferences(r.Context(), user.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": d})
}
func (s *server) updatePreferences(w http.ResponseWriter, r *http.Request) {
	var body settingsUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	d, err := s.settings.UpdatePreferences(r.Context(), user.ID, body.Revision, body.Values)
	if err != nil {
		s.writeSettingsError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": d})
}
func (s *server) getGroupPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	d, err := s.settings.GroupPolicy(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": d})
}
func (s *server) putGroupPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body policyUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	d, err := s.settings.PutGroupPolicy(r.Context(), user.ID, id, body.Revision, body.Priority, body.Values)
	if err != nil {
		s.writeSettingsError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": d})
}
func (s *server) deleteGroupPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	if err := s.settings.DeleteGroupPolicy(r.Context(), user.ID, id); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(204)
}
func (s *server) getScreenPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	d, err := s.settings.ScreenPolicy(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": d})
}
func (s *server) putScreenPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body policyUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	d, err := s.settings.PutScreenPolicy(r.Context(), user.ID, id, body.Revision, body.Values)
	if err != nil {
		s.writeSettingsError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": d})
}
func (s *server) deleteScreenPolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	if err := s.settings.DeleteScreenPolicy(r.Context(), user.ID, id); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(204)
}
func (s *server) getEffectivePolicy(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	d, err := s.settings.Effective(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": d})
}
func (s *server) systemStatus(w http.ResponseWriter, r *http.Request) {
	var migration string
	if err := s.db.QueryRow(r.Context(), `SELECT version_id::text FROM goose_db_version WHERE is_applied ORDER BY id DESC LIMIT 1`).Scan(&migration); err != nil {
		s.internalError(w, r, err)
		return
	}
	var postgres string
	if err := s.db.QueryRow(r.Context(), `SHOW server_version`).Scan(&postgres); err != nil {
		s.internalError(w, r, err)
		return
	}
	var pending, connected, jobs int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM player_commands WHERE state IN('pending','delivered','acknowledged','running')`).Scan(&pending); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM screens WHERE last_heartbeat_at>now()-interval '2 minutes'`).Scan(&connected); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM media_jobs WHERE status IN('queued','running')`).Scan(&jobs); err != nil {
		s.internalError(w, r, err)
		return
	}
	mediaStatus := map[string]any{"status": "not_configured"}
	if s.media != nil {
		diagnostics, err := s.media.Diagnostics()
		if err != nil {
			mediaStatus = map[string]any{
				"status":  "degraded",
				"message": "Media storage is unavailable.",
			}
		} else {
			diagnostics["status"] = "healthy"
			mediaStatus = diagnostics
		}
	}
	updateTrust := "missing"
	if s.updates != nil && s.updates.ManifestKeyConfigured() {
		updateTrust = "configured"
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"tilecastVersion": version.Display(), "channel": version.Channel, "buildCommit": version.Commit, "buildDate": version.Date, "uptimeSeconds": int64(time.Since(s.startedAt).Seconds()), "goVersion": runtime.Version(), "database": map[string]any{"status": "healthy", "migrationVersion": migration, "postgresVersion": postgres}, "media": mediaStatus, "activeProcessingJobs": jobs, "pendingCommands": pending, "connectedScreens": connected, "serverTimezone": time.Local.String(), "deployment": map[string]any{"database": "configured", "mediaStorage": "configured", "ffmpeg": "available", "updateManifestTrust": updateTrust, "restartRequired": false}}})
}
func (s *server) systemMaintenance(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimSpace(chi.URLParam(r, "action"))
	allowed := map[string]bool{"expired-upload-cleanup": true, "completed-command-cleanup": true, "retention-cleanup": true, "reconcile-config": true, "validate-media": true}
	if !allowed[action] {
		writeError(w, 422, "maintenance_action_invalid", "Maintenance action is not supported.")
		return
	}
	var operationErr error
	switch action {
	case "completed-command-cleanup":
		_, operationErr = s.db.Exec(r.Context(), `DELETE FROM player_commands WHERE completed_at<now()-interval '30 days'`)
	case "expired-upload-cleanup":
		_, operationErr = s.db.Exec(r.Context(), `INSERT INTO media_jobs(id,kind,status,run_after)VALUES(gen_random_uuid(),'clean_expired_uploads','queued',now())`)
	case "retention-cleanup":
		_, operationErr = s.db.Exec(r.Context(), `DELETE FROM device_pairing_sessions WHERE expires_at<now()-interval '30 days'`)
	case "reconcile-config":
		rows, err := s.db.Query(r.Context(), `SELECT screen_id,config_revision FROM screen_config_state`)
		operationErr = err
		if rows != nil {
			for rows.Next() {
				var id uuid.UUID
				var revision int64
				if err := rows.Scan(&id, &revision); err != nil {
					operationErr = err
					break
				}
				s.devices.ConfigChanged(id, revision)
			}
			if operationErr == nil {
				operationErr = rows.Err()
			}
			rows.Close()
		}
	case "validate-media":
		if s.media == nil {
			operationErr = errors.New("media service is unavailable")
		} else {
			_, operationErr = s.media.Diagnostics()
		}
	}
	if operationErr != nil {
		if action == "validate-media" {
			writeError(w, 503, "media_validation_failed", "Media infrastructure is unavailable.")
			return
		}
		s.internalError(w, r, operationErr)
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'system.maintenance_requested','system',$3)`, uuid.New(), user.ID, action)
	writeJSON(w, 202, map[string]any{"data": map[string]any{"action": action, "status": "accepted"}})
}

type settingsExport struct {
	SchemaVersion   int               `json:"schemaVersion"`
	ExportedAt      time.Time         `json:"exportedAt"`
	TilecastVersion string            `json:"tilecastVersion"`
	Organization    settings.Document `json:"organization"`
	GroupPolicies   []map[string]any  `json:"groupPolicies"`
	ScreenPolicies  []map[string]any  `json:"screenPolicies,omitempty"`
}

func (s *server) exportSettings(w http.ResponseWriter, r *http.Request) {
	org, err := s.settings.Organization(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	org.Definitions = nil
	export := settingsExport{1, time.Now().UTC(), version.Display(), org, []map[string]any{}, []map[string]any{}}
	rows, err := s.db.Query(r.Context(), `SELECT screen_group_id,priority,revision,policy FROM screen_group_player_policies ORDER BY screen_group_id`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var priority int
		var revision int64
		var raw []byte
		if err := rows.Scan(&id, &priority, &revision, &raw); err != nil {
			s.internalError(w, r, err)
			return
		}
		var values any
		if err := json.Unmarshal(raw, &values); err != nil {
			s.internalError(w, r, err)
			return
		}
		export.GroupPolicies = append(export.GroupPolicies, map[string]any{"screenGroupId": id, "priority": priority, "revision": revision, "values": values})
	}
	if err := rows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	rows.Close()
	screenRows, err := s.db.Query(r.Context(), `SELECT screen_id,revision,policy FROM screen_player_policies ORDER BY screen_id`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer screenRows.Close()
	for screenRows.Next() {
		var id uuid.UUID
		var revision int64
		var raw []byte
		if err := screenRows.Scan(&id, &revision, &raw); err != nil {
			s.internalError(w, r, err)
			return
		}
		var values any
		if err := json.Unmarshal(raw, &values); err != nil {
			s.internalError(w, r, err)
			return
		}
		export.ScreenPolicies = append(export.ScreenPolicies, map[string]any{"screenId": id, "revision": revision, "values": values})
	}
	if err := screenRows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": export})
}
func (s *server) previewSettingsImport(w http.ResponseWriter, r *http.Request) {
	var body settingsExport
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "settings_import_invalid", err.Error())
		return
	}
	if body.SchemaVersion != 1 {
		writeError(w, 422, "settings_import_version_unsupported", "Settings export version is not supported.")
		return
	}
	if _, err := settings.Validate(body.Organization.Values, settings.ScopeOrganization); err != nil {
		writeError(w, 422, "settings_import_invalid", err.Error())
		return
	}
	for _, entry := range append(append([]map[string]any{}, body.GroupPolicies...), body.ScreenPolicies...) {
		values, err := importValues(entry)
		if err != nil {
			writeError(w, 422, "settings_import_invalid", err.Error())
			return
		}
		if _, err = settings.Validate(values, settings.ScopePolicy); err != nil {
			writeError(w, 422, "settings_import_invalid", err.Error())
			return
		}
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"valid": true, "changedKeys": keys(body.Organization.Values), "groupPolicyCount": len(body.GroupPolicies), "screenPolicyCount": len(body.ScreenPolicies), "requiresConfirmation": true}})
}
func (s *server) applySettingsImport(w http.ResponseWriter, r *http.Request) {
	var body settingsExport
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "settings_import_invalid", err.Error())
		return
	}
	if body.SchemaVersion != 1 {
		writeError(w, 422, "settings_import_version_unsupported", "Settings export version is not supported.")
		return
	}
	current, err := s.settings.Organization(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	updated, err := s.settings.UpdateOrganization(r.Context(), user.ID, current.Revision, body.Organization.Values)
	if err != nil {
		s.writeSettingsError(w, r, err)
		return
	}
	for _, entry := range body.GroupPolicies {
		id, err := uuid.Parse(fmt.Sprint(entry["screenGroupId"]))
		if err != nil {
			writeError(w, 422, "settings_import_invalid", "Group policy target is invalid.")
			return
		}
		values, _ := importValues(entry)
		currentPolicy, _ := s.settings.GroupPolicy(r.Context(), id)
		priority := 0
		if value, ok := entry["priority"].(float64); ok {
			priority = int(value)
		}
		if _, err = s.settings.PutGroupPolicy(r.Context(), user.ID, id, currentPolicy.Revision, priority, values); err != nil {
			s.writeSettingsError(w, r, err)
			return
		}
	}
	for _, entry := range body.ScreenPolicies {
		id, err := uuid.Parse(fmt.Sprint(entry["screenId"]))
		if err != nil {
			writeError(w, 422, "settings_import_invalid", "Screen policy target is invalid.")
			return
		}
		values, _ := importValues(entry)
		currentPolicy, _ := s.settings.ScreenPolicy(r.Context(), id)
		if _, err = s.settings.PutScreenPolicy(r.Context(), user.ID, id, currentPolicy.Revision, values); err != nil {
			s.writeSettingsError(w, r, err)
			return
		}
	}
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'settings.imported','organization','singleton')`, uuid.New(), user.ID)
	writeJSON(w, 200, map[string]any{"data": updated})
}
func (s *server) writeSettingsError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, settings.ErrRevisionConflict) {
		writeError(w, 409, "settings_revision_conflict", "Settings changed in another session. Reload and try again.")
		return
	}
	message := err.Error()
	code := "invalid_setting_value"
	for _, candidate := range []string{"unknown_setting", "setting_not_allowed_at_scope", "setting_exceeds_hard_limit", "branding_asset_invalid"} {
		if strings.HasPrefix(message, candidate) {
			code = candidate
		}
	}
	if strings.Contains(message, "not found") {
		code = "not_found"
	}
	writeError(w, 422, code, message)
}
func keys(values map[string]any) []string {
	out := make([]string, 0, len(values))
	for key := range values {
		out = append(out, key)
	}
	return out
}
func importValues(entry map[string]any) (map[string]any, error) {
	raw, err := json.Marshal(entry["values"])
	if err != nil {
		return nil, err
	}
	values := map[string]any{}
	err = json.Unmarshal(raw, &values)
	return values, err
}
