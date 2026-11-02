package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/previews"
)

const previewUploadOverhead = 128 * 1024

func (s *server) previewRoutes(next http.Handler) http.Handler {
	router := chi.NewRouter()
	router.With(s.requireDevice).Get("/api/v1/player/preview-session", s.playerPreviewSession)
	router.With(s.requireDevice).Post("/api/v1/player/preview", s.uploadPlayerPreview)
	router.With(s.requireSession, s.requireCapability(auth.CapScreenRead), s.requireCSRF).Post("/api/v1/screens/{id}/preview-session", s.renewScreenPreview)
	router.With(s.requireSession, s.requireCapability(auth.CapScreenRead)).Get("/api/v1/screens/{id}/preview", s.getScreenPreview)
	router.With(s.requireSession, s.requireCapability(auth.CapScreenRead)).Get("/api/v1/screens/{id}/preview/image", s.getScreenPreviewImage)
	router.NotFound(next.ServeHTTP)
	router.MethodNotAllowed(next.ServeHTTP)
	return router
}

func (s *server) previewService() *previews.Service {
	service := previews.NewService(s.db, s.devices)
	if s.snapshots != nil {
		// Every successful capture, scheduled or manual, flows through the
		// recorder. Installing it here rather than at each call site means a
		// frame cannot reach a screen's live preview without also being offered
		// to history.
		service.SetHistoryRecorder(s.snapshots.Record)
	}
	return service
}

func (s *server) renewScreenPreview(w http.ResponseWriter, r *http.Request) {
	screenID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		ForceCapture bool `json:"forceCapture"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session, err := s.previewService().Renew(r.Context(), screenID, body.ForceCapture)
	if err != nil {
		s.writePreviewError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": session})
}

func (s *server) playerPreviewSession(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	session, err := s.previewService().PlayerSession(r.Context(), principal.ScreenID)
	if err != nil {
		s.writePreviewError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": session})
}

func (s *server) uploadPlayerPreview(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	r.Body = http.MaxBytesReader(w, r.Body, previews.MaxImageBytes+previewUploadOverhead)
	if err := r.ParseMultipartForm(previews.MaxImageBytes + previewUploadOverhead); err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "preview_too_large", "The preview upload exceeded 500 KB.")
		return
	}

	upload := previews.Upload{
		PlayerVersion: strings.TrimSpace(r.FormValue("playerVersion")),
		FailureStatus: strings.TrimSpace(r.FormValue("failureStatus")),
	}
	if capturedAt := strings.TrimSpace(r.FormValue("capturedAt")); capturedAt != "" {
		parsed, err := time.Parse(time.RFC3339Nano, capturedAt)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "invalid_preview", "capturedAt must be an RFC 3339 timestamp.")
			return
		}
		upload.CapturedAt = parsed
	}
	var err error
	if upload.Width, err = previewFormInt(r, "width"); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid_preview", err.Error())
		return
	}
	if upload.Height, err = previewFormInt(r, "height"); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid_preview", err.Error())
		return
	}

	file, header, fileErr := r.FormFile("preview")
	if fileErr == nil {
		defer file.Close()
		upload.ContentType = strings.TrimSpace(header.Header.Get("Content-Type"))
		upload.Data, err = io.ReadAll(io.LimitReader(file, previews.MaxImageBytes+1))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_preview", "The preview image could not be read.")
			return
		}
		if len(upload.Data) > previews.MaxImageBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "preview_too_large", "The preview image exceeded 500 KB.")
			return
		}
	} else if !errors.Is(fileErr, http.ErrMissingFile) {
		writeError(w, http.StatusBadRequest, "invalid_preview", "The preview upload was malformed.")
		return
	}

	if err := s.previewService().RecordUpload(r.Context(), principal.ScreenID, upload); err != nil {
		s.writePreviewError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) getScreenPreview(w http.ResponseWriter, r *http.Request) {
	screenID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	preview, err := s.previewService().GetMetadata(r.Context(), screenID)
	if err != nil {
		s.writePreviewError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"data": preview})
}

func (s *server) getScreenPreviewImage(w http.ResponseWriter, r *http.Request) {
	screenID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	image, err := s.previewService().GetImage(r.Context(), screenID)
	if err != nil {
		s.writePreviewError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Content-Type", image.ContentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(image.Data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(image.Data)
}

func previewFormInt(r *http.Request, name string) (int, error) {
	value := strings.TrimSpace(r.FormValue(name))
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", name)
	}
	return parsed, nil
}

func (s *server) writePreviewError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, previews.ErrNotFound):
		writeError(w, http.StatusNotFound, "preview_not_found", "The requested screen or preview was not found.")
	case errors.Is(err, previews.ErrLeaseExpired):
		writeError(w, http.StatusConflict, "preview_session_expired", "The preview session is no longer active.")
	case errors.Is(err, previews.ErrInvalidUpload):
		writeError(w, http.StatusUnprocessableEntity, "invalid_preview", err.Error())
	default:
		s.internalError(w, r, err)
	}
}
