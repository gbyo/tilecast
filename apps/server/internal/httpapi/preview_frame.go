package httpapi

import (
	"errors"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/sandbox"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// previewFramePolicy is the response Content-Security-Policy for
// sandboxed Widget frame documents. The document runs external code,
// so the policy sandboxes it to an opaque origin even when opened
// top-level: no allow-same-origin, no network beyond credentialless
// image/media/font loads, no workers, no forms. Scripts and styles are
// inline by design (the bootstrap plus the verified bundle); the
// bundle interpolation escapes script closers, and the iframe element
// repeats the sandbox flags as defense in depth.
//
// Image, media, and font sources stay scheme-wide because Studio
// preview grants are same-origin server URLs and an opaque origin
// cannot use 'self'. The grant list stays the real boundary: the
// Widget only receives host-authorized URIs over the bridge. Pinning
// these sources to the exact granted URIs through the iframe csp
// attribute is recorded future hardening.
const previewFramePolicy = "sandbox allow-scripts; default-src 'none'; " +
	"script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
	"img-src data: https: http:; media-src data: https: http:; font-src data: https: http:; " +
	"connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"

// previewWidgetFrame serves one installed Widget contribution's
// sandboxed frame document to Studio: the generated bootstrap with
// the verified bundle interpolated. Dashboard sessions carry the
// request (the sandboxed frame cannot hold credentials), so this
// stays a plain authenticated GET beside the device-authenticated
// player bundle endpoint. Unknown packages and missing bundles share
// one 404, mirroring the player endpoint.
func (s *server) previewWidgetFrame(w http.ResponseWriter, r *http.Request) {
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
	writePreviewFrame(w, string(raw))
}

// writePreviewFrame assembles one verified bundle into its frame
// document and serves it with the sandbox response policy. The global
// middleware denies framing and locks the dashboard policy; the
// preview frame replaces both. X-Frame-Options stays as a legacy
// layer for engines without frame-ancestors.
func writePreviewFrame(w http.ResponseWriter, bundle string) {
	document, err := sandbox.Assemble(bundle)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "frame_unavailable", "The Widget preview frame is unavailable.")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", previewFramePolicy)
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(document))
}
