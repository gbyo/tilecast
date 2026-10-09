package httpapi

import (
	"encoding/base64"
	"errors"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/wasm"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// studioFramePolicy is the response Content-Security-Policy for sandboxed
// Studio UI frame documents. The document is package-authored HTML served
// from the operator's own origin, so the policy sandboxes it to an opaque
// origin: no allow-same-origin, no network, no workers, no forms. Scripts
// and styles must be inline; the entry cannot load subresources. The page
// reaches its guest backend over a MessageChannel the Studio parent binds
// to its document after a hello handshake, and the parent relays calls
// over the bridge endpoint below with the dashboard session the frame
// itself must never hold.
const studioFramePolicy = "sandbox allow-scripts; default-src 'none'; " +
	"script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
	"connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"

// studioFrame serves one installed package's Studio UI entry page as a
// sandboxed frame document. Unknown packages and packages without a
// Studio UI capability share one 404.
func (s *server) studioFrame(w http.ResponseWriter, r *http.Request) {
	packageID := chi.URLParam(r, "packageId")
	if !packagemanifest.ValidPackageID(packageID) {
		writeError(w, http.StatusNotFound, "package_studio_unavailable", "The package has no Studio interface.")
		return
	}
	entry, err := s.packages.StudioEntry(r.Context(), packageID)
	if err != nil {
		if errors.Is(err, installer.ErrNotFound) {
			writeError(w, http.StatusNotFound, "package_studio_unavailable", "The package has no Studio interface.")
			return
		}
		s.writePackageError(w, r, err)
		return
	}
	raw, err := os.ReadFile(entry.Path)
	if err != nil || len(raw) == 0 || int64(len(raw)) > wasm.MaxStudioEntryBytes {
		writeError(w, http.StatusNotFound, "package_studio_unavailable", "The package has no Studio interface.")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", studioFramePolicy)
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// studioBridgeRequest is one Studio UI frame relay: the parent posts the
// frame's call here with the dashboard session, and the host invokes the
// package's handle_ui_request export. Input is base64 so guests may use
// any framing over the 16 KiB call window.
type studioBridgeRequest struct {
	Input string `json:"input"`
}

// studioBridge relays one Studio UI call into the package guest. The
// frame cannot hold credentials, so the Studio parent carries the
// dashboard session and CSRF token. A successful invocation always
// answers 200 with the guest's status code and output; only transport
// and host failures become errors.
func (s *server) studioBridge(w http.ResponseWriter, r *http.Request) {
	packageID := chi.URLParam(r, "packageId")
	if !packagemanifest.ValidPackageID(packageID) {
		writeError(w, http.StatusNotFound, "package_studio_unavailable", "The package has no Studio interface.")
		return
	}
	var body studioBridgeRequest
	if err := decodeJSONLimit(w, r, &body, 1<<16); err != nil {
		return
	}
	input, err := base64.StdEncoding.DecodeString(body.Input)
	if err != nil || len(input) > wasm.MaxBridgeInputBytes {
		writeError(w, http.StatusBadRequest, "invalid_bridge_input", "The bridge call payload is invalid.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	result, err := s.wasm.InvokeUI(r.Context(), packageID, services.Actor{UserID: principal.User.ID, Role: principal.User.Role}, input)
	if err != nil {
		if errors.Is(err, installer.ErrNotFound) || errors.Is(err, wasm.ErrNoStudioUI) || errors.Is(err, wasm.ErrNoRuntime) {
			writeError(w, http.StatusNotFound, "package_studio_unavailable", "The package has no Studio interface.")
			return
		}
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"status": result.Status,
		"output": base64.StdEncoding.EncodeToString(result.Output),
	}})
}

// packageJobs reports one installed package's declared background jobs
// with the scheduler cursor: next run, last outcome, and failures.
func (s *server) packageJobs(w http.ResponseWriter, r *http.Request) {
	packageID := chi.URLParam(r, "packageId")
	if !packagemanifest.ValidPackageID(packageID) {
		writeError(w, http.StatusNotFound, "package_not_installed", "The package is not installed.")
		return
	}
	if _, err := s.installer.Get(r.Context(), packageID); err != nil {
		if errors.Is(err, installer.ErrNotFound) {
			writeError(w, http.StatusNotFound, "package_not_installed", "The package is not installed.")
			return
		}
		s.internalError(w, r, err)
		return
	}
	jobs, err := wasm.ListJobs(r.Context(), s.db, packageID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": jobs})
}
