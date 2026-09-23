package httpapi

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/forms"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// writeFormError maps a forms domain error to the appropriate HTTP status.
func (s *server) writeFormError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, plugins.ErrPluginNotInstalled):
		s.writePluginError(w, r, err)
	case errors.Is(err, forms.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "The requested form resource was not found.")
	case errors.Is(err, forms.ErrForbidden):
		writeError(w, http.StatusForbidden, "insufficient_access", "You do not have access to this form.")
	case errors.Is(err, forms.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "The record was modified by someone else. Reload and try again.")
	case errors.Is(err, forms.ErrInUse):
		writeError(w, http.StatusConflict, "resource_in_use", strings.TrimPrefix(err.Error(), "form resource is in use: "))
	case errors.Is(err, forms.ErrValidation):
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", strings.TrimPrefix(err.Error(), "form request is invalid: "))
	default:
		s.internalError(w, r, err)
	}
}

func sessionUser(r *http.Request) auth.User {
	return r.Context().Value(sessionContextKey).(auth.Session).User
}

// authorizeForm enforces a per-form capability, writing the appropriate error and returning false
// when the caller is not permitted. It returns the resolved form id and acting user id.
func (s *server) authorizeForm(w http.ResponseWriter, r *http.Request, need forms.Capability) (uuid.UUID, uuid.UUID, bool) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}
	user := sessionUser(r)
	allowed, err := s.forms.Authorize(r.Context(), id, user.ID, need)
	if err != nil {
		s.writeFormError(w, r, err)
		return uuid.Nil, uuid.Nil, false
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "insufficient_access", "You do not have access to this form.")
		return uuid.Nil, uuid.Nil, false
	}
	return id, user.ID, true
}

// --- Form definition ---

type createFormRequest struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	DraftSchema forms.FormSchema `json:"draftSchema"`
}

func (s *server) createForm(w http.ResponseWriter, r *http.Request) {
	var body createFormRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	user := sessionUser(r)
	form, err := s.forms.CreateForm(r.Context(), user.ID, forms.FormInput{Name: body.Name, Description: body.Description, DraftSchema: body.DraftSchema})
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": form})
}

// listForms returns every Form Data Source the current user may access. Scoping (owner sees all,
// others see created/granted forms) is enforced inside the forms service.
func (s *server) listForms(w http.ResponseWriter, r *http.Request) {
	user := sessionUser(r)
	items, err := s.forms.ListAccessibleForms(r.Context(), user.ID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items}})
}

