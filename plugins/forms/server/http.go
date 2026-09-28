package server

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var _ plugin.RouteProvider = (*Service)(nil)

// maxAttachmentRequestBytes bounds the JSON body for an attachment upload (base64 inflates ~33%).
const maxAttachmentRequestBytes = 40 << 20

// contentManagers may create a form. The creator becomes its manager. This
// preserves the historical global-role requirement: Owner and Administrator
// alone would lock Editors out of form creation.
var contentManagers = map[string]bool{"owner": true, "administrator": true, "editor": true}

// Routes declares every Forms route. All routes take AccessSession: any
// enrolled dashboard session may reach them, mutations carry the host CSRF
// check, and per-form capabilities are enforced inside each handler (grants
// depend on the {id} path param). Creating a form additionally requires the
// content-manager global role, checked explicitly in the handler.
func (s *Service) Routes(router plugin.Router) {
	router.Handle(http.MethodPost, "/forms", plugin.AccessSession, s.createForm)
	router.Handle(http.MethodGet, "/forms", plugin.AccessSession, s.listForms)
	router.Handle(http.MethodGet, "/data-sources/{id}/form", plugin.AccessSession, s.getForm)
	router.Handle(http.MethodPatch, "/data-sources/{id}/form", plugin.AccessSession, s.updateFormMetadata)
	router.Handle(http.MethodPatch, "/data-sources/{id}/form/draft", plugin.AccessSession, s.updateFormDraft)
	router.Handle(http.MethodPost, "/data-sources/{id}/form/publish", plugin.AccessSession, s.publishForm)
	router.Handle(http.MethodPut, "/data-sources/{id}/form/workflow", plugin.AccessSession, s.configureFormWorkflow)
	router.Handle(http.MethodGet, "/data-sources/{id}/records", plugin.AccessSession, s.listFormRecords)
	router.Handle(http.MethodPost, "/data-sources/{id}/records", plugin.AccessSession, s.createFormRecord)
	router.Handle(http.MethodGet, "/data-sources/{id}/records/{recordId}", plugin.AccessSession, s.getFormRecord)
	router.Handle(http.MethodPatch, "/data-sources/{id}/records/{recordId}", plugin.AccessSession, s.updateFormRecord)
	router.Handle(http.MethodDelete, "/data-sources/{id}/records/{recordId}", plugin.AccessSession, s.deleteFormRecord)
	router.Handle(http.MethodPost, "/data-sources/{id}/records/{recordId}/transitions", plugin.AccessSession, s.transitionFormRecord)
	router.Handle(http.MethodPost, "/data-sources/{id}/records/{recordId}/comments", plugin.AccessSession, s.addFormRecordComment)
	router.Handle(http.MethodPost, "/data-sources/{id}/records/{recordId}/attachments", plugin.AccessSession, s.uploadFormRecordAttachment)
	router.Handle(http.MethodGet, "/data-sources/{id}/records/{recordId}/attachments/{attachmentId}/content", plugin.AccessSession, s.serveFormRecordAttachment)
	router.Handle(http.MethodDelete, "/data-sources/{id}/records/{recordId}/attachments/{attachmentId}", plugin.AccessSession, s.removeFormRecordAttachment)
	router.Handle(http.MethodGet, "/data-sources/{id}/views", plugin.AccessSession, s.listFormViews)
	router.Handle(http.MethodPut, "/data-sources/{id}/views", plugin.AccessSession, s.upsertFormView)
	router.Handle(http.MethodPost, "/data-sources/{id}/views/preview", plugin.AccessSession, s.previewFormView)
	router.Handle(http.MethodDelete, "/data-sources/{id}/views/{viewId}", plugin.AccessSession, s.deleteFormView)
	router.Handle(http.MethodGet, "/data-sources/{id}/outputs", plugin.AccessSession, s.getFormOutputs)
	router.Handle(http.MethodPost, "/data-sources/{id}/outputs/rebuild", plugin.AccessSession, s.rebuildFormOutputs)
	router.Handle(http.MethodGet, "/data-sources/{id}/grants", plugin.AccessSession, s.listFormGrants)
	router.Handle(http.MethodPut, "/data-sources/{id}/grants", plugin.AccessSession, s.setFormGrant)
	router.Handle(http.MethodDelete, "/data-sources/{id}/grants/{grantId}", plugin.AccessSession, s.revokeFormGrant)
	router.Handle(http.MethodGet, "/data-sources/{id}/access", plugin.AccessSession, s.listFormAccess)
	router.Handle(http.MethodPut, "/data-sources/{id}/access/{userId}", plugin.AccessSession, s.replaceFormGrants)
	router.Handle(http.MethodGet, "/data-sources/{id}/user-directory", plugin.AccessSession, s.searchFormUsers)
	router.Handle(http.MethodGet, "/approvals", plugin.AccessSession, s.listApprovals)
}

