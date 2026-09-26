package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// RecordInput carries submitted or edited record values and display metadata. The display fields
// are tri-state (see Optional): omitted preserves the stored value, explicit null clears it, and
// a value replaces it.
type RecordInput struct {
	Values       map[string]any
	DisplayTitle Optional[string]
	Priority     Optional[int]
	DisplayAt    Optional[time.Time]
	ExpiresAt    Optional[time.Time]
}

// RecordFilter selects and paginates records.
type RecordFilter struct {
	States      []string
	Search      string
	SubmittedBy *uuid.UUID
	// Mine scopes the result to the caller's own submissions even when they could otherwise see all
	// records (used by the Forms portal's "your submissions" list).
	Mine     bool
	Sort     string
	Page     int
	PageSize int
}

// RecordPage is a paginated slice of records.
type RecordPage struct {
	Items    []Record `json:"items"`
	Total    int      `json:"total"`
	Page     int      `json:"page"`
	PageSize int      `json:"pageSize"`
}

// recordMeta is the minimal record identity used for authorization decisions.
type recordMeta struct {
	id           uuid.UUID
	dataSourceID uuid.UUID
	revisionID   uuid.UUID
	state        string
	owner        *uuid.UUID
	version      int
	eligible     bool
}

// loadRecordScoped returns a record's identity scoped to a form. A record that does not exist, is
// deleted, or belongs to a different Form Data Source returns ErrNotFound so callers never leak
// the existence of records outside the addressed form.
func (s *Service) loadRecordScoped(ctx context.Context, q rowQuerier, formID, recordID uuid.UUID) (recordMeta, error) {
	var meta recordMeta
	err := q.QueryRow(ctx, `SELECT id,data_source_id,revision_id,state_key,submitted_by,version,eligible
		FROM form_records WHERE id=$1 AND deleted_at IS NULL`, recordID).
		Scan(&meta.id, &meta.dataSourceID, &meta.revisionID, &meta.state, &meta.owner, &meta.version, &meta.eligible)
	if errors.Is(err, pgx.ErrNoRows) {
		return recordMeta{}, ErrNotFound
	}
	if err != nil {
		return recordMeta{}, err
	}
	if meta.dataSourceID != formID {
		return recordMeta{}, ErrNotFound
	}
	return meta, nil
}

// allow is a small helper that treats an authorization error as "not allowed" only when the form
// is missing; real errors propagate.
func (s *Service) allow(ctx context.Context, formID, userID uuid.UUID, need Capability) (bool, error) {
	return s.Authorize(ctx, formID, userID, need)
}

// visibilityError chooses 404 vs 403 so a submitter cannot probe for records they may not see: a
// user who owns the record or can view all records gets Forbidden; anyone else gets NotFound.
func visibilityError(isOwner, canViewAll bool) error {
	if isOwner || canViewAll {
		return ErrForbidden
	}
	return ErrNotFound
}

