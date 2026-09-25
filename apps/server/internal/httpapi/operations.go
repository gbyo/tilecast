package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

var commandTypes = map[string]bool{
	"sync_now": true, "reload_playback": true, "identify_screen": true,
	"clear_media_cache": true, "clear_website_data": true,
	"disable_playback": true, "enable_playback": true,
	"install_player_update": true,
	"retry_player_recovery": true, "exit_safe_mode": true,
	"power_assist_sleep": true, "power_assist_wake": true,
	"retry_current_item": true, "skip_current_item": true,
	"recreate_renderer": true, "recreate_playback_session": true,
	"restart_activity": true, "restart_player_process": true,
	"resynchronize_player": true, "run_player_self_test": true,
	// Linux (systemd) autostart. Android players answer unsupported_command.
	"install_autostart": true, "remove_autostart": true,
	// External presentation is a player capability, not playlist content.
	"prepare_airplay_session": true, "stop_airplay_session": true,
	"test_airplay_support": true,
	"display_power_on":     true, "display_power_off": true,
	"display_set_input": true, "display_set_volume": true,
	"display_mute": true, "display_unmute": true,
	"display_set_brightness": true, "display_probe": true,
	// Presentation Networks. Both payloads carry identifiers and a timeout only:
	// the Wi-Fi credential is fetched by the player over its own authenticated
	// channel and never enters a durable command row.
	"provision_presentation_network": true, "test_presentation_network": true,
}

type takeoverInput struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	PlaylistID  uuid.UUID   `json:"playlistId"`
	ScreenIDs   []uuid.UUID `json:"screenIds"`
	GroupIDs    []uuid.UUID `json:"groupIds"`
	ExpiresAt   time.Time   `json:"expiresAt"`
	Password    string      `json:"password"`
}

type commandInput struct {
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	IdempotencyKey *uuid.UUID      `json:"idempotencyKey"`
}

func (s *server) listTakeovers(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.Exec(r.Context(), `UPDATE takeovers SET status='expired',updated_at=now() WHERE status='active' AND expires_at<=now()`); err != nil {
		s.internalError(w, r, err)
		return
	}
	rows, err := s.db.Query(r.Context(), `SELECT e.id,e.name,e.description,e.playlist_id,p.name,e.status,e.activated_at,e.expires_at,e.cancelled_at,e.cancellation_reason,
		(SELECT count(*) FROM takeover_screen_states es WHERE es.takeover_id=e.id),
		(SELECT count(*) FROM takeover_screen_states es WHERE es.takeover_id=e.id AND es.state='active'),
		(SELECT count(*) FROM takeover_screen_states es WHERE es.takeover_id=e.id AND es.state IN ('pending','notified','preparing','ready')),
		(SELECT count(*) FROM takeover_screen_states es WHERE es.takeover_id=e.id AND es.state='failed')
		FROM takeovers e JOIN playlists p ON p.id=e.playlist_id ORDER BY e.created_at DESC LIMIT 100`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, playlist uuid.UUID
		var name, description, playlistName, status, reason string
		var activated, cancelled *time.Time
		var expires time.Time
		var affected, active, preparing, failed int
		if err = rows.Scan(&id, &name, &description, &playlist, &playlistName, &status, &activated, &expires, &cancelled, &reason, &affected, &active, &preparing, &failed); err != nil {
			s.internalError(w, r, err)
			return
		}
		items = append(items, map[string]any{"id": id, "name": name, "description": description, "playlistId": playlist, "playlistName": playlistName, "status": status, "activatedAt": activated, "expiresAt": expires, "cancelledAt": cancelled, "cancellationReason": reason, "affectedCount": affected, "activeCount": active, "preparingCount": preparing, "failedCount": failed})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items, "total": len(items)}})
}

