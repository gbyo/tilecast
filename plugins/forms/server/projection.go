package server

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// RebuildProjection recomputes the cached typed-dataset payload for a form (one dataset per
// saved view) and invalidates affected manifests. Only records that are both in a view's
// included states and output-eligible reach the payload, so unapproved records and their
// attachments never enter a manifest. Time-window filtering is applied at projection time and the
// refresh state is rescheduled to the next boundary so signage updates without a Player round trip
// and stays correct offline.
func (s *Service) RebuildProjection(ctx context.Context, formID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	views, err := s.listViews(ctx, tx, formID)
	if err != nil {
		return err
	}
	fieldTypes, fieldLabels, err := s.outputFieldMaps(ctx, tx, formID)
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	var nextBoundary *time.Time
	noteBoundary := func(candidate *time.Time) {
		if candidate == nil || !candidate.After(now) {
			return
		}
		if nextBoundary == nil || candidate.Before(*nextBoundary) {
			value := *candidate
			nextBoundary = &value
		}
	}

	payload := plugin.TypedDatasetPayload{Datasets: []plugin.TypedDataset{}}
	for _, view := range views {
		dataset, err := s.projectView(ctx, tx, formID, view, fieldTypes, fieldLabels, now, noteBoundary)
		if err != nil {
			return err
		}
		payload.Datasets = append(payload.Datasets, dataset)
	}

	// Schedule a wake at the next expiry among eligible records so the worker can auto-expire them
	// even when no view carries a relative time filter.
	var nextExpiry *time.Time
	if err := tx.QueryRow(ctx, `SELECT min(expires_at) FROM form_records
		WHERE data_source_id=$1 AND deleted_at IS NULL AND eligible AND expires_at IS NOT NULL AND expires_at>now()`, formID).Scan(&nextExpiry); err != nil {
		return err
	}
	noteBoundary(nextExpiry)

	if err := s.host.DataSources.WriteProjectionInTx(ctx, tx, formID, plugin.ProjectionWrite{
		Payload:      payload,
		DatasetCount: len(payload.Datasets),
		NextRefresh:  nextBoundary,
	}); err != nil {
		return err
	}
	// Invalidate through the normal Data Source revision path inside the
	// same transaction; the notification runs after commit.
	afterCommit, err := s.host.DataSources.InvalidateDataSourceInTx(ctx, tx, formID, "form.projected")
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	afterCommit()
	return nil
}

// outputFieldMaps returns the key→type and key→label maps for a form's output fields, derived from
// its published revision (empty when nothing is published yet).
func (s *Service) outputFieldMaps(ctx context.Context, q rowQuerier, formID uuid.UUID) (map[string]string, map[string]string, error) {
	fieldTypes := map[string]string{}
	fieldLabels := map[string]string{}
	revision, err := s.loadPublishedRevision(ctx, q, formID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return fieldTypes, fieldLabels, nil
		}
		return nil, nil, err
	}
	for _, spec := range outputFieldSpecs(revision.Schema) {
		fieldTypes[spec.Key] = spec.Type
		fieldLabels[spec.Key] = spec.Label
	}
	return fieldTypes, fieldLabels, nil
}

