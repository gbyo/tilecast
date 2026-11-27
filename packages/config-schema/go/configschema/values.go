package configschema

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	currencydata "golang.org/x/text/currency"
)

var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$`)

// References checks values that name a Tilecast resource. The Server
// implements it against its own tables; a nil References accepts any
// well-formed identifier, which is what pure schema tests and Studio-side
// checks need. Each method returns an error whose text an operator can read.
type References interface {
	DataSource(ctx context.Context, field Field, id uuid.UUID) error
	MediaAsset(ctx context.Context, field Field, id uuid.UUID) error
	Font(ctx context.Context, field Field, id uuid.UUID) error
}

// Normalize validates a configuration document against fields and returns
// the normalized document: defaults applied, text trimmed, identifiers and
// colors canonical, datetimes in UTC, integers as int, weekdays sorted. It
// refuses unknown keys. Secret and connection values never travel in a
// configuration document, so a value for either is refused; the host writes
// secrets through the secret store.
func Normalize(ctx context.Context, fields []Field, input map[string]any, refs References) (map[string]any, error) {
	return normalizeObject(ctx, fields, input, "", refs)
}

func normalizeObject(ctx context.Context, fields []Field, input map[string]any, prefix string, refs References) (map[string]any, error) {
	known := make(map[string]Field, len(fields))
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
		if field.Control == ControlSecret || field.Control == ControlConnection {
			if present && value != nil {
				if field.Control == ControlSecret {
					return nil, fmt.Errorf("%s is a secret and is written through the secret store", field.Label)
				}
				return nil, fmt.Errorf("%s needs an outbound connection, which this release does not provide", field.Label)
			}
			continue
		}
		if !present && field.Default != nil {
			value, present = field.Default, true
		}
		if !present || value == nil || (field.Required && value == "") {
			if field.Required {
				return nil, fmt.Errorf("%s is required", field.Label)
			}
			continue
		}
		normalized, err := normalizeField(ctx, field, value, prefix+field.Key, refs)
		if err != nil {
			return nil, err
		}
		output[field.Key] = normalized
	}
	return output, nil
}

func normalizeField(ctx context.Context, field Field, value any, path string, refs References) (any, error) {
	switch field.Control {
	case "text", "multiline_text", "color", "date", "datetime", "local_datetime", "time", "timezone", "currency_code", "url", "data_source", "data_source_field", "media_asset", "font":
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be text", field.Label)
		}
		text = strings.TrimSpace(text)
		if field.MinLength > 0 && len(text) < field.MinLength || field.MaxLength > 0 && len(text) > field.MaxLength {
			return nil, fmt.Errorf("%s length is outside the allowed range", field.Label)
		}
		return normalizeText(ctx, field, text, refs)
	case "number", "integer":
		number, ok := value.(float64)
		if !ok {
			if integer, isInt := value.(int); isInt {
				number, ok = float64(integer), true
			}
		}
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
	case "weekdays":
		days, err := normalizeWeekdays(value)
		if err != nil {
			return nil, fmt.Errorf("%s must contain unique days from 0 (Sunday) through 6", field.Label)
		}
		if field.Required && len(days) == 0 {
			return nil, fmt.Errorf("%s is required", field.Label)
		}
		return days, nil
	case "string_list":
		items, ok := value.([]any)
		if !ok || len(items) > field.MaximumItems {
			return nil, fmt.Errorf("%s exceeds its bounded item limit", field.Label)
		}
		normalized := make([]string, 0, len(items))
		for _, item := range items {
			text, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("%s must contain only text", field.Label)
			}
			text = strings.TrimSpace(text)
			if text == "" {
				continue
			}
			if field.MinLength > 0 && len(text) < field.MinLength || field.MaxLength > 0 && len(text) > field.MaxLength {
				return nil, fmt.Errorf("%s contains an entry outside the allowed length", field.Label)
			}
			normalized = append(normalized, text)
		}
		return normalized, nil
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
			result, err := normalizeObject(ctx, field.ItemFields, object, fmt.Sprintf("%s[%d].", path, index), refs)
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

func normalizeText(ctx context.Context, field Field, text string, refs References) (any, error) {
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
		if !colorPattern.MatchString(text) {
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
	case "time":
		if text == "" && !field.Required {
			break
		}
		if _, err := time.Parse("15:04", text); err != nil || len(text) != 5 {
			return nil, fmt.Errorf("%s must be a time written HH:MM", field.Label)
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
		if refs != nil {
			if err := refs.DataSource(ctx, field, id); err != nil {
				return nil, err
			}
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
		if refs != nil {
			if err := refs.MediaAsset(ctx, field, id); err != nil {
				return nil, err
			}
		}
		text = id.String()
	case "font":
		if text == "" && !field.Required {
			break
		}
		id, err := uuid.Parse(text)
		if err != nil || id == uuid.Nil {
			return nil, fmt.Errorf("%s must identify a library font", field.Label)
		}
		if refs != nil {
			if err := refs.Font(ctx, field, id); err != nil {
				return nil, err
			}
		}
		text = id.String()
	}
	return text, nil
}

// normalizeWeekdays accepts a list of whole numbers 0 (Sunday) through 6,
// each at most once, and returns them sorted.
func normalizeWeekdays(value any) ([]int, error) {
	items, ok := value.([]any)
	if !ok {
		if ints, isInts := value.([]int); isInts {
			items = make([]any, len(ints))
			for index, day := range ints {
				items[index] = float64(day)
			}
		} else {
			return nil, errors.New("not a list")
		}
	}
	if len(items) > 7 {
		return nil, errors.New("too many days")
	}
	seen := map[int]bool{}
	days := make([]int, 0, len(items))
	for _, item := range items {
		number, ok := item.(float64)
		if !ok || math.Trunc(number) != number || number < 0 || number > 6 || seen[int(number)] {
			return nil, errors.New("invalid day")
		}
		seen[int(number)] = true
		days = append(days, int(number))
	}
	sort.Ints(days)
	return days, nil
}

// NormalizeSecret checks one secret value for a secret field. Leading and
// trailing whitespace is part of the value: a token is stored exactly as
// entered. An empty value is refused; the host clears a secret explicitly.
func NormalizeSecret(field Field, value string) (string, error) {
	if field.Control != ControlSecret {
		return "", fmt.Errorf("%s is not a secret field", field.Label)
	}
	maximum := field.MaxLength
	if maximum <= 0 || maximum > MaxSecretBytes {
		maximum = MaxSecretBytes
	}
	if value == "" || len(value) > maximum || field.MinLength > 0 && len(value) < field.MinLength {
		return "", fmt.Errorf("%s length is outside the allowed range", field.Label)
	}
	if !utf8.ValidString(value) {
		return "", fmt.Errorf("%s must be text", field.Label)
	}
	return value, nil
}

// FontValues returns the library font IDs a configuration's top-level font
// fields choose, lowercased, without duplicates, in schema order. Empty and
// malformed values choose nothing: saving validates them, and a projection
// never trusts stored text as a family.
func FontValues(fields []Field, configuration map[string]any) []string {
	ids := []string{}
	for _, field := range fields {
		if field.Control != "font" {
			continue
		}
		text, _ := configuration[field.Key].(string)
		id, err := uuid.Parse(strings.TrimSpace(text))
		if err != nil || id == uuid.Nil {
			continue
		}
		value := id.String()
		known := false
		for _, existing := range ids {
			known = known || existing == value
		}
		if !known {
			ids = append(ids, value)
		}
	}
	return ids
}

// MediaAssetValues returns the media asset IDs a configuration names, at any
// depth, without duplicates, in schema order.
func MediaAssetValues(fields []Field, configuration map[string]any) []string {
	ids := []string{}
	seen := map[string]bool{}
	var walk func([]Field, map[string]any)
	walk = func(fields []Field, values map[string]any) {
		for _, field := range fields {
			switch field.Control {
			case "media_asset":
				text, _ := values[field.Key].(string)
				id, err := uuid.Parse(strings.TrimSpace(text))
				if err == nil && id != uuid.Nil && !seen[id.String()] {
					seen[id.String()] = true
					ids = append(ids, id.String())
				}
			case "repeating_group":
				switch items := values[field.Key].(type) {
				case []any:
					for _, item := range items {
						if row, ok := item.(map[string]any); ok {
							walk(field.ItemFields, row)
						}
					}
				case []map[string]any:
					for _, row := range items {
						walk(field.ItemFields, row)
					}
				}
			}
		}
	}
	walk(fields, configuration)
	return ids
}