func (s *server) getForm(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	user := sessionUser(r)
	access, err := s.forms.CanAccessForm(r.Context(), id, user.ID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	if !access {
		writeError(w, http.StatusForbidden, "insufficient_access", "You do not have access to this form.")
		return
	}
	form, err := s.forms.GetForm(r.Context(), id, user.ID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": form})
}

type metadataRequest struct {
	Name string `json:"name"`
	// Description is a pointer so an omitted field preserves the stored value (partial update).
	Description *string `json:"description"`
}

func (s *server) updateFormMetadata(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	var body metadataRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	form, err := s.forms.UpdateMetadata(r.Context(), id, userID, forms.MetadataInput{Name: body.Name, Description: body.Description})
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": form})
}

type draftRequest struct {
	Schema forms.FormSchema `json:"schema"`
}

func (s *server) updateFormDraft(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	var body draftRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	form, err := s.forms.UpdateDraft(r.Context(), id, userID, forms.DraftInput{Schema: body.Schema})
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": form})
}

func (s *server) publishForm(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	revision, err := s.forms.PublishRevision(r.Context(), id, userID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": revision})
}

func (s *server) configureFormWorkflow(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	var body forms.Workflow
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := s.forms.ConfigureWorkflow(r.Context(), id, userID, forms.WorkflowInput{Workflow: body}); err != nil {
		s.writeFormError(w, r, err)
		return
	}
	form, err := s.forms.GetForm(r.Context(), id, userID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": form})
}

// --- Records ---

func (s *server) listFormRecords(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	user := sessionUser(r)
	query := r.URL.Query()
	page, _ := strconv.Atoi(query.Get("page"))
	pageSize, _ := strconv.Atoi(query.Get("pageSize"))
	filter := forms.RecordFilter{Search: query.Get("search"), Sort: query.Get("sort"), Page: page, PageSize: pageSize, Mine: query.Get("mine") == "true"}
	if states := strings.TrimSpace(query.Get("states")); states != "" {
		filter.States = strings.Split(states, ",")
	}
	// Ownership scoping (own vs. all) is enforced inside the forms service.
	result, err := s.forms.ListRecords(r.Context(), id, user.ID, filter)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

type recordRequest struct {
	Values       map[string]any            `json:"values"`
	DisplayTitle forms.Optional[string]    `json:"displayTitle"`
	Priority     forms.Optional[int]       `json:"priority"`
	DisplayAt    forms.Optional[time.Time] `json:"displayAt"`
	ExpiresAt    forms.Optional[time.Time] `json:"expiresAt"`
	Version      *int                      `json:"version"`
}

func (s *server) createFormRecord(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	user := sessionUser(r)
	var body recordRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, err := s.forms.CreateRecord(r.Context(), id, user.ID, recordInput(body))
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": record})
}

func (s *server) getFormRecord(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	recordID, ok := urlUUID(w, r, "recordId")
	if !ok {
		return
	}
	user := sessionUser(r)
	detail, err := s.forms.GetRecord(r.Context(), id, recordID, user.ID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": detail})
}

func (s *server) updateFormRecord(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	recordID, ok := urlUUID(w, r, "recordId")
	if !ok {
		return
	}
	user := sessionUser(r)
	var body recordRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.Version == nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "A record version is required for edits.")
		return
	}
	record, err := s.forms.UpdateRecord(r.Context(), id, recordID, user.ID, recordInput(body), *body.Version)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": record})
}

func (s *server) deleteFormRecord(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	recordID, ok := urlUUID(w, r, "recordId")
	if !ok {
		return
	}
	user := sessionUser(r)
	if err := s.forms.DeleteRecord(r.Context(), id, recordID, user.ID); err != nil {
		s.writeFormError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type transitionRequest struct {
	ToState string `json:"toState"`
	Note    string `json:"note"`
	Version int    `json:"version"`
}

func (s *server) transitionFormRecord(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	recordID, ok := urlUUID(w, r, "recordId")
	if !ok {
		return
	}
	user := sessionUser(r)
	var body transitionRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	record, err := s.forms.Transition(r.Context(), id, recordID, user.ID, body.ToState, body.Note, body.Version)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": record})
}

type commentRequest struct {
	Body string `json:"body"`
}

func (s *server) addFormRecordComment(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	recordID, ok := urlUUID(w, r, "recordId")
	if !ok {
		return
	}
	user := sessionUser(r)
	var body commentRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	comment, err := s.forms.AddComment(r.Context(), id, recordID, user.ID, body.Body)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": comment})
}

type attachmentRequest struct {
	FieldKey    string `json:"fieldKey"`
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	Data        string `json:"data"`    // base64-encoded image bytes
	Version     *int   `json:"version"` // record version for optimistic concurrency
}

// maxAttachmentRequestBytes bounds the JSON body for an attachment upload (base64 inflates ~33%).
const maxAttachmentRequestBytes = 40 << 20

func (s *server) uploadFormRecordAttachment(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	recordID, ok := urlUUID(w, r, "recordId")
	if !ok {
		return
	}
	user := sessionUser(r)
	var body attachmentRequest
	if err := decodeJSONLimit(w, r, &body, maxAttachmentRequestBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if body.Version == nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "A record version is required for attachment uploads.")
		return
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.Data))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", "Attachment data must be base64-encoded.")
		return
	}
	record, err := s.forms.CreateAttachment(r.Context(), id, recordID, user.ID, forms.AttachmentUpload{
		FieldKey: body.FieldKey, FileName: body.FileName, ContentType: body.ContentType, Data: data,
	}, *body.Version)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": record})
}

// removeFormRecordAttachment unbinds an attachment from a record and soft-deletes its asset,
// returning the updated record detail.
func (s *server) removeFormRecordAttachment(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	recordID, ok := urlUUID(w, r, "recordId")
	if !ok {
		return
	}
	attachmentID, ok := urlUUID(w, r, "attachmentId")
	if !ok {
		return
	}
	version, err := strconv.Atoi(r.URL.Query().Get("version"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "A record version is required for attachment removal.")
		return
	}
	user := sessionUser(r)
	record, err := s.forms.RemoveAttachment(r.Context(), id, recordID, attachmentID, user.ID, version)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": record})
}

// serveFormRecordAttachment streams a record's image attachment through a form-record-authorized
// endpoint. Form attachments are never exposed through the general Media library, so this is the
// only way to view them, and it applies the same visibility rules as reading the record.
func (s *server) serveFormRecordAttachment(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	recordID, ok := urlUUID(w, r, "recordId")
	if !ok {
		return
	}
	attachmentID, ok := urlUUID(w, r, "attachmentId")
	if !ok {
		return
	}
	user := sessionUser(r)
	assetID, err := s.forms.AttachmentAsset(r.Context(), id, recordID, attachmentID, user.ID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	delivery, err := s.media.FormAttachmentDelivery(r.Context(), assetID)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	serveDelivery(w, r, delivery)
}

// --- Views ---

func (s *server) listFormViews(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapViewAll)
	if !ok {
		return
	}
	form, err := s.forms.GetForm(r.Context(), id, userID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": form.Views})
}

type viewRequest struct {
	Key            string              `json:"key"`
	Name           string              `json:"name"`
	IncludedStates []string            `json:"includedStates"`
	FieldFilters   []forms.FieldFilter `json:"fieldFilters"`
	TimeFilter     forms.TimeFilter    `json:"timeFilter"`
	Sort           []forms.SortRule    `json:"sort"`
	OutputFields   []string            `json:"outputFields"`
	RecordLimit    int                 `json:"recordLimit"`
	Position       int                 `json:"position"`
}

func (s *server) upsertFormView(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	var body viewRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	view, err := s.forms.UpsertView(r.Context(), id, userID, forms.ViewInput{
		Key: body.Key, Name: body.Name, IncludedStates: body.IncludedStates, FieldFilters: body.FieldFilters,
		TimeFilter: body.TimeFilter, Sort: body.Sort, OutputFields: body.OutputFields, RecordLimit: body.RecordLimit, Position: body.Position,
	})
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": view})
}

func (s *server) deleteFormView(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	viewID, ok := urlUUID(w, r, "viewId")
	if !ok {
		return
	}
	if err := s.forms.DeleteView(r.Context(), id, viewID, userID); err != nil {
		s.writeFormError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// previewFormView projects an unsaved proposed view and returns the resulting dataset without saving.
func (s *server) previewFormView(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	var body viewRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	dataset, err := s.forms.PreviewView(r.Context(), id, forms.ViewInput{
		Key: body.Key, Name: body.Name, IncludedStates: body.IncludedStates, FieldFilters: body.FieldFilters,
		TimeFilter: body.TimeFilter, Sort: body.Sort, OutputFields: body.OutputFields, RecordLimit: body.RecordLimit, Position: body.Position,
	})
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": dataset})
}

// --- Outputs ---

func (s *server) getFormOutputs(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.authorizeForm(w, r, forms.CapViewAll)
	if !ok {
		return
	}
	outputs, err := s.forms.GetOutputs(r.Context(), id)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": outputs})
}

func (s *server) rebuildFormOutputs(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	outputs, err := s.forms.RebuildOutputs(r.Context(), id, userID)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": outputs})
}

// --- Access (directory + per-user grant replacement) ---

func (s *server) listFormAccess(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	entries, err := s.forms.ListAccess(r.Context(), id)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"entries": entries}})
}

func (s *server) searchFormUsers(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.authorizeForm(w, r, forms.CapManage); !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	users, err := s.forms.SearchUsers(r.Context(), r.URL.Query().Get("search"), limit)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": users}})
}

type accessRequest struct {
	Capabilities []string `json:"capabilities"`
}

func (s *server) replaceFormGrants(w http.ResponseWriter, r *http.Request) {
	id, actor, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	targetUser, ok := urlUUID(w, r, "userId")
	if !ok {
		return
	}
	var body accessRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	caps := make([]forms.Capability, 0, len(body.Capabilities))
	for _, capability := range body.Capabilities {
		caps = append(caps, forms.Capability(capability))
	}
	entries, err := s.forms.ReplaceGrants(r.Context(), id, actor, targetUser, caps)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"entries": entries}})
}

