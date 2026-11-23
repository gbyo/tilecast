package plugins

import (
	"reflect"
	"testing"

	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
)

func fingerprintBase() []configschema.Field {
	low, high := 1.0, 10.0
	return []configschema.Field{
		{Key: "message", Label: "Message", Control: "text", Required: true, MinLength: 1, MaxLength: 200},
		{Key: "count", Label: "Count", Control: "integer", Minimum: &low, Maximum: &high, Default: 3.0},
		{Key: "level", Label: "Level", Control: "select", Options: []configschema.SelectOption{
			{Value: "info", Label: "Info"}, {Value: "warning", Label: "Warning"},
		}},
		{Key: "tags", Label: "Tags", Control: "string_list", MaximumItems: 5},
	}
}

// The hash of the canonical form is pinned. A change to the form must bump
// eventFingerprintFormat, because installations store these hashes.
func TestEventFingerprintIsPinned(t *testing.T) {
	const want = "2a26d217cb1b8066743fd5c907b4981d3ded62f4fe1267449eeb1eac65ed60be"
	if got := eventFingerprint(fingerprintBase()); got != want {
		t.Fatalf("fingerprint = %s; a changed canonical form needs a new eventFingerprintFormat", got)
	}
}

// Presentation can change under the same event version.
func TestEventFingerprintIgnoresPresentation(t *testing.T) {
	base := eventFingerprint(fingerprintBase())
	for name, change := range map[string]func([]configschema.Field){
		"label":           func(f []configschema.Field) { f[0].Label = "Text" },
		"label key":       func(f []configschema.Field) { f[0].LabelKey = "events.message" },
		"description":     func(f []configschema.Field) { f[0].Description = "What happened." },
		"description key": func(f []configschema.Field) { f[0].DescriptionKey = "events.messageHelp" },
		"ui hint":         func(f []configschema.Field) { f[0].UI = map[string]any{"placeholder": "Hello"} },
		"option label":    func(f []configschema.Field) { f[2].Options[0].Label = "Information" },
		"option label key": func(f []configschema.Field) {
			f[2].Options[0].LabelKey = "events.info"
		},
		"option order": func(f []configschema.Field) { f[2].Options[0], f[2].Options[1] = f[2].Options[1], f[2].Options[0] },
		"field order":  func(f []configschema.Field) { f[0], f[3] = f[3], f[0] },
	} {
		fields := fingerprintBase()
		change(fields)
		if got := eventFingerprint(fields); got != base {
			t.Errorf("%s changed the fingerprint", name)
		}
	}
}

// Anything that changes which payloads are accepted, or what a subscriber
// receives, is a new event version.
func TestEventFingerprintTracksValidation(t *testing.T) {
	base := eventFingerprint(fingerprintBase())
	two, twenty := 2.0, 20.0
	for name, change := range map[string]func([]configschema.Field) []configschema.Field{
		"key":          func(f []configschema.Field) []configschema.Field { f[0].Key = "text"; return f },
		"control":      func(f []configschema.Field) []configschema.Field { f[0].Control = "multiline_text"; return f },
		"required":     func(f []configschema.Field) []configschema.Field { f[0].Required = false; return f },
		"default":      func(f []configschema.Field) []configschema.Field { f[1].Default = 4.0; return f },
		"no default":   func(f []configschema.Field) []configschema.Field { f[1].Default = nil; return f },
		"minimum":      func(f []configschema.Field) []configschema.Field { f[1].Minimum = &two; return f },
		"maximum":      func(f []configschema.Field) []configschema.Field { f[1].Maximum = &twenty; return f },
		"min length":   func(f []configschema.Field) []configschema.Field { f[0].MinLength = 2; return f },
		"max length":   func(f []configschema.Field) []configschema.Field { f[0].MaxLength = 100; return f },
		"option value": func(f []configschema.Field) []configschema.Field { f[2].Options[1].Value = "warn"; return f },
		"option added": func(f []configschema.Field) []configschema.Field {
			f[2].Options = append(f[2].Options, configschema.SelectOption{Value: "error", Label: "Error"})
			return f
		},
		"maximum items": func(f []configschema.Field) []configschema.Field { f[3].MaximumItems = 6; return f },
		"field added": func(f []configschema.Field) []configschema.Field {
			return append(f, configschema.Field{Key: "extra", Label: "Extra", Control: "boolean"})
		},
		"field removed": func(f []configschema.Field) []configschema.Field { return f[1:] },
		"item fields": func(f []configschema.Field) []configschema.Field {
			f[3].ItemFields = []configschema.Field{{Key: "name", Label: "Name", Control: "text"}}
			return f
		},
	} {
		if got := eventFingerprint(change(fingerprintBase())); got == base {
			t.Errorf("%s did not change the fingerprint", name)
		}
	}
}

// Every property of configschema.Field is classified. A new property fails
// this test until it is placed in eventFieldShape or named presentation.
func TestEventFingerprintClassifiesEveryFieldProperty(t *testing.T) {
	presentation := map[string]bool{
		"Label": true, "LabelKey": true, "Description": true, "DescriptionKey": true, "UI": true,
		// The event profile refuses these controls and markers; on the
		// scalar controls it accepts, normalization does not read them.
		"AcceptedDataSourceKinds": true, "RequiredFields": true, "DataSourceFieldTypes": true,
		"DataSourceKey": true, "MediaTypes": true, "Personal": true, "Connections": true,
	}
	shape := map[string]bool{}
	shapeType := reflect.TypeOf(eventFieldShape{})
	for i := 0; i < shapeType.NumField(); i++ {
		shape[shapeType.Field(i).Name] = true
	}
	fieldType := reflect.TypeOf(configschema.Field{})
	for i := 0; i < fieldType.NumField(); i++ {
		name := fieldType.Field(i).Name
		if presentation[name] == shape[name] {
			t.Errorf("configschema.Field.%s must be either in eventFieldShape or listed as presentation", name)
		}
	}
	optionType := reflect.TypeOf(configschema.SelectOption{})
	for i := 0; i < optionType.NumField(); i++ {
		if name := optionType.Field(i).Name; name != "Value" && name != "Label" && name != "LabelKey" {
			t.Errorf("configschema.SelectOption.%s is not classified for event fingerprints", name)
		}
	}
}
