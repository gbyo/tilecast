package server

import (
	"errors"
	"fmt"
	"testing"
)

func textFieldsSchema(count int) FormSchema {
	schema := FormSchema{Fields: []FormField{}}
	for i := 0; i < count; i++ {
		schema.Fields = append(schema.Fields, FormField{Key: fmt.Sprintf("field%d", i), Label: "Field", Control: ControlShortText})
	}
	return schema
}

func TestDefaultViewFieldKeysStayWithinPlayerLimit(t *testing.T) {
	// 11 ordinary fields plus six synthetic fields is 17 output fields.
	if got := len(outputFieldSpecs(textFieldsSchema(11))); got != 17 {
		t.Fatalf("expected 17 output fields, got %d", got)
	}
	keys := defaultViewFieldKeys(textFieldsSchema(11))
	if len(keys) != maxViewOutputFields {
		t.Fatalf("default view exposes %d fields, want %d", len(keys), maxViewOutputFields)
	}
	if keys[0] != "field0" || keys[10] != "field10" {
		t.Fatalf("form fields must come first, got %v", keys)
	}
	if small := defaultViewFieldKeys(textFieldsSchema(2)); len(small) != 8 {
		t.Fatalf("a small form keeps every field, got %d", len(small))
	}
}

func TestCheckViewFieldCount(t *testing.T) {
	cases := []struct {
		name                string
		selected, available int
		wantErr             bool
	}{
		{"explicit selection at the limit", 16, 40, false},
		{"explicit selection over the limit", 17, 40, true},
		{"empty selection with few fields", 0, 16, false},
		{"empty selection over the limit", 0, 17, true},
	}
	for _, tc := range cases {
		err := checkViewFieldCount(tc.selected, tc.available)
		if tc.wantErr != (err != nil) {
			t.Fatalf("%s: got %v, wantErr=%v", tc.name, err, tc.wantErr)
		}
		if err != nil && !errors.Is(err, ErrValidation) {
			t.Fatalf("%s: error must wrap ErrValidation, got %v", tc.name, err)
		}
	}
}
