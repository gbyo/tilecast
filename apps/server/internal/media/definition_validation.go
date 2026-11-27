package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
	currencydata "golang.org/x/text/currency"
)

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
	output, err := configschema.Normalize(ctx, normalizer.schema.Fields, input, definitionReferences{normalizer: normalizer})
	if err != nil {
		return nil, err
	}
	if err := normalizer.validateDataSourceFieldSelections(ctx, normalizer.schema.Fields, output); err != nil {
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

// definitionReferences checks resource identifiers in Widget configuration
// against the Server's tables for the shared configuration normalizer.
type definitionReferences struct {
	normalizer definitionConfigNormalizer
}

func (refs definitionReferences) DataSource(ctx context.Context, field contentdefs.FieldDefinition, id uuid.UUID) error {
	return refs.normalizer.validateDataSource(ctx, id, field)
}

func (refs definitionReferences) MediaAsset(ctx context.Context, field contentdefs.FieldDefinition, id uuid.UUID) error {
	var assetType string
	if err := refs.normalizer.service.db.QueryRow(ctx, `SELECT type FROM assets WHERE id=$1 AND deleted_at IS NULL AND processing_status='ready'`, id).Scan(&assetType); err != nil {
		return fmt.Errorf("%s references an unavailable media asset", field.Label)
	}
	if len(field.MediaTypes) > 0 && !containsString(field.MediaTypes, assetType) {
		return fmt.Errorf("%s references an incompatible media asset", field.Label)
	}
	return nil
}

func (refs definitionReferences) Font(ctx context.Context, field contentdefs.FieldDefinition, id uuid.UUID) error {
	// The save transaction locks the family FOR SHARE before it records the
	// reference; this read only refuses early.
	var exists bool
	if err := refs.normalizer.service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM font_families WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%s references a font that is not in the font library", field.Label)
	}
	return nil
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
