package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
	"github.com/tilecast/tilecast/apps/server/internal/presentations"
)

type presentationOverrideInput struct {
	TargetType      string    `json:"targetType"`
	TargetID        uuid.UUID `json:"targetId"`
	ContentType     string    `json:"contentType"`
	ContentID       uuid.UUID `json:"contentId"`
	DurationMinutes int       `json:"durationMinutes"`
	AfterAction     string    `json:"afterAction"`
	WakeDisplay     bool      `json:"wakeDisplay"`
}

func (s *server) listPresentationOverrides(w http.ResponseWriter, r *http.Request) {
	if s.presentations == nil {
		writeError(w, http.StatusNotImplemented, "feature_unavailable", "Quick Present is not configured.")
		return
	}
	items, err := s.presentations.List(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	reached, err := s.authorizer().Reachable(r.Context(), authz.ActorFor(principal), auth.CapScreenRead, authz.KindPresentationOverride, ids)
	if err != nil {
		s.writeAuthzError(w, r, err, notFoundFor(objectPresentationOverride))
		return
	}
	visible := make([]presentations.Override, 0, len(items))
	for _, item := range items {
		if reached[item.ID] {
			visible = append(visible, item)
		}
	}
	items = visible
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items, "total": len(items)}})
}

func (s *server) createPresentationOverride(w http.ResponseWriter, r *http.Request) {
	if s.presentations == nil {
		writeError(w, http.StatusNotImplemented, "feature_unavailable", "Quick Present is not configured.")
		return
	}
	var body presentationOverrideInput
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.DurationMinutes != 0 && body.DurationMinutes != 5 && body.DurationMinutes != 15 && body.DurationMinutes != 30 && body.DurationMinutes != 60 {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", "Duration must be 5, 15, 30, 60 minutes, or until stopped.")
		return
	}
	if body.TargetType == "screen" || body.TargetType == "group" {
		selection := authz.Selection{ScreenIDs: []uuid.UUID{body.TargetID}, Peers: true}
		if body.TargetType == "group" {
			selection = authz.Selection{GroupIDs: []uuid.UUID{body.TargetID}}
		}
		if !s.decide(w, r, notFoundFor(objectScreen), func(z *authz.Authorizer, actor authz.Actor) error {
			return z.Selection(r.Context(), actor, auth.CapScreenAssign, selection)
		}) {
			return
		}
	} else {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", "Choose a screen or Display Group destination.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	item, err := s.presentations.Create(r.Context(), presentations.CreateInput{
		TargetType:  body.TargetType,
		TargetID:    body.TargetID,
		ContentType: body.ContentType,
		ContentID:   body.ContentID,
		Duration:    time.Duration(body.DurationMinutes) * time.Minute,
		AfterAction: body.AfterAction,
		WakeDisplay: body.WakeDisplay,
		CreatedBy:   user.ID,
	})
	if errors.Is(err, presentations.ErrConflict) {
		writeError(w, http.StatusConflict, "presentation_conflict", "An AirPlay presentation or another Quick Present session is active on one or more selected displays.")
		return
	}
	if errors.Is(err, presentations.ErrNotFound) {
		writeError(w, http.StatusNotFound, "presentation_target_not_found", "The selected destination was not found.")
		return
	}
	if errors.Is(err, presentations.ErrInvalid) {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": item})
}

func (s *server) stopPresentationOverride(w http.ResponseWriter, r *http.Request) {
	if s.presentations == nil {
		writeError(w, http.StatusNotImplemented, "feature_unavailable", "Quick Present is not configured.")
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
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
	item, err := s.presentations.Stop(r.Context(), id, user.ID, body.Reason)
	if errors.Is(err, presentations.ErrNotFound) {
		writeError(w, http.StatusNotFound, "presentation_not_found", "Quick Present is no longer active.")
		return
	}
	if errors.Is(err, presentations.ErrInvalid) {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}
