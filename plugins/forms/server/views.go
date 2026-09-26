package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var viewKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,79}$`)

var filterOperators = map[string]bool{
	"equals": true, "not_equals": true, "contains": true,
	"empty": true, "not_empty": true,
	"greater_than": true, "less_than": true,
}

const maxViewsPerForm = 32

// ViewInput creates or updates a saved output view (upsert by Key).
type ViewInput struct {
	Key            string
	Name           string
	IncludedStates []string
	FieldFilters   []FieldFilter
	TimeFilter     TimeFilter
	Sort           []SortRule
	OutputFields   []string
	RecordLimit    int
	Position       int
}

// listViews reads the saved views for a form.
func (s *Service) listViews(ctx context.Context, q rowQuerier, id uuid.UUID) ([]View, error) {
	rows, err := q.Query(ctx, `SELECT id,key,name,included_states,field_filters,time_filter,sort,output_fields,record_limit,position
		FROM form_views WHERE data_source_id=$1 AND deleted_at IS NULL ORDER BY position,key`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	views := []View{}
	for rows.Next() {
		var view View
		var filters, timeFilter, sort []byte
		if err := rows.Scan(&view.ID, &view.Key, &view.Name, &view.IncludedStates, &filters, &timeFilter, &sort, &view.OutputFields, &view.RecordLimit, &view.Position); err != nil {
			return nil, err
		}
		view.FieldFilters = []FieldFilter{}
		view.Sort = []SortRule{}
		_ = json.Unmarshal(filters, &view.FieldFilters)
		_ = json.Unmarshal(timeFilter, &view.TimeFilter)
		_ = json.Unmarshal(sort, &view.Sort)
		views = append(views, view)
	}
	return views, rows.Err()
}

// availableFieldKeys returns the set of output field keys the current published revision (or the
// draft, when nothing is published yet) exposes, used to validate view field references.
func (s *Service) availableFieldKeys(ctx context.Context, q rowQuerier, id uuid.UUID) (map[string]bool, error) {
	schema, err := s.loadPublishedRevision(ctx, q, id)
	var fieldSpecs []string
	if err == nil {
		for _, spec := range outputFieldSpecs(schema.Schema) {
			fieldSpecs = append(fieldSpecs, spec.Key)
		}
	} else if errors.Is(err, ErrNotFound) {
		draft, draftErr := s.loadDraftSchema(ctx, id)
		if draftErr != nil {
			return nil, draftErr
		}
		for _, spec := range outputFieldSpecs(draft) {
			fieldSpecs = append(fieldSpecs, spec.Key)
		}
	} else {
		return nil, err
	}
	keys := map[string]bool{}
	for _, key := range fieldSpecs {
		keys[key] = true
	}
	return keys, nil
}

func (s *Service) validateView(ctx context.Context, q rowQuerier, id uuid.UUID, in ViewInput) error {
	if !viewKeyPattern.MatchString(in.Key) {
		return fmt.Errorf("%w: view key %q is invalid", ErrValidation, in.Key)
	}
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 180 {
		return fmt.Errorf("%w: view name must be between 1 and 180 characters", ErrValidation)
	}
	if in.RecordLimit < 1 || in.RecordLimit > 2000 {
		return fmt.Errorf("%w: view record limit must be between 1 and 2000", ErrValidation)
	}
	workflow, err := loadWorkflow(ctx, q, id)
	if err != nil {
		return err
	}
	states := map[string]bool{}
	for _, state := range workflow.States {
		states[state.Key] = true
	}
	for _, state := range in.IncludedStates {
		if !states[state] {
			return fmt.Errorf("%w: view references unknown state %q", ErrValidation, state)
		}
	}
	fields, err := s.availableFieldKeys(ctx, q, id)
	if err != nil {
		return err
	}
	for _, key := range in.OutputFields {
		if !fields[key] {
			return fmt.Errorf("%w: view references unknown output field %q", ErrValidation, key)
		}
	}
	for _, filter := range in.FieldFilters {
		if !fields[filter.Field] {
			return fmt.Errorf("%w: filter references unknown field %q", ErrValidation, filter.Field)
		}
		if !filterOperators[filter.Operator] {
			return fmt.Errorf("%w: filter uses unsupported operator %q", ErrValidation, filter.Operator)
		}
	}
	for _, rule := range in.Sort {
		if !fields[rule.Field] {
			return fmt.Errorf("%w: sort references unknown field %q", ErrValidation, rule.Field)
		}
		if rule.Direction != "asc" && rule.Direction != "desc" {
			return fmt.Errorf("%w: sort direction must be asc or desc", ErrValidation)
		}
	}
	if in.TimeFilter.Enabled {
		if in.TimeFilter.StartField != "" && !fields[in.TimeFilter.StartField] {
			return fmt.Errorf("%w: time filter references unknown start field %q", ErrValidation, in.TimeFilter.StartField)
		}
		if in.TimeFilter.EndField != "" && !fields[in.TimeFilter.EndField] {
			return fmt.Errorf("%w: time filter references unknown end field %q", ErrValidation, in.TimeFilter.EndField)
		}
	}
	return nil
}

// viewFromInput builds a transient View from a ViewInput for previewing (no id/persistence).
func viewFromInput(in ViewInput) View {
	return View{
		Key: in.Key, Name: strings.TrimSpace(in.Name), IncludedStates: in.IncludedStates,
		FieldFilters: in.FieldFilters, TimeFilter: in.TimeFilter, Sort: in.Sort,
		OutputFields: in.OutputFields, RecordLimit: in.RecordLimit, Position: in.Position,
	}
}

// PreviewView projects an unsaved, proposed view and returns the resulting typed dataset without
// persisting anything or touching the cached projection. Only output-eligible records in the view's
// included states reach the result (the same safety invariant as the real projection), so a preview
// never exposes unapproved records. Manager-authorized.
func (s *Service) PreviewView(ctx context.Context, id uuid.UUID, in ViewInput) (plugin.TypedDataset, error) {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return plugin.TypedDataset{}, err
	}
	if in.IncludedStates == nil {
		in.IncludedStates = []string{}
	}
	if in.OutputFields == nil {
		in.OutputFields = []string{}
	}
	if in.FieldFilters == nil {
		in.FieldFilters = []FieldFilter{}
	}
	if in.Sort == nil {
		in.Sort = []SortRule{}
	}
	if in.RecordLimit == 0 {
		in.RecordLimit = 100
	}
	if err := s.validateView(ctx, s.db, id, in); err != nil {
		return plugin.TypedDataset{}, err
	}
	fieldTypes, fieldLabels, err := s.outputFieldMaps(ctx, s.db, id)
	if err != nil {
		return plugin.TypedDataset{}, err
	}
	return s.projectView(ctx, s.db, id, viewFromInput(in), fieldTypes, fieldLabels, time.Now().UTC(), func(*time.Time) {})
}

// UpsertView creates or replaces a saved view (identified by its key) and rebuilds the
// projection so the named dataset reflects the change.
func (s *Service) UpsertView(ctx context.Context, id, actor uuid.UUID, in ViewInput) (View, error) {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return View{}, err
	}
	if in.IncludedStates == nil {
		in.IncludedStates = []string{}
	}
	if in.OutputFields == nil {
		in.OutputFields = []string{}
	}
	if in.FieldFilters == nil {
		in.FieldFilters = []FieldFilter{}
	}
	if in.Sort == nil {
		in.Sort = []SortRule{}
	}
	if in.RecordLimit == 0 {
		in.RecordLimit = 100
	}
	if err := s.validateView(ctx, s.db, id, in); err != nil {
		return View{}, err
	}
	filters, _ := json.Marshal(in.FieldFilters)
	timeFilter, _ := json.Marshal(in.TimeFilter)
	sort, _ := json.Marshal(in.Sort)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return View{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM form_views WHERE data_source_id=$1 AND deleted_at IS NULL AND key<>$2`, id, in.Key).Scan(&count); err != nil {
		return View{}, err
	}
	if count >= maxViewsPerForm {
		return View{}, fmt.Errorf("%w: a form allows at most %d views", ErrValidation, maxViewsPerForm)
	}
	viewID := uuid.New()
	err = tx.QueryRow(ctx, `INSERT INTO form_views(id,data_source_id,key,name,included_states,field_filters,time_filter,sort,output_fields,record_limit,position)
		VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
		ON CONFLICT(data_source_id,key) WHERE deleted_at IS NULL
		DO UPDATE SET name=EXCLUDED.name,included_states=EXCLUDED.included_states,field_filters=EXCLUDED.field_filters,
			time_filter=EXCLUDED.time_filter,sort=EXCLUDED.sort,output_fields=EXCLUDED.output_fields,
			record_limit=EXCLUDED.record_limit,position=EXCLUDED.position,updated_at=now()
		RETURNING id`,
		viewID, id, in.Key, strings.TrimSpace(in.Name), in.IncludedStates, string(filters), string(timeFilter), string(sort), in.OutputFields, in.RecordLimit, in.Position).Scan(&viewID)
	if err != nil {
		return View{}, err
	}
	if err := s.syncConfiguration(ctx, tx, id, nil); err != nil {
		return View{}, err
	}
	if err := s.recordAudit(ctx, tx, actor, "form.view_saved", id.String(), map[string]any{"view": in.Key}); err != nil {
		return View{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return View{}, err
	}
	if err := s.RebuildProjection(ctx, id); err != nil {
		return View{}, err
	}
	view := View{ID: viewID, Key: in.Key, Name: strings.TrimSpace(in.Name), IncludedStates: in.IncludedStates,
		FieldFilters: in.FieldFilters, TimeFilter: in.TimeFilter, Sort: in.Sort, OutputFields: in.OutputFields,
		RecordLimit: in.RecordLimit, Position: in.Position}
	return view, nil
}

// DeleteView soft-deletes a saved view and rebuilds the projection. Deletion is blocked when the
// view's dataset is still referenced by a Widget, so removing it cannot silently break signage.
func (s *Service) DeleteView(ctx context.Context, id, viewID, actor uuid.UUID) error {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return err
	}
	// Resolve the view key and refuse deletion while its dataset is in use downstream.
	var viewKey string
	err := s.db.QueryRow(ctx, `SELECT key FROM form_views WHERE id=$1 AND data_source_id=$2 AND deleted_at IS NULL`, viewID, id).Scan(&viewKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	usage, err := s.datasetUsage(ctx, id, viewKey)
	if err != nil {
		return err
	}
	if usage.Widgets > 0 {
		return fmt.Errorf("%w: this view's dataset is used by %s", ErrInUse, strings.Join(usage.Names, ", "))
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `UPDATE form_views SET deleted_at=now(),updated_at=now() WHERE id=$1 AND data_source_id=$2 AND deleted_at IS NULL`, viewID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := s.syncConfiguration(ctx, tx, id, nil); err != nil {
		return err
	}
	if err := s.recordAudit(ctx, tx, actor, "form.view_deleted", id.String(), nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.RebuildProjection(ctx, id)
}
