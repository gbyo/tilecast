package plugins

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
)

// eventFingerprintFormat versions the canonical form below. A change to the
// form is a new format, never a silent change to the hash of a stored
// schema.
const eventFingerprintFormat = 1

// eventFieldShape is the part of one payload field that decides which
// payloads events.publish@1 accepts and what a subscriber receives: the
// properties that configschema.Normalize reads, other than the label it
// puts in error text. Labels, descriptions, translation keys, option labels,
// and UI hints are presentation. A plugin may change them under the same
// event version.
type eventFieldShape struct {
	Key      string `json:"key"`
	Control  string `json:"control"`
	Required bool   `json:"required"`
	// Default fills an omitted value, so it changes the delivered payload.
	Default      any               `json:"default,omitempty"`
	Minimum      *float64          `json:"minimum,omitempty"`
	Maximum      *float64          `json:"maximum,omitempty"`
	MinLength    int               `json:"minLength,omitempty"`
	MaxLength    int               `json:"maxLength,omitempty"`
	Options      []string          `json:"options,omitempty"`
	MaximumItems int               `json:"maximumItems,omitempty"`
	ItemFields   []eventFieldShape `json:"itemFields,omitempty"`
}

// eventFingerprint is the SHA-256 of the canonical JSON of the payload
// shape of an event schema. A payload is a JSON object and a select value
// is checked by membership, so fields are sorted by key and options by
// value: reordering either is not a schema change.
func eventFingerprint(fields []configschema.Field) string {
	encoded, _ := json.Marshal(struct {
		Format int               `json:"format"`
		Fields []eventFieldShape `json:"fields"`
	}{eventFingerprintFormat, eventShapes(fields)})
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func eventShapes(fields []configschema.Field) []eventFieldShape {
	out := make([]eventFieldShape, 0, len(fields))
	for _, field := range fields {
		shape := eventFieldShape{
			Key: field.Key, Control: field.Control, Required: field.Required, Default: field.Default,
			Minimum: field.Minimum, Maximum: field.Maximum, MinLength: field.MinLength, MaxLength: field.MaxLength,
			MaximumItems: field.MaximumItems,
		}
		for _, option := range field.Options {
			shape.Options = append(shape.Options, option.Value)
		}
		sort.Strings(shape.Options)
		if len(field.ItemFields) > 0 {
			shape.ItemFields = eventShapes(field.ItemFields)
		}
		out = append(out, shape)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}
