package media

import (
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestFieldsReferenceDataSourceRecursesIntoRepeatingGroups(t *testing.T) {
	fields := []contentdefs.FieldDefinition{
		{
			Key:     "groups",
			Control: "repeating_group",
			ItemFields: []contentdefs.FieldDefinition{
				{Key: "label", Control: "text"},
				{Key: "source", Control: "data_source"},
			},
		},
	}
	configuration := map[string]any{
		"groups": []any{
			map[string]any{"label": "First", "source": "other-source"},
			map[string]any{"label": "Second", "source": "target-source"},
		},
	}

	if !fieldsReferenceDataSource(fields, configuration, "target-source") {
		t.Fatal("nested data_source control was not discovered")
	}
	if fieldsReferenceDataSource(fields, configuration, "missing-source") {
		t.Fatal("unreferenced Data Source was reported as a dependency")
	}
}

func TestLegacyDependencyFallbackRecursesButRequiresExactString(t *testing.T) {
	configuration := map[string]any{
		"nested":      []any{map[string]any{"source": "target-source"}},
		"description": "target-source is mentioned in prose",
	}
	if !jsonValueContainsExactString(configuration, "target-source") {
		t.Fatal("legacy nested source was not discovered")
	}
	if jsonValueContainsExactString(configuration, "target") {
		t.Fatal("legacy fallback must not use substring matching")
	}
}
