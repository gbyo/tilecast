package server

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxFormFields = 100

var fieldKeyPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9_]{0,63}$`)

var supportedControls = map[string]bool{
	ControlShortText: true, ControlLongText: true, ControlNumber: true, ControlInteger: true,
	ControlBoolean: true, ControlSelect: true, ControlMultiSelect: true, ControlDate: true,
	ControlDateTime: true, ControlURL: true, ControlImage: true, ControlSection: true,
	ControlHelpText: true,
}

// validateSchema enforces stable, safe form definitions.
func validateSchema(schema FormSchema) error {
	if len(schema.Fields) > maxFormFields {
		return fmt.Errorf("%w: a form allows at most %d fields", ErrValidation, maxFormFields)
	}
	seen := map[string]bool{}
	for _, field := range schema.Fields {
		if !fieldKeyPattern.MatchString(field.Key) {
			return fmt.Errorf("%w: field key %q is invalid", ErrValidation, field.Key)
		}
		if reservedFieldKeys[field.Key] {
			return fmt.Errorf("%w: field key %q is reserved", ErrValidation, field.Key)
		}
		if seen[field.Key] {
			return fmt.Errorf("%w: duplicate field key %q", ErrValidation, field.Key)
		}
		seen[field.Key] = true
		if !supportedControls[field.Control] {
			return fmt.Errorf("%w: field %q uses unsupported control %q", ErrValidation, field.Key, field.Control)
		}
		if strings.TrimSpace(field.Label) == "" && field.Control != ControlHelpText {
			return fmt.Errorf("%w: field %q needs a label", ErrValidation, field.Key)
		}
		if field.Control == ControlSelect || field.Control == ControlMultiSelect {
			if len(field.Options) == 0 {
				return fmt.Errorf("%w: field %q needs options", ErrValidation, field.Key)
			}
			optionValues := map[string]bool{}
			for _, option := range field.Options {
				if strings.TrimSpace(option.Value) == "" || optionValues[option.Value] {
					return fmt.Errorf("%w: field %q has a missing or duplicate option value", ErrValidation, field.Key)
				}
				optionValues[option.Value] = true
			}
		}
		if field.Minimum != nil && field.Maximum != nil && *field.Minimum > *field.Maximum {
			return fmt.Errorf("%w: field %q minimum exceeds maximum", ErrValidation, field.Key)
		}
		if field.MinLength < 0 || field.MaxLength < 0 || (field.MaxLength > 0 && field.MinLength > field.MaxLength) {
			return fmt.Errorf("%w: field %q has invalid length bounds", ErrValidation, field.Key)
		}
	}
	return nil
}

// validateRecordValues checks submitted values against a schema and returns the normalized value
// map. When requireComplete is true, required fields must be present (used when submitting for
// review or approving). Unknown keys are rejected; presentation-only controls carry no value.
//
// Image fields are never taken from the client here: their value is an attachment asset id owned by
// the attachment upload/remove endpoints. This function ignores any client-supplied image value and
// omits image fields from the normalized map; the caller merges the record's real (bound) image
// values back in. Required-image completeness is verified against boundImages — the set of field
// keys that currently have a live attachment bound to the record — not against the client payload.
func validateRecordValues(schema FormSchema, values map[string]any, requireComplete bool, boundImages map[string]bool) (map[string]any, error) {
	fields := map[string]FormField{}
	for _, field := range schema.Fields {
		fields[field.Key] = field
	}
	for key := range values {
		field, ok := fields[key]
		if !ok {
			return nil, fmt.Errorf("%w: value provided for unknown field %q", ErrValidation, key)
		}
		// A client may not set an image field's value directly; those are managed by attachments.
		if field.Control == ControlImage {
			return nil, fmt.Errorf("%w: field %q is an image and is set by uploading an attachment", ErrValidation, key)
		}
	}
	normalized := map[string]any{}
	for _, field := range schema.Fields {
		if outputTypeFor(field.Control) == "" {
			continue
		}
		if field.Control == ControlImage {
			// Completeness is satisfied only by a live bound attachment, never by a client value.
			if field.Required && requireComplete && !boundImages[field.Key] {
				return nil, fmt.Errorf("%w: field %q requires an uploaded image", ErrValidation, field.Key)
			}
			continue
		}
		raw, present := values[field.Key]
		if !present || isEmptyValue(raw) {
			if field.Required && requireComplete {
				return nil, fmt.Errorf("%w: field %q is required", ErrValidation, field.Key)
			}
			continue
		}
		value, err := normalizeFieldValue(field, raw)
		if err != nil {
			return nil, err
		}
		normalized[field.Key] = value
	}
	return normalized, nil
}

func isEmptyValue(raw any) bool {
	switch v := raw.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(v) == ""
	case []any:
		return len(v) == 0
	default:
		return false
	}
}

func normalizeFieldValue(field FormField, raw any) (any, error) {
	invalid := func() error { return fmt.Errorf("%w: field %q has an invalid value", ErrValidation, field.Key) }
	switch field.Control {
	case ControlShortText, ControlLongText:
		text, ok := asString(raw)
		if !ok {
			return nil, invalid()
		}
		if field.MaxLength > 0 && len([]rune(text)) > field.MaxLength {
			return nil, fmt.Errorf("%w: field %q exceeds its maximum length", ErrValidation, field.Key)
		}
		if field.MinLength > 0 && len([]rune(text)) < field.MinLength {
			return nil, fmt.Errorf("%w: field %q is shorter than its minimum length", ErrValidation, field.Key)
		}
		return text, nil
	case ControlURL:
		text, ok := asString(raw)
		if !ok {
			return nil, invalid()
		}
		parsed, err := url.Parse(text)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return nil, fmt.Errorf("%w: field %q must be an http(s) URL", ErrValidation, field.Key)
		}
		return text, nil
	case ControlNumber, ControlInteger:
		number, ok := asFloat(raw)
		if !ok {
			return nil, invalid()
		}
		if field.Control == ControlInteger && number != float64(int64(number)) {
			return nil, fmt.Errorf("%w: field %q must be a whole number", ErrValidation, field.Key)
		}
		if field.Minimum != nil && number < *field.Minimum {
			return nil, fmt.Errorf("%w: field %q is below its minimum", ErrValidation, field.Key)
		}
		if field.Maximum != nil && number > *field.Maximum {
			return nil, fmt.Errorf("%w: field %q is above its maximum", ErrValidation, field.Key)
		}
		return number, nil
	case ControlBoolean:
		b, ok := asBool(raw)
		if !ok {
			return nil, invalid()
		}
		return b, nil
	case ControlDate:
		text, ok := asString(raw)
		if !ok {
			return nil, invalid()
		}
		if _, err := time.Parse("2006-01-02", text); err != nil {
			return nil, fmt.Errorf("%w: field %q must be a date (YYYY-MM-DD)", ErrValidation, field.Key)
		}
		return text, nil
	case ControlDateTime:
		text, ok := asString(raw)
		if !ok {
			return nil, invalid()
		}
		if _, err := time.Parse(time.RFC3339, text); err != nil {
			return nil, fmt.Errorf("%w: field %q must be an RFC3339 datetime", ErrValidation, field.Key)
		}
		return text, nil
	case ControlSelect:
		text, ok := asString(raw)
		if !ok || !optionAllowed(field, text) {
			return nil, fmt.Errorf("%w: field %q is not one of its options", ErrValidation, field.Key)
		}
		return text, nil
	case ControlMultiSelect:
		list, ok := raw.([]any)
		if !ok {
			return nil, invalid()
		}
		result := make([]string, 0, len(list))
		for _, item := range list {
			text, ok := asString(item)
			if !ok || !optionAllowed(field, text) {
				return nil, fmt.Errorf("%w: field %q contains a value that is not one of its options", ErrValidation, field.Key)
			}
			result = append(result, text)
		}
		return result, nil
	case ControlImage:
		// Image fields carry an attachment asset id (UUID string) validated by AttachAsset.
		text, ok := asString(raw)
		if !ok {
			return nil, invalid()
		}
		return text, nil
	default:
		return nil, invalid()
	}
}

func optionAllowed(field FormField, value string) bool {
	for _, option := range field.Options {
		if option.Value == value {
			return true
		}
	}
	return false
}

func asString(raw any) (string, bool) {
	s, ok := raw.(string)
	return s, ok
}

func asFloat(raw any) (float64, bool) {
	switch v := raw.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func asBool(raw any) (bool, bool) {
	switch v := raw.(type) {
	case bool:
		return v, true
	case string:
		b, err := strconv.ParseBool(strings.TrimSpace(v))
		return b, err == nil
	default:
		return false, false
	}
}

// stringifyValue coerces a normalized value into the string form the typed-dataset projection
// uses (plugin.TypedRecord.Values is map[string]string).
func stringifyValue(raw any) string {
	switch v := raw.(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			parts = append(parts, stringifyValue(item))
		}
		return strings.Join(parts, ", ")
	case []string:
		return strings.Join(v, ", ")
	default:
		return ""
	}
}