// projectView builds one typed dataset for a saved view. noteBoundary is called with every future
// display/expiry timestamp among candidate records so the caller can schedule the next rebuild.
func (s *Service) projectView(ctx context.Context, q rowQuerier, formID uuid.UUID, view View, fieldTypes, fieldLabels map[string]string, now time.Time, noteBoundary func(*time.Time)) (plugin.TypedDataset, error) {
	dataset := plugin.TypedDataset{ID: view.Key, Kind: "records", Records: []plugin.TypedRecord{}, Fields: []plugin.DataSourceField{}}
	outputFields := view.OutputFields
	if len(outputFields) == 0 {
		// Default to every available field, in a stable order.
		keys := make([]string, 0, len(fieldTypes))
		for key := range fieldTypes {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		outputFields = keys
	}
	for _, key := range outputFields {
		dataset.Fields = append(dataset.Fields, plugin.DataSourceField{Key: key, Label: fieldLabels[key], Type: fieldTypes[key]})
	}

	// Candidate records: in the view's included states AND output-eligible. This is the safety
	// invariant — no unapproved record can ever reach the payload.
	rows, err := q.Query(ctx, `SELECT id,state_key,values,display_title,priority,display_at,expires_at,created_at
		FROM form_records
		WHERE data_source_id=$1 AND deleted_at IS NULL AND eligible AND state_key = ANY($2)
		ORDER BY priority DESC,created_at DESC`, formID, includedStates(view))
	if err != nil {
		return plugin.TypedDataset{}, err
	}
	defer rows.Close()

	type candidate struct {
		id          uuid.UUID
		state       string
		values      map[string]any
		displayText string
		priority    int
		displayAt   *time.Time
		expiresAt   *time.Time
		createdAt   time.Time
	}
	candidates := []candidate{}
	for rows.Next() {
		var c candidate
		var valuesRaw []byte
		if err := rows.Scan(&c.id, &c.state, &valuesRaw, &c.displayText, &c.priority, &c.displayAt, &c.expiresAt, &c.createdAt); err != nil {
			return plugin.TypedDataset{}, err
		}
		c.values = map[string]any{}
		if len(valuesRaw) > 0 {
			_ = json.Unmarshal(valuesRaw, &c.values)
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return plugin.TypedDataset{}, err
	}

	resolve := func(c candidate, field string) any {
		switch field {
		case "state":
			return c.state
		case "displayTitle":
			return c.displayText
		case "priority":
			return c.priority
		case "submittedAt":
			return c.createdAt.Format(time.RFC3339)
		case "displayAt":
			if c.displayAt != nil {
				return c.displayAt.Format(time.RFC3339)
			}
			return nil
		case "expiresAt":
			if c.expiresAt != nil {
				return c.expiresAt.Format(time.RFC3339)
			}
			return nil
		default:
			return c.values[field]
		}
	}
	resolveTime := func(c candidate, field string) *time.Time {
		switch field {
		case "displayAt":
			return c.displayAt
		case "expiresAt":
			return c.expiresAt
		default:
			if text, ok := c.values[field].(string); ok {
				if parsed, err := time.Parse(time.RFC3339, text); err == nil {
					return &parsed
				}
				if parsed, err := time.Parse("2006-01-02", text); err == nil {
					return &parsed
				}
			}
			return nil
		}
	}

	filtered := candidates[:0]
	for _, c := range candidates {
		// Record every future window boundary so the worker can reschedule a rebuild.
		if view.TimeFilter.Enabled {
			if view.TimeFilter.StartBeforeNow && view.TimeFilter.StartField != "" {
				noteBoundary(resolveTime(c, view.TimeFilter.StartField))
			}
			if view.TimeFilter.EndAfterNow && view.TimeFilter.EndField != "" {
				noteBoundary(resolveTime(c, view.TimeFilter.EndField))
			}
		}
		if !passesFieldFilters(resolve, c, view.FieldFilters) {
			continue
		}
		if !passesTimeFilter(c, view.TimeFilter, resolveTime, now) {
			continue
		}
		filtered = append(filtered, c)
	}

	sortCandidates(filtered, view.Sort, resolve)
	if view.RecordLimit > 0 && len(filtered) > view.RecordLimit {
		filtered = filtered[:view.RecordLimit]
	}

	for _, c := range filtered {
		values := map[string]string{}
		for _, key := range outputFields {
			values[key] = stringifyValue(resolve(c, key))
		}
		dataset.Records = append(dataset.Records, plugin.TypedRecord{ID: c.id.String(), Values: values})
	}
	return dataset, nil
}

func includedStates(view View) []string {
	if len(view.IncludedStates) == 0 {
		// A view with no explicit states still only ever shows eligible records; scope to the
		// canonical approved state so an empty configuration does not accidentally show nothing.
		return []string{"approved"}
	}
	return view.IncludedStates
}

// passesFieldFilters applies the bounded operator set over a record's resolved values.
func passesFieldFilters[T any](resolve func(T, string) any, c T, filters []FieldFilter) bool {
	for _, filter := range filters {
		actual := stringifyValue(resolve(c, filter.Field))
		switch filter.Operator {
		case "equals":
			if actual != filter.Value {
				return false
			}
		case "not_equals":
			if actual == filter.Value {
				return false
			}
		case "contains":
			if !strings.Contains(strings.ToLower(actual), strings.ToLower(filter.Value)) {
				return false
			}
		case "empty":
			if strings.TrimSpace(actual) != "" {
				return false
			}
		case "not_empty":
			if strings.TrimSpace(actual) == "" {
				return false
			}
		case "greater_than":
			if !numericCompare(actual, filter.Value, true) {
				return false
			}
		case "less_than":
			if !numericCompare(actual, filter.Value, false) {
				return false
			}
		}
	}
	return true
}

func numericCompare(actual, expected string, greater bool) bool {
	a, err1 := strconv.ParseFloat(strings.TrimSpace(actual), 64)
	b, err2 := strconv.ParseFloat(strings.TrimSpace(expected), 64)
	if err1 != nil || err2 != nil {
		return false
	}
	if greater {
		return a > b
	}
	return a < b
}

func passesTimeFilter[T any](c T, filter TimeFilter, resolveTime func(T, string) *time.Time, now time.Time) bool {
	if !filter.Enabled {
		return true
	}
	if filter.StartBeforeNow && filter.StartField != "" {
		start := resolveTime(c, filter.StartField)
		if start != nil && start.After(now) {
			return false
		}
	}
	if filter.EndAfterNow && filter.EndField != "" {
		end := resolveTime(c, filter.EndField)
		if end != nil && !end.After(now) {
			return false
		}
	}
	return true
}

func sortCandidates[T any](items []T, rules []SortRule, resolve func(T, string) any) {
	if len(rules) == 0 {
		return
	}
	sort.SliceStable(items, func(i, j int) bool {
		for _, rule := range rules {
			a := stringifyValue(resolve(items[i], rule.Field))
			b := stringifyValue(resolve(items[j], rule.Field))
			if a == b {
				continue
			}
			less := a < b
			if af, err1 := strconv.ParseFloat(a, 64); err1 == nil {
				if bf, err2 := strconv.ParseFloat(b, 64); err2 == nil {
					less = af < bf
				}
			}
			if rule.Direction == "desc" {
				return !less
			}
			return less
		}
		return false
	})
}