// stateSubmitterEditable reports whether a state allows submitter edits, defined as any state
// with an outgoing transition that requires the submit capability (draft and changes_requested by
// default). This keeps "editable states" derived from the configured workflow rather than hardcoded.
func (s *Service) stateSubmitterEditable(ctx context.Context, q rowQuerier, formID uuid.UUID, state string) (bool, error) {
	var editable bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM form_workflow_transitions
		WHERE data_source_id=$1 AND from_state=$2 AND required_capability='submit')`, formID, state).Scan(&editable)
	return editable, err
}

// authorizeEdit enforces who may edit a record's fields or attachments: a manager may edit any
// record; otherwise the caller must own the record, hold submit, and the record must be in a
// submitter-editable state. Existence is hidden from callers who may not see the record.
func (s *Service) authorizeEdit(ctx context.Context, formID, recordID, userID uuid.UUID) (recordMeta, error) {
	meta, err := s.loadRecordScoped(ctx, s.db, formID, recordID)
	if err != nil {
		return recordMeta{}, err
	}
	manage, err := s.allow(ctx, formID, userID, CapManage)
	if err != nil {
		return recordMeta{}, err
	}
	if manage {
		return meta, nil
	}
	isOwner := meta.owner != nil && *meta.owner == userID
	canViewAll, err := s.allow(ctx, formID, userID, CapViewAll)
	if err != nil {
		return recordMeta{}, err
	}
	if !isOwner {
		return recordMeta{}, visibilityError(false, canViewAll)
	}
	hasSubmit, err := s.allow(ctx, formID, userID, CapSubmit)
	if err != nil {
		return recordMeta{}, err
	}
	if !hasSubmit {
		return recordMeta{}, ErrForbidden
	}
	editable, err := s.stateSubmitterEditable(ctx, s.db, formID, meta.state)
	if err != nil {
		return recordMeta{}, err
	}
	if !editable {
		return recordMeta{}, fmt.Errorf("%w: the record cannot be edited in its current state", ErrValidation)
	}
	return meta, nil
}

// CreateRecord creates a draft submission bound to the form's current published revision. The
// caller must hold the submit capability on the form.
func (s *Service) CreateRecord(ctx context.Context, formID, actor uuid.UUID, in RecordInput) (Record, error) {
	if _, err := s.ensureForm(ctx, formID); err != nil {
		return Record{}, err
	}
	allowed, err := s.allow(ctx, formID, actor, CapSubmit)
	if err != nil {
		return Record{}, err
	}
	if !allowed {
		return Record{}, ErrForbidden
	}
	revision, err := s.loadPublishedRevision(ctx, s.db, formID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Record{}, fmt.Errorf("%w: the form has no published revision", ErrValidation)
		}
		return Record{}, err
	}
	// A new record has no attachments yet, so no image fields can be bound. Client-supplied image
	// values are rejected by validateRecordValues.
	values, err := validateRecordValues(revision.Schema, in.Values, false, nil)
	if err != nil {
		return Record{}, err
	}
	initialState, err := initialStateKey(ctx, s.db, formID)
	if err != nil {
		return Record{}, err
	}
	encoded, _ := json.Marshal(values)
	recordID := uuid.New()
	displayTitle := ""
	if in.DisplayTitle.Set && in.DisplayTitle.Value != nil {
		displayTitle = strings.TrimSpace(*in.DisplayTitle.Value)
	}
	priority := 0
	if in.Priority.Set && in.Priority.Value != nil {
		priority = *in.Priority.Value
	}
	var displayAt, expiresAt *time.Time
	if in.DisplayAt.Set {
		displayAt = in.DisplayAt.Value
	}
	if in.ExpiresAt.Set {
		expiresAt = in.ExpiresAt.Value
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Record{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	submitterName := s.userNameInTx(ctx, tx, actor)
	if _, err := tx.Exec(ctx, `INSERT INTO form_records(id,data_source_id,revision_id,state_key,values,submitted_by,submitter_name,display_title,priority,display_at,expires_at,eligible,version)
		VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,FALSE,1)`,
		recordID, formID, revision.ID, initialState, string(encoded), actor, submitterName, displayTitle, priority, displayAt, expiresAt); err != nil {
		return Record{}, err
	}
	if err := insertEvent(ctx, tx, recordID, formID, "created", "", initialState, actor, submitterName, ""); err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, err
	}
	return s.getRecordRow(ctx, s.db, recordID)
}

// UpdateRecord edits a record's values and display metadata under optimistic concurrency. Display
// fields are tri-state: omitted preserves, explicit null clears, a value replaces.
func (s *Service) UpdateRecord(ctx context.Context, formID, recordID, actor uuid.UUID, in RecordInput, expectedVersion int) (Record, error) {
	if _, err := s.authorizeEdit(ctx, formID, recordID, actor); err != nil {
		return Record{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Record{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var revisionID uuid.UUID
	var version int
	var eligible bool
	var existingRaw []byte
	err = tx.QueryRow(ctx, `SELECT revision_id,version,eligible,values FROM form_records WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, recordID).Scan(&revisionID, &version, &eligible, &existingRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, ErrNotFound
	}
	if err != nil {
		return Record{}, err
	}
	if version != expectedVersion {
		return Record{}, ErrConflict
	}
	schema, err := s.revisionSchema(ctx, tx, revisionID)
	if err != nil {
		return Record{}, err
	}
	boundImages, err := s.boundImageFields(ctx, tx, recordID)
	if err != nil {
		return Record{}, err
	}
	values, err := validateRecordValues(schema, in.Values, eligible, boundImages)
	if err != nil {
		return Record{}, err
	}
	// Preserve the record's real image values (managed by the attachment endpoints); the client
	// never sends them, so re-merge them from the stored values so an edit cannot drop an image.
	existing := map[string]any{}
	if len(existingRaw) > 0 {
		_ = json.Unmarshal(existingRaw, &existing)
	}
	mergeImageValues(schema, values, existing)
	encoded, _ := json.Marshal(values)
	sets := []string{"values=$2::jsonb", "version=version+1", "updated_at=now()"}
	args := []any{recordID, string(encoded)}
	addSet := func(col string, val any) {
		args = append(args, val)
		sets = append(sets, fmt.Sprintf("%s=$%d", col, len(args)))
	}
	if in.DisplayTitle.Set {
		if in.DisplayTitle.Value == nil {
			sets = append(sets, "display_title=''")
		} else {
			addSet("display_title", strings.TrimSpace(*in.DisplayTitle.Value))
		}
	}
	if in.Priority.Set {
		if in.Priority.Value == nil {
			sets = append(sets, "priority=0")
		} else {
			addSet("priority", *in.Priority.Value)
		}
	}
	if in.DisplayAt.clears() {
		sets = append(sets, "display_at=NULL")
	} else if in.DisplayAt.Set {
		addSet("display_at", *in.DisplayAt.Value)
	}
	if in.ExpiresAt.clears() {
		sets = append(sets, "expires_at=NULL")
	} else if in.ExpiresAt.Set {
		addSet("expires_at", *in.ExpiresAt.Value)
	}
	actorName := s.userNameInTx(ctx, tx, actor)
	if _, err := tx.Exec(ctx, `UPDATE form_records SET `+strings.Join(sets, ",")+` WHERE id=$1`, args...); err != nil {
		return Record{}, err
	}
	if err := insertEvent(ctx, tx, recordID, formID, "edited", "", "", actor, actorName, ""); err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, err
	}
	if eligible {
		if err := s.RebuildProjection(ctx, formID); err != nil {
			return Record{}, err
		}
	}
	return s.getRecordRow(ctx, s.db, recordID)
}

