package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

func (s *server) playerPackagePluginFrame(w http.ResponseWriter, r *http.Request) {
	pkg, id := chi.URLParam(r, "packageId"), chi.URLParam(r, "pluginId")
	unavailable := func() {
		writeError(w, http.StatusNotFound, "package_plugin_unavailable", "The requested plugin frame is unavailable.")
	}
	if !packagemanifest.ValidPackageID(pkg) || !validNestedWidgetID(id) || strings.Contains(id, "-") || s.packages == nil {
		unavailable()
		return
	}
	frame, err := s.packages.PluginFrame(r.Context(), pkg, id)
	if err != nil {
		unavailable()
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", sandbox.PluginFramePolicy)
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", media.ETag(frame.SHA256Hex))
	http.ServeContent(w, r, "", time.Time{}, strings.NewReader(frame.Document))
}
