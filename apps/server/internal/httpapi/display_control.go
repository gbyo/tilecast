package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

var displayControlCommandTypes = map[string]bool{
	"display_power_on": true, "display_power_off": true,
	"display_set_input": true, "display_set_volume": true,
	"display_mute": true, "display_unmute": true,
	"display_set_brightness": true, "display_probe": true,
}

// Group display actions intentionally start with the commands that are safe
// and useful for a wall operator. The per-screen command endpoint remains the
// place for input, volume, brightness, and probing until those actions have a
// group-specific payload/preview contract of their own.
var groupDisplayControlCommands = map[string]bool{
	displaycontrol.CommandPowerOn:  true,
	displaycontrol.CommandPowerOff: true,
	displaycontrol.CommandMute:     true,
	displaycontrol.CommandUnmute:   true,
}

type groupDisplayControlScreen struct {
	ScreenID     uuid.UUID         `json:"screenId"`
	Name         string            `json:"name"`
	Provider     string            `json:"provider"`
	Capabilities map[string]string `json:"capabilities"`
	Supported    bool              `json:"supported"`
	Eligible     bool              `json:"eligible"`
	Reason       string            `json:"reason,omitempty"`
}

type groupDisplayControlPreview struct {
	GroupID          uuid.UUID                   `json:"groupId"`
	GroupName        string                      `json:"groupName"`
	CommandType      string                      `json:"commandType"`
	SelectedCount    int                         `json:"selectedCount"`
	SupportedCount   int                         `json:"supportedCount"`
	UnsupportedCount int                         `json:"unsupportedCount"`
	EligibleCount    int                         `json:"eligibleCount"`
	Fingerprint      string                      `json:"fingerprint"`
	Screens          []groupDisplayControlScreen `json:"screens"`
}

type groupDisplayControlApplyInput struct {
	CommandType string `json:"commandType"`
	// Fingerprint is returned by the preview. An apply with a stale preview is
	// refused so an operator does not send a command based on old capability
	// claims after a replacement or reconnect.
	Fingerprint string `json:"fingerprint"`
}

type groupDisplayControlResult struct {
	ScreenID uuid.UUID `json:"screenId"`
	Name     string    `json:"name"`
	State    string    `json:"state"`
	Reason   string    `json:"reason,omitempty"`
	ID       uuid.UUID `json:"id,omitempty"`
}

var errDisplayControlGroupNotFound = errors.New("display control group not found")

func displayControlCapabilityForCommand(command string) (string, bool) {
	switch command {
	case displaycontrol.CommandPowerOn, displaycontrol.CommandPowerOff:
		return displaycontrol.CapabilityPower, true
	case displaycontrol.CommandMute, displaycontrol.CommandUnmute:
		return displaycontrol.CapabilityMute, true
	default:
		return "", false
	}
}

func displayControlGroupCommandValid(command string) bool {
	return groupDisplayControlCommands[command]
}

func supportsGroupDisplayControl(capabilities map[string]string, command string) bool {
	capability, valid := displayControlCapabilityForCommand(command)
	if !valid {
		return false
	}
	provider, ok := capabilities[capability]
	return ok && provider != displaycontrol.ProviderUnsupported && displaycontrol.IsProvider(provider)
}