func (s *server) getTakeover(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var item map[string]any
	_ = item
	rows, err := s.db.Query(r.Context(), `SELECT es.screen_id,sc.name,es.manifest_version,es.state,es.last_updated_at,es.failure_code,es.safe_failure_message,es.prepared_at,es.activated_at,es.restored_at FROM takeover_screen_states es JOIN screens sc ON sc.id=es.screen_id WHERE es.takeover_id=$1 ORDER BY sc.name,sc.id`, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	states := []map[string]any{}
	for rows.Next() {
		var screen uuid.UUID
		var name, state string
		var version int64
		var updated time.Time
		var code, message *string
		var prepared, activated, restored *time.Time
		if rows.Scan(&screen, &name, &version, &state, &updated, &code, &message, &prepared, &activated, &restored) == nil {
			states = append(states, map[string]any{"screenId": screen, "screenName": name, "manifestVersion": version, "state": state, "lastUpdatedAt": updated, "failureCode": code, "failureMessage": message, "preparedAt": prepared, "activatedAt": activated, "restoredAt": restored})
		}
	}
	var name, description, status, playlistName, reason string
	var playlist uuid.UUID
	var activated, cancelled *time.Time
	var expires time.Time
	if err = s.db.QueryRow(r.Context(), `SELECT e.name,e.description,e.status,e.playlist_id,p.name,e.activated_at,e.expires_at,e.cancelled_at,e.cancellation_reason FROM takeovers e JOIN playlists p ON p.id=e.playlist_id WHERE e.id=$1`, id).Scan(&name, &description, &status, &playlist, &playlistName, &activated, &expires, &cancelled, &reason); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "takeover_not_found", "Takeover was not found.")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"id": id, "name": name, "description": description, "status": status, "playlistId": playlist, "playlistName": playlistName, "activatedAt": activated, "expiresAt": expires, "cancelledAt": cancelled, "cancellationReason": reason, "screens": states}})
}

