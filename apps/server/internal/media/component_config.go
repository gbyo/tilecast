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
		case contentdefs.DerivedConfigurationKeys[key]:
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
	return output, nil
}
