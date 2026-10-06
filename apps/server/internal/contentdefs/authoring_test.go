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

func TestAuthoringProblemChecksTheRecommendedFrame(t *testing.T) {
	withFrame := func(width, height int) WidgetDefinition {
		return WidgetDefinition{
			ID: "strip", Runtime: "native", Component: &ComponentSpec{Type: "example.strip"},
			Authoring: &Authoring{Preview: AuthoringPreview{RecommendedFrame: &FrameSize{Width: width, Height: height}}},
		}
	}
	if got := AuthoringProblem(withFrame(1920, 160)); got != "" {
		t.Fatalf("a strip frame is valid, got %q", got)
	}
	for _, size := range [][2]int{{0, 160}, {1920, 0}, {31, 160}, {3841, 160}, {1920, -1}} {
		if got := AuthoringProblem(withFrame(size[0], size[1])); !strings.Contains(got, "recommended frame") {
			t.Errorf("frame %v: got %q, want a recommended frame problem", size, got)
		}
	}
}

// Translation keys are Studio resource paths. A malformed one would silently
// fall back to the English text, so the shipped catalog must keep them
// well-formed and paired with the literal fallback.
func TestCatalogTranslationKeysAreWellFormed(t *testing.T) {
	var check func(owner string, fields []FieldDefinition)
	check = func(owner string, fields []FieldDefinition) {
		for _, field := range fields {
			where := owner + "." + field.Key
			if field.LabelKey != "" && !translationKeyPattern.MatchString(field.LabelKey) {
				t.Errorf("%s labelKey %q is malformed", where, field.LabelKey)
			}
			if field.DescriptionKey != "" && (field.Description == "" || !translationKeyPattern.MatchString(field.DescriptionKey)) {
				t.Errorf("%s descriptionKey %q needs a literal description and a well-formed key", where, field.DescriptionKey)
			}
			if field.LabelKey != "" && field.Label == "" {
				t.Errorf("%s labelKey needs a literal label as the fallback", where)
			}
			for _, option := range field.Options {
				if option.LabelKey != "" && (option.Label == "" || !translationKeyPattern.MatchString(option.LabelKey)) {
					t.Errorf("%s option %q labelKey %q needs a literal label and a well-formed key", where, option.Value, option.LabelKey)
				}
			}
			check(where, field.ItemFields)
		}
	}
	for _, definition := range MustLoad().Widgets {
		check(definition.ID, definition.ConfigurationSchema.Fields)
	}
}