func (s *server) activateTakeover(w http.ResponseWriter, r *http.Request) {
	var input takeoverInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	now := time.Now().UTC()
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	if s.settings != nil {
		document, _ := s.settings.Organization(r.Context())
		if required, _ := document.Values["takeover.reauthentication_required"].(bool); required && !s.auth.VerifyCurrentPassword(r.Context(), user.ID, input.Password) {
			writeError(w, 401, "reauthentication_required", "Confirm your current password before activating a takeover.")
			return
		}
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len(input.Name) > 180 || len(input.Description) > 2000 {
		writeError(w, 422, "validation_failed", "Takeover name or description is invalid.")
		return
	}
	if len(input.ScreenIDs)+len(input.GroupIDs) == 0 {
		writeError(w, 422, "takeover_target_required", "Select at least one screen or group.")
		return
	}
	if len(input.ScreenIDs)+len(input.GroupIDs) > s.operations.MaxTakeoverTargets {
		writeError(w, 422, "takeover_target_required", fmt.Sprintf("A takeover may have at most %d targets.", s.operations.MaxTakeoverTargets))
		return
	}
	maxTakeoverMinutes := s.runtimeInt(r, "takeover.maximum_duration_minutes", s.operations.MaxTakeoverDurationHours*60)
	if !input.ExpiresAt.After(now) || input.ExpiresAt.Sub(now) > time.Duration(maxTakeoverMinutes)*time.Minute {
		writeError(w, 422, "takeover_duration_exceeded", fmt.Sprintf("Takeover expiration must be within %d minutes.", maxTakeoverMinutes))
		return
	}
	var org uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT organization_id FROM playlists WHERE id=$1 AND deleted_at IS NULL`, input.PlaylistID).Scan(&org); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 422, "takeover_playlist_not_ready", "Select a ready, non-empty playlist.")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	// Activation is immediate. Use the shared strict validator so a layout
	// item, nested playlist, unavailable asset, or missing widget fallback
	// cannot bypass readiness merely because playlist_items.asset_id is NULL.
	if err := s.playlists.ValidatePresentationNow(r.Context(), "playlist", input.PlaylistID, now); err != nil {
		writeError(w, 422, "takeover_playlist_not_ready", "Select a ready, non-empty playlist.")
		return
	}
	// A takeover is the most disruptive thing in Studio, so scope is checked
	// before anything is written.
	if !s.authorizeScreenList(w, r, input.ScreenIDs, input.GroupIDs) {
		return
	}
	if err := s.playlists.ValidatePresentationTargets(r.Context(), &input.PlaylistID, nil, input.ScreenIDs, input.GroupIDs); err != nil {
		s.writePlaylistError(w, r, err)
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	id := uuid.New()
	if _, err = tx.Exec(r.Context(), `INSERT INTO takeovers(id,organization_id,name,description,playlist_id,status,activated_by,activated_at,expires_at)VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8)`, id, org, input.Name, input.Description, input.PlaylistID, user.ID, now, input.ExpiresAt); err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, screen := range uniqueUUIDs(input.ScreenIDs) {
		if _, err = tx.Exec(r.Context(), `INSERT INTO takeover_targets(takeover_id,target_type,screen_id) SELECT $1,'screen',$2 WHERE EXISTS(SELECT 1 FROM screens WHERE id=$2 AND organization_id=$3)`, id, screen, org); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	for _, group := range uniqueUUIDs(input.GroupIDs) {
		if _, err = tx.Exec(r.Context(), `INSERT INTO takeover_targets(takeover_id,target_type,screen_group_id) SELECT $1,'group',$2 WHERE EXISTS(SELECT 1 FROM screen_groups WHERE id=$2 AND organization_id=$3 AND deleted_at IS NULL)`, id, group, org); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	screens, err := takeoverScreens(r.Context(), tx, org, input.ScreenIDs, input.GroupIDs)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if len(screens) == 0 {
		writeError(w, 422, "takeover_target_required", "No eligible screens matched the targets.")
		return
	}
	replacedRows, err := tx.Query(r.Context(), `SELECT DISTINCT es.takeover_id FROM takeover_screen_states es JOIN takeovers e ON e.id=es.takeover_id WHERE es.screen_id=ANY($1) AND e.status='active' AND e.id<>$2 AND es.state NOT IN ('restored','cancelled','expired')`, screens, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	replacedIDs := []uuid.UUID{}
	for replacedRows.Next() {
		var replaced uuid.UUID
		if err = replacedRows.Scan(&replaced); err != nil {
			replacedRows.Close()
			s.internalError(w, r, err)
			return
		}
		replacedIDs = append(replacedIDs, replaced)
		if _, err = tx.Exec(r.Context(), `UPDATE takeovers SET status='cancelled',cancelled_at=now(),cancellation_reason='Replaced by another Takeover',updated_at=now() WHERE id=$1 AND status='active'`, replaced); err != nil {
			replacedRows.Close()
			s.internalError(w, r, err)
			return
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'takeover.replaced','takeover',$3)`, uuid.New(), user.ID, replaced.String()); err != nil {
			replacedRows.Close()
			s.internalError(w, r, err)
			return
		}
	}
	replacedRows.Close()
	if err = replacedRows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	versions := map[uuid.UUID]int64{}
	for _, screen := range screens {
		if _, err = tx.Exec(r.Context(), `UPDATE takeover_screen_states SET state='restored',restored_at=now(),last_updated_at=now() WHERE screen_id=$1 AND takeover_id=ANY($2) AND state NOT IN ('restored','cancelled','expired')`, screen, replacedIDs); err != nil {
			s.internalError(w, r, err)
			return
		}
		var version int64
		if err = tx.QueryRow(r.Context(), `UPDATE screen_manifest_state SET manifest_version=manifest_version+1,changed_at=now(),change_reason='takeover.activated' WHERE screen_id=$1 RETURNING manifest_version`, screen).Scan(&version); err != nil {
			s.internalError(w, r, err)
			return
		}
		versions[screen] = version
		_, err = tx.Exec(r.Context(), `INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state)VALUES($1,$2,$3,'pending')`, id, screen, version)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'takeover.activated','takeover',$3)`, uuid.New(), user.ID, id.String()); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	// Emergency takeover preempts the lower-priority external presentation.
	// For groups this stops every participant through the session's state rows.
	s.stopAirplayForScreens(r.Context(), screens, user.ID, "emergency_takeover")
	for _, screen := range screens {
		version := versions[screen]
		s.devices.Notify(screen, map[string]any{"type": "takeover.changed", "takeoverId": id, "manifestVersion": version})
		s.devices.Notify(screen, map[string]any{"type": "manifest.changed", "manifestVersion": version})
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{"id": id, "status": "active", "affectedCount": len(screens), "expiresAt": input.ExpiresAt}})
}

func (s *server) cancelTakeover(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if len(body.Reason) > 1000 {
		writeError(w, 422, "validation_failed", "Cancellation reason is too long.")
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	tag, err := tx.Exec(r.Context(), `UPDATE takeovers SET status='cancelled',cancelled_by=$2,cancelled_at=now(),cancellation_reason=$3,updated_at=now() WHERE id=$1 AND status='active'`, id, user.ID, strings.TrimSpace(body.Reason))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, 409, "takeover_expired", "Takeover is no longer active.")
		return
	}
	rows, err := tx.Query(r.Context(), `UPDATE takeover_screen_states SET state='cancelled',restored_at=now(),last_updated_at=now() WHERE takeover_id=$1 RETURNING screen_id`, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	screens := []uuid.UUID{}
	for rows.Next() {
		var screen uuid.UUID
		if err = rows.Scan(&screen); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		screens = append(screens, screen)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	versions := map[uuid.UUID]int64{}
	for _, screen := range screens {
		var version int64
		if err = tx.QueryRow(r.Context(), `UPDATE screen_manifest_state SET manifest_version=manifest_version+1,changed_at=now(),change_reason='takeover.cancelled' WHERE screen_id=$1 RETURNING manifest_version`, screen).Scan(&version); err != nil {
			s.internalError(w, r, err)
			return
		}
		versions[screen] = version
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'takeover.cancelled','takeover',$3)`, uuid.New(), user.ID, id.String()); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, screen := range screens {
		version := versions[screen]
		s.devices.Notify(screen, map[string]any{"type": "takeover.changed", "takeoverId": id, "manifestVersion": version})
		s.devices.Notify(screen, map[string]any{"type": "manifest.changed", "manifestVersion": version})
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"id": id, "status": "cancelled"}})
}

