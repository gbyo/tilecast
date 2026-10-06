package contentdefs

import (
	"strings"
	"testing"
)

// Studio has one Widget editor. A definition that cannot describe itself
// declaratively would need a provider-specific editor, which no longer
// exists, so the shipped catalog (core definitions, Widget modules, and
// bundled plugin Widgets) must satisfy the authoring contract.
func TestEveryCatalogWidgetSatisfiesTheAuthoringContract(t *testing.T) {
	for _, definition := range MustLoad().Widgets {
		if problem := AuthoringProblem(definition); problem != "" {
			t.Errorf("Widget definition %q %s", definition.ID, problem)
		}
	}
}

func TestAuthoringProblemRejectsUndescribedDefinitions(t *testing.T) {
	disabled := false
	field := []FieldDefinition{{Key: "url", Label: "URL", Control: "url"}}
	cases := map[string]struct {
		definition WidgetDefinition
		want       string
	}{
		"componentless native": {
			WidgetDefinition{ID: "a", Runtime: "native", ConfigurationSchema: ConfigurationSchema{Fields: []FieldDefinition{{Key: "text", Control: "text"}}}},
			"without a component",
		},
		"schemaless web": {
			WidgetDefinition{ID: "c", Runtime: "web", LegacyEditor: true},
			`"url" address field`,
		},
		"web without a contract": {
			WidgetDefinition{ID: "d", Runtime: "web", ConfigurationSchema: ConfigurationSchema{Fields: field}},
			"without a webIntegration contract",
		},
		"web without its address field": {
			WidgetDefinition{ID: "e", Runtime: "web", WebIntegration: &WebIntegration{URLField: "address"}, ConfigurationSchema: ConfigurationSchema{Fields: field}},
			`"address" address field`,
		},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			if got := AuthoringProblem(test.definition); !strings.Contains(got, test.want) {
				t.Fatalf("got %q, want it to contain %q", got, test.want)
			}
		})
	}
	unavailable := WidgetDefinition{ID: "f", Runtime: "web", Availability: Availability{Enabled: &disabled, Reason: "Retired."}}
	if got := AuthoringProblem(unavailable); got != "" {
		t.Fatalf("a disabled definition is exempt, got %q", got)
	}
	settingless := WidgetDefinition{ID: "b", Runtime: "native", Component: &ComponentSpec{Type: "example.b"}}
	if got := AuthoringProblem(settingless); got != "" {
		t.Fatalf("a component Widget without settings is authorable, got %q", got)
	}
	legacyWeb := WidgetDefinition{ID: "g", Runtime: "web", LegacyEditor: true, ConfigurationSchema: ConfigurationSchema{Fields: field}}
	if got := AuthoringProblem(legacyWeb); got != "" {
		t.Fatalf("a server-validated web integration with a url field is authorable, got %q", got)
	}
}