// formError maps a forms domain error to the historical HTTP status and code.
func (s *Service) formError(err error) error {
	switch {
	case errors.Is(err, plugin.ErrNotInstalled):
		return err // the host answers 409 plugin_not_installed
	case errors.Is(err, ErrNotFound):
		return &plugin.APIError{Status: http.StatusNotFound, Code: "not_found", Message: "The requested form resource was not found."}
	case errors.Is(err, ErrForbidden):
		return &plugin.APIError{Status: http.StatusForbidden, Code: "insufficient_access", Message: "You do not have access to this form."}
	case errors.Is(err, ErrConflict):
		return &plugin.APIError{Status: http.StatusConflict, Code: "conflict", Message: "The record was modified by someone else. Reload and try again."}
	case errors.Is(err, ErrInUse):
		return &plugin.APIError{Status: http.StatusConflict, Code: "resource_in_use", Message: strings.TrimPrefix(err.Error(), "form resource is in use: ")}
	case errors.Is(err, ErrValidation):
		return &plugin.APIError{Status: http.StatusUnprocessableEntity, Code: "validation_failed", Message: strings.TrimPrefix(err.Error(), "form request is invalid: ")}
	default:
		return err
	}
}

// authorize enforces a per-form capability, returning the resolved form id
// and acting user id.
func (s *Service) authorize(r *http.Request, need Capability) (uuid.UUID, uuid.UUID, error) {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	allowed, err := s.Authorize(r.Context(), id, principal.UserID, need)
	if err != nil {
		return uuid.Nil, uuid.Nil, s.formError(err)
	}
	if !allowed {
		return uuid.Nil, uuid.Nil, &plugin.APIError{Status: http.StatusForbidden, Code: "insufficient_access", Message: "You do not have access to this form."}
	}
	return id, principal.UserID, nil
}

func principal(r *http.Request) plugin.Principal {
	principal, _ := plugin.PrincipalFrom(r.Context())
	return principal
}

// --- Form definition ---

type createFormRequest struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	DraftSchema FormSchema `json:"draftSchema"`
}

func (s *Service) createForm(w http.ResponseWriter, r *http.Request) error {
	if !contentManagers[principal(r).Role] {
		return &plugin.APIError{Status: http.StatusForbidden, Code: "insufficient_role", Message: "Owner or Administrator access is required."}
	}
	var body createFormRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	form, err := s.CreateForm(r.Context(), principal(r).UserID, FormInput{Name: body.Name, Description: body.Description, DraftSchema: body.DraftSchema})
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusCreated, form)
	return nil
}

// listForms returns every Form Data Source the current user may access. Scoping (owner sees all,
// others see created/granted forms) is enforced inside the forms service.
func (s *Service) listForms(w http.ResponseWriter, r *http.Request) error {
	items, err := s.ListAccessibleForms(r.Context(), principal(r).UserID)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, map[string]any{"items": items})
	return nil
}

func (s *Service) getForm(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	userID := principal(r).UserID
	access, err := s.CanAccessForm(r.Context(), id, userID)
	if err != nil {
		return s.formError(err)
	}
	if !access {
		return &plugin.APIError{Status: http.StatusForbidden, Code: "insufficient_access", Message: "You do not have access to this form."}
	}
	form, err := s.GetForm(r.Context(), id, userID)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, form)
	return nil
}

