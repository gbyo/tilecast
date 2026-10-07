package httpapi

import (
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// playerPackageWidget serves one installed Widget contribution's player
// bundle to an authenticated Player. The manifest names the bundle hash;
// the Player verifies the bytes before activation and keeps its last
// known playable presentation when verification fails. Unknown packages
// and missing bundles share one 404: Players must never distinguish
// them.
func (s *server) playerPackageWidget(w http.ResponseWriter, r *http.Request) {
	packageID := chi.URLParam(r, "packageId")
	widgetID := chi.URLParam(r, "widgetId")
	if !packagemanifest.ValidPackageID(packageID) || !validNestedWidgetID(widgetID) {
		writeError(w, http.StatusNotFound, "package_widget_unavailable", "The requested Widget bundle is unavailable.")
		return
	}
	bundle, err := s.packages.WidgetBundle(r.Context(), packageID, widgetID)
	if err != nil {
		if errors.Is(err, installer.ErrNotFound) {
			writeError(w, http.StatusNotFound, "package_widget_unavailable", "The requested Widget bundle is unavailable.")
			return
		}
		s.writePackageError(w, r, err)
		return
	}
	file, err := os.Open(bundle.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, "package_widget_unavailable", "The requested Widget bundle is unavailable.")
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "text/javascript")
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", media.ETag(bundle.SHA256Hex))
	http.ServeContent(w, r, "", time.Time{}, file)
}

// validNestedWidgetID mirrors the package extractor's nested identity
// rule: one dotless segment, bounded. The bundle lookup matches the
// qualified identity against installed contribution rows, so anything
// else 404s without touching the filesystem.
func validNestedWidgetID(id string) bool {
	if len(id) < 1 || len(id) > 80 || id[0] < 'a' || id[0] > 'z' {
		return false
	}
	for i := 1; i < len(id); i++ {
		c := id[i]
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-' {
			continue
		}
		return false
	}
	return true
}
