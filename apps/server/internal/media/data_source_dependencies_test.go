package media

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestWidgetSourceUsageFollowsNestedCanonicalIDs(t *testing.T) {
	target, other := uuid.New(), uuid.New()
	fields := []contentdefs.FieldDefinition{
		{
			Key:     "groups",
			Control: "repeating_group",
			ItemFields: []contentdefs.FieldDefinition{
				{Key: "label", Label: "Label", Control: "text"},
				{Key: "source", Label: "Source", Control: "data_source"},
			},
		},
	}
	fields[0].Label = "Groups"
	fields[0].MaximumItems = 4
	definition := pluginWidgetCatalog(t).Widgets[0]
	definition.ConfigurationSchema.Fields = fields
	definition.DefaultConfiguration = map[string]any{}
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{definition}, nil)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{definitions: catalog}
	configuration := map[string]any{
		"groups": []any{
			map[string]any{"label": "First", "source": other.String()},
			map[string]any{"label": "Second", "source": strings.ToUpper(target.String())},
		},
	}

	raw, _ := json.Marshal(configuration)
	if !service.widgetConfigurationReferencesDataSource(definition.ID, raw, nil, target) {
		t.Fatal("nested data_source control was not discovered")
	}
	if service.widgetConfigurationReferencesDataSource(definition.ID, raw, nil, uuid.New()) {
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
