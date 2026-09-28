package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	currencydata "golang.org/x/text/currency"
)

var definitionColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$`)

type definitionConfigNormalizer struct {
	service      *Service
	schema       contentdefs.ConfigurationSchema
	outputSchema contentdefs.OutputSchema
}

func (normalizer definitionConfigNormalizer) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var input map[string]any
	if err := decodeConfig(raw, &input); err != nil {
		return nil, err
	}
	output, err := normalizer.normalizeObject(ctx, input, normalizer.schema.Fields, "")
	if err != nil {
		return nil, err
	}
	for _, field := range normalizer.outputSchema.Fields {
		if field.Type != "currency" {
			continue
		}
		code := field.Currency
		if field.CurrencyConfigKey != "" {
			code, _ = output[field.CurrencyConfigKey].(string)
		}
		if code == "" {
			// Legacy definitions may have currency-typed fields without a code. Their
			// values remain usable as plain localized numbers without a money symbol.
			continue
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		currency, parseErr := currencydata.ParseISO(code)
		if parseErr != nil || currency == currencydata.XXX {
			return nil, fmt.Errorf("%s must be a recognized ISO 4217 currency code", field.Label)
		}
		if field.CurrencyConfigKey != "" {
			output[field.CurrencyConfigKey] = currency.String()
		}
	}
	return output, nil
}

func (normalizer definitionConfigNormalizer) normalizeObject(ctx context.Context, input map[string]any, fields []contentdefs.FieldDefinition, prefix string) (map[string]any, error) {
	known := make(map[string]contentdefs.FieldDefinition, len(fields))
	for _, field := range fields {
		known[field.Key] = field
	}
	for key := range input {
		if _, ok := known[key]; !ok {
			return nil, fmt.Errorf("configuration contains unknown field %q", prefix+key)
		}
	}
	output := make(map[string]any, len(fields))
	for _, field := range fields {
		value, present := input[field.Key]
		if !present && field.Default != nil {
			value, present = field.Default, true
		}
		if !present || value == nil || (field.Required && value == "") {
			if field.Required {
				return nil, fmt.Errorf("%s is required", field.Label)
			}
			continue
		}
		normalized, err := normalizer.normalizeField(ctx, field, value, prefix+field.Key)
		if err != nil {
			return nil, err
		}
		output[field.Key] = normalized
	}
	if prefix == "" {
		if err := normalizer.validateDataSourceFieldSelections(ctx, fields, output); err != nil {
			return nil, err
		}
	}
	return output, nil
}

func (normalizer definitionConfigNormalizer) validateDataSourceFieldSelections(ctx context.Context, fields []contentdefs.FieldDefinition, values map[string]any) error {
	validator := dataSourceSelectionValidator{normalizer: normalizer, root: values, cache: map[string]map[string]string{}, rootSources: rootDataSources(fields)}
	return validator.walk(ctx, fields, values, "")
}

func rootDataSources(fields []contentdefs.FieldDefinition) []string {
	var sources []string
	var collect func(list []contentdefs.FieldDefinition)
	collect = func(list []contentdefs.FieldDefinition) {
		for _, field := range list {
			if field.Control == "data_source" {
				sources = append(sources, field.Key)
			}
			if len(field.ItemFields) > 0 {
				collect(field.ItemFields)
			}
		}
	}
	collect(fields)
	return sources
}

// dataSourceSelectionValidator checks every populated data_source_field in a
// normalized configuration, including controls nested inside repeating
// groups, against the output schema of the Data Source it reads. An
// explicit dataSourceKey wins; otherwise a definition with exactly one
// data_source control is unambiguous. When several sources make the
// relationship ambiguous the check fails closed rather than validating
// against the wrong source. Field schemas resolve once per Data Source ID.
type dataSourceSelectionValidator struct {
	normalizer  definitionConfigNormalizer
	root        map[string]any
	cache       map[string]map[string]string
	rootSources []string
}

func (validator *dataSourceSelectionValidator) walk(ctx context.Context, fields []contentdefs.FieldDefinition, current map[string]any, path string) error {
	siblings := make([]string, 0, 1)
	for _, field := range fields {
		if field.Control == "data_source" {
			siblings = append(siblings, field.Key)
		}
	}
	for _, field := range fields {
		switch field.Control {
		case "data_source_field":
			if err := validator.checkField(ctx, field, current, siblings, path); err != nil {
				return err
			}
		case "repeating_group":
			items, ok := groupItems(current[field.Key])
			if !ok {
				return fmt.Errorf("%s is invalid", field.Label)
			}
			for index, item := range items {
				if err := validator.walk(ctx, field.ItemFields, item, fmt.Sprintf("%s%s[%d].", path, field.Key, index)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// groupItems reads normalized repeating-group items, which normalizeObject
// stores as []map[string]any, tolerating the generic []any form.
func groupItems(value any) ([]map[string]any, bool) {
	switch items := value.(type) {
	case nil:
		return nil, true
	case []map[string]any:
		return items, true
	case []any:
		out := make([]map[string]any, 0, len(items))
		for _, entry := range items {
			item, ok := entry.(map[string]any)
			if !ok {
				return nil, false
			}
			out = append(out, item)
		}
		return out, true
	default:
		return nil, false
	}
}

func (validator *dataSourceSelectionValidator) checkField(ctx context.Context, field contentdefs.FieldDefinition, current map[string]any, siblings []string, path string) error {
	label := path + field.Label
	selected, _ := current[field.Key].(string)
	key := field.DataSourceKey
	explicit := key != ""
	if key == "" {
		if len(siblings) == 1 {
			key = siblings[0]
		} else if len(validator.rootSources) == 1 {
			// A nested field with no dataSourceKey reads the definition's
			// single root source. Load-time validation accepts this, so
			// save-time must too; only multiple root sources stay ambiguous.
			key = validator.rootSources[0]
		} else {
			if selected == "" && !field.Required {
				return nil
			}
			return fmt.Errorf("%s does not identify which Data Source supplies its fields", label)
		}
	}
	rawID, _ := current[key].(string)
	if rawID == "" {
		rawID, _ = validator.root[key].(string)
	}
	if rawID == "" {
		// The source ID lives in neither the current item nor the root:
		// an explicit key pointing into an unrelated group is unreachable
		// from this field's scope. An empty selection skips; a populated
		// one fails closed instead of skipping validation.
		if selected == "" && !field.Required {
			return nil
		}
		if explicit {
			return fmt.Errorf("%s references a Data Source that is not available to it", label)
		}
		return nil
	}
	types, err := validator.fieldTypes(ctx, rawID)
	if err != nil {
		return err
	}
	if selected == "" && !field.Required {
		return nil
	}
	selectedType, exists := types[selected]
	if !exists {
		return fmt.Errorf("%s references a field the Data Source does not expose", label)
	}
	if len(field.DataSourceFieldTypes) > 0 && !containsString(field.DataSourceFieldTypes, selectedType) {
		return fmt.Errorf("%s requires a field of type %s", label, strings.Join(field.DataSourceFieldTypes, " or "))
	}
	return nil
}

func (validator *dataSourceSelectionValidator) fieldTypes(ctx context.Context, rawID string) (map[string]string, error) {
	if cached, ok := validator.cache[rawID]; ok {
		return cached, nil
	}
	id, err := uuid.Parse(rawID)
	if err != nil {
		return nil, errors.New("Data Source is invalid")
	}
	var provider string
	var configuration json.RawMessage
	if err = validator.normalizer.service.db.QueryRow(ctx, `SELECT provider,configuration FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&provider, &configuration); err != nil {
		return nil, errors.New("Data Source is unavailable")
	}
	if _, ok := validator.normalizer.service.definitions.DataSource(provider); !ok {
		return nil, errors.New("Data Source provider is unknown")
	}
	types := map[string]string{}
	for _, output := range validator.normalizer.service.availableDataSourceFields(provider, configuration) {
		types[output.Key] = output.Type
	}
	validator.cache[rawID] = types
	return types, nil
}

