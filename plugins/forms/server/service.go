package server

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// Service owns Form Data Source domain logic. It queries its own form_*
// tables directly and reaches every core table through generic Host
// services: DataSources for the parent data_sources row and cached
// projection, Users for directory facts, PluginAssets for record
// attachments, Audit for the audit log, Installation for the install gate,
// and Manifests for nothing (projection invalidation travels the normal
// Data Source path through DataSources).
type Service struct {
	host plugin.Host
	db   plugin.DB
}

// NewService builds an uninitialized Service. The host calls Init before
// any other contribution is used.
func NewService() *Service { return &Service{} }

// Init receives the Host services and keeps them; it runs once per process.
func (s *Service) Init(_ context.Context, host plugin.Host) error {
	s.host = host
	s.db = host.DB
	return nil
}

// providerName is the reserved Data Source provider id for forms.
const providerName = "form"

// ensureForm confirms the id references a live Form Data Source and returns its creator.
func (s *Service) ensureForm(ctx context.Context, id uuid.UUID) (*uuid.UUID, error) {
	record, err := s.host.DataSources.Get(ctx, id)
	if errors.Is(err, plugin.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if record.CreatedBy == uuid.Nil {
		return nil, nil
	}
	createdBy := record.CreatedBy
	return &createdBy, nil
}

type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func (s *Service) userGlobalRole(ctx context.Context, userID uuid.UUID) (string, error) {
	user, err := s.host.Users.Get(ctx, userID)
	if errors.Is(err, plugin.ErrNotFound) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return user.Role, nil
}

func (s *Service) userName(ctx context.Context, userID uuid.UUID) string {
	user, err := s.host.Users.Get(ctx, userID)
	if err != nil {
		return ""
	}
	return user.Name
}

// recordAudit writes an audit event inside the caller's transaction.
func (s *Service) recordAudit(ctx context.Context, tx pgx.Tx, userID uuid.UUID, action, resourceID string, metadata map[string]any) error {
	return s.host.Audit.RecordInTx(ctx, tx, plugin.AuditEvent{
		UserID: userID, Action: action, ResourceType: "data_source",
		ResourceID: resourceID, Metadata: metadata,
	})
}

// auditBestEffort records an audit event outside any caller transaction and
// ignores failures, preserving the historical fire-and-forget audit writes
// that follow an already-committed change.
func (s *Service) auditBestEffort(ctx context.Context, userID uuid.UUID, action, resourceID string, metadata map[string]any) {
	_ = s.auditChecked(ctx, userID, action, resourceID, metadata)
}

// auditChecked records an audit event in its own transaction and reports
// failures, for writes the caller treats as part of the operation.
func (s *Service) auditChecked(ctx context.Context, userID uuid.UUID, action, resourceID string, metadata map[string]any) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := s.recordAudit(ctx, tx, userID, action, resourceID, metadata); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) userNameInTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID) string {
	user, err := s.host.Users.GetInTx(ctx, tx, userID)
	if err != nil {
		return ""
	}
	return user.Name
}

