package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// FormInput creates a new Form Data Source.
type FormInput struct {
	Name        string
	Description string
	DraftSchema FormSchema
}

// DraftInput updates a form's editable draft schema.
type DraftInput struct {
	Schema FormSchema
}

// emptyPayload is the initial cached typed-dataset payload for a form with no records yet.
const emptyPayload = `{"datasets":[]}`

// CreateForm provisions a Form Data Source: the parent data_sources row, the default workflow,
// an initial published revision, a default "Approved" saved view, and the internally managed
// refresh state. It runs in one transaction so a form is never half-created.
func (s *Service) CreateForm(ctx context.Context, user uuid.UUID, in FormInput) (Form, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 180 {
		return Form{}, fmt.Errorf("%w: name must be between 1 and 180 characters", ErrValidation)
	}
	if len(in.Description) > 2000 {
		return Form{}, fmt.Errorf("%w: description must be at most 2000 characters", ErrValidation)
	}
	if in.DraftSchema.Fields == nil {
		in.DraftSchema.Fields = []FormField{}
	}
	if err := validateSchema(in.DraftSchema); err != nil {
		return Form{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Form{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := plugins.LockInstallation(ctx, tx, plugins.FormsID); err != nil {
		return Form{}, err
	}

	var organizationID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		return Form{}, err
	}
	id := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by)
		VALUES($1,$2,$3,$4,'form',1,'{}'::jsonb,$5)`, id, organizationID, name, strings.TrimSpace(in.Description), user); err != nil {
		return Form{}, err
	}
	if err := seedWorkflow(ctx, tx, id); err != nil {
		return Form{}, err
	}
	if _, err := s.publishRevisionTx(ctx, tx, id, user, in.DraftSchema); err != nil {
		return Form{}, err
	}
	// Seed a default "Approved" view exposing every published output field.
	outputKeys := make([]string, 0)
	for _, spec := range outputFieldSpecs(in.DraftSchema) {
		outputKeys = append(outputKeys, spec.Key)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO form_views(id,data_source_id,key,name,included_states,field_filters,time_filter,sort,output_fields,record_limit,position)
		VALUES($1,$2,'approved','Approved',$3,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb,$4,100,0)`,
		uuid.New(), id, []string{"approved"}, outputKeys); err != nil {
		return Form{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_attempt_at,last_success_at,http_result_category,parse_status,available_item_count,using_cached_data,cache_updated_at,cache_expires_at,cached_payload)
		VALUES($1,now()+interval '100 years',now(),now(),'manual','success',0,FALSE,now(),now()+interval '100 years',$2::jsonb)`, id, emptyPayload); err != nil {
		return Form{}, err
	}
	if err := s.syncConfiguration(ctx, tx, id, &in.DraftSchema); err != nil {
		return Form{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
		VALUES($1,$2,'form.created','data_source',$3,jsonb_build_object('name',$4::text))`, uuid.New(), user, id.String(), name); err != nil {
		return Form{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Form{}, err
	}
	if err := s.RebuildProjection(ctx, id); err != nil {
		return Form{}, err
	}
	return s.GetForm(ctx, id, user)
}

// MetadataInput updates the parent Data Source name and description of a form. Description is a
// pointer so an omitted field (nil) preserves the stored value, honoring the PATCH contract where
// only name is required.
type MetadataInput struct {
	Name        string
	Description *string
}

// UpdateMetadata edits only the parent data_sources name and (optionally) description for a form.
// Provider and configuration are never touched here. The caller must hold the manage capability.
func (s *Service) UpdateMetadata(ctx context.Context, id, user uuid.UUID, in MetadataInput) (Form, error) {
	if _, err := s.ensureForm(ctx, s.db, id); err != nil {
		return Form{}, err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 180 {
		return Form{}, fmt.Errorf("%w: name must be between 1 and 180 characters", ErrValidation)
	}
	var description *string
	if in.Description != nil {
		trimmed := strings.TrimSpace(*in.Description)
		if utf8.RuneCountInString(trimmed) > 2000 {
			return Form{}, fmt.Errorf("%w: description must be at most 2000 characters", ErrValidation)
		}
		description = &trimmed
	}
	// The metadata update and its audit event commit together: if auditing fails, the name and
	// description change is rolled back rather than silently unaudited. An omitted description
	// (nil) preserves the existing value via COALESCE.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Form{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `UPDATE data_sources SET name=$2,description=COALESCE($3,description),updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, name, description)
	if err != nil {
		return Form{}, err
	}
	if tag.RowsAffected() == 0 {
		return Form{}, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
		VALUES($1,$2,'form.metadata_updated','data_source',$3,jsonb_build_object('name',$4::text))`, uuid.New(), user, id.String(), name); err != nil {
		return Form{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Form{}, err
	}
	return s.GetForm(ctx, id, user)
}

// UpdateDraft replaces the editable draft schema without publishing it, so existing submissions
// are untouched until PublishRevision runs.
func (s *Service) UpdateDraft(ctx context.Context, id, user uuid.UUID, in DraftInput) (Form, error) {
	if _, err := s.ensureForm(ctx, s.db, id); err != nil {
		return Form{}, err
	}
	if in.Schema.Fields == nil {
		in.Schema.Fields = []FormField{}
	}
	if err := validateSchema(in.Schema); err != nil {
		return Form{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Form{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := s.syncConfiguration(ctx, tx, id, &in.Schema); err != nil {
		return Form{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)
		VALUES($1,$2,'form.draft_updated','data_source',$3)`, uuid.New(), user, id.String()); err != nil {
		return Form{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Form{}, err
	}
	return s.GetForm(ctx, id, user)
}

// PublishRevision snapshots the current draft into a new immutable revision and points the form
// at it. Older submissions keep referencing the revision they were created against.
func (s *Service) PublishRevision(ctx context.Context, id, user uuid.UUID) (Revision, error) {
	if _, err := s.ensureForm(ctx, s.db, id); err != nil {
		return Revision{}, err
	}
	draft, err := s.loadDraftSchema(ctx, s.db, id)
	if err != nil {
		return Revision{}, err
	}
	if err := validateSchema(draft); err != nil {
		return Revision{}, err
	}
	// Guard against destructive schema changes: an already-published output field cannot be
	// removed, and its key cannot be reused for a different output type. Also reject a no-op
	// publish when the draft is identical to the current published revision.
	if published, pubErr := s.loadPublishedRevision(ctx, s.db, id); pubErr == nil {
		if err := checkPublishCompatibility(published.Schema, draft); err != nil {
			return Revision{}, err
		}
		if schemasEquivalent(published.Schema, draft) {
			return Revision{}, fmt.Errorf("%w: the draft matches the published revision; there is nothing to publish", ErrValidation)
		}
	} else if !errors.Is(pubErr, ErrNotFound) {
		return Revision{}, pubErr
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Revision{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	revision, err := s.publishRevisionTx(ctx, tx, id, user, draft)
	if err != nil {
		return Revision{}, err
	}
	if err := s.syncConfiguration(ctx, tx, id, &draft); err != nil {
		return Revision{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata)
		VALUES($1,$2,'form.published','data_source',$3,jsonb_build_object('revision',$4::int))`, uuid.New(), user, id.String(), revision.RevisionNumber); err != nil {
		return Revision{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Revision{}, err
	}
	if err := s.RebuildProjection(ctx, id); err != nil {
		return Revision{}, err
	}
	return revision, nil
}

// checkPublishCompatibility rejects a draft that would break Widgets or saved views bound to an
// already-published output field. Every output-producing field in the published schema must still
// exist in the draft with the same output type; a key may not be reused for a different output
// type. Label, description, required status, default, options, bounds, order, and presentation-only
// fields (section, help_text) may change freely.
func checkPublishCompatibility(published, draft FormSchema) error {
	draftByKey := map[string]FormField{}
	for _, field := range draft.Fields {
		draftByKey[field.Key] = field
	}
	for _, field := range published.Fields {
		publishedType := outputTypeFor(field.Control)
		if publishedType == "" {
			continue // presentation-only fields may be added, reordered, or removed
		}
		draftField, ok := draftByKey[field.Key]
		if !ok {
			return fmt.Errorf("%w: published field %q cannot be removed; deprecate it instead", ErrValidation, field.Key)
		}
		if outputTypeFor(draftField.Control) != publishedType {
			return fmt.Errorf("%w: published field %q cannot change its output type", ErrValidation, field.Key)
		}
	}
	return nil
}

// schemasEquivalent reports whether two form schemas are identical after normalizing nil slices,
// so a publish that would create a byte-for-byte duplicate revision can be rejected.
func schemasEquivalent(a, b FormSchema) bool {
	return canonicalSchemaJSON(a) == canonicalSchemaJSON(b)
}

func canonicalSchemaJSON(schema FormSchema) string {
	normalized := schema
	fields := make([]FormField, len(schema.Fields))
	for i, field := range schema.Fields {
		if field.Options == nil {
			field.Options = []SelectOption{}
		}
		fields[i] = field
	}
	normalized.Fields = fields
	encoded, _ := json.Marshal(normalized)
	return string(encoded)
}

// publishRevisionTx inserts the next revision inside an open transaction.
func (s *Service) publishRevisionTx(ctx context.Context, tx pgx.Tx, id, user uuid.UUID, schema FormSchema) (Revision, error) {
	var next int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(revision_number),0)+1 FROM form_revisions WHERE data_source_id=$1`, id).Scan(&next); err != nil {
		return Revision{}, err
	}
	if schema.Fields == nil {
		schema.Fields = []FormField{}
	}
	encoded, err := json.Marshal(schema)
	if err != nil {
		return Revision{}, err
	}
	revisionID := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO form_revisions(id,data_source_id,revision_number,title,description,schema,published_by)
		VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, revisionID, id, next, schema.Title, schema.Description, string(encoded), user); err != nil {
		return Revision{}, err
	}
	return Revision{ID: revisionID, DataSourceID: id, RevisionNumber: next, Title: schema.Title, Description: schema.Description, Schema: schema}, nil
}

// loadDraftSchema reads the editable draft schema from the form configuration.
func (s *Service) loadDraftSchema(ctx context.Context, q rowQuerier, id uuid.UUID) (FormSchema, error) {
	var raw []byte
	if err := q.QueryRow(ctx, `SELECT configuration FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return FormSchema{}, ErrNotFound
		}
		return FormSchema{}, err
	}
	var config media.FormSourceConfig
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &config)
	}
	schema := FormSchema{Fields: []FormField{}}
	if len(config.DraftSchema) > 0 {
		_ = json.Unmarshal(config.DraftSchema, &schema)
	}
	if schema.Fields == nil {
		schema.Fields = []FormField{}
	}
	return schema, nil
}

// loadPublishedRevision reads the latest published revision, or ErrNotFound if none.
func (s *Service) loadPublishedRevision(ctx context.Context, q rowQuerier, id uuid.UUID) (Revision, error) {
	var revision Revision
	var schemaRaw []byte
	err := q.QueryRow(ctx, `SELECT id,data_source_id,revision_number,title,description,schema,published_at
		FROM form_revisions WHERE data_source_id=$1 ORDER BY revision_number DESC LIMIT 1`, id).
		Scan(&revision.ID, &revision.DataSourceID, &revision.RevisionNumber, &revision.Title, &revision.Description, &schemaRaw, &revision.PublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Revision{}, ErrNotFound
	}
	if err != nil {
		return Revision{}, err
	}
	revision.Schema = FormSchema{Fields: []FormField{}}
	if len(schemaRaw) > 0 {
		_ = json.Unmarshal(schemaRaw, &revision.Schema)
	}
	return revision, nil
}

// loadRevisionByID loads a full revision (number, title, description, schema) by id. Used to attach
// the immutable revision a record was created against to its detail response.
func (s *Service) loadRevisionByID(ctx context.Context, q rowQuerier, revisionID uuid.UUID) (Revision, error) {
	var revision Revision
	var schemaRaw []byte
	err := q.QueryRow(ctx, `SELECT id,data_source_id,revision_number,title,description,schema,published_at
		FROM form_revisions WHERE id=$1`, revisionID).
		Scan(&revision.ID, &revision.DataSourceID, &revision.RevisionNumber, &revision.Title, &revision.Description, &schemaRaw, &revision.PublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Revision{}, ErrNotFound
	}
	if err != nil {
		return Revision{}, err
	}
	revision.Schema = FormSchema{Fields: []FormField{}}
	if len(schemaRaw) > 0 {
		_ = json.Unmarshal(schemaRaw, &revision.Schema)
	}
	return revision, nil
}

// revisionSchema loads the schema for a specific revision id (used to validate record values).
func (s *Service) revisionSchema(ctx context.Context, q rowQuerier, revisionID uuid.UUID) (FormSchema, error) {
	var schemaRaw []byte
	err := q.QueryRow(ctx, `SELECT schema FROM form_revisions WHERE id=$1`, revisionID).Scan(&schemaRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return FormSchema{}, ErrNotFound
	}
	if err != nil {
		return FormSchema{}, err
	}
	schema := FormSchema{Fields: []FormField{}}
	if len(schemaRaw) > 0 {
		_ = json.Unmarshal(schemaRaw, &schema)
	}
	return schema, nil
}

// GetForm returns the full form detail decorated with the caller's effective capabilities.
func (s *Service) GetForm(ctx context.Context, id, viewer uuid.UUID) (Form, error) {
	createdBy, err := s.ensureForm(ctx, s.db, id)
	if err != nil {
		return Form{}, err
	}
	form := Form{ID: id, CreatedBy: createdBy}
	if err := s.db.QueryRow(ctx, `SELECT name,description,created_at,updated_at FROM data_sources WHERE id=$1`, id).
		Scan(&form.Name, &form.Description, &form.CreatedAt, &form.UpdatedAt); err != nil {
		return Form{}, err
	}
	if form.DraftSchema, err = s.loadDraftSchema(ctx, s.db, id); err != nil {
		return Form{}, err
	}
	if published, err := s.loadPublishedRevision(ctx, s.db, id); err == nil {
		form.Published = &published
	} else if !errors.Is(err, ErrNotFound) {
		return Form{}, err
	}
	if form.Workflow, err = loadWorkflow(ctx, s.db, id); err != nil {
		return Form{}, err
	}
	if err := s.decorateWorkflowUsage(ctx, s.db, id, &form.Workflow); err != nil {
		return Form{}, err
	}
	if form.Views, err = s.listViews(ctx, s.db, id); err != nil {
		return Form{}, err
	}
	if form.Capabilities, err = s.grantedCapabilities(ctx, s.db, id, createdBy, viewer); err != nil {
		return Form{}, err
	}
	// Non-managers must never see unpublished draft edits. Narrow the visible draft to the
	// published schema so the UI can render one schema safely regardless of role.
	if !containsCapability(form.Capabilities, CapManage) {
		if form.Published != nil {
			form.DraftSchema = form.Published.Schema
		} else {
			form.DraftSchema = FormSchema{Fields: []FormField{}}
		}
	}
	return form, nil
}

func containsCapability(capabilities []Capability, want Capability) bool {
	for _, capability := range capabilities {
		if capability == want {
			return true
		}
	}
	return false
}
