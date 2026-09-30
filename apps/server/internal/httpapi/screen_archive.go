package httpapi

import "net/http"

func (s *server) listArchivedScreens(w http.ResponseWriter, r *http.Request) {
	_, scoped, ok := s.callerScope(w, r)
	if !ok {
		return
	}
	// Archiving deliberately detaches a screen from its location and Display
	// Group, so current grants cannot safely reconstruct its historical scope.
	// Fail closed for narrowed accounts instead of exposing the installation-wide
	// archive through metadata that no longer carries an authorization anchor.
	if scoped {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": []any{}, "total": 0}})
		return
	}
	screens, err := s.devices.ListArchivedScreens(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": screens, "total": len(screens)}})
}