func (normalizer definitionConfigNormalizer) normalizeField(ctx context.Context, field contentdefs.FieldDefinition, value any, path string) (any, error) {
	switch field.Control {
	case "text", "multiline_text", "color", "date", "datetime", "local_datetime", "timezone", "currency_code", "url", "data_source", "data_source_field", "media_asset":
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be text", field.Label)
		}
		text = strings.TrimSpace(text)
		if field.MinLength > 0 && len(text) < field.MinLength || field.MaxLength > 0 && len(text) > field.MaxLength {
			return nil, fmt.Errorf("%s length is outside the allowed range", field.Label)
		}
		switch field.Control {
		case "currency_code":
			if text != "" {
				text = strings.ToUpper(text)
				currency, err := currencydata.ParseISO(text)
				if err != nil || currency == currencydata.XXX {
					return nil, fmt.Errorf("%s must be a recognized ISO 4217 currency code", field.Label)
				}
				text = currency.String()
			}
		case "color":
			// An optional color left empty follows the display theme.
			if text == "" && !field.Required {
				break
			}
			if !definitionColorPattern.MatchString(text) {
				return nil, fmt.Errorf("%s must be a hexadecimal color", field.Label)
			}
			text = strings.ToLower(text)
		case "date":
			if text != "" {
				if _, err := time.Parse("2006-01-02", text); err != nil {
					return nil, fmt.Errorf("%s must be a date", field.Label)
				}
			}
		case "datetime":
			if text != "" {
				parsed, err := time.Parse(time.RFC3339, text)
				if err != nil {
					return nil, fmt.Errorf("%s must be an RFC 3339 datetime", field.Label)
				}
				text = parsed.UTC().Format(time.RFC3339)
			}
		case "local_datetime":
			// A wall-clock time that a sibling timezone field interprets.
			// Saved RFC 3339 instants from older releases stay valid.
			if text != "" {
				if _, err := time.Parse("2006-01-02T15:04", text); err != nil {
					if _, err = time.Parse("2006-01-02T15:04:05", text); err != nil {
						if _, err = time.Parse(time.RFC3339, text); err != nil {
							return nil, fmt.Errorf("%s must be a local date and time", field.Label)
						}
					}
				}
			}
		case "timezone":
			if _, err := time.LoadLocation(text); err != nil {
				return nil, fmt.Errorf("%s must be an IANA timezone", field.Label)
			}
		case "url":
			parsed, err := url.Parse(text)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
				return nil, fmt.Errorf("%s must be an HTTP or HTTPS URL", field.Label)
			}
		case "data_source":
			id, err := uuid.Parse(text)
			if err != nil {
				return nil, fmt.Errorf("%s must identify a Data Source", field.Label)
			}
			if err := normalizer.validateDataSource(ctx, id, field); err != nil {
				return nil, err
			}
			text = id.String()
		case "media_asset":
			if text == "" && !field.Required {
				break
			}
			id, err := uuid.Parse(text)
			if err != nil {
				return nil, fmt.Errorf("%s must identify a media asset", field.Label)
			}
			var assetType string
			if err := normalizer.service.db.QueryRow(ctx, `SELECT type FROM assets WHERE id=$1 AND deleted_at IS NULL AND processing_status='ready'`, id).Scan(&assetType); err != nil {
				return nil, fmt.Errorf("%s references an unavailable media asset", field.Label)
			}
			if len(field.MediaTypes) > 0 && !containsString(field.MediaTypes, assetType) {
				return nil, fmt.Errorf("%s references an incompatible media asset", field.Label)
			}
			text = id.String()
		}
		return text, nil
	case "number", "integer":
		number, ok := value.(float64)
		if !ok || field.Control == "integer" && math.Trunc(number) != number {
			return nil, fmt.Errorf("%s must be a %s", field.Label, field.Control)
		}
		if field.Minimum != nil && number < *field.Minimum || field.Maximum != nil && number > *field.Maximum {
			return nil, fmt.Errorf("%s is outside the allowed range", field.Label)
		}
		if field.Control == "integer" {
			return int(number), nil
		}
		return number, nil
	case "boolean":
		boolean, ok := value.(bool)
		if !ok {
			return nil, fmt.Errorf("%s must be true or false", field.Label)
		}
		return boolean, nil
	case "select":
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be selected", field.Label)
		}
		for _, option := range field.Options {
			if option.Value == text {
				return text, nil
			}
		}
		return nil, fmt.Errorf("%s has an invalid selection", field.Label)
	case "repeating_group":
		items, ok := value.([]any)
		if !ok || len(items) > field.MaximumItems {
			return nil, fmt.Errorf("%s exceeds its bounded item limit", field.Label)
		}
		normalized := make([]map[string]any, 0, len(items))
		for index, item := range items {
			object, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s item %d is invalid", field.Label, index+1)
			}
			result, err := normalizer.normalizeObject(ctx, object, field.ItemFields, fmt.Sprintf("%s[%d].", path, index))
			if err != nil {
				return nil, err
			}
			normalized = append(normalized, result)
		}
		return normalized, nil
	default:
		return nil, errors.New("unsupported release-defined form control")
	}
}