// Authorize reports whether userID may perform an action needing capability on form id. The
// form creator and any global Owner always have full manage access; everyone else needs an
// explicit grant that satisfies the requested capability.
func (s *Service) Authorize(ctx context.Context, id, userID uuid.UUID, need Capability) (bool, error) {
	createdBy, err := s.ensureForm(ctx, id)
	if err != nil {
		return false, err
	}
	if createdBy != nil && *createdBy == userID {
		return true, nil
	}
	role, err := s.userGlobalRole(ctx, userID)
	if err != nil {
		return false, err
	}
	if role == "owner" {
		return true, nil
	}
	rows, err := s.db.Query(ctx, `SELECT capability FROM form_grants WHERE data_source_id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var held string
		if err := rows.Scan(&held); err != nil {
			return false, err
		}
		if capabilitySatisfies(Capability(held), need) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// CanAccessForm reports whether a user may see a form at all: the creator, a global Owner, or the
// holder of any grant on it. Used to gate the form-detail read for submitters who lack view_own.
func (s *Service) CanAccessForm(ctx context.Context, id, userID uuid.UUID) (bool, error) {
	createdBy, err := s.ensureForm(ctx, id)
	if err != nil {
		return false, err
	}
	if createdBy != nil && *createdBy == userID {
		return true, nil
	}
	if role, err := s.userGlobalRole(ctx, userID); err == nil && role == "owner" {
		return true, nil
	} else if err != nil {
		return false, err
	}
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM form_grants WHERE data_source_id=$1 AND user_id=$2)`, id, userID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

// grantedCapabilities returns every capability userID effectively holds on form id, expanding
// creator/owner into the full set. Used to decorate the Form detail for the UI.
func (s *Service) grantedCapabilities(ctx context.Context, q rowQuerier, id uuid.UUID, createdBy *uuid.UUID, userID uuid.UUID) ([]Capability, error) {
	if createdBy != nil && *createdBy == userID {
		return []Capability{CapManage}, nil
	}
	if role, err := s.userGlobalRole(ctx, userID); err == nil && role == "owner" {
		return []Capability{CapManage}, nil
	}
	rows, err := q.Query(ctx, `SELECT capability FROM form_grants WHERE data_source_id=$1 AND user_id=$2 ORDER BY capability`, id, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Capability{}
	for rows.Next() {
		var held string
		if err := rows.Scan(&held); err != nil {
			return nil, err
		}
		result = append(result, Capability(held))
	}
	return result, rows.Err()
}

// syncConfiguration rewrites data_sources.configuration for a form so media's field discovery
// (availableDataSourceFields) and the provider gallery stay in agreement with the published
// revision and saved views. It must run inside the same transaction as any schema/view change.
// When draft is non-nil it replaces the stored editable draft; otherwise the existing draft is
// preserved.
func (s *Service) syncConfiguration(ctx context.Context, tx pgx.Tx, id uuid.UUID, draft *FormSchema) error {
	existingRaw, err := s.host.DataSources.ConfigurationInTx(ctx, tx, id)
	if errors.Is(err, plugin.ErrNotFound) {
		existingRaw = nil
	} else if err != nil {
		return err
	}
	var currentRevisionID *uuid.UUID
	var schemaRaw []byte
	err = tx.QueryRow(ctx, `SELECT r.id, r.schema FROM form_revisions r
		WHERE r.data_source_id=$1 ORDER BY r.revision_number DESC LIMIT 1`, id).Scan(&currentRevisionID, &schemaRaw)
	config := FormSourceConfig{Fields: []FormFieldSpec{}, Views: []FormViewSpec{}}
	// Carry forward the existing editable draft unless the caller supplies a new one.
	if len(existingRaw) > 0 {
		var previous FormSourceConfig
		if json.Unmarshal(existingRaw, &previous) == nil {
			config.DraftSchema = previous.DraftSchema
			config.DisplayFieldMappings = previous.DisplayFieldMappings
		}
	}
	if draft != nil {
		encodedDraft, marshalErr := json.Marshal(draft)
		if marshalErr != nil {
			return marshalErr
		}
		config.DraftSchema = encodedDraft
	}
	if err == nil {
		config.CurrentRevisionID = currentRevisionID.String()
		var schema FormSchema
		if len(schemaRaw) > 0 {
			_ = json.Unmarshal(schemaRaw, &schema)
		}
		config.Fields = outputFieldSpecs(schema)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	viewRows, err := tx.Query(ctx, `SELECT key,name,output_fields FROM form_views WHERE data_source_id=$1 AND deleted_at IS NULL ORDER BY position,key`, id)
	if err != nil {
		return err
	}
	defer viewRows.Close()
	for viewRows.Next() {
		var spec FormViewSpec
		if err := viewRows.Scan(&spec.Key, &spec.Name, &spec.Fields); err != nil {
			return err
		}
		config.Views = append(config.Views, spec)
	}
	if err := viewRows.Err(); err != nil {
		return err
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return err
	}
	return s.host.DataSources.SetConfigurationInTx(ctx, tx, id, encoded)
}

// outputFieldSpecs derives the selectable Widget fields for a published schema: one per
// output-producing form field, plus the synthetic record fields every form exposes.
func outputFieldSpecs(schema FormSchema) []FormFieldSpec {
	fields := []FormFieldSpec{}
	for _, field := range schema.Fields {
		typ := outputTypeFor(field.Control)
		if typ == "" {
			continue
		}
		fields = append(fields, FormFieldSpec{Key: field.Key, Label: field.Label, Type: typ})
	}
	fields = append(fields,
		FormFieldSpec{Key: "state", Label: "Workflow state", Type: "text"},
		FormFieldSpec{Key: "displayTitle", Label: "Display title", Type: "text"},
		FormFieldSpec{Key: "priority", Label: "Priority", Type: "integer"},
		FormFieldSpec{Key: "submittedAt", Label: "Submitted time", Type: "datetime"},
		FormFieldSpec{Key: "displayAt", Label: "Display from", Type: "datetime"},
		FormFieldSpec{Key: "expiresAt", Label: "Expires at", Type: "datetime"},
	)
	return fields
}

// reservedFieldKeys are the synthetic keys a form always exposes; a user field may not shadow
// them.
var reservedFieldKeys = map[string]bool{
	"state": true, "displayTitle": true, "priority": true, "submittedAt": true,
	"displayAt": true, "expiresAt": true, "id": true,
}
