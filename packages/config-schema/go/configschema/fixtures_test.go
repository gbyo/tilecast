package configschema

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// The fixtures in packages/config-schema/testdata are shared with the
// TypeScript half, so both validators accept and refuse the same documents.

type schemaFixture struct {
	Name    string  `json:"name"`
	Profile Profile `json:"profile"`
	Valid   bool    `json:"valid"`
	Fields  []Field `json:"fields"`
}

type valueFixture struct {
	Name   string         `json:"name"`
	Fields []Field        `json:"fields"`
	Input  map[string]any `json:"input"`
	Valid  bool           `json:"valid"`
	Output map[string]any `json:"output"`
}

func readFixtures(t *testing.T, name string, out any) {
	t.Helper()
	data, err := os.ReadFile("../../testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatal(err)
	}
}

func TestSchemaFixtures(t *testing.T) {
	var fixtures []schemaFixture
	readFixtures(t, "schemas.json", &fixtures)
	if len(fixtures) < 10 {
		t.Fatalf("only %d schema fixtures", len(fixtures))
	}
	for _, fixture := range fixtures {
		err := ValidateFields(fixture.Fields, fixture.Profile)
		if fixture.Valid && err != nil {
			t.Errorf("%s: unexpected error %v", fixture.Name, err)
		}
		if !fixture.Valid && err == nil {
			t.Errorf("%s: accepted an invalid schema", fixture.Name)
		}
	}
}

func TestValueFixtures(t *testing.T) {
	var fixtures []valueFixture
	readFixtures(t, "values.json", &fixtures)
	for _, fixture := range fixtures {
		if err := ValidateFields(fixture.Fields, ProfilePlugin); err != nil {
			t.Fatalf("%s: fixture schema is invalid: %v", fixture.Name, err)
		}
		output, err := Normalize(context.Background(), fixture.Fields, fixture.Input, nil)
		if !fixture.Valid {
			if err == nil {
				t.Errorf("%s: accepted invalid values %v", fixture.Name, output)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: unexpected error %v", fixture.Name, err)
			continue
		}
		if got, want := canonical(t, output), canonical(t, fixture.Output); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v, want %v", fixture.Name, got, want)
		}
	}
}

func canonical(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestNormalizeSecret(t *testing.T) {
	field := Field{Key: "token", Label: "Token", Control: ControlSecret, MaxLength: 8}
	if _, err := NormalizeSecret(field, ""); err == nil {
		t.Fatal("empty secret accepted")
	}
	if _, err := NormalizeSecret(field, "123456789"); err == nil {
		t.Fatal("oversized secret accepted")
	}
	if value, err := NormalizeSecret(field, " a b "); err != nil || value != " a b " {
		t.Fatalf("secret was changed: %q %v", value, err)
	}
	if _, err := NormalizeSecret(Field{Key: "a", Label: "A", Control: "text"}, "x"); err == nil {
		t.Fatal("a text field accepted a secret")
	}
}

func TestPersonalFieldsAndValues(t *testing.T) {
	fields := []Field{
		{Key: "who", Label: "Who", Control: "text", Personal: &Personal{RetentionDays: 7}},
		{Key: "rows", Label: "Rows", Control: "repeating_group", MaximumItems: 2, ItemFields: []Field{
			{Key: "phone", Label: "Phone", Control: "text", Personal: &Personal{RetentionDays: 1}},
			{Key: "imageAssetId", Label: "Image", Control: "media_asset"},
		}},
		{Key: "font", Label: "Font", Control: "font"},
	}
	personal := PersonalFields(fields)
	if len(personal) != 2 || personal["who"].RetentionDays != 7 || personal["rows.phone"].RetentionDays != 1 {
		t.Fatalf("personal fields %v", personal)
	}
	values := map[string]any{"font": "0a8f2b5e-7c1d-4e3f-9a6b-1c2d3e4f5a6b", "rows": []any{
		map[string]any{"imageAssetId": "1a8f2b5e-7c1d-4e3f-9a6b-1c2d3e4f5a6b"},
		map[string]any{"imageAssetId": "1a8f2b5e-7c1d-4e3f-9a6b-1c2d3e4f5a6b"},
	}}
	if got := MediaAssetValues(fields, values); len(got) != 1 {
		t.Fatalf("media values %v", got)
	}
	if got := FontValues(fields, values); len(got) != 1 {
		t.Fatalf("font values %v", got)
	}
}