func (s *server) createPlayerCommand(w http.ResponseWriter, r *http.Request) {
	screen, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input commandInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	payload, err := s.validateCommand(input.Type, input.Payload)
	if err != nil {
		writeError(w, 422, "command_invalid_payload", err.Error())
		return
	}
	if input.Type == "test_presentation_network" {
		// The Presentation Network test API is what verifies that the named
		// network is actually assigned to this screen, and that the screen is not
		// mid-AirPlay. A generic command escape hatch would skip both checks.
		writeError(w, http.StatusForbidden, "presentation_network_api_required", "Use the Presentation Network test API to run a connection test.")
		return
	}
	if input.Type == "prepare_airplay_session" || input.Type == "stop_airplay_session" {
		// AirPlay commands carry a temporary PIN/device identity and must be
		// issued only by the session coordinator after it has resolved the target
		// membership and authorization. Do not expose a generic command escape
		// hatch that can advertise an arbitrary receiver on a screen.
		writeError(w, http.StatusForbidden, "airplay_session_api_required", "Use the AirPlay Present session API for AirPlay activation and stop commands.")
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	key := uuid.New()
	if input.IdempotencyKey != nil {
		key = *input.IdempotencyKey
	}
	id, expires, err := s.queueCommand(r.Context(), screen, user.ID, input.Type, payload, key)
	if errors.Is(err, errScreenNotFound) {
		writeError(w, 404, "screen_not_found", "Screen was not found.")
		return
	}
	if errors.Is(err, errCommandLimit) {
		writeError(w, 429, "command_limit_reached", "This screen has reached its pending-command limit.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": map[string]any{"id": id, "state": "pending", "expiresAt": expires}})
}

func (s *server) listScreenCommands(w http.ResponseWriter, r *http.Request) {
	screen, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	s.expireCommands(r)
	rows, err := s.db.Query(r.Context(), `SELECT id,type,payload,state,created_at,expires_at,delivered_at,acknowledged_at,completed_at,safe_result_code,safe_result_message FROM player_commands WHERE screen_id=$1 ORDER BY created_at DESC LIMIT 50`, screen)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var typ, state string
		var payload []byte
		var created, expires time.Time
		var delivered, ack, completed *time.Time
		var code, message *string
		if rows.Scan(&id, &typ, &payload, &state, &created, &expires, &delivered, &ack, &completed, &code, &message) == nil {
			var body any
			_ = json.Unmarshal(payload, &body)
			items = append(items, map[string]any{"id": id, "type": typ, "payload": body, "state": state, "createdAt": created, "expiresAt": expires, "deliveredAt": delivered, "acknowledgedAt": ack, "completedAt": completed, "resultCode": code, "resultMessage": message})
		}
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"items": items, "total": len(items)}})
}

