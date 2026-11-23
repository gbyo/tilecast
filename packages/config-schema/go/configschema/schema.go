package configschema

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var connectionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// ValidateFields checks a schema for one profile. It is the authoritative
// shape check for Widget definitions (apps/server/internal/contentdefs) and
// for Plugin Manifest API 3 settings and instance schemas (the plugin SDK).
func ValidateFields(fields []Field, profile Profile) error {
	if profile != ProfileWidget && profile != ProfilePlugin && profile != ProfileEvent {
		return fmt.Errorf("unknown configuration profile %q", profile)
	}
	if err := validateLevel(fields, profile, 0); err != nil {
		return err
	}
	if err := validateFontFields(fields); err != nil {
		return err
	}
	return validateDataSourceKeys(fields)
}

func validateLevel(fields []Field, profile Profile, depth int) error {
	seen := map[string]bool{}
	for _, field := range fields {
		if field.Key == "" || seen[field.Key] {
			return errors.New("configuration schema contains a missing or duplicate field key")
		}
		seen[field.Key] = true
		if !Supported(profile, field.Control) {
			if pluginControls[field.Control] && profile != ProfileEvent {
				return fmt.Errorf("configuration schema uses the plugin-only control %q", field.Control)
			}
			return fmt.Errorf("configuration schema uses unsupported form control %q", field.Control)
		}
		if field.Personal != nil {
			if profile != ProfilePlugin {
				return fmt.Errorf("field %q uses the plugin-only personal marker", field.Key)
			}
			if field.Personal.RetentionDays < MinPersonalRetentionDays || field.Personal.RetentionDays > MaxPersonalRetentionDays {
				return fmt.Errorf("personal field %q must declare a retention between %d and %d days", field.Key, MinPersonalRetentionDays, MaxPersonalRetentionDays)
			}
		}
		if err := validateFieldBounds(field); err != nil {
			return err
		}
		switch field.Control {
		case "select":
			if len(field.Options) == 0 {
				return fmt.Errorf("select field %q has no options", field.Key)
			}
			if err := validateSelectDefault(field); err != nil {
				return err
			}
		case "time":
			if field.Default != nil {
				text, ok := field.Default.(string)
				if !ok {
					return fmt.Errorf("time field %q default must be HH:MM", field.Key)
				}
				if _, err := time.Parse("15:04", text); err != nil {
					return fmt.Errorf("time field %q default must be HH:MM", field.Key)
				}
			}
		case "weekdays":
			if field.Default != nil {
				if _, err := normalizeWeekdays(field.Default); err != nil {
					return fmt.Errorf("weekdays field %q default must be unique days from 0 through 6", field.Key)
				}
			}
		case ControlSecret, ControlConnection:
			if depth > 0 {
				return fmt.Errorf("%s field %q must be at the top level", field.Control, field.Key)
			}
			if field.Default != nil {
				return fmt.Errorf("%s field %q cannot declare a default", field.Control, field.Key)
			}
			if field.Control == ControlSecret && field.MaxLength > MaxSecretBytes {
				return fmt.Errorf("secret field %q allows more than %d bytes", field.Key, MaxSecretBytes)
			}
		}
		if field.Control == ControlConnection {
			if field.Personal != nil {
				// A connection value is a record ID, not personal data, and
				// a removed value would leave its reference behind.
				return fmt.Errorf("connection field %q cannot be personal", field.Key)
			}
			if len(field.Connections) < 1 || len(field.Connections) > MaxFieldConnections {
				return fmt.Errorf("connection field %q must accept 1 to %d connection declarations", field.Key, MaxFieldConnections)
			}
			seenConnections := map[string]bool{}
			for _, id := range field.Connections {
				if !connectionIDPattern.MatchString(id) || seenConnections[id] {
					return fmt.Errorf("connection field %q names an invalid or repeated connection %q", field.Key, id)
				}
				seenConnections[id] = true
			}
		} else if len(field.Connections) > 0 {
			return fmt.Errorf("field %q lists connections but is not a connection field", field.Key)
		}
		if field.Required {
			if text, ok := field.Default.(string); ok && strings.TrimSpace(text) == "" {
				return fmt.Errorf("required field %q declares an empty default", field.Key)
			}
		}
		if field.Control == "string_list" && (field.MaximumItems < 1 || field.MaximumItems > 100) {
			return fmt.Errorf("string list %q has invalid bounds", field.Key)
		}
		if field.Control == "repeating_group" {
			if field.MaximumItems < 1 || field.MaximumItems > 100 {
				return fmt.Errorf("repeating group %q has invalid bounds", field.Key)
			}
			if len(field.ItemFields) == 0 {
				return fmt.Errorf("repeating group %q declares no item fields", field.Key)
			}
			if err := validateLevel(field.ItemFields, profile, depth+1); err != nil {
				return err
			}
		}
	}
	derived := map[string]bool{}
	for _, field := range fields {
		if field.Control != "media_asset" {
			continue
		}
		key, _ := DerivedVariantKey(field.Key)
		if seen[key] || derived[key] {
			return fmt.Errorf("media_asset field %q derives configuration key %q that conflicts with another field", field.Key, key)
		}
		derived[key] = true
	}
	return nil
}

