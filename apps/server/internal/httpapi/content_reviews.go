package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
)

func (s *server) listContentSubmissions(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	allowed := map[string]bool{"": true, "in_review": true, "changes_requested": true, "approved": true, "scheduled": true, "published": true, "publication_failed": true, "superseded": true}
	if !allowed[state] {
		writeError(w, http.StatusBadRequest, "invalid_state", "Submission state is invalid.")
		return
	}
	result, err := s.approvals.ListSubmissions(r.Context(), state)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"policy": s.approvals.Policy(r.Context()), "allowSelfApproval": s.approvals.AllowSelfApproval(r.Context()), "autoPublishOnApproval": s.approvals.AutoPublishOnApproval(r.Context()), "items": result.Items,
	}})
}

func (s *server) getContentSubmission(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	result, err := s.approvals.GetSubmission(r.Context(), id)
	if errors.Is(err, approvals.ErrNotFound) {
		writeError(w, http.StatusNotFound, "submission_not_found", "The requested submission was not found.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

type contentSubmissionRequest struct {
	RequestedPublicationAt *time.Time `json:"requestedPublicationAt,omitempty"`
	ExpectedRevision       int64      `json:"expectedRevision,omitempty"`
}

func (s *server) submitContent(w http.ResponseWriter, r *http.Request) {
	contentType := chi.URLParam(r, "type")
	if contentType != approvals.TypePlaylist && contentType != approvals.TypeLayout && contentType != approvals.TypeCampaign {
		writeError(w, http.StatusBadRequest, "invalid_type", "Only a playlist, Layout, or campaign can be submitted.")
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body contentSubmissionRequest
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
	result, err := s.approvals.SubmitExpected(r.Context(), user.ID, user.Role, contentType, id, body.RequestedPublicationAt, body.ExpectedRevision)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": result})
}

func (s *server) approveContentSubmission(w http.ResponseWriter, r *http.Request) {
	s.decideSubmission(w, r)
}

func (s *server) requestContentChanges(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Note string `json:"note"`
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
	result, err := s.approvals.RequestChanges(r.Context(), user.ID, user.Role, id, body.Note)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func (s *server) decideSubmission(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Note string `json:"note,omitempty"`
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
	result, err := s.approvals.Approve(r.Context(), user.ID, user.Role, id, body.Note)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func (s *server) publishContentSubmission(w http.ResponseWriter, r *http.Request) {
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
	result, err := s.approvals.PublishSubmission(r.Context(), user.ID, user.Role, id)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": result})
}

func (s *server) scheduleContentSubmission(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		RequestedPublicationAt time.Time `json:"requestedPublicationAt"`
	}
	if err := decodeJSON(w, r, &body); err != nil || body.RequestedPublicationAt.IsZero() {
		writeError(w, http.StatusBadRequest, "invalid_request", "A future requestedPublicationAt is required.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	result, err := s.approvals.Schedule(r.Context(), user.ID, user.Role, id, body.RequestedPublicationAt)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func (s *server) cancelContentSchedule(w http.ResponseWriter, r *http.Request) {
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
	result, err := s.approvals.CancelSchedule(r.Context(), user.ID, user.Role, id)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func (s *server) contentPublicationHistory(w http.ResponseWriter, r *http.Request) {
	contentType := chi.URLParam(r, "type")
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	items, err := s.approvals.GetPublicationHistory(r.Context(), contentType, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items}})
}

func (s *server) comparePublications(w http.ResponseWriter, r *http.Request) {
	contentType := chi.URLParam(r, "type")
	contentID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	fromID, err := uuid.Parse(r.URL.Query().Get("fromPublicationId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_publication", "fromPublicationId is required.")
		return
	}
	toID, err := uuid.Parse(r.URL.Query().Get("toPublicationId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_publication", "toPublicationId is required.")
		return
	}
	diff, err := s.approvals.ComparePublications(r.Context(), contentType, contentID, fromID, toID)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": diff})
}

func (s *server) restorePublicationToDraft(w http.ResponseWriter, r *http.Request) {
	contentType := chi.URLParam(r, "type")
	if contentType != approvals.TypePlaylist && contentType != approvals.TypeLayout && contentType != approvals.TypeCampaign {
		writeError(w, http.StatusBadRequest, "invalid_type", "Only a playlist, Layout, or campaign can be restored.")
		return
	}
	contentID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	publicationID, err := uuid.Parse(chi.URLParam(r, "publicationId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "publication_not_found", "The requested publication was not found.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	snapshot, err := s.approvals.RestorePublicationToDraft(r.Context(), user.ID, user.Role, contentType, contentID, publicationID)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": snapshot})
}

func (s *server) rollbackPublication(w http.ResponseWriter, r *http.Request) {
	contentType := chi.URLParam(r, "type")
	if contentType != approvals.TypePlaylist && contentType != approvals.TypeLayout && contentType != approvals.TypeCampaign {
		writeError(w, http.StatusBadRequest, "invalid_type", "Only a playlist, Layout, or campaign can be rolled back.")
		return
	}
	contentID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	publicationID, err := uuid.Parse(chi.URLParam(r, "publicationId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "publication_not_found", "The requested publication was not found.")
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	result, err := s.approvals.Rollback(r.Context(), user.ID, user.Role, contentType, contentID, publicationID)
	if err != nil {
		s.writeEditorialError(w, r, err)
		return
	}
	status := http.StatusCreated
	if result.Submission.Status == "in_review" {
		status = http.StatusAccepted
	}
	writeJSON(w, status, map[string]any{"data": result})
}

func (s *server) writeEditorialError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, approvals.ErrNotFound):
		writeError(w, http.StatusNotFound, "submission_not_found", "The requested editorial resource was not found.")
	case errors.Is(err, approvals.ErrReviewRequired):
		writeError(w, http.StatusConflict, "review_required", "Submit this exact draft for review before publishing it.")
	case errors.Is(err, approvals.ErrConflict):
		writeError(w, http.StatusConflict, "editorial_conflict", strings.TrimPrefix(err.Error(), approvals.ErrConflict.Error()+": "))
	case errors.Is(err, approvals.ErrValidation):
		writeError(w, http.StatusUnprocessableEntity, "editorial_validation_failed", strings.TrimPrefix(err.Error(), approvals.ErrValidation.Error()+": "))
	default:
		s.internalError(w, r, err)
	}
}

// listContentReviews is the legacy current-revision queue. New Studio actions
// use content submissions, but this compatibility route remains available to
// older clients and still reports the server-side assignment gate.
func (s *server) listContentReviews(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	switch state {
	case "", "pending", "approved", "rejected":
	default:
		writeError(w, http.StatusBadRequest, "invalid_state",
			"State must be pending, approved, or rejected.")
		return
	}
	items, err := s.approvals.Queue(r.Context(), state)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"required": s.approvals.Required(r.Context()),
		"items":    items,
	}})
}

type contentReviewRequest struct {
	Approve bool   `json:"approve"`
	Note    string `json:"note,omitempty"`
	// Revision is the revision the reviewer was looking at. The decision is
	// refused when the content has changed since, so an approval can never
	// land on a revision nobody read.
	Revision int64 `json:"revision,omitempty"`
}

func (s *server) decideContentReview(w http.ResponseWriter, r *http.Request) {
	contentType := chi.URLParam(r, "type")
	if contentType != approvals.TypePlaylist && contentType != approvals.TypeLayout {
		writeError(w, http.StatusBadRequest, "invalid_type", "Only a playlist or a Layout can be reviewed.")
		return
	}
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body contentReviewRequest
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
	review, err := s.approvals.Decide(r.Context(), user.ID, contentType, id, body.Approve, body.Note, body.Revision)
	switch {
	case errors.Is(err, approvals.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found",
			"That content no longer exists, or the Layout is not published.")
		return
	case errors.Is(err, approvals.ErrValidation):
		writeError(w, http.StatusConflict, "review_invalid",
			strings.TrimPrefix(err.Error(), approvals.ErrValidation.Error()+": "))
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	action := "content.review_rejected"
	if body.Approve {
		action = "content.review_approved"
	}
	_, _ = s.db.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,summary)
		VALUES($1,$2,$3,$4,$5,'success',$6)`,
		uuid.New(), user.ID, action, contentType, id.String(),
		"Reviewed revision "+strconv.FormatInt(review.Revision, 10))
	writeJSON(w, http.StatusOK, map[string]any{"data": review})
}