// --- Grants ---

func (s *server) listFormGrants(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	grants, err := s.forms.ListGrants(r.Context(), id)
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": grants})
}

type grantRequest struct {
	UserID     uuid.UUID `json:"userId"`
	Capability string    `json:"capability"`
}

func (s *server) setFormGrant(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	var body grantRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	grant, err := s.forms.SetGrant(r.Context(), id, userID, forms.GrantInput{UserID: body.UserID, Capability: forms.Capability(body.Capability)})
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": grant})
}

func (s *server) revokeFormGrant(w http.ResponseWriter, r *http.Request) {
	id, userID, ok := s.authorizeForm(w, r, forms.CapManage)
	if !ok {
		return
	}
	grantID, ok := urlUUID(w, r, "grantId")
	if !ok {
		return
	}
	if err := s.forms.RevokeGrant(r.Context(), id, grantID, userID); err != nil {
		s.writeFormError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Central approvals inbox ---

func (s *server) listApprovals(w http.ResponseWriter, r *http.Request) {
	user := sessionUser(r)
	query := r.URL.Query()
	page, _ := strconv.Atoi(query.Get("page"))
	pageSize, _ := strconv.Atoi(query.Get("pageSize"))
	result, err := s.forms.PendingApprovals(r.Context(), user.ID, forms.ApprovalFilter{Page: page, PageSize: pageSize})
	if err != nil {
		s.writeFormError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

func recordInput(body recordRequest) forms.RecordInput {
	return forms.RecordInput{
		Values:       body.Values,
		DisplayTitle: body.DisplayTitle,
		Priority:     body.Priority,
		DisplayAt:    body.DisplayAt,
		ExpiresAt:    body.ExpiresAt,
	}
}
