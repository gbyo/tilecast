package httpapi

import (
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
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

// playerFramePolicy is the response Content-Security-Policy for the
// Player sandbox-frame documents. It is the shared cross-player frame
// policy (packages/player-contracts, responsePolicy): passive loads
// reach only host-granted tcmedia: capabilities and inline data:, never
// the open web, so a Widget cannot encode granted data into an
// attacker-owned image, media, or font URL. The frame's own <meta> policy
// is deliberately broader (it must also admit the Browser Player's media
// route and Edge's loopback route, which only the serving host can
// name) and is not a barrier: the untrusted bytes choose it. Every
// Player host re-serves the verified bytes with its own header, built
// from the same contract, and a fixture-driven test pins each of them.
const playerFramePolicy = "sandbox allow-scripts; default-src 'none'; " +
	"script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
	"img-src data: tcmedia:; media-src data: tcmedia:; font-src data: tcmedia:; " +
	"connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

// playerPackageWidgetFrame serves one installed Widget contribution's
// assembled sandbox frame to an authenticated Player (manifest v19).
// The body is deterministically produced by the same generated sandbox
// assembler Studio previews use, over the same retained verified
// bundle the manifest snapshot was built from: compilation and this
// endpoint agree on the exact bytes, SHA-256, and size by
// construction. The Player verifies all three before activation and
// keeps its last known playable presentation when verification fails.
// Unknown packages and missing bundles share one 404, mirroring the
// raw bundle endpoint.
func (s *server) playerPackageWidgetFrame(w http.ResponseWriter, r *http.Request) {
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
	raw, err := os.ReadFile(bundle.Path)
	if err != nil || len(raw) == 0 || int64(len(raw)) > packages.MaxWidgetPayloadBytes {
		writeError(w, http.StatusNotFound, "package_widget_unavailable", "The requested Widget bundle is unavailable.")
		return
	}
	frame, err := sandbox.AssembleFrame(string(raw))
	if err != nil {
		writeError(w, http.StatusNotFound, "package_widget_unavailable", "The requested Widget bundle is unavailable.")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", playerFramePolicy)
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", media.ETag(frame.SHA256Hex))
	http.ServeContent(w, r, "", time.Time{}, strings.NewReader(frame.Document))
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
