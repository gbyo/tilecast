package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// componentConfigNormalizer validates writes for every Widget provider that
// declares a Widgets V2 component (docs/widgets-v2-catalog.md §8):
//
//  1. saved legacy keys are upgraded through the component configTemplate;
//  2. the provider's configuration schema validates the result, including
//     hidden retained fields;
//  3. keys the configTemplate still reads directly are kept as bounded
//     JSON, because the component reads them;
//  4. every other key is rejected.
//
// It replaces the hand-written legacy normalizer of each migrated provider.
// ConfigurationError reports a Widget configuration that its provider's
// schema refuses. The HTTP layer maps it to 422 validation_failed.
type ConfigurationError struct{ Err error }

func (e *ConfigurationError) Error() string { return e.Err.Error() }
func (e *ConfigurationError) Unwrap() error { return e.Err }

type componentConfigNormalizer struct {
	service    *Service
	definition contentdefs.WidgetDefinition
}

func (normalizer componentConfigNormalizer) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	normalized, err := normalizer.normalize(ctx, raw)
	if err != nil {
		return nil, &ConfigurationError{Err: err}
	}
	return normalized, nil
}

func (normalizer componentConfigNormalizer) normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var input map[string]any
	if err := decodeConfig(raw, &input); err != nil {
		return nil, err
	}
	if input == nil {
		return nil, errors.New("configuration must be an object")
	}
	upgraded, _ := contentdefs.UpgradeAuthorConfiguration(normalizer.definition, input)
	applyChartLegacyStyle(normalizer.definition.ID, input, upgraded)
	schema := map[string]bool{}
	for _, field := range normalizer.definition.ConfigurationSchema.Fields {
		schema[field.Key] = true
	}
	reads := contentdefs.TemplateReads(*normalizer.definition.Component)
	retained := map[string]any{}
	authored := map[string]any{}
	for key, value := range upgraded {
		switch {
		case schema[key]:
			authored[key] = value
		case contentdefs.IsDerivedConfigurationKey(normalizer.definition.ConfigurationSchema.Fields, key):
			// Derived keys come from manifest projection, never a client.
			return nil, fmt.Errorf("configuration contains unknown field %q", key)
		case reads[key]:
			if err := contentdefs.ComponentConfigLimitProblem(map[string]any{key: value}); err != nil {
				return nil, fmt.Errorf("configuration field %q: %w", key, err)
			}
			retained[key] = value
		default:
			return nil, fmt.Errorf("configuration contains unknown field %q", key)
		}
	}
	encoded, err := json.Marshal(authored)
	if err != nil {
		return nil, err
	}
	normalized, err := (definitionConfigNormalizer{service: normalizer.service, schema: normalizer.definition.ConfigurationSchema}).Normalize(ctx, encoded)
	if err != nil {
		return nil, err
	}
	output := normalized.(map[string]any)
	for key, value := range retained {
		output[key] = value
	}
	if err := validateMigratedBounds(normalizer.definition.ID, output); err != nil {
		return nil, err
	}
	return output, nil
}

// applyChartLegacyStyle preserves a saved legacy chartType when the author
// has not chosen a new style. The configuration schema defaults style to
// "line", so without this a resaved bar or donut chart would silently
// become a line chart in both the component and compatibility presentations.
func applyChartLegacyStyle(provider string, input, upgraded map[string]any) {
	if provider != "chart" {
		return
	}
	if _, hasStyle := input["style"]; hasStyle {
		return
	}
	if _, hasStyle := upgraded["style"]; hasStyle {
		return
	}
	chartType, _ := upgraded["chartType"].(string)
	if chartType == "" {
		chartType, _ = input["chartType"].(string)
	}
	switch chartType {
	case "bar", "donut":
		upgraded["style"] = "bar"
	case "line":
		upgraded["style"] = "line"
	case "area":
		upgraded["style"] = "area"
	}
}

// validateMigratedBounds restores the cross-field and minimum-count bounds
// the hand-written providers enforced before the generic schema validator
// replaced them. The manifests alone cannot express them: a missing or
// zero progress target, inverted chart bounds, or an empty series/metrics
// list would otherwise save and fail only at render.
func validateMigratedBounds(provider string, output map[string]any) error {
	switch provider {
	case "progress":
		targetField, _ := output["targetField"].(string)
		if targetField != "" {
			return nil
		}
		if number, ok := componentNumber(output["staticTarget"]); ok && number > 0 {
			return nil
		}
		return errors.New("progress requires a positive target")
	case "chart":
		if minimum, ok := componentNumber(output["minimum"]); ok {
			if maximum, ok := componentNumber(output["maximum"]); ok {
				if minimum >= maximum {
					return errors.New("chart bounds are invalid")
				}
			}
		}
		if count := componentItems(output["series"]); count < 1 {
			return errors.New("chart supports one to four series")
		}
	case "metric":
		if count := componentItems(output["metrics"]); count < 1 {
			return errors.New("metrics requires at least one metric")
		}
	}
	return nil
}

func componentNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, true
	case float32:
		return float64(number), true
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	case json.Number:
		parsed, err := number.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func componentItems(value any) int {
	switch items := value.(type) {
	case []map[string]any:
		return len(items)
	case []any:
		return len(items)
	default:
		return 0
	}
}