func (s *server) cancelPlayerCommand(w http.ResponseWriter, r *http.Request) {
	screen, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	command, ok := urlUUID(w, r, "commandId")
	if !ok {
		return
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE player_commands SET state='cancelled',completed_at=now(),updated_at=now() WHERE id=$1 AND screen_id=$2 AND state IN ('pending','delivered','acknowledged')`, command, screen)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, 409, "command_already_completed", "Command cannot be cancelled.")
		return
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"id": command, "state": "cancelled"}})
}

func (s *server) playerCommands(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	s.expireCommands(r)
	s.expireAirplaySessions(r.Context())
	rows, err := s.db.Query(r.Context(), `
		WITH delivered AS (
			UPDATE player_commands
			SET
				state = CASE
					WHEN state = 'pending' THEN 'delivered'
					ELSE state
				END,
				delivered_at = COALESCE(delivered_at, now()),
				attempt_count = attempt_count + 1,
				updated_at = now()
			WHERE
				screen_id = $1
				AND state IN ('pending', 'delivered', 'acknowledged', 'running')
				AND expires_at > now()
			RETURNING
				id,
				type,
				payload,
				idempotency_key,
				state,
				created_at,
				expires_at
		)
		SELECT
			id,
			type,
			payload,
			idempotency_key,
			state,
			created_at,
			expires_at
		FROM delivered
		ORDER BY created_at, id
	`, principal.ScreenID)
	if err != nil {
		s.logger.Error("player command poll failed",
			"operation", "player_commands_poll",
			"error", err,
			"request_id", middleware.GetReqID(r.Context()),
			"path", r.URL.Path,
			"screen_id", principal.ScreenID,
		)
		writeError(w, http.StatusInternalServerError, "internal_error", "Tilecast could not complete the request.")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, key uuid.UUID
		var typ, state string
		var payload []byte
		var created, expires time.Time
		if err := rows.Scan(&id, &typ, &payload, &key, &state, &created, &expires); err != nil {
			s.internalError(w, r, err)
			return
		}
		var body any
		_ = json.Unmarshal(payload, &body)
		items = append(items, map[string]any{"id": id, "type": typ, "payload": body, "idempotencyKey": key, "state": state, "createdAt": created, "expiresAt": expires})
	}
	if err := rows.Err(); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"items": items}})
}

func (s *server) acknowledgePlayerCommand(w http.ResponseWriter, r *http.Request) {
	s.updatePlayerCommand(w, r, "acknowledged", nil)
}
func (s *server) resultPlayerCommand(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Success bool   `json:"success"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if len(body.Code) > 80 || len(body.Message) > 240 {
		writeError(w, 422, "command_invalid_payload", "Command result is too long.")
		return
	}
	state := "failed"
	if body.Success {
		state = "succeeded"
	}
	s.updatePlayerCommand(w, r, state, &body)
}

func (s *server) updatePlayerCommand(w http.ResponseWriter, r *http.Request, state string, result any) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var code, message string
	if result != nil {
		raw, _ := json.Marshal(result)
		var body struct{ Code, Message string }
		_ = json.Unmarshal(raw, &body)
		code = body.Code
		message = body.Message
	}
	var tag pgconn.CommandTag
	var err error
	if state == "acknowledged" {
		tag, err = s.db.Exec(r.Context(), `UPDATE player_commands SET state='acknowledged',acknowledged_at=COALESCE(acknowledged_at,now()),updated_at=now() WHERE id=$1 AND screen_id=$2 AND state IN ('pending','delivered','acknowledged') AND expires_at>now()`, id, principal.ScreenID)
	} else {
		tag, err = s.db.Exec(r.Context(), `UPDATE player_commands SET state=$3,started_at=COALESCE(started_at,now()),completed_at=now(),safe_result_code=NULLIF($4,''),safe_result_message=NULLIF($5,''),updated_at=now() WHERE id=$1 AND screen_id=$2 AND state IN ('delivered','acknowledged','running') AND expires_at>now()`, id, principal.ScreenID, state, code, message)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if tag.RowsAffected() == 0 {
		var existing string
		if s.db.QueryRow(r.Context(), `SELECT state FROM player_commands WHERE id=$1 AND screen_id=$2`, id, principal.ScreenID).Scan(&existing) == nil && (existing == "succeeded" || existing == "failed") {
			writeJSON(w, 200, map[string]any{"data": map[string]any{"id": id, "state": existing}})
			return
		}
		writeError(w, 409, "command_expired", "Command is expired, cancelled, or already completed.")
		return
	}
	if state != "acknowledged" {
		_, _ = s.db.Exec(r.Context(), `UPDATE screen_player_status SET last_command_id=$2,last_command_state=$3,last_command_result=NULLIF($4,''),last_command_completed_at=now(),playback_disabled=CASE WHEN $4='playback_disabled' THEN true WHEN $4='playback_enabled' THEN false ELSE playback_disabled END WHERE screen_id=$1`, principal.ScreenID, id, state, code)
		s.recordDisplayControlCommandResult(r.Context(), id, state, code, message)
		s.recordAirplayCommandResult(r.Context(), id, state, code, message)
		action := "command.failed"
		if state == "succeeded" {
			action = "command.completed"
		}
		_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,action,resource_type,resource_id)VALUES($1,$2,'player_command',$3)`, uuid.New(), action, id.String())
	}
	writeJSON(w, 200, map[string]any{"data": map[string]any{"id": id, "state": state}})
}

func (s *server) validateCommand(typ string, raw json.RawMessage) ([]byte, error) {
	if !commandTypes[typ] {
		return nil, errors.New("command type is not supported")
	}
	if len(raw) == 0 {
		raw = []byte(`{}`)
	}
	maxPayload := 2048
	if typ == "prepare_airplay_session" {
		// A group command carries one bounded destination per display. It is
		// still deliberately small and never contains a shell command.
		maxPayload = 8192
	}
	if len(raw) > maxPayload {
		return nil, errors.New("command payload is too large")
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, errors.New("command payload must be an object")
	}
	switch typ {
	case "identify_screen":
		for key := range object {
			if key != "durationSeconds" {
				return nil, errors.New("identify screen only accepts durationSeconds")
			}
		}
		duration, ok := object["durationSeconds"].(float64)
		maxIdentify := s.operations.MaxIdentifySeconds
		if !ok || duration < 10 || duration > float64(maxIdentify) || duration != float64(int(duration)) {
			return nil, fmt.Errorf("identify duration must be 10 to %d seconds", maxIdentify)
		}
	case "install_player_update":
		allowed := map[string]bool{"deploymentId": true, "releaseId": true, "expectedVersionCode": true, "expectedApkSha256": true, "expectedArtifactSha256": true, "installationMode": true, "maintenanceWindowStart": true}
		for key := range object {
			if !allowed[key] {
				return nil, errors.New("player update payload contains an unsupported field")
			}
		}
		if _, err := uuid.Parse(fmt.Sprint(object["deploymentId"])); err != nil {
			return nil, errors.New("player update deployment ID is invalid")
		}
		if _, err := uuid.Parse(fmt.Sprint(object["releaseId"])); err != nil {
			return nil, errors.New("player update release ID is invalid")
		}
		version, versionOK := object["expectedVersionCode"].(float64)
		// Accept either the Android (expectedApkSha256) or the platform-neutral
		// (expectedArtifactSha256) hash key; the deployment orchestrator writes both.
		hash, hashOK := object["expectedApkSha256"].(string)
		if !hashOK {
			hash, hashOK = object["expectedArtifactSha256"].(string)
		}
		mode, modeOK := object["installationMode"].(string)
		if !versionOK || version <= 0 || version != float64(int64(version)) || !hashOK || len(hash) != 64 || !modeOK || (mode != "download_only" && mode != "install_now" && mode != "maintenance_window") {
			return nil, errors.New("player update payload is invalid")
		}
	case "prepare_airplay_session", "stop_airplay_session":
		if err := validateAirplayCommandPayload(typ, object); err != nil {
			return nil, err
		}
	case "test_airplay_support":
		if len(object) > 0 {
			return nil, errors.New("AirPlay support test does not accept a payload")
		}
	case "provision_presentation_network":
		// "Reconcile your Presentation Network state now." The desired state is
		// durable configuration; this command only makes a player act promptly,
		// so it deliberately carries nothing that could be used to point a player
		// at a network it was not assigned.
		if len(object) > 0 {
			return nil, errors.New("presentation network provisioning does not accept a payload")
		}
	case "test_presentation_network":
		allowed := map[string]bool{"presentationNetworkId": true, "timeoutSeconds": true}
		for key := range object {
			if !allowed[key] {
				return nil, errors.New("presentation network test payload contains an unsupported field")
			}
		}
		if _, err := uuid.Parse(fmt.Sprint(object["presentationNetworkId"])); err != nil {
			return nil, errors.New("presentation network ID is invalid")
		}
		timeout, ok := object["timeoutSeconds"].(float64)
		if !ok || timeout < 15 || timeout > 180 || timeout != float64(int(timeout)) {
			return nil, errors.New("presentation network test timeout must be 15 to 180 seconds")
		}
	case "display_power_on", "display_power_off", "display_set_input", "display_set_volume", "display_mute", "display_unmute", "display_set_brightness", "display_probe":
		if err := displaycontrol.ValidateCommandPayload(typ, object); err != nil {
			return nil, err
		}
	default:
		if len(object) > 0 {
			return nil, errors.New("this command does not accept a payload")
		}
	}
	return json.Marshal(object)
}
func (s *server) runtimeInt(r *http.Request, key string, fallback int) int {
	return s.runtimeIntContext(r.Context(), key, fallback)
}

func (s *server) runtimeIntContext(ctx context.Context, key string, fallback int) int {
	if s.settings == nil {
		return fallback
	}
	document, err := s.settings.Organization(ctx)
	if err != nil {
		return fallback
	}
	if value, ok := document.Values[key].(float64); ok {
		return int(value)
	}
	return fallback
}
func uniqueUUIDs(values []uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	out := []uuid.UUID{}
	for _, value := range values {
		if value != uuid.Nil && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}
func (s *server) expireCommands(r *http.Request) {
	_, _ = s.db.Exec(r.Context(), `UPDATE player_commands SET state='expired',completed_at=now(),updated_at=now() WHERE state IN ('pending','delivered','acknowledged','running') AND expires_at<=now()`)
	_, _ = s.db.Exec(r.Context(), `DELETE FROM player_commands WHERE completed_at<now()-make_interval(days=>$1)`, s.operations.CommandRetentionDays)
}

// Command enqueueing lives here, once. Bulk sending goes through the same
// function as single sending, so the pending-command limit, the idempotency
// key, the audit entries, and the socket wake cannot drift apart.
var (
	errScreenNotFound = errors.New("screen not found")
	errCommandLimit   = errors.New("pending command limit reached")
)

func (s *server) queueCommand(ctx context.Context, screen, user uuid.UUID, commandType string, payload []byte, idempotencyKey uuid.UUID) (uuid.UUID, time.Time, error) {
	var org uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT organization_id FROM screens WHERE id=$1`, screen).Scan(&org); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, time.Time{}, errScreenNotFound
	} else if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	var pending int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM player_commands WHERE screen_id=$1 AND state IN ('pending','delivered','acknowledged','running') AND expires_at>now()`, screen).Scan(&pending)
	if pending >= s.operations.MaxPendingCommands {
		return uuid.Nil, time.Time{}, errCommandLimit
	}
	id := uuid.New()
	expires := time.Now().Add(time.Duration(s.runtimeIntContext(ctx, "commands.default_expiry_minutes", s.operations.DefaultCommandExpiryMinutes)) * time.Minute)
	if err := s.db.QueryRow(ctx, `INSERT INTO player_commands(id,organization_id,screen_id,type,payload,idempotency_key,created_by,expires_at)VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT(screen_id,idempotency_key) DO UPDATE SET updated_at=player_commands.updated_at RETURNING id`, id, org, screen, commandType, string(payload), idempotencyKey, user, expires).Scan(&id); err != nil {
		return uuid.Nil, time.Time{}, err
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'command.created','player_command',$3)`, uuid.New(), user, id.String())
	if action := map[string]string{"clear_media_cache": "media.cache_clear_requested", "clear_website_data": "website.data_clear_requested", "disable_playback": "playback.disable_requested", "enable_playback": "playback.enable_requested"}[commandType]; action != "" {
		_, _ = s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,$3,'screen',$4)`, uuid.New(), user, action, screen.String())
	}
	s.devices.Notify(screen, map[string]any{"type": "commands.available"})
	return id, expires, nil
}

// EnqueueCommand satisfies fleetops.CommandEnqueuer. Each screen gets its own
// idempotency key: one bulk operation is many commands, and sharing a key would
// collapse them into one row.
func (s *server) EnqueueCommand(ctx context.Context, screenID, userID uuid.UUID, commandType string, payload json.RawMessage) error {
	validated, err := s.validateCommand(commandType, payload)
	if err != nil {
		return err
	}
	_, _, err = s.queueCommand(ctx, screenID, userID, commandType, validated, uuid.New())
	return err
}

// takeoverScreens resolves a takeover's screen and group targets to the
// organization's live screens. Every parameter is referenced: PostgreSQL
// cannot type a parameter that the statement never uses, and the pool
// prepares statements, so an unused argument fails the whole activation.
func takeoverScreens(ctx context.Context, tx pgx.Tx, org uuid.UUID, screenIDs, groupIDs []uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT s.id FROM screens s WHERE s.organization_id=$1 AND s.deleted_at IS NULL AND (s.id=ANY($2) OR EXISTS(SELECT 1 FROM screen_group_memberships m WHERE m.screen_id=s.id AND m.screen_group_id=ANY($3)))`, org, screenIDs, groupIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	screens := []uuid.UUID{}
	for rows.Next() {
		var screen uuid.UUID
		if err := rows.Scan(&screen); err != nil {
			return nil, err
		}
		screens = append(screens, screen)
	}
	return screens, rows.Err()
}
