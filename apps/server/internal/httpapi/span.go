package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/span"
)

type spanGeometryBody struct {
	DisplayMode *string      `json:"displayMode"`
	Canvas      *span.Canvas `json:"canvas"`
	Panels      []span.Panel `json:"panels"`
}

func (s *server) getSpanStatus(w http.ResponseWriter, r *http.Request) {
	if s.span == nil {
		writeError(w, http.StatusServiceUnavailable, "span_unavailable", "Span support is unavailable.")
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	status, err := s.span.Status(r.Context(), id)
	if err != nil {
		s.writeSpanError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": status})
}

func (s *server) updateSpanGeometry(w http.ResponseWriter, r *http.Request) {
	if s.span == nil {
		writeError(w, http.StatusServiceUnavailable, "span_unavailable", "Span support is unavailable.")
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body spanGeometryBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	if err := s.span.UpdateGeometry(r.Context(), id, user.ID, body.DisplayMode, body.Canvas, body.Panels, body.Panels != nil); err != nil {
		s.writeSpanError(w, r, err)
		return
	}
	group, err := s.scheduling.GetGroup(r.Context(), id)
	if err != nil {
		s.writeScheduleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": group})
}

func (s *server) playerSpanPanel(w http.ResponseWriter, r *http.Request) {
	if s.span == nil {
		writeError(w, http.StatusNotFound, "media_variant_unavailable", "The requested media variant is unavailable.")
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "media_variant_unavailable", "The requested media variant is unavailable.")
		return
	}
	delivery, err := s.span.Delivery(r.Context(), id)
	if err != nil {
		s.writeSpanError(w, r, err)
		return
	}
	serveDelivery(w, r, delivery)
}

func (s *server) writeSpanError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, span.ErrNotFound):
		writeError(w, http.StatusNotFound, "span_not_found", "The requested Span resource was not found.")
	case errors.Is(err, span.ErrNotReady):
		writeError(w, http.StatusConflict, "span_not_ready", "The Span wall is still being prepared.")
	default:
		if len(err.Error()) < 240 {
			writeError(w, http.StatusUnprocessableEntity, "span_validation_failed", err.Error())
		} else {
			s.internalError(w, r, err)
		}
	}
}
