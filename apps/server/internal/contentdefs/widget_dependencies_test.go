package contentdefs

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestWidgetDataSourceIDsFollowOnlyDeclaredDependencies(t *testing.T) {
	first, second, decoy := uuid.New(), uuid.New(), uuid.New()
	catalog := &Catalog{widgetsByID: map[string]WidgetDefinition{
		"nested": {ConfigurationSchema: ConfigurationSchema{Fields: []FieldDefinition{
			{Key: "title", Control: "text"},
			{Key: "sections", Control: "repeating_group", ItemFields: []FieldDefinition{
				{Key: "source", Control: "data_source"},
				{Key: "rows", Control: "repeating_group", ItemFields: []FieldDefinition{{Key: "source", Control: "data_source"}}},
			}},
		}}},
	}}
	raw, _ := json.Marshal(map[string]any{"title": decoy.String(), "dataSourceId": decoy.String(),
		"sections": []any{
			map[string]any{"source": first.String(), "rows": []any{map[string]any{"source": second.String()}}},
			map[string]any{"source": first.String()},
			map[string]any{"source": "invalid"},
			map[string]any{"source": uuid.Nil.String()},
		}})
	if got := catalog.WidgetDataSourceIDs("nested", raw); !reflect.DeepEqual(got, []uuid.UUID{first, second}) {
		t.Fatalf("dependencies = %v", got)
	}
	if got := catalog.WidgetDataSourceIDs("nested", json.RawMessage(`{`)); len(got) != 0 {
		t.Fatalf("invalid configuration produced dependencies: %v", got)
	}
}

func TestWidgetDataSourceIDsKeepRecipeAndLegacyContracts(t *testing.T) {
	source, unrelated := uuid.New(), uuid.New()
	catalog := MustLoad()
	raw, _ := json.Marshal(map[string]string{"managedDataSourceId": source.String(), "title": unrelated.String()})
	if got := catalog.WidgetDataSourceIDs("espn", raw); !reflect.DeepEqual(got, []uuid.UUID{source}) {
		t.Fatalf("recipe dependency = %v", got)
	}
	raw, _ = json.Marshal(map[string]string{"dataSourceId": source.String(), "imageAssetId": unrelated.String()})
	if got := catalog.WidgetDataSourceIDs("agenda", raw); !reflect.DeepEqual(got, []uuid.UUID{source}) {
		t.Fatalf("legacy dependency = %v", got)
	}
	if got := catalog.WidgetDataSourceIDs("text", raw); len(got) != 0 {
		t.Fatalf("unrelated legacy fields became source dependencies: %v", got)
	}
}
