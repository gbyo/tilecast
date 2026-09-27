package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

type githubConfigurationInput struct {
	ClientID string `json:"clientId"`
}

func (s *server) configureGitHubOAuth(w http.ResponseWriter, r *http.Request) {
	var input githubConfigurationInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.ClientID = strings.TrimSpace(input.ClientID)
	if err := s.updates.ConfigureGitHubClientID(input.ClientID); err != nil {
		switch {
		case errors.Is(err, updates.ErrGitHubClientIDInvalid):
			writeError(w, http.StatusUnprocessableEntity, "github_client_id_invalid", "Enter the Client ID from a GitHub OAuth App with Device Flow enabled.")
		case errors.Is(err, updates.ErrGitHubClientIDManaged):
			writeError(w, http.StatusConflict, "github_client_id_environment_managed", err.Error())
		case errors.Is(err, updates.ErrGitHubClientIDConnected):
			writeError(w, http.StatusConflict, "github_client_id_connected", err.Error())
		case errors.Is(err, updates.ErrGitHubAuthUnavailable):
			writeError(w, http.StatusServiceUnavailable, "github_sign_in_unavailable", "This Tilecast server cannot use GitHub device authorization.")
		default:
			s.internalError(w, r, err)
		}
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	metadata, _ := json.Marshal(map[string]any{"source": "studio", "clientIdSuffix": clientIDSuffix(input.ClientID)})
	_, _ = s.db.Exec(r.Context(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)VALUES($1,$2,'player_updates.github_oauth_configured','update_provider','github',$3::jsonb)`, uuid.New(), user.ID, string(metadata))
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"configured": true}})
}

func clientIDSuffix(value string) string {
	if len(value) <= 4 {
		return value
	}
	return value[len(value)-4:]
}
