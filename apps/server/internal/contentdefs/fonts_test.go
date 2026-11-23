package contentdefs

import (
	"reflect"
	"testing"

	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
)

func TestFontFieldsStayTopLevelAndBounded(t *testing.T) {
	font := func(key string) FieldDefinition {
		return FieldDefinition{Key: key, Label: key, Control: "font", Default: ""}
	}
	if err := validateSchema(ConfigurationSchema{Fields: []FieldDefinition{font("a"), font("b"), font("c"), font("d")}}); err != nil {
		t.Fatalf("four font fields: %v", err)
	}
	if err := validateSchema(ConfigurationSchema{Fields: []FieldDefinition{font("a"), font("b"), font("c"), font("d"), font("e")}}); err == nil {
		t.Fatal("five font fields were accepted")
	}
	nested := FieldDefinition{Key: "rows", Control: "repeating_group", MaximumItems: 2, ItemFields: []FieldDefinition{font("a")}}
	if err := validateSchema(ConfigurationSchema{Fields: []FieldDefinition{nested}}); err == nil {
		t.Fatal("a font field inside a repeating group was accepted")
	}
	withDefault := font("a")
	withDefault.Default = "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f"
	if err := validateSchema(ConfigurationSchema{Fields: []FieldDefinition{withDefault}}); err == nil {
		t.Fatal("a font field with a family default was accepted")
	}
}

func TestFontFieldValuesNormalizeAndSkipInvalid(t *testing.T) {
	fields := []FieldDefinition{
		{Key: "heading", Control: "font"},
		{Key: "body", Control: "font"},
		{Key: "caption", Control: "font"},
		{Key: "label", Control: "text"},
	}
	got := FontFieldValues(fields, map[string]any{
		"heading": "5C0A2F8E-3C1B-4D2A-9E7F-0A1B2C3D4E5F",
		"body":    "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f",
		"caption": "Inter",
		"label":   "1f8f2d8e-1b1a-4c55-9a0d-3d2f6c7b8a90",
	})
	if want := []string{"5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("FontFieldValues = %v, want %v", got, want)
	}
}

// A Widget schema uses the widget profile of the configuration schema. The
// plugin-only controls and the personal marker are refused by the validator,
// not by the Widget editor's good behavior.
func TestWidgetSchemaRefusesPluginOnlySemantics(t *testing.T) {
	for name, field := range map[string]FieldDefinition{
		"secret":     {Key: "token", Label: "Token", Control: "secret"},
		"connection": {Key: "service", Label: "Service", Control: "connection"},
		"personal":   {Key: "who", Label: "Who", Control: "text", Personal: &configschema.Personal{RetentionDays: 7}},
	} {
		if err := validateSchema(ConfigurationSchema{Fields: []FieldDefinition{field}}); err == nil {
			t.Errorf("a Widget schema accepted %s", name)
		}
	}
	if err := validateSchema(ConfigurationSchema{Fields: []FieldDefinition{{Key: "title", Label: "Title", Control: "text"}}}); err != nil {
		t.Fatal(err)
	}
}