// Transition moves a record to a new state, enforcing the configured workflow, per-form record
// ownership and capability rules, optimistic concurrency, and required-field completeness when
// entering an output-eligible state. It records history and rebuilds the projection so approvals
// reach signage and manifests are invalidated.
func (s *Service) Transition(ctx context.Context, formID, recordID, actor uuid.UUID, toState, note string, expectedVersion int) (Record, error) {
	meta, err := s.loadRecordScoped(ctx, s.db, formID, recordID)
	if err != nil {
		return Record{}, err
	}
	workflow, err := loadWorkflow(ctx, s.db, formID)
	if err != nil {
		return Record{}, err
	}
	var chosen *WorkflowTransition
	for i := range workflow.Transitions {
		if workflow.Transitions[i].From == meta.state && workflow.Transitions[i].To == toState {
			chosen = &workflow.Transitions[i]
			break
		}
	}
	if chosen == nil {
		return Record{}, fmt.Errorf("%w: no transition from %q to %q", ErrValidation, meta.state, toState)
	}
	requiredCapability := string(chosen.RequiredCapability)
	// Enforce required transition notes on the server (the same rule the UI renders): a transition
	// that requires a note is rejected when the note is empty.
	if transitionRequiresNote(workflow, *chosen) && strings.TrimSpace(note) == "" {
		return Record{}, fmt.Errorf("%w: this decision requires a note", ErrValidation)
	}
	isOwner := meta.owner != nil && *meta.owner == actor
	manage, err := s.allow(ctx, formID, actor, CapManage)
	if err != nil {
		return Record{}, err
	}
	canViewAll, err := s.allow(ctx, formID, actor, CapViewAll)
	if err != nil {
		return Record{}, err
	}
	allowed := manage
	if !allowed {
		if Capability(requiredCapability) == CapSubmit {
			// Submitters may submit or resubmit only their own records.
			hasSubmit, err := s.allow(ctx, formID, actor, CapSubmit)
			if err != nil {
				return Record{}, err
			}
			allowed = isOwner && hasSubmit
		} else {
			// Review/approve transitions require that reviewer capability.
			allowed, err = s.allow(ctx, formID, actor, Capability(requiredCapability))
			if err != nil {
				return Record{}, err
			}
		}
	}
	if !allowed {
		return Record{}, visibilityError(isOwner, canViewAll)
	}
	var targetEligible bool
	if err := s.db.QueryRow(ctx, `SELECT eligible_for_output FROM form_workflow_states WHERE data_source_id=$1 AND state_key=$2`, formID, toState).Scan(&targetEligible); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Record{}, fmt.Errorf("%w: target state %q does not exist", ErrValidation, toState)
		}
		return Record{}, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Record{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var version int
	var lockedState string
	var revisionID uuid.UUID
	var valuesRaw []byte
	err = tx.QueryRow(ctx, `SELECT version,state_key,revision_id,values FROM form_records WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, recordID).
		Scan(&version, &lockedState, &revisionID, &valuesRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, ErrNotFound
	}
	if err != nil {
		return Record{}, err
	}
	if version != expectedVersion {
		return Record{}, ErrConflict
	}
	if lockedState != meta.state {
		return Record{}, ErrConflict
	}
	// Enforce required-field completeness before a submit/resubmit (any transition requiring the
	// submit capability) as well as before entering an output-eligible state. This blocks an
	// incomplete draft from being submitted, not only from reaching signage.
	if targetEligible || Capability(requiredCapability) == CapSubmit {
		schema, err := s.revisionSchema(ctx, tx, revisionID)
		if err != nil {
			return Record{}, err
		}
		var values map[string]any
		if len(valuesRaw) > 0 {
			_ = json.Unmarshal(valuesRaw, &values)
		}
		boundImages, err := s.boundImageFields(ctx, tx, recordID)
		if err != nil {
			return Record{}, err
		}
		// The stored values legitimately carry image asset ids; strip them before validating so the
		// client-forgery guard does not fire, and verify required images via the bound-image set.
		if _, err := validateRecordValues(schema, imageOnlyOmitted(schema, values), true, boundImages); err != nil {
			return Record{}, err
		}
	}
	actorName := s.userNameInTx(ctx, tx, actor)
	if _, err := tx.Exec(ctx, `UPDATE form_records SET state_key=$2,eligible=$3,version=version+1,updated_at=now() WHERE id=$1`, recordID, toState, targetEligible); err != nil {
		return Record{}, err
	}
	if err := insertEvent(ctx, tx, recordID, formID, "transition", meta.state, toState, actor, actorName, note); err != nil {
		return Record{}, err
	}
	if strings.TrimSpace(note) != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO form_record_comments(id,record_id,author_id,author_name,body) VALUES($1,$2,$3,$4,$5)`,
			uuid.New(), recordID, actor, actorName, strings.TrimSpace(note)); err != nil {
			return Record{}, err
		}
	}
	if err := s.recordAudit(ctx, tx, actor, "form.record_transition", formID.String(),
		map[string]any{"record": recordID.String(), "from": meta.state, "to": toState}); err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, err
	}
	if err := s.RebuildProjection(ctx, formID); err != nil {
		return Record{}, err
	}
	return s.getRecordRow(ctx, s.db, recordID)
}

