package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/campaigns"
)

type campaignDetailsRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Timezone    string `json:"timezone"`
}

type campaignDraftRequest struct {
	ExpectedDraftRevision int64              `json:"expectedDraftRevision"`
	Draft                 campaigns.Snapshot `json:"draft"`
}

func (s *server) listCampaigns(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	items, total, err := s.campaigns.List(r.Context(), r.URL.Query().Get("search"), page, pageSize)
	if err != nil {
		s.writeCampaignError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"items": items, "total": total, "page": page, "pageSize": pageSize,
	}})
}

func (s *server) createCampaign(w http.ResponseWriter, r *http.Request) {
	var body campaignDetailsRequest
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
	item, err := s.campaigns.Create(r.Context(), user.ID, body.Name, body.Description, body.Timezone)
	if err != nil {
		s.writeCampaignError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": item})
}

func (s *server) getCampaign(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	item, err := s.campaigns.Get(r.Context(), id)
	if err != nil {
		s.writeCampaignError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) updateCampaignDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body campaignDraftRequest
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
	item, err := s.campaigns.UpdateDraft(r.Context(), id, user.ID, body.ExpectedDraftRevision, body.Draft)
	if err != nil {
		s.writeCampaignError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) preflightCampaign(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	result, err := s.campaigns.Preflight(r.Context(), id)
	if err != nil {
		s.writeCampaignError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func (s *server) listCampaignReleases(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := s.campaigns.Releases(r.Context(), id)
	if err != nil {
		s.writeCampaignError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items}})
}

func (s *server) restoreCampaignRelease(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	releaseID, err := uuid.Parse(chi.URLParam(r, "releaseId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "release_not_found", "The requested campaign release was not found.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	item, err := s.campaigns.RestoreReleaseToDraft(r.Context(), id, releaseID, user.ID)
	if err != nil {
		s.writeCampaignError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) archiveCampaign(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	if err := s.campaigns.Archive(r.Context(), id, user.ID); err != nil {
		s.writeCampaignError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) publishCampaign(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		ExpectedDraftRevision int64 `json:"expectedDraftRevision"`
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
	if s.approvals == nil {
		writeError(w, http.StatusServiceUnavailable, "editorial_unavailable", "Editorial publication is unavailable.")
		return
	}
	result, publishErr := s.approvals.SubmitAndPublish(r.Context(), user.ID, user.Role, approvals.TypeCampaign, id, body.ExpectedDraftRevision)
	if errors.Is(publishErr, approvals.ErrReviewRequired) {
		submission, submitErr := s.approvals.SubmitExpected(r.Context(), user.ID, user.Role, approvals.TypeCampaign, id, nil, body.ExpectedDraftRevision)
		if submitErr != nil {
			s.writeEditorialError(w, r, submitErr)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"data": submission})
		return
	}
	if publishErr != nil {
		s.writeEditorialError(w, r, publishErr)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": result})
}

func (s *server) writeCampaignError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, campaigns.ErrNotFound):
		writeError(w, http.StatusNotFound, "campaign_not_found", "The requested campaign was not found.")
	case errors.Is(err, campaigns.ErrConflict):
		writeError(w, http.StatusConflict, "campaign_conflict", err.Error())
	case errors.Is(err, campaigns.ErrInvalid):
		writeError(w, http.StatusUnprocessableEntity, "campaign_invalid", err.Error())
	default:
		s.internalError(w, r, err)
	}
}
