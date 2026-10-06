package media

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func stringListSchema() contentdefs.ConfigurationSchema {
	return contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
		{Key: "hosts", Label: "Hosts", Control: "string_list", MaximumItems: 3, MaxLength: 12},
	}}
}

func TestStringListNormalizesTrimmedEntries(t *testing.T) {
	normalizer := definitionConfigNormalizer{schema: stringListSchema()}
	got, err := normalizer.Normalize(context.Background(), json.RawMessage(`{"hosts":[" a.example ","","b.example"]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"hosts": []string{"a.example", "b.example"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestStringListRejectsInvalidValues(t *testing.T) {
	normalizer := definitionConfigNormalizer{schema: stringListSchema()}
	for name, raw := range map[string]string{
		"not a list":    `{"hosts":"a.example"}`,
		"non-text item": `{"hosts":[1]}`,
		"too many":      `{"hosts":["a","b","c","d"]}`,
		"too long":      `{"hosts":["a-very-long-host.example"]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := normalizer.Normalize(context.Background(), json.RawMessage(raw)); err == nil || !strings.Contains(err.Error(), "Hosts") {
				t.Fatalf("expected a Hosts error, got %v", err)
			}
		})
	}
}