type metadataRequest struct {
	Name string `json:"name"`
	// Description is a pointer so an omitted field preserves the stored value (partial update).
	Description *string `json:"description"`
}

func (s *Service) updateFormMetadata(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	var body metadataRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	form, err := s.UpdateMetadata(r.Context(), id, userID, MetadataInput{Name: body.Name, Description: body.Description})
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, form)
	return nil
}

type draftRequest struct {
	Schema FormSchema `json:"schema"`
}

func (s *Service) updateFormDraft(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	var body draftRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	form, err := s.UpdateDraft(r.Context(), id, userID, DraftInput{Schema: body.Schema})
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, form)
	return nil
}

func (s *Service) publishForm(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	revision, err := s.PublishRevision(r.Context(), id, userID)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, revision)
	return nil
}

func (s *Service) configureFormWorkflow(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	var body Workflow
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	if err := s.ConfigureWorkflow(r.Context(), id, userID, WorkflowInput{Workflow: body}); err != nil {
		return s.formError(err)
	}
	form, err := s.GetForm(r.Context(), id, userID)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, form)
	return nil
}

// --- Records ---

func (s *Service) listFormRecords(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	query := r.URL.Query()
	page, _ := strconv.Atoi(query.Get("page"))
	pageSize, _ := strconv.Atoi(query.Get("pageSize"))
	filter := RecordFilter{Search: query.Get("search"), Sort: query.Get("sort"), Page: page, PageSize: pageSize, Mine: query.Get("mine") == "true"}
	if states := strings.TrimSpace(query.Get("states")); states != "" {
		filter.States = strings.Split(states, ",")
	}
	// Ownership scoping (own vs. all) is enforced inside the forms service.
	result, err := s.ListRecords(r.Context(), id, principal(r).UserID, filter)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, result)
	return nil
}

type recordRequest struct {
	Values       map[string]any      `json:"values"`
	DisplayTitle Optional[string]    `json:"displayTitle"`
	Priority     Optional[int]       `json:"priority"`
	DisplayAt    Optional[time.Time] `json:"displayAt"`
	ExpiresAt    Optional[time.Time] `json:"expiresAt"`
	Version      *int                `json:"version"`
}

func recordInput(body recordRequest) RecordInput {
	return RecordInput{
		Values:       body.Values,
		DisplayTitle: body.DisplayTitle,
		Priority:     body.Priority,
		DisplayAt:    body.DisplayAt,
		ExpiresAt:    body.ExpiresAt,
	}
}

func (s *Service) createFormRecord(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	var body recordRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	record, err := s.CreateRecord(r.Context(), id, principal(r).UserID, recordInput(body))
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusCreated, record)
	return nil
}

func (s *Service) getFormRecord(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	recordID, err := plugin.PathUUID(r, "recordId")
	if err != nil {
		return err
	}
	detail, err := s.GetRecord(r.Context(), id, recordID, principal(r).UserID)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, detail)
	return nil
}

func (s *Service) updateFormRecord(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	recordID, err := plugin.PathUUID(r, "recordId")
	if err != nil {
		return err
	}
	var body recordRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	if body.Version == nil {
		return &plugin.APIError{Status: http.StatusBadRequest, Code: "invalid_request", Message: "A record version is required for edits."}
	}
	record, err := s.UpdateRecord(r.Context(), id, recordID, principal(r).UserID, recordInput(body), *body.Version)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, record)
	return nil
}

func (s *Service) deleteFormRecord(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	recordID, err := plugin.PathUUID(r, "recordId")
	if err != nil {
		return err
	}
	if err := s.DeleteRecord(r.Context(), id, recordID, principal(r).UserID); err != nil {
		return s.formError(err)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type transitionRequest struct {
	ToState string `json:"toState"`
	Note    string `json:"note"`
	Version int    `json:"version"`
}

func (s *Service) transitionFormRecord(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	recordID, err := plugin.PathUUID(r, "recordId")
	if err != nil {
		return err
	}
	var body transitionRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	record, err := s.Transition(r.Context(), id, recordID, principal(r).UserID, body.ToState, body.Note, body.Version)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, record)
	return nil
}

type commentRequest struct {
	Body string `json:"body"`
}

func (s *Service) addFormRecordComment(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	recordID, err := plugin.PathUUID(r, "recordId")
	if err != nil {
		return err
	}
	var body commentRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	comment, err := s.AddComment(r.Context(), id, recordID, principal(r).UserID, body.Body)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusCreated, comment)
	return nil
}