func (s *server) loadGroupDisplayControlPreview(ctx context.Context, groupID uuid.UUID, command string) (groupDisplayControlPreview, error) {
	capability, valid := displayControlCapabilityForCommand(command)
	if !valid || !displayControlGroupCommandValid(command) {
		return groupDisplayControlPreview{}, fmt.Errorf("unsupported group display action %q", command)
	}
	var preview groupDisplayControlPreview
	preview.GroupID = groupID
	preview.CommandType = command
	if err := s.db.QueryRow(ctx, `SELECT name FROM screen_groups WHERE id=$1 AND deleted_at IS NULL`, groupID).Scan(&preview.GroupName); errors.Is(err, pgx.ErrNoRows) {
		return groupDisplayControlPreview{}, errDisplayControlGroupNotFound
	} else if err != nil {
		return groupDisplayControlPreview{}, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT s.id,s.name,COALESCE(ps.display_control_provider,'unsupported'),
		       COALESCE(ps.display_control_capabilities,'{}'::jsonb),s.enabled,
		       (s.archived_at IS NULL),
		       EXISTS(SELECT 1 FROM device_credentials c WHERE c.screen_id=s.id AND c.revoked_at IS NULL)
		FROM screen_group_memberships m
		JOIN screens s ON s.id=m.screen_id
		LEFT JOIN screen_player_status ps ON ps.screen_id=s.id
		WHERE m.screen_group_id=$1 AND s.deleted_at IS NULL
		ORDER BY lower(s.name),s.id`, groupID)
	if err != nil {
		return groupDisplayControlPreview{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var item groupDisplayControlScreen
		var raw []byte
		var enabled, active, hasCredential bool
		if err := rows.Scan(&item.ScreenID, &item.Name, &item.Provider, &raw, &enabled, &active, &hasCredential); err != nil {
			return groupDisplayControlPreview{}, err
		}
		item.Eligible = enabled && active && hasCredential
		item.Capabilities = map[string]string{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &item.Capabilities)
		}
		item.Supported = supportsGroupDisplayControl(item.Capabilities, command)
		if !item.Supported {
			item.Reason = fmt.Sprintf("Player does not report %s control.", capability)
		} else if !active {
			item.Reason = "Screen hardware is archived."
		} else if !enabled {
			item.Reason = "Screen is disabled."
		} else if !hasCredential {
			item.Reason = "Screen has no active Player credential."
		}
		if item.Supported {
			preview.SupportedCount++
		} else {
			preview.UnsupportedCount++
		}
		if item.Supported && item.Eligible {
			preview.EligibleCount++
		}
		preview.Screens = append(preview.Screens, item)
	}
	if err := rows.Err(); err != nil {
		return groupDisplayControlPreview{}, err
	}
	preview.SelectedCount = len(preview.Screens)
	canonical, err := json.Marshal(struct {
		GroupID uuid.UUID                   `json:"groupId"`
		Command string                      `json:"command"`
		Screens []groupDisplayControlScreen `json:"screens"`
	}{preview.GroupID, preview.CommandType, preview.Screens})
	if err != nil {
		return groupDisplayControlPreview{}, err
	}
	digest := sha256.Sum256(canonical)
	preview.Fingerprint = hex.EncodeToString(digest[:])
	return preview, nil
}

func (s *server) previewGroupDisplayControl(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	command := strings.TrimSpace(r.URL.Query().Get("commandType"))
	if !displayControlGroupCommandValid(command) {
		writeError(w, http.StatusUnprocessableEntity, "display_control_action_invalid", "Choose a supported group Display Control action.")
		return
	}
	if !s.authorizeScreenList(w, r, nil, []uuid.UUID{id}) {
		return
	}
	preview, err := s.loadGroupDisplayControlPreview(r.Context(), id, command)
	if errors.Is(err, errDisplayControlGroupNotFound) {
		writeError(w, http.StatusNotFound, "display_group_not_found", "Display Group was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": preview})
}

func (s *server) applyGroupDisplayControl(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input groupDisplayControlApplyInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.CommandType = strings.TrimSpace(input.CommandType)
	if !displayControlGroupCommandValid(input.CommandType) {
		writeError(w, http.StatusUnprocessableEntity, "display_control_action_invalid", "Choose a supported group Display Control action.")
		return
	}
	if !s.authorizeScreenList(w, r, nil, []uuid.UUID{id}) {
		return
	}
	preview, err := s.loadGroupDisplayControlPreview(r.Context(), id, input.CommandType)
	if errors.Is(err, errDisplayControlGroupNotFound) {
		writeError(w, http.StatusNotFound, "display_group_not_found", "Display Group was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if input.Fingerprint != "" && input.Fingerprint != preview.Fingerprint {
		writeError(w, http.StatusConflict, "display_control_preview_stale", "Display capabilities changed. Review the group preview again.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	results := make([]groupDisplayControlResult, 0, len(preview.Screens))
	queued := 0
	failed := 0
	for _, item := range preview.Screens {
		if !item.Supported || !item.Eligible {
			results = append(results, groupDisplayControlResult{ScreenID: item.ScreenID, Name: item.Name, State: "skipped", Reason: item.Reason})
			continue
		}
		commandID, _, queueErr := s.queueCommand(r.Context(), item.ScreenID, user.ID, input.CommandType, []byte(`{}`), uuid.New())
		if queueErr != nil {
			failed++
			results = append(results, groupDisplayControlResult{ScreenID: item.ScreenID, Name: item.Name, State: "failed", Reason: queueErr.Error()})
			continue
		}
		queued++
		results = append(results, groupDisplayControlResult{ScreenID: item.ScreenID, Name: item.Name, State: "queued", ID: commandID})
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": map[string]any{
		"groupId": id, "commandType": input.CommandType, "selectedCount": preview.SelectedCount,
		"supportedCount": preview.SupportedCount, "queuedCount": queued, "failedCount": failed,
		"unsupportedCount": preview.UnsupportedCount, "results": results,
	}})
}

// recordDisplayControlCommandResult keeps the protocol acknowledgement and the
// display-state observation separate. A successful command means the player
// accepted and attempted the bounded provider call; only a later heartbeat (or
// a provider's explicit confirmation) can claim that the panel changed state.
func (s *server) recordDisplayControlCommandResult(ctx context.Context, id uuid.UUID, state, code, message string) {
	var commandType string
	if err := s.db.QueryRow(ctx, `SELECT type FROM player_commands WHERE id=$1`, id).Scan(&commandType); err != nil || !displayControlCommandTypes[commandType] {
		return
	}
	if runes := []rune(message); len(runes) > 240 {
		message = string(runes[:240])
	}
	errorText := ""
	if state != "succeeded" {
		errorText = strings.TrimSpace(message)
	}
	_, _ = s.db.Exec(ctx, `UPDATE screen_player_status SET
		display_control_last_command_id=$2,
		display_control_last_command_state=$3,
		display_control_last_command_result=NULLIF($4,''),
		display_control_last_command_sent_at=now(),
		display_control_last_state_confirmed_at=CASE WHEN $4='display_state_confirmed' THEN now() ELSE display_control_last_state_confirmed_at END,
		display_control_error=CASE WHEN $3='succeeded' THEN NULL ELSE NULLIF($5,'') END
		WHERE screen_id=(SELECT screen_id FROM player_commands WHERE id=$2)`, id, id, state, code, errorText)
}
