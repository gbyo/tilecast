package httpapi

import (
	"net/http"

	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

func (s *server) playerConfig(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	config, etag, err := s.settings.PlayerConfiguration(r.Context(), principal.ScreenID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The Presentation Network section carries safe identifiers and a
	// configuration revision only — never a credential, because a configuration
	// document is cached on disk by every player that reads it. The player
	// compares the revision it has installed against this one and fetches the
	// credential over its own authenticated, no-store channel when it has to
	// (re)provision. A screen with no assignment gets no section at all, which is
	// what keeps existing Ethernet-only AirPlay behavior unchanged.
	//
	// Assignment changes bump screen_config_state, so the ETag above already
	// changes when this section does.
	if s.presentationNetworks != nil {
		assignment, assignmentErr := s.presentationNetworks.PlayerConfiguration(r.Context(), principal.ScreenID)
		if assignmentErr != nil {
			s.internalError(w, r, assignmentErr)
			return
		}
		config.PresentationNetwork = presentationNetworkConfigSection(assignment)
	}
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", etag)
	_, _ = s.db.Exec(r.Context(), `UPDATE screen_config_state SET last_requested_at=now() WHERE screen_id=$1`, principal.ScreenID)
	writeJSON(w, 200, map[string]any{"data": config})
}