// validateFontFields keeps library font choices at the top level of a
// schema and within the per-component bound, so the families a
// configuration uses are a short static list the Server records and
// projects.
func validateFontFields(fields []Field) error {
	count := 0
	for _, field := range fields {
		switch field.Control {
		case "font":
			count++
			if text, ok := field.Default.(string); field.Default != nil && (!ok || text != "") {
				return fmt.Errorf("font field %q must default to empty", field.Key)
			}
		case "repeating_group":
			if hasFontField(field.ItemFields) {
				return fmt.Errorf("repeating group %q may not contain a font field", field.Key)
			}
		}
	}
	if count > MaxFontFields {
		return fmt.Errorf("configuration schema declares more than %d font fields", MaxFontFields)
	}
	return nil
}

func hasFontField(fields []Field) bool {
	for _, field := range fields {
		if field.Control == "font" || field.Control == "repeating_group" && hasFontField(field.ItemFields) {
			return true
		}
	}
	return false
}

// validateDataSourceKeys rejects a data_source_field whose explicit
// dataSourceKey does not name a data_source control in the same schema.
// Nested repeating-group controls may point at a root source, so keys are
// collected at every level before any reference is checked.
func validateDataSourceKeys(fields []Field) error {
	sources := map[string]bool{}
	var collect func(fields []Field)
	collect = func(fields []Field) {
		for _, field := range fields {
			if field.Control == "data_source" {
				sources[field.Key] = true
			}
			if field.Control == "repeating_group" && len(field.ItemFields) > 0 {
				collect(field.ItemFields)
			}
		}
	}
	collect(fields)
	var walk func(fields []Field) error
	walk = func(fields []Field) error {
		for _, field := range fields {
			if field.Control == "data_source_field" && field.DataSourceKey != "" && !sources[field.DataSourceKey] {
				return fmt.Errorf("field %q refers to unknown Data Source %q", field.Key, field.DataSourceKey)
			}
			if field.Control == "repeating_group" && len(field.ItemFields) > 0 {
				if err := walk(field.ItemFields); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(fields)
}

// validateFieldBounds rejects contradictory numeric and string bounds.
func validateFieldBounds(field Field) error {
	if field.Minimum != nil && field.Maximum != nil && *field.Minimum > *field.Maximum {
		return fmt.Errorf("field %q has a minimum greater than its maximum", field.Key)
	}
	if field.MinLength < 0 || field.MaxLength < 0 {
		return fmt.Errorf("field %q has a negative length bound", field.Key)
	}
	if field.MaxLength > 0 && field.MinLength > field.MaxLength {
		return fmt.Errorf("field %q has a minimum length greater than its maximum length", field.Key)
	}
	return nil
}

// validateSelectDefault rejects a select default that is not one of its
// options.
func validateSelectDefault(field Field) error {
	if field.Default == nil {
		return nil
	}
	value, ok := field.Default.(string)
	if !ok {
		return fmt.Errorf("select field %q default must be text", field.Key)
	}
	for _, option := range field.Options {
		if option.Value == value {
			return nil
		}
	}
	return fmt.Errorf("select field %q default is not one of its options", field.Key)
}