type attachmentRequest struct {
	FieldKey    string `json:"fieldKey"`
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	Data        string `json:"data"`    // base64-encoded image bytes
	Version     *int   `json:"version"` // record version for optimistic concurrency
}

func (s *Service) uploadFormRecordAttachment(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	recordID, err := plugin.PathUUID(r, "recordId")
	if err != nil {
		return err
	}
	var body attachmentRequest
	if err := plugin.DecodeJSONLimit(w, r, &body, maxAttachmentRequestBytes); err != nil {
		return err
	}
	if body.Version == nil {
		return &plugin.APIError{Status: http.StatusBadRequest, Code: "invalid_request", Message: "A record version is required for attachment uploads."}
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.Data))
	if err != nil {
		return &plugin.APIError{Status: http.StatusUnprocessableEntity, Code: "validation_failed", Message: "Attachment data must be base64-encoded."}
	}
	record, err := s.CreateAttachment(r.Context(), id, recordID, principal(r).UserID, AttachmentUpload{
		FieldKey: body.FieldKey, FileName: body.FileName, ContentType: body.ContentType, Data: data,
	}, *body.Version)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusCreated, record)
	return nil
}

// removeFormRecordAttachment unbinds an attachment from a record and soft-deletes its asset,
// returning the updated record detail.
func (s *Service) removeFormRecordAttachment(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	recordID, err := plugin.PathUUID(r, "recordId")
	if err != nil {
		return err
	}
	attachmentID, err := plugin.PathUUID(r, "attachmentId")
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(r.URL.Query().Get("version"))
	if err != nil {
		return &plugin.APIError{Status: http.StatusBadRequest, Code: "invalid_request", Message: "A record version is required for attachment removal."}
	}
	record, err := s.RemoveAttachment(r.Context(), id, recordID, attachmentID, principal(r).UserID, version)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, record)
	return nil
}

// serveFormRecordAttachment streams a record's image attachment through a form-record-authorized
// endpoint. Form attachments are never exposed through the general Media library, so this is the
// only way to view them, and it applies the same visibility rules as reading the record.
func (s *Service) serveFormRecordAttachment(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	recordID, err := plugin.PathUUID(r, "recordId")
	if err != nil {
		return err
	}
	attachmentID, err := plugin.PathUUID(r, "attachmentId")
	if err != nil {
		return err
	}
	assetID, err := s.AttachmentAsset(r.Context(), id, recordID, attachmentID, principal(r).UserID)
	if err != nil {
		return s.formError(err)
	}
	if err := s.host.PluginAssets.ServePrivate(w, r, assetID); err != nil {
		if errors.Is(err, plugin.ErrNotFound) {
			return &plugin.APIError{Status: http.StatusNotFound, Code: "media_variant_unavailable", Message: "The requested media variant is unavailable."}
		}
		return err
	}
	return nil
}

// --- Views ---

func (s *Service) listFormViews(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapViewAll)
	if err != nil {
		return err
	}
	form, err := s.GetForm(r.Context(), id, userID)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, form.Views)
	return nil
}

type viewRequest struct {
	Key            string        `json:"key"`
	Name           string        `json:"name"`
	IncludedStates []string      `json:"includedStates"`
	FieldFilters   []FieldFilter `json:"fieldFilters"`
	TimeFilter     TimeFilter    `json:"timeFilter"`
	Sort           []SortRule    `json:"sort"`
	OutputFields   []string      `json:"outputFields"`
	RecordLimit    int           `json:"recordLimit"`
	Position       int           `json:"position"`
}

