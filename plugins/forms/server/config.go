package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// The stored data_sources.configuration shape for a Form Data Source. It is
// JSON-identical to the shape core media code used to define, so existing
// rows keep decoding unchanged: the ownership moved, the bytes did not.
// Records, workflow, views, grants, history, and attachments live in
// dedicated form_* tables; only the Widget-facing summary lives here.

// FormFieldSpec is one selectable output field a Form Data Source exposes to Widgets.
type FormFieldSpec struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"`
}

// FormViewSpec names one saved output view. Each maps to one typed dataset in the cached
// payload, keyed by Key, so Widgets can select a named dataset under the Form Data Source.
type FormViewSpec struct {
	Key    string   `json:"key"`
	Name   string   `json:"name"`
	Fields []string `json:"fields,omitempty"`
}

// FormSourceConfig is the minimal object stored on data_sources.configuration for a Form Data
// Source. DraftSchema is the editable, not-yet-published form definition, opaque outside this
// plugin and preserved across updates.
type FormSourceConfig struct {
	CurrentRevisionID    string            `json:"currentRevisionId,omitempty"`
	Fields               []FormFieldSpec   `json:"fields"`
	Views                []FormViewSpec    `json:"views"`
	DisplayFieldMappings map[string]string `json:"displayFieldMappings,omitempty"`
	DraftSchema          json.RawMessage   `json:"draftSchema,omitempty"`
}

// formOutputFieldTypes bounds the typed values a form field may expose to Widgets. It mirrors
// the catalog's supportedOutputFieldTypes for the kinds a form builder can produce.
var formOutputFieldTypes = map[string]bool{
	"text": true, "number": true, "integer": true, "boolean": true,
	"date": true, "datetime": true, "url": true, "asset": true,
}

// normalizeFormConfig validates a stored configuration shape strictly, returning the
// normalized form. It is pure: no database. The generic Data Source path calls it through
// the provider contribution when a form configuration passes through generic handling.
func normalizeFormConfig(raw json.RawMessage) (FormSourceConfig, error) {
	var config FormSourceConfig
	if len(raw) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&config); err != nil {
			return FormSourceConfig{}, fmt.Errorf("form configuration is invalid: %w", err)
		}
	}
	if config.CurrentRevisionID != "" {
		if _, err := uuid.Parse(config.CurrentRevisionID); err != nil {
			return FormSourceConfig{}, errors.New("form configuration has an invalid current revision id")
		}
	}
	seenFields := map[string]bool{}
	for _, field := range config.Fields {
		if field.Key == "" || seenFields[field.Key] {
			return FormSourceConfig{}, errors.New("form configuration has a missing or duplicate field key")
		}
		seenFields[field.Key] = true
		if !formOutputFieldTypes[field.Type] {
			return FormSourceConfig{}, fmt.Errorf("form field %q uses unsupported type %q", field.Key, field.Type)
		}
	}
	seenViews := map[string]bool{}
	for _, view := range config.Views {
		if view.Key == "" || seenViews[view.Key] {
			return FormSourceConfig{}, errors.New("form configuration has a missing or duplicate view key")
		}
		seenViews[view.Key] = true
		for _, key := range view.Fields {
			if !seenFields[key] {
				return FormSourceConfig{}, fmt.Errorf("form view %q references unknown field %q", view.Key, key)
			}
		}
	}
	for role, key := range config.DisplayFieldMappings {
		if key != "" && !seenFields[key] {
			return FormSourceConfig{}, fmt.Errorf("form display mapping %q references unknown field %q", role, key)
		}
	}
	if config.Fields == nil {
		config.Fields = []FormFieldSpec{}
	}
	if config.Views == nil {
		config.Views = []FormViewSpec{}
	}
	return config, nil
}