// DeleteRecord soft-deletes a record; only a manager may delete, and existence is hidden from
// callers who may not see the record.
func (s *Service) DeleteRecord(ctx context.Context, formID, recordID, actor uuid.UUID) error {
	meta, err := s.loadRecordScoped(ctx, s.db, formID, recordID)
	if err != nil {
		return err
	}
	manage, err := s.allow(ctx, formID, actor, CapManage)
	if err != nil {
		return err
	}
	if !manage {
		isOwner := meta.owner != nil && *meta.owner == actor
		canViewAll, err := s.allow(ctx, formID, actor, CapViewAll)
		if err != nil {
			return err
		}
		return visibilityError(isOwner, canViewAll)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var eligible bool
	if err := tx.QueryRow(ctx, `SELECT eligible FROM form_records WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, recordID).Scan(&eligible); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE form_records SET deleted_at=now(),eligible=FALSE,updated_at=now() WHERE id=$1`, recordID); err != nil {
		return err
	}
	if err := s.recordAudit(ctx, tx, actor, "form.record_deleted", formID.String(), nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if eligible {
		return s.RebuildProjection(ctx, formID)
	}
	return nil
}

// AddComment records a reviewer or submitter comment on a record. The comment and its history
// event commit together or not at all.
func (s *Service) AddComment(ctx context.Context, formID, recordID, actor uuid.UUID, body string) (RecordComment, error) {
	body = strings.TrimSpace(body)
	if body == "" || len(body) > 4000 {
		return RecordComment{}, fmt.Errorf("%w: comment must be between 1 and 4000 characters", ErrValidation)
	}
	meta, err := s.loadRecordScoped(ctx, s.db, formID, recordID)
	if err != nil {
		return RecordComment{}, err
	}
	isOwner := meta.owner != nil && *meta.owner == actor
	canReview, err := s.allow(ctx, formID, actor, CapReview)
	if err != nil {
		return RecordComment{}, err
	}
	canViewAll, err := s.allow(ctx, formID, actor, CapViewAll)
	if err != nil {
		return RecordComment{}, err
	}
	if !canReview && !isOwner {
		return RecordComment{}, visibilityError(false, canViewAll)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RecordComment{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	actorName := s.userNameInTx(ctx, tx, actor)
	commentID := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO form_record_comments(id,record_id,author_id,author_name,body) VALUES($1,$2,$3,$4,$5)`,
		commentID, recordID, actor, actorName, body); err != nil {
		return RecordComment{}, err
	}
	if err := insertEvent(ctx, tx, recordID, formID, "comment", "", "", actor, actorName, body); err != nil {
		return RecordComment{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecordComment{}, err
	}
	return RecordComment{ID: commentID, AuthorName: actorName, Body: body, CreatedAt: time.Now().UTC()}, nil
}

// AttachmentUpload carries the bytes and metadata for a new form attachment.
type AttachmentUpload struct {
	FieldKey    string
	FileName    string
	ContentType string
	Data        []byte
}

// CreateAttachment ingests an uploaded image as a dedicated form attachment (origin
// 'form_attachment' from the start), binds it to the record and a validated image field, and
// records the value on the record. It never reclassifies an existing library asset. Authorization
// matches record editing. It uses optimistic concurrency: the record is locked and its stored
// version compared to expectedVersion, returning ErrConflict on a mismatch. Because image fields are
// single-valued, uploading to a field that already has an attachment replaces it: the prior
// attachment for that field is unbound and its asset is soft-deleted. The updated record detail
// (with its incremented version) is returned.
func (s *Service) CreateAttachment(ctx context.Context, formID, recordID, actor uuid.UUID, upload AttachmentUpload, expectedVersion int) (RecordDetail, error) {
	meta, err := s.authorizeEdit(ctx, formID, recordID, actor)
	if err != nil {
		return RecordDetail{}, err
	}
	schema, err := s.revisionSchema(ctx, s.db, meta.revisionID)
	if err != nil {
		return RecordDetail{}, err
	}
	if !isImageField(schema, upload.FieldKey) {
		return RecordDetail{}, fmt.Errorf("%w: %q is not an image field in this form", ErrValidation, upload.FieldKey)
	}
	asset, err := s.host.PluginAssets.IngestPrivate(ctx, actor, upload.FileName, upload.ContentType, upload.Data)
	if err != nil {
		if errors.Is(err, plugin.ErrTooLarge) || errors.Is(err, plugin.ErrInvalid) {
			return RecordDetail{}, fmt.Errorf("%w: %v", ErrValidation, err)
		}
		return RecordDetail{}, err
	}
	// Until the new binding is committed, the freshly ingested asset is orphaned; clean it up on any
	// failure so a rejected bind never leaks storage.
	committed := false
	defer func() {
		if !committed {
			_ = s.host.PluginAssets.DiscardPrivate(ctx, asset.ID)
		}
	}()

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RecordDetail{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// Lock the record so concurrent replacements serialize, then enforce optimistic concurrency
	// against the stored version.
	var valuesRaw []byte
	var eligible bool
	var version int
	if err := tx.QueryRow(ctx, `SELECT values,eligible,version FROM form_records WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, recordID).Scan(&valuesRaw, &eligible, &version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RecordDetail{}, ErrNotFound
		}
		return RecordDetail{}, err
	}
	if version != expectedVersion {
		return RecordDetail{}, ErrConflict
	}
	// Image fields are single-valued: remove any existing attachment on this field before binding
	// the new one so the UNIQUE(record_id, field_key) invariant holds. The displaced asset is cleaned
	// up only after the projection no longer references it.
	staleAssets, err := s.deleteFieldAttachments(ctx, tx, recordID, upload.FieldKey)
	if err != nil {
		return RecordDetail{}, err
	}
	if _, err := s.bindAttachment(ctx, tx, recordID, asset.ID, upload.FieldKey); err != nil {
		return RecordDetail{}, err
	}
	values := map[string]any{}
	if len(valuesRaw) > 0 {
		_ = json.Unmarshal(valuesRaw, &values)
	}
	values[upload.FieldKey] = asset.ID.String()
	if err := s.validateEligibleAfterAttachment(ctx, tx, schema, recordID, values, eligible); err != nil {
		return RecordDetail{}, err
	}
	encoded, _ := json.Marshal(values)
	actorName := s.userNameInTx(ctx, tx, actor)
	if _, err := tx.Exec(ctx, `UPDATE form_records SET values=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1`, recordID, string(encoded)); err != nil {
		return RecordDetail{}, err
	}
	if err := insertEvent(ctx, tx, recordID, formID, "attachment_added", "", "", actor, actorName, upload.FieldKey); err != nil {
		return RecordDetail{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecordDetail{}, err
	}
	committed = true
	// Rebuild the projection first so cached signage output stops referencing any replaced asset,
	// then soft-delete the displaced assets. A rebuild failure surfaces and leaves the old asset in
	// place rather than dangling.
	if eligible {
		if err := s.RebuildProjection(ctx, formID); err != nil {
			return RecordDetail{}, err
		}
	}
	for _, staleAsset := range staleAssets {
		_ = s.host.PluginAssets.DiscardPrivate(ctx, staleAsset)
	}
	return s.GetRecord(ctx, formID, recordID, actor)
}

// RemoveAttachment unbinds an attachment from a record, clears the field value it backed, and
// soft-deletes the underlying asset. Authorization matches record editing. It uses optimistic
// concurrency: the record is locked and its stored version compared to expectedVersion, returning
// ErrConflict on a mismatch. On an output-eligible record, required fields are re-validated (so a
// required image cannot be dropped from approved output) and the projection is rebuilt before the
// asset is deleted. The updated record detail (with its incremented version) is returned.
func (s *Service) RemoveAttachment(ctx context.Context, formID, recordID, attachmentID, actor uuid.UUID, expectedVersion int) (RecordDetail, error) {
	meta, err := s.authorizeEdit(ctx, formID, recordID, actor)
	if err != nil {
		return RecordDetail{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RecordDetail{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// Lock the record, then enforce optimistic concurrency against the stored version.
	var valuesRaw []byte
	var eligible bool
	var version int
	if err := tx.QueryRow(ctx, `SELECT values,eligible,version FROM form_records WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, recordID).Scan(&valuesRaw, &eligible, &version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RecordDetail{}, ErrNotFound
		}
		return RecordDetail{}, err
	}
	if version != expectedVersion {
		return RecordDetail{}, ErrConflict
	}
	var assetID uuid.UUID
	var fieldKey string
	err = tx.QueryRow(ctx, `SELECT asset_id,field_key FROM form_record_attachments WHERE id=$1 AND record_id=$2`, attachmentID, recordID).Scan(&assetID, &fieldKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordDetail{}, ErrNotFound
	}
	if err != nil {
		return RecordDetail{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM form_record_attachments WHERE id=$1 AND record_id=$2`, attachmentID, recordID); err != nil {
		return RecordDetail{}, err
	}
	values := map[string]any{}
	if len(valuesRaw) > 0 {
		_ = json.Unmarshal(valuesRaw, &values)
	}
	// Only clear the field if it still points at the removed asset (guards against a concurrent replace).
	if current, ok := values[fieldKey].(string); ok && current == assetID.String() {
		delete(values, fieldKey)
	}
	schema, err := s.revisionSchema(ctx, tx, meta.revisionID)
	if err != nil {
		return RecordDetail{}, err
	}
	if err := s.validateEligibleAfterAttachment(ctx, tx, schema, recordID, values, eligible); err != nil {
		return RecordDetail{}, err
	}
	encoded, _ := json.Marshal(values)
	actorName := s.userNameInTx(ctx, tx, actor)
	if _, err := tx.Exec(ctx, `UPDATE form_records SET values=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1`, recordID, string(encoded)); err != nil {
		return RecordDetail{}, err
	}
	if err := insertEvent(ctx, tx, recordID, formID, "attachment_removed", "", "", actor, actorName, fieldKey); err != nil {
		return RecordDetail{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecordDetail{}, err
	}
	// Rebuild first so cached output stops referencing the asset, then soft-delete it.
	if eligible {
		if err := s.RebuildProjection(ctx, formID); err != nil {
			return RecordDetail{}, err
		}
	}
	_ = s.host.PluginAssets.DiscardPrivate(ctx, assetID)
	return s.GetRecord(ctx, formID, recordID, actor)
}

// validateEligibleAfterAttachment re-validates required-field completeness for an output-eligible
// record after an attachment change, using the post-change bound-image set. A no-op for records that
// are not output-eligible (drafts may be incomplete). Returns ErrValidation if a required field —
// including a required image — would no longer be satisfied.
func (s *Service) validateEligibleAfterAttachment(ctx context.Context, tx pgx.Tx, schema FormSchema, recordID uuid.UUID, values map[string]any, eligible bool) error {
	if !eligible {
		return nil
	}
	boundImages, err := s.boundImageFields(ctx, tx, recordID)
	if err != nil {
		return err
	}
	_, err = validateRecordValues(schema, imageOnlyOmitted(schema, values), true, boundImages)
	return err
}

// imageOnlyOmitted returns a copy of values with image-field entries removed, so re-validation runs
// against the non-image values plus the bound-image set (image values are never client-authored).
func imageOnlyOmitted(schema FormSchema, values map[string]any) map[string]any {
	imageKeys := map[string]bool{}
	for _, field := range schema.Fields {
		if field.Control == ControlImage {
			imageKeys[field.Key] = true
		}
	}
	out := map[string]any{}
	for key, value := range values {
		if imageKeys[key] {
			continue
		}
		out[key] = value
	}
	return out
}

// deleteFieldAttachments removes every attachment row bound to a record's field, returning the freed
// asset ids so the caller can clean them up after the change commits.
func (s *Service) deleteFieldAttachments(ctx context.Context, tx pgx.Tx, recordID uuid.UUID, fieldKey string) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT asset_id FROM form_record_attachments WHERE record_id=$1 AND field_key=$2`, recordID, fieldKey)
	if err != nil {
		return nil, err
	}
	stale := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		stale = append(stale, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(stale) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM form_record_attachments WHERE record_id=$1 AND field_key=$2`, recordID, fieldKey); err != nil {
			return nil, err
		}
	}
	return stale, nil
}

// AttachmentAsset authorizes a viewer to see one of a record's attachments and returns the backing
// asset id for delivery. Visibility matches record reads: a manager/reviewer/view_all holder or the
// record's own submitter. Anything else — including an attachment that does not belong to the
// addressed record — returns ErrNotFound so existence is never revealed.
func (s *Service) AttachmentAsset(ctx context.Context, formID, recordID, attachmentID, viewer uuid.UUID) (uuid.UUID, error) {
	meta, err := s.loadRecordScoped(ctx, s.db, formID, recordID)
	if err != nil {
		return uuid.Nil, err
	}
	canViewAll, err := s.allow(ctx, formID, viewer, CapViewAll)
	if err != nil {
		return uuid.Nil, err
	}
	isOwner := meta.owner != nil && *meta.owner == viewer
	if !canViewAll && !isOwner {
		return uuid.Nil, ErrNotFound
	}
	var assetID uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT asset_id FROM form_record_attachments WHERE id=$1 AND record_id=$2`, attachmentID, recordID).Scan(&assetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNotFound
	}
	if err != nil {
		return uuid.Nil, err
	}
	return assetID, nil
}

// bindAttachment links a private attachment asset to a record and field, refusing library assets
// and assets already used by playlists, layouts, Widgets, or other records. The core-side
// origin and usage check runs through Host.PluginAssets; the other-record check reads the
// plugin's own binding table.
func (s *Service) bindAttachment(ctx context.Context, tx pgx.Tx, recordID, assetID uuid.UUID, fieldKey string) (uuid.UUID, error) {
	if err := s.host.PluginAssets.ClaimPrivateInTx(ctx, tx, assetID); err != nil {
		if errors.Is(err, plugin.ErrInvalid) {
			return uuid.Nil, fmt.Errorf("%w: %v", ErrValidation, err)
		}
		return uuid.Nil, err
	}
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM form_record_attachments WHERE asset_id=$1 AND record_id<>$2)`, assetID, recordID).Scan(&used); err != nil {
		return uuid.Nil, err
	}
	if used {
		return uuid.Nil, fmt.Errorf("%w: the asset is already in use", ErrValidation)
	}
	attachmentID := uuid.New()
	err := tx.QueryRow(ctx, `INSERT INTO form_record_attachments(id,record_id,asset_id,field_key)
		VALUES($1,$2,$3,$4)
		ON CONFLICT(record_id,asset_id) DO UPDATE SET field_key=EXCLUDED.field_key
		RETURNING id`, attachmentID, recordID, assetID, fieldKey).Scan(&attachmentID)
	if err != nil {
		return uuid.Nil, err
	}
	return attachmentID, nil
}

// boundImageFields returns the set of image field keys that currently have a live attachment bound
// to the record. Required-image validation is satisfied only by membership in this set.
func (s *Service) boundImageFields(ctx context.Context, q rowQuerier, recordID uuid.UUID) (map[string]bool, error) {
	rows, err := q.Query(ctx, `SELECT field_key FROM form_record_attachments WHERE record_id=$1`, recordID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	set := map[string]bool{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		set[key] = true
	}
	return set, rows.Err()
}

// mergeImageValues copies the record's stored image-field values (attachment asset ids) into a
// freshly normalized value map, so a value update never drops an image the client did not send.
func mergeImageValues(schema FormSchema, normalized, existing map[string]any) {
	for _, field := range schema.Fields {
		if field.Control != ControlImage {
			continue
		}
		if value, ok := existing[field.Key]; ok && value != nil {
			normalized[field.Key] = value
		}
	}
}

func isImageField(schema FormSchema, key string) bool {
	for _, field := range schema.Fields {
		if field.Key == key {
			return field.Control == ControlImage
		}
	}
	return false
}

func isAttachmentInputError(err error) bool {
	message := err.Error()
	return strings.Contains(message, "must be images") || strings.Contains(message, "attachment is empty")
}

// ListRecords returns a filtered, paginated slice of a form's records. Callers without view_all
// see only their own submissions; callers who cannot view any records are refused.
func (s *Service) ListRecords(ctx context.Context, formID, viewer uuid.UUID, filter RecordFilter) (RecordPage, error) {
	if _, err := s.ensureForm(ctx, formID); err != nil {
		return RecordPage{}, err
	}
	canViewAll, err := s.allow(ctx, formID, viewer, CapViewAll)
	if err != nil {
		return RecordPage{}, err
	}
	if !canViewAll {
		canViewOwn, err := s.allow(ctx, formID, viewer, CapViewOwn)
		if err != nil {
			return RecordPage{}, err
		}
		if !canViewOwn {
			hasSubmit, err := s.allow(ctx, formID, viewer, CapSubmit)
			if err != nil {
				return RecordPage{}, err
			}
			canViewOwn = hasSubmit
		}
		if !canViewOwn {
			return RecordPage{}, ErrForbidden
		}
		filter.SubmittedBy = &viewer
	}
	// The Forms portal's "your submissions" list scopes to the caller even when they could see all
	// records, so pagination reflects only their own submissions rather than every record.
	if filter.Mine {
		filter.SubmittedBy = &viewer
	}
	if filter.Page < 1 {
		filter.Page = 1
	}
	if filter.PageSize < 1 {
		filter.PageSize = 25
	}
	if filter.PageSize > 100 {
		filter.PageSize = 100
	}
	where := []string{"data_source_id=$1", "deleted_at IS NULL"}
	args := []any{formID}
	add := func(clause string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	if len(filter.States) > 0 {
		add("state_key = ANY($%d)", filter.States)
	}
	if filter.SubmittedBy != nil {
		add("submitted_by=$%d", *filter.SubmittedBy)
	}
	if q := strings.TrimSpace(filter.Search); q != "" {
		args = append(args, q)
		where = append(where, fmt.Sprintf("(display_title ILIKE '%%'||$%d||'%%' OR submitter_name ILIKE '%%'||$%d||'%%')", len(args), len(args)))
	}
	clause := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM form_records WHERE `+clause, args...).Scan(&total); err != nil {
		return RecordPage{}, err
	}
	order := "created_at DESC,id DESC"
	switch filter.Sort {
	case "oldest":
		order = "created_at ASC,id ASC"
	case "priority":
		order = "priority DESC,created_at DESC"
	case "updated":
		order = "updated_at DESC,id DESC"
	}
	args = append(args, filter.PageSize, (filter.Page-1)*filter.PageSize)
	query := `SELECT id,data_source_id,revision_id,state_key,values,submitted_by,submitter_name,display_title,priority,display_at,expires_at,eligible,version,created_at,updated_at
		FROM form_records WHERE ` + clause + ` ORDER BY ` + order + fmt.Sprintf(" LIMIT $%d OFFSET $%d", len(args)-1, len(args))
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return RecordPage{}, err
	}
	defer rows.Close()
	items := []Record{}
	for rows.Next() {
		record, err := scanRecord(rows)
		if err != nil {
			return RecordPage{}, err
		}
		items = append(items, record)
	}
	if err := rows.Err(); err != nil {
		return RecordPage{}, err
	}
	return RecordPage{Items: items, Total: total, Page: filter.Page, PageSize: filter.PageSize}, nil
}

// GetRecord returns a record with its history, comments, and attachments, scoped to a form and
// visible only to a manager/reviewer or the record's own submitter. Records outside the form or
// invisible to the caller return ErrNotFound so existence is not revealed. The detail is decorated
// for the viewer with the immutable revision, canEdit/canComment/canDelete, and the workflow
// transitions the viewer may perform, so the UI never re-implements authorization.
func (s *Service) GetRecord(ctx context.Context, formID, recordID, viewer uuid.UUID) (RecordDetail, error) {
	createdBy, err := s.ensureForm(ctx, formID)
	if err != nil {
		return RecordDetail{}, err
	}
	meta, err := s.loadRecordScoped(ctx, s.db, formID, recordID)
	if err != nil {
		return RecordDetail{}, err
	}
	held, err := s.grantedCapabilities(ctx, s.db, formID, createdBy, viewer)
	if err != nil {
		return RecordDetail{}, err
	}
	isOwner := meta.owner != nil && *meta.owner == viewer
	if !effectiveHas(held, CapViewAll) && !isOwner {
		return RecordDetail{}, ErrNotFound
	}
	detail, err := s.recordDetail(ctx, recordID)
	if err != nil {
		return RecordDetail{}, err
	}
	if err := s.decorateDetail(ctx, formID, meta, held, isOwner, &detail); err != nil {
		return RecordDetail{}, err
	}
	return detail, nil
}

// effectiveHas reports whether any held capability satisfies the needed one via the lattice.
func effectiveHas(held []Capability, need Capability) bool {
	for _, h := range held {
		if capabilitySatisfies(h, need) {
			return true
		}
	}
	return false
}

// decorateDetail attaches the record's immutable revision and the server-calculated actions the
// viewer is permitted to take. Every authorization decision the UI needs is resolved here so React
// renders only what the server allows.
func (s *Service) decorateDetail(ctx context.Context, formID uuid.UUID, meta recordMeta, held []Capability, isOwner bool, detail *RecordDetail) error {
	if revision, err := s.loadRevisionByID(ctx, s.db, meta.revisionID); err == nil {
		detail.Revision = &revision
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}

	manage := effectiveHas(held, CapManage)
	detail.CanDelete = manage
	detail.CanComment = manage || effectiveHas(held, CapReview) || isOwner

	// canEdit mirrors authorizeEdit: a manager may always edit; otherwise the caller must own the
	// record, hold submit, and the record must be in a submitter-editable state.
	if manage {
		detail.CanEdit = true
	} else if isOwner && effectiveHas(held, CapSubmit) {
		editable, err := s.stateSubmitterEditable(ctx, s.db, formID, meta.state)
		if err != nil {
			return err
		}
		detail.CanEdit = editable
	}

	workflow, err := loadWorkflow(ctx, s.db, formID)
	if err != nil {
		return err
	}
	stateLabels := map[string]string{}
	for _, state := range workflow.States {
		stateLabels[state.Key] = state.Label
	}

	detail.AvailableTransitions = []AvailableTransition{}
	for _, t := range workflow.Transitions {
		if t.From != meta.state {
			continue
		}
		allowed := manage
		if !allowed {
			if t.RequiredCapability == CapSubmit {
				allowed = isOwner && effectiveHas(held, CapSubmit)
			} else {
				allowed = effectiveHas(held, t.RequiredCapability)
			}
		}
		if !allowed {
			continue
		}
		detail.AvailableTransitions = append(detail.AvailableTransitions, AvailableTransition{
			To:                 t.To,
			ToLabel:            stateLabels[t.To],
			Label:              t.Label,
			RequiredCapability: t.RequiredCapability,
			RequiresNote:       transitionRequiresNote(workflow, t),
		})
	}
	return nil
}

func (s *Service) recordDetail(ctx context.Context, recordID uuid.UUID) (RecordDetail, error) {
	record, err := s.getRecordRow(ctx, s.db, recordID)
	if err != nil {
		return RecordDetail{}, err
	}
	detail := RecordDetail{Record: record, Events: []RecordEvent{}, Comments: []RecordComment{}, Attachments: []Attachment{}}
	eventRows, err := s.db.Query(ctx, `SELECT id,event_type,from_state,to_state,actor_name,note,created_at
		FROM form_record_events WHERE record_id=$1 ORDER BY created_at DESC,id`, recordID)
	if err != nil {
		return RecordDetail{}, err
	}
	for eventRows.Next() {
		var event RecordEvent
		if err := eventRows.Scan(&event.ID, &event.EventType, &event.FromState, &event.ToState, &event.ActorName, &event.Note, &event.CreatedAt); err != nil {
			eventRows.Close()
			return RecordDetail{}, err
		}
		detail.Events = append(detail.Events, event)
	}
	eventRows.Close()
	commentRows, err := s.db.Query(ctx, `SELECT id,author_name,body,created_at FROM form_record_comments
		WHERE record_id=$1 AND deleted_at IS NULL ORDER BY created_at`, recordID)
	if err != nil {
		return RecordDetail{}, err
	}
	for commentRows.Next() {
		var comment RecordComment
		if err := commentRows.Scan(&comment.ID, &comment.AuthorName, &comment.Body, &comment.CreatedAt); err != nil {
			commentRows.Close()
			return RecordDetail{}, err
		}
		detail.Comments = append(detail.Comments, comment)
	}
	commentRows.Close()
	attachmentRows, err := s.db.Query(ctx, `SELECT id,asset_id,field_key FROM form_record_attachments WHERE record_id=$1 ORDER BY created_at`, recordID)
	if err != nil {
		return RecordDetail{}, err
	}
	defer attachmentRows.Close()
	for attachmentRows.Next() {
		var attachment Attachment
		if err := attachmentRows.Scan(&attachment.ID, &attachment.AssetID, &attachment.FieldKey); err != nil {
			return RecordDetail{}, err
		}
		detail.Attachments = append(detail.Attachments, attachment)
	}
	return detail, attachmentRows.Err()
}

func (s *Service) getRecordRow(ctx context.Context, q rowQuerier, recordID uuid.UUID) (Record, error) {
	row := q.QueryRow(ctx, `SELECT id,data_source_id,revision_id,state_key,values,submitted_by,submitter_name,display_title,priority,display_at,expires_at,eligible,version,created_at,updated_at
		FROM form_records WHERE id=$1 AND deleted_at IS NULL`, recordID)
	record, err := scanRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, ErrNotFound
	}
	return record, err
}

type scanner interface{ Scan(dest ...any) error }

func scanRecord(row scanner) (Record, error) {
	var record Record
	var valuesRaw []byte
	if err := row.Scan(&record.ID, &record.DataSourceID, &record.RevisionID, &record.State, &valuesRaw,
		&record.SubmittedBy, &record.SubmitterName, &record.DisplayTitle, &record.Priority,
		&record.DisplayAt, &record.ExpiresAt, &record.Eligible, &record.Version, &record.CreatedAt, &record.UpdatedAt); err != nil {
		return Record{}, err
	}
	record.Values = map[string]any{}
	if len(valuesRaw) > 0 {
		_ = json.Unmarshal(valuesRaw, &record.Values)
	}
	return record, nil
}

func initialStateKey(ctx context.Context, q rowQuerier, formID uuid.UUID) (string, error) {
	var state string
	err := q.QueryRow(ctx, `SELECT state_key FROM form_workflow_states WHERE data_source_id=$1 AND is_initial ORDER BY position LIMIT 1`, formID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return "draft", nil
	}
	return state, err
}

func insertEvent(ctx context.Context, tx pgx.Tx, recordID, formID uuid.UUID, eventType, from, to string, actor uuid.UUID, actorName, note string) error {
	_, err := tx.Exec(ctx, `INSERT INTO form_record_events(id,record_id,data_source_id,event_type,from_state,to_state,actor_id,actor_name,note)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, uuid.New(), recordID, formID, eventType, from, to, actor, actorName, note)
	return err
}
