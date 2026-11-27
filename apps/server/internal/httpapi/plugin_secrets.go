package httpapi

import (
	"net/http"

	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
)

// pluginSecretStatus reports the plugin secret keys for the Owner warning:
// the KEK IDs (never key bytes), whether an Owner confirmed exporting this
// exact set, and how many secrets this installation cannot read.
func (s *server) pluginSecretStatus(w http.ResponseWriter, r *http.Request) {
	if s.pluginSecrets == nil {
		writeError(w, http.StatusServiceUnavailable, "secrets_unavailable", "Plugin secrets are unavailable on this server.")
		return
	}
	status, err := s.pluginSecrets.Status(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": status})
}

// confirmPluginSecretExport records that an Owner stored an export of the
// current KEK set. A KEK rotation changes the set, so the warning returns.
func (s *server) confirmPluginSecretExport(w http.ResponseWriter, r *http.Request) {
	if s.pluginSecrets == nil {
		writeError(w, http.StatusServiceUnavailable, "secrets_unavailable", "Plugin secrets are unavailable on this server.")
		return
	}
	userID := s.sessionUserID(r)
	if userID == nil {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	ids, err := s.pluginSecrets.AcknowledgeExport(r.Context(), tx, *userID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := audit.RecordTx(r.Context(), tx, audit.Event{Action: "plugin_secrets.export_confirmed", ResourceType: "plugin_secrets",
		ResourceID: pluginsecrets.KEKSetID(ids), Metadata: map[string]any{"kekIds": ids}, Actor: userID}); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.pluginSecretStatus(w, r)
}

func (s *server) secretKEKIDs() []string {
	if s.pluginSecrets == nil {
		return nil
	}
	return s.pluginSecrets.AvailableKEKIDs()
}