func (s *Service) upsertFormView(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	var body viewRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	view, err := s.UpsertView(r.Context(), id, userID, ViewInput{
		Key: body.Key, Name: body.Name, IncludedStates: body.IncludedStates, FieldFilters: body.FieldFilters,
		TimeFilter: body.TimeFilter, Sort: body.Sort, OutputFields: body.OutputFields, RecordLimit: body.RecordLimit, Position: body.Position,
	})
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, view)
	return nil
}

func (s *Service) deleteFormView(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	viewID, err := plugin.PathUUID(r, "viewId")
	if err != nil {
		return err
	}
	if err := s.DeleteView(r.Context(), id, viewID, userID); err != nil {
		return s.formError(err)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// previewFormView projects an unsaved proposed view and returns the resulting dataset without saving.
func (s *Service) previewFormView(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	var body viewRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	dataset, err := s.PreviewView(r.Context(), id, ViewInput{
		Key: body.Key, Name: body.Name, IncludedStates: body.IncludedStates, FieldFilters: body.FieldFilters,
		TimeFilter: body.TimeFilter, Sort: body.Sort, OutputFields: body.OutputFields, RecordLimit: body.RecordLimit, Position: body.Position,
	})
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, dataset)
	return nil
}

// --- Outputs ---

func (s *Service) getFormOutputs(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.authorize(r, CapViewAll)
	if err != nil {
		return err
	}
	outputs, err := s.GetOutputs(r.Context(), id)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, outputs)
	return nil
}

func (s *Service) rebuildFormOutputs(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	outputs, err := s.RebuildOutputs(r.Context(), id, userID)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, outputs)
	return nil
}

// --- Access (directory + per-user grant replacement) ---

func (s *Service) listFormAccess(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	entries, err := s.ListAccess(r.Context(), id)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, map[string]any{"entries": entries})
	return nil
}

func (s *Service) searchFormUsers(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := s.authorize(r, CapManage); err != nil {
		return err
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	users, err := s.SearchUsers(r.Context(), r.URL.Query().Get("search"), limit)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, map[string]any{"items": users})
	return nil
}

type accessRequest struct {
	Capabilities []string `json:"capabilities"`
}

// --- Grants ---

func (s *Service) listFormGrants(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	grants, err := s.ListGrants(r.Context(), id)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, grants)
	return nil
}

type grantRequest struct {
	UserID     uuid.UUID `json:"userId"`
	Capability string    `json:"capability"`
}

func (s *Service) setFormGrant(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	var body grantRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	grant, err := s.SetGrant(r.Context(), id, userID, GrantInput{UserID: body.UserID, Capability: Capability(body.Capability)})
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusCreated, grant)
	return nil
}

func (s *Service) revokeFormGrant(w http.ResponseWriter, r *http.Request) error {
	id, userID, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	grantID, err := plugin.PathUUID(r, "grantId")
	if err != nil {
		return err
	}
	if err := s.RevokeGrant(r.Context(), id, grantID, userID); err != nil {
		return s.formError(err)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Service) replaceFormGrants(w http.ResponseWriter, r *http.Request) error {
	id, actor, err := s.authorize(r, CapManage)
	if err != nil {
		return err
	}
	targetUser, err := plugin.PathUUID(r, "userId")
	if err != nil {
		return err
	}
	var body accessRequest
	if err := plugin.DecodeJSON(w, r, &body); err != nil {
		return err
	}
	caps := make([]Capability, 0, len(body.Capabilities))
	for _, capability := range body.Capabilities {
		caps = append(caps, Capability(capability))
	}
	entries, err := s.ReplaceGrants(r.Context(), id, actor, targetUser, caps)
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, map[string]any{"entries": entries})
	return nil
}

// --- Central approvals inbox ---

func (s *Service) listApprovals(w http.ResponseWriter, r *http.Request) error {
	query := r.URL.Query()
	page, _ := strconv.Atoi(query.Get("page"))
	pageSize, _ := strconv.Atoi(query.Get("pageSize"))
	result, err := s.PendingApprovals(r.Context(), principal(r).UserID, ApprovalFilter{Page: page, PageSize: pageSize})
	if err != nil {
		return s.formError(err)
	}
	plugin.WriteData(w, http.StatusOK, result)
	return nil
}
