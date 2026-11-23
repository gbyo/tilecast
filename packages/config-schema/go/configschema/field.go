// Package configschema is the Server half of the Tilecast configuration
// schema: the field vocabulary that Widget definitions and Plugin Manifest
// API 3 plugins share (packages/config-schema). It owns the field model, the
// schema validator for each profile, and the authoritative value
// normalizer. The TypeScript half in ../../src mirrors every rule, and the
// fixtures in ../../testdata keep the two in agreement.
//
// The Player configuration schema (packages/settings-schema) is a different
// contract and does not use this package.
package configschema

import "strings"

// Profile names who uses a schema. The profiles share one vocabulary; the
// plugin profile adds the plugin-only controls and the personal marker.
type Profile string

const (
	// ProfileWidget is a Widget definition's configuration schema.
	ProfileWidget Profile = "widget"
	// ProfilePlugin is a Plugin Manifest API 3 settings or instance schema.
	ProfilePlugin Profile = "plugin"
)

// Controls every profile accepts.
var sharedControls = map[string]bool{
	"text": true, "multiline_text": true, "number": true, "integer": true,
	"boolean": true, "select": true, "color": true, "date": true,
	"datetime": true, "local_datetime": true, "time": true, "timezone": true,
	"currency_code": true, "url": true, "data_source": true,
	"data_source_field": true, "media_asset": true, "repeating_group": true,
	"string_list": true, "font": true, "weekdays": true,
}

// Plugin-only controls. A secret value is stored only through the secret
// store, never in configuration. A connection value is the ID of a
// host-owned connection record of the same plugin; Connections names the
// connection declarations the field accepts.
const (
	ControlSecret     = "secret"
	ControlConnection = "connection"
)

var pluginControls = map[string]bool{ControlSecret: true, ControlConnection: true}

// Controls lists every control a profile accepts.
func Controls(profile Profile) []string {
	out := make([]string, 0, len(sharedControls)+len(pluginControls))
	for control := range sharedControls {
		out = append(out, control)
	}
	if profile == ProfilePlugin {
		for control := range pluginControls {
			out = append(out, control)
		}
	}
	return out
}

// Supported reports whether a profile accepts a control.
func Supported(profile Profile, control string) bool {
	return sharedControls[control] || profile == ProfilePlugin && pluginControls[control]
}

// MaxFontFields bounds the organization library families one configuration
// may choose. It mirrors the Player Runtime bound on the fonts one component
// presentation declares, and the Player state bound on fonts per entry.
const MaxFontFields = 4

// MaxSecretBytes bounds one secret value. Secrets are tokens, passwords, and
// keys, not documents.
const MaxSecretBytes = 4096

// Retention bounds for a personal field, in days.
const (
	MinPersonalRetentionDays = 1
	MaxPersonalRetentionDays = 3650
)

// Schema is a list of fields.
type Schema struct {
	Fields []Field `json:"fields"`
}

// Field is one configuration field.
type Field struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	// LabelKey and DescriptionKey name Studio translation keys for Label and
	// Description. The literal text always stays the English source and the
	// fallback, so a client that does not know a key still has readable words.
	LabelKey                string            `json:"labelKey,omitempty"`
	Description             string            `json:"description,omitempty"`
	DescriptionKey          string            `json:"descriptionKey,omitempty"`
	Control                 string            `json:"control"`
	Required                bool              `json:"required,omitempty"`
	Default                 any               `json:"default,omitempty"`
	Minimum                 *float64          `json:"minimum,omitempty"`
	Maximum                 *float64          `json:"maximum,omitempty"`
	MinLength               int               `json:"minLength,omitempty"`
	MaxLength               int               `json:"maxLength,omitempty"`
	Options                 []SelectOption    `json:"options,omitempty"`
	AcceptedDataSourceKinds []string          `json:"acceptedDataSourceKinds,omitempty"`
	RequiredFields          map[string]string `json:"requiredFields,omitempty"`
	DataSourceFieldTypes    []string          `json:"dataSourceFieldTypes,omitempty"`
	// DataSourceKey names the data_source control whose selected source
	// supplies the field list for a data_source_field control. An explicit
	// key wins; a definition with exactly one data_source control may omit
	// it. Nested repeating-group controls may point at a root source.
	DataSourceKey string         `json:"dataSourceKey,omitempty"`
	MediaTypes    []string       `json:"mediaTypes,omitempty"`
	MaximumItems  int            `json:"maximumItems,omitempty"`
	ItemFields    []Field        `json:"itemFields,omitempty"`
	UI            map[string]any `json:"ui,omitempty"`
	// Personal marks a field that holds personal data. Plugin profile only.
	Personal *Personal `json:"personal,omitempty"`
	// Connections lists the connection declarations a connection field
	// accepts. Plugin profile, connection control only.
	Connections []string `json:"connections,omitempty"`
}

// MaxFieldConnections bounds the declarations one connection field accepts.
const MaxFieldConnections = 8

// ConnectionValues returns the top-level connection field values of a
// normalized document, keyed by field key.
func ConnectionValues(fields []Field, values map[string]any) map[string]string {
	out := map[string]string{}
	for _, field := range fields {
		if field.Control != ControlConnection {
			continue
		}
		if text, ok := values[field.Key].(string); ok && text != "" {
			out[field.Key] = text
		}
	}
	return out
}

// SelectOption is one select choice.
type SelectOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
	// LabelKey names the Studio translation key for Label.
	LabelKey string `json:"labelKey,omitempty"`
}

// Personal is the personal-data declaration of one field. The host keeps
// the value for at most RetentionDays after its last write. The retention
// is a contract the host enforces as its storage features arrive; see
// docs/plugin-api-v3.md for what this release enforces.
type Personal struct {
	RetentionDays int `json:"retentionDays"`
}

// DerivedVariantKey maps a media_asset field key to the configuration key
// manifest projection writes its resolved variant under ("logoAssetId" gives
// "logoVariantId"). Other declared media fields append VariantId. The same
// alias rule applies in Studio.
func DerivedVariantKey(assetKey string) (string, bool) {
	if assetKey == "" {
		return "", false
	}
	return strings.TrimSuffix(assetKey, "AssetId") + "VariantId", true
}

// SecretKeys returns the top-level secret field keys in schema order.
func SecretKeys(fields []Field) []string {
	keys := []string{}
	for _, field := range fields {
		if field.Control == ControlSecret {
			keys = append(keys, field.Key)
		}
	}
	return keys
}

// Lookup returns a top-level field by key.
func Lookup(fields []Field, key string) (Field, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field, true
		}
	}
	return Field{}, false
}

// PersonalFields returns every field, at any depth, that declares personal
// data, with its dotted path.
func PersonalFields(fields []Field) map[string]Personal {
	out := map[string]Personal{}
	var walk func([]Field, string)
	walk = func(fields []Field, prefix string) {
		for _, field := range fields {
			if field.Personal != nil {
				out[prefix+field.Key] = *field.Personal
			}
			if field.Control == "repeating_group" {
				walk(field.ItemFields, prefix+field.Key+".")
			}
		}
	}
	walk(fields, "")
	return out
}