func (normalizer definitionConfigNormalizer) validateDataSource(ctx context.Context, id uuid.UUID, field contentdefs.FieldDefinition) error {
	var provider string
	if err := normalizer.service.db.QueryRow(ctx, `SELECT provider FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&provider); err != nil {
		return fmt.Errorf("%s references an unavailable Data Source", field.Label)
	}
	definition, ok := normalizer.service.definitions.DataSource(provider)
	if !ok {
		return fmt.Errorf("%s references an unknown Data Source provider", field.Label)
	}
	if len(field.AcceptedDataSourceKinds) > 0 && !containsString(field.AcceptedDataSourceKinds, definition.OutputSchema.Kind) {
		return fmt.Errorf("%s requires a %s Data Source", field.Label, strings.Join(field.AcceptedDataSourceKinds, " or "))
	}
	available := map[string]string{}
	for _, output := range definition.OutputSchema.Fields {
		available[output.Key] = output.Type
	}
	for key, requiredType := range field.RequiredFields {
		if available[key] != requiredType {
			return fmt.Errorf("%s requires Data Source field %s of type %s", field.Label, key, requiredType)
		}
	}
	return nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// manualObjectPayload projects a manual_object Data Source's normalized configuration
// into the typed object payload stored in the refresh cache and returned to the Player.
// Every field is taken from the definition's output schema: output fields that match a
// configuration key receive the configured value, while declared fields with no matching
// configuration key are generated (only updatedAt is generated today). This is fully
// generic — a new manual_object definition needs no provider-specific code here.
func manualObjectPayload(definition contentdefs.DataSourceDefinition, configuration map[string]any, updatedAt time.Time) TypedDatasetPayload {
	fields := outputDataSourceFields(definition.OutputSchema, configuration)
	values := make(map[string]string, len(definition.OutputSchema.Fields))
	for _, field := range definition.OutputSchema.Fields {
		if raw, ok := configuration[field.Key]; ok {
			values[field.Key] = manualObjectValueString(raw)
			continue
		}
		if field.Key == "updatedAt" {
			values[field.Key] = updatedAt.UTC().Format(time.RFC3339)
			continue
		}
		values[field.Key] = ""
	}
	return TypedDatasetPayload{Datasets: []TypedDataset{{
		ID: "object", Kind: "object", Fields: fields, Values: values,
		CachedAt: &updatedAt, StaleAt: &updatedAt,
	}}}
}

func manualObjectValueString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	default:
		return fmt.Sprint(typed)
	}
}

// manualObjectConfiguration coerces a normalized configuration into the map form the
// generic manual_object projection consumes. The definition normalizer returns a map,
// but stored configurations may arrive as raw JSON.
func manualObjectConfiguration(configuration any) (map[string]any, error) {
	if typed, ok := configuration.(map[string]any); ok {
		return typed, nil
	}
	encoded, err := json.Marshal(configuration)
	if err != nil {
		return nil, err
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}
