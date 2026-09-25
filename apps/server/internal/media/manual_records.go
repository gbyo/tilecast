package media

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// The manual_records adapter projects a bounded, Studio-maintained table of rows into a
// typed record dataset. It is fully generic: the rows come from a repeating_group
// configuration field and every emitted value is named by the definition's output schema,
// so a new manual_records Data Source needs no provider-specific code here.
//
// Three output-schema keys carry behavior when a definition declares them. They are
// conventions, not requirements, and a definition that omits them simply gets an
// unfiltered, unsorted, authored-order list:
//
//	publishAt  datetime  the row is hidden until this moment
//	expiresAt  datetime  the row is hidden from this moment onward
//	priority   integer   higher values sort first
//
// Because visibility depends on the clock rather than on an edit, the projection also
// reports the next moment at which the visible set changes. Callers schedule the Data
// Source's next refresh for exactly that moment instead of polling.
const (
	manualRecordsField          = "records"
	manualRecordsPublishAtKey   = "publishAt"
	manualRecordsExpiresAtKey   = "expiresAt"
	manualRecordsPriorityKey    = "priority"
	manualRecordsMaximumRecords = 200
)

// manualRecordsProjection is the result of projecting a manual_records configuration.
type manualRecordsProjection struct {
	Payload TypedDatasetPayload
	// Visible is the number of rows that pass the publish window at projection time.
	Visible int
	// NextBoundary is the earliest future moment a row appears or disappears, or nil when
	// the visible set cannot change without an edit.
	NextBoundary *time.Time
}

// manualRecordsPayload projects a normalized manual_records configuration into the typed
// record dataset the Player receives.
func manualRecordsPayload(definition contentdefs.DataSourceDefinition, configuration map[string]any, now time.Time) manualRecordsProjection {
	now = now.UTC()
	fields := outputDataSourceFields(definition.OutputSchema, configuration)
	declared := make(map[string]bool, len(definition.OutputSchema.Fields))
	for _, field := range definition.OutputSchema.Fields {
		declared[field.Key] = true
	}

	rows := manualRecordsRows(configuration)
	records := make([]TypedRecord, 0, len(rows))
	var boundary *time.Time
	for index, row := range rows {
		if index >= manualRecordsMaximumRecords {
			break
		}
		publishAt := manualRecordsTime(declared, row, manualRecordsPublishAtKey)
		expiresAt := manualRecordsTime(declared, row, manualRecordsExpiresAtKey)
		// A row that has not started yet, and a row that has already ended, both change the
		// visible set at their own boundary.
		if publishAt != nil && publishAt.After(now) {
			boundary = earlierBoundary(boundary, *publishAt)
			continue
		}
		if expiresAt != nil && !expiresAt.After(now) {
			continue
		}
		if expiresAt != nil {
			boundary = earlierBoundary(boundary, *expiresAt)
		}
		values := make(map[string]string, len(definition.OutputSchema.Fields))
		for _, field := range definition.OutputSchema.Fields {
			values[field.Key] = manualObjectValueString(row[field.Key])
		}
		records = append(records, TypedRecord{ID: "row-" + strconv.Itoa(index+1), Values: values})
	}
	sortManualRecords(definition, declared, records)

	dataset := TypedDataset{
		ID: "records", Kind: "records", Fields: fields, Records: records,
		CachedAt: &now, StaleAt: &now,
	}
	return manualRecordsProjection{
		Payload:      TypedDatasetPayload{Datasets: []TypedDataset{dataset}},
		Visible:      len(records),
		NextBoundary: boundary,
	}
}

// manualRecordsRows coerces the repeating-group value into row maps. The definition
// normalizer produces []map[string]any, while a configuration reloaded from the database
// arrives as []any of map[string]any.
func manualRecordsRows(configuration map[string]any) []map[string]any {
	switch typed := configuration[manualRecordsField].(type) {
	case []map[string]any:
		return typed
	case []any:
		rows := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if row, ok := item.(map[string]any); ok {
				rows = append(rows, row)
			}
		}
		return rows
	default:
		return nil
	}
}

// manualRecordsTime reads a window boundary only when the definition declares that key,
// so a definition without a publish window is never filtered by a stray configuration
// value of the same name.
func manualRecordsTime(declared map[string]bool, row map[string]any, key string) *time.Time {
	if !declared[key] {
		return nil
	}
	raw := strings.TrimSpace(manualObjectValueString(row[key]))
	if raw == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil
	}
	utc := parsed.UTC()
	return &utc
}

func earlierBoundary(current *time.Time, candidate time.Time) *time.Time {
	if current == nil || candidate.Before(*current) {
		copied := candidate
		return &copied
	}
	return current
}

// sortManualRecords orders visible rows by descending priority, then by the definition's
// first declared date or datetime field ascending. Rows a definition cannot order stay in
// the order the author entered them, which sort.SliceStable preserves.
func sortManualRecords(definition contentdefs.DataSourceDefinition, declared map[string]bool, records []TypedRecord) {
	dateKey := ""
	for _, field := range definition.OutputSchema.Fields {
		if field.Key == manualRecordsPublishAtKey || field.Key == manualRecordsExpiresAtKey {
			continue
		}
		if field.Type == "date" || field.Type == "datetime" {
			dateKey = field.Key
			break
		}
	}
	hasPriority := declared[manualRecordsPriorityKey]
	if !hasPriority && dateKey == "" {
		return
	}
	sort.SliceStable(records, func(i, j int) bool {
		if hasPriority {
			left := manualRecordsNumber(records[i].Values[manualRecordsPriorityKey])
			right := manualRecordsNumber(records[j].Values[manualRecordsPriorityKey])
			if left != right {
				return left > right
			}
		}
		if dateKey == "" {
			return false
		}
		return records[i].Values[dateKey] < records[j].Values[dateKey]
	})
}

func manualRecordsNumber(raw string) float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return 0
	}
	return value
}

// ManualRecordsPreview projects an unsaved manual_records configuration into the same
// payload the Player receives, so Studio previews match stored behavior.
func (s *Service) ManualRecordsPreview(ctx context.Context, provider string, raw json.RawMessage) (TypedDatasetPayload, error) {
	definition, ok := s.definitions.DataSource(provider)
	if !ok || definition.AdapterID != "manual_records" {
		return TypedDatasetPayload{}, errors.New("data source provider is not a manual record table")
	}
	normalizer, err := s.dataSourceProvider(provider)
	if err != nil {
		return TypedDatasetPayload{}, err
	}
	configuration, err := normalizer.Normalize(ctx, raw)
	if err != nil {
		return TypedDatasetPayload{}, err
	}
	config, err := manualObjectConfiguration(configuration)
	if err != nil {
		return TypedDatasetPayload{}, err
	}
	return manualRecordsPayload(definition, config, time.Now()).Payload, nil
}
