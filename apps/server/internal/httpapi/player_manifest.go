package httpapi

import (
	"net/http"
	"strings"

	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

func (s *server) playerManifest(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	manifest, etag, err := s.playlists.BuildManifest(r.Context(), principal.ScreenID)
	if err != nil {
		s.writePlaylistError(w, r, err)
		return
	}
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")
	if strings.TrimSpace(r.Header.Get("If-None-Match")) == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": manifest})
}
