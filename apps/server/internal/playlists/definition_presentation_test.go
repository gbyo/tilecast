package playlists

import (
	"encoding/json"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// TestEveryReleaseWidgetCompilesFromItsDefaults compiles every release-defined Widget in
// the embedded catalog using nothing but its own declared default configuration. It is the
// standing guard for declarative Widgets: a template that references a configuration key
// the schema does not supply a value for, uses a node the definition forgot to declare, or
// resolves to nothing at all fails here rather than at manifest generation on a screen.
func TestEveryReleaseWidgetCompilesFromItsDefaults(t *testing.T) {
	catalog := contentdefs.MustLoad()
	declarative := 0
	for _, definition := range catalog.Widgets {
		if definition.LegacyEditor {
			continue
		}
		declarative++
		t.Run(definition.ID, func(t *testing.T) {
			configuration := make(map[string]any, len(definition.DefaultConfiguration))
			for key, value := range definition.DefaultConfiguration {
				configuration[key] = value
			}
			if definition.Runtime == "web" && definition.WebIntegration != nil {
				host := "example.com"
				if len(definition.WebIntegration.AllowedHosts) > 0 {
					host = definition.WebIntegration.AllowedHosts[0]
				}
				path := definition.WebIntegration.RequiredPathPrefix
				switch definition.WebIntegration.Transform {
				case "google_sheets":
					path = "/spreadsheets/d/1234567890abcdef/edit"
				case "google_slides":
					path = "/presentation/d/1234567890abcdef/edit"
				case "canva_embed":
					path = "/design/1234567890abcdef/view"
				}
				configuration[definition.WebIntegration.URLField] = "https://" + host + path
				if definition.WebIntegration.AllowAnyHTTPSHost {
					configuration["trustedHost"] = host
				}
			}
			raw, err := json.Marshal(configuration)
			if err != nil {
				t.Fatal(err)
			}
			if definition.Component != nil && !definition.HasFallback() {
				presentation, err := (&Service{definitions: catalog}).compileWidgetComponent(definition.ID, raw)
				if err != nil || presentation == nil || presentation.Component == nil {
					t.Fatalf("compile component-only defaults: %+v, %v", presentation, err)
				}
				if presentation.RequiredCapabilities["widget."+definition.Component.Type] != definition.Component.Version {
					t.Fatalf("component capability missing: %+v", presentation.RequiredCapabilities)
				}
				return
			}
			presentation, err := compileDefinitionPresentation(definition, raw)
			if err != nil {
				t.Fatalf("compile from defaults: %v", err)
			}
			if definition.Runtime == "web" {
				if presentation.Kind != "web" || presentation.Web == nil {
					t.Fatalf("expected a web presentation, got %#v", presentation)
				}
				return
			}
			if presentation.Kind != "native" || presentation.Native == nil {
				t.Fatalf("expected a native presentation, got %#v", presentation)
			}
			if presentation.Native.Root.Type == "" {
				t.Fatal("compiled presentation has no root node type")
			}
			// The Player rejects a presentation requiring a capability it does not declare,
			// so every node the compiled tree actually contains must be covered.
			used := map[string]bool{}
			collectNodeTypes(&presentation.Native.Root, used)
			for nodeType := range used {
				capability := presentationNodeCapability(nodeType)
				if capability == "" {
					continue
				}
				if _, declared := presentation.RequiredCapabilities[capability]; !declared {
					t.Fatalf("compiled tree uses node %q without declaring capability %q", nodeType, capability)
				}
			}
		})
	}
	if declarative == 0 {
		t.Fatal("expected the embedded catalog to contain release-defined Widgets")
	}
}

// TestStandaloneReleaseWidgetCompilesWithoutADataSource proves the declarative path does
// not require a data_source control: a Widget whose bindings are entirely literal compiles
// to a complete tree. Studio's Essentials definitions depend on this.
func TestStandaloneReleaseWidgetCompilesWithoutADataSource(t *testing.T) {
	catalog := contentdefs.MustLoad()
	definition, ok := catalog.Widget("text-notice")
	if !ok {
		t.Fatal("text-notice definition is missing from the embedded catalog")
	}
	for _, field := range definition.ConfigurationSchema.Fields {
		if field.Control == "data_source" || field.Control == "data_source_field" {
			t.Fatalf("text-notice is expected to be standalone but declares %q", field.Control)
		}
	}
	raw, err := json.Marshal(map[string]any{
		"heading": "Early dismissal", "showHeading": true,
		"body": "Buses depart at 1:15 PM.", "align": "center", "bodyLines": 4,
		"foregroundColor": "#ffffff", "backgroundColor": "#12253a",
	})
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := compileDefinitionPresentation(definition, raw)
	if err != nil {
		t.Fatal(err)
	}
	texts := map[string]bool{}
	collectLiteralValues(&presentation.Native.Root, texts)
	if !texts["Early dismissal"] || !texts["Buses depart at 1:15 PM."] {
		t.Fatalf("literal bindings did not reach the compiled tree: %v", texts)
	}
}

// TestReleaseWidgetOmitsHiddenBranch confirms $ifConfig removes a branch rather than
// emitting an empty node, so turning a heading off actually removes it from the Player tree.
func TestReleaseWidgetOmitsHiddenBranch(t *testing.T) {
	definition, ok := contentdefs.MustLoad().Widget("text-notice")
	if !ok {
		t.Fatal("text-notice definition is missing")
	}
	raw, err := json.Marshal(map[string]any{
		"heading": "Hidden", "showHeading": false,
		"body": "Body only.", "align": "left", "bodyLines": 3,
		"foregroundColor": "#ffffff", "backgroundColor": "#12253a",
	})
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := compileDefinitionPresentation(definition, raw)
	if err != nil {
		t.Fatal(err)
	}
	texts := map[string]bool{}
	collectLiteralValues(&presentation.Native.Root, texts)
	if texts["Hidden"] {
		t.Fatal("heading branch was compiled even though showHeading is false")
	}
	if !texts["Body only."] {
		t.Fatal("body branch was dropped")
	}
}

// TestImageWidgetCompilesWithoutAProjectedVariant covers the derived-key contract: a Widget
// referencing a Server-derived configuration key still compiles before manifest projection
// has supplied one, so previewing an Image Notice does not fail.
func TestImageWidgetCompilesWithoutAProjectedVariant(t *testing.T) {
	definition, ok := contentdefs.MustLoad().Widget("image-notice")
	if !ok {
		t.Fatal("image-notice definition is missing")
	}
	raw, err := json.Marshal(map[string]any{
		"fit": "contain", "caption": "Library hours", "showCaption": true,
		"foregroundColor": "#ffffff", "backgroundColor": "#000000",
	})
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := compileDefinitionPresentation(definition, raw)
	if err != nil {
		t.Fatalf("compile without a projected variant: %v", err)
	}
	used := map[string]bool{}
	collectNodeTypes(&presentation.Native.Root, used)
	if !used["asset_image"] {
		t.Fatal("expected the compiled tree to retain its asset_image node")
	}
}

// TestNowAndNextSkipsTheFeaturedRecord checks that the upcoming list is compiled with a
// repeat offset, so the record featured above it is not repeated below.
func TestNowAndNextSkipsTheFeaturedRecord(t *testing.T) {
	definition, ok := contentdefs.MustLoad().Widget("now-and-next")
	if !ok {
		t.Fatal("now-and-next definition is missing")
	}
	raw, err := json.Marshal(definition.DefaultConfiguration)
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := compileDefinitionPresentation(definition, raw)
	if err != nil {
		t.Fatal(err)
	}
	repeat := findRepeat(&presentation.Native.Root)
	if repeat == nil {
		t.Fatal("expected a repeat node")
	}
	if repeat.Offset != 1 {
		t.Fatalf("expected the upcoming list to skip the featured record, got offset %d", repeat.Offset)
	}
	if repeat.Limit != 3 {
		t.Fatalf("expected the configured row count to reach the repeat, got limit %d", repeat.Limit)
	}
}

func TestScheduleBoardCompilesTemporalSelectorsAndCountdown(t *testing.T) {
	definition, ok := contentdefs.MustLoad().Widget("schedule-board")
	if !ok {
		t.Fatal("schedule-board definition is missing")
	}
	raw, err := json.Marshal(definition.DefaultConfiguration)
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := compileDefinitionPresentation(definition, raw)
	if err != nil {
		t.Fatal(err)
	}
	if presentation.RequiredCapabilities["selection.temporal"] != 1 {
		t.Fatalf("expected temporal selection capability, got %#v", presentation.RequiredCapabilities)
	}
	selectors := map[string]bool{}
	formats := map[string]bool{}
	collectTemporalPresentationFeatures(&presentation.Native.Root, selectors, formats)
	for _, selector := range []string{"current", "next", "upcoming"} {
		if !selectors[selector] {
			t.Fatalf("compiled Schedule Board is missing %q selection", selector)
		}
	}
	if !formats["relative-countdown"] {
		t.Fatal("compiled Schedule Board is missing its relative countdown")
	}
	fontSizes := map[int]bool{}
	collectNumericProps(&presentation.Native.Root, "fontSize", fontSizes)
	for _, size := range []int{18, 26, 42, 58} {
		if !fontSizes[size] {
			t.Fatalf("compiled Schedule Board is missing configured text size %d: %#v", size, fontSizes)
		}
	}
}

func TestScheduleBoardCanHideCountdownAndUpcomingTimeline(t *testing.T) {
	definition, ok := contentdefs.MustLoad().Widget("schedule-board")
	if !ok {
		t.Fatal("schedule-board definition is missing")
	}
	configuration := make(map[string]any, len(definition.DefaultConfiguration))
	for key, value := range definition.DefaultConfiguration {
		configuration[key] = value
	}
	configuration["showCountdown"] = false
	configuration["showUpcomingTimeline"] = false
	raw, err := json.Marshal(configuration)
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := compileDefinitionPresentation(definition, raw)
	if err != nil {
		t.Fatal(err)
	}
	used := map[string]bool{}
	collectNodeTypes(&presentation.Native.Root, used)
	if used["grid"] || used["divider"] {
		t.Fatalf("hidden upcoming timeline still compiled display nodes: %#v", used)
	}
	selectors := map[string]bool{}
	formats := map[string]bool{}
	collectTemporalPresentationFeatures(&presentation.Native.Root, selectors, formats)
	if formats["relative-countdown"] {
		t.Fatal("hidden countdown still compiled a relative countdown")
	}
}

func TestScheduleBoardEnablesAutoskipOnlyWhenConfigured(t *testing.T) {
	definition, ok := contentdefs.MustLoad().Widget("schedule-board")
	if !ok {
		t.Fatal("schedule-board definition is missing")
	}
	configuration := make(map[string]any, len(definition.DefaultConfiguration))
	for key, value := range definition.DefaultConfiguration {
		configuration[key] = value
	}
	configuration["autoSkipWhenEmpty"] = true
	raw, err := json.Marshal(configuration)
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := compileDefinitionPresentation(definition, raw)
	if err != nil {
		t.Fatal(err)
	}
	if presentation.RequiredCapabilities["playback.auto_skip"] != 1 {
		t.Fatalf("expected autoskip capability, got %#v", presentation.RequiredCapabilities)
	}
	if enabled, _ := presentation.Native.Root.Props["autoSkipWhenEmpty"].(bool); !enabled {
		t.Fatal("compiled presentation did not enable autoskip")
	}
	condition, ok := presentation.Native.Root.Props["emptyCondition"].(map[string]any)
	if !ok || condition["op"] != "empty" {
		t.Fatalf("compiled presentation has no empty condition: %#v", condition)
	}
}

func collectNodeTypes(node *PresentationNode, into map[string]bool) {
	into[node.Type] = true
	for index := range node.Children {
		collectNodeTypes(&node.Children[index], into)
	}
}

func collectTemporalPresentationFeatures(node *PresentationNode, selectors, formats map[string]bool) {
	if node.Binding != nil {
		selectors[node.Binding.Selector] = true
		formats[node.Binding.Format] = true
	}
	if node.Repeat != nil {
		selectors[node.Repeat.Selector] = true
	}
	if node.Condition != nil {
		selectors[node.Condition.Binding.Selector] = true
		formats[node.Condition.Binding.Format] = true
	}
	for index := range node.Children {
		collectTemporalPresentationFeatures(&node.Children[index], selectors, formats)
	}
}

func collectNumericProps(node *PresentationNode, key string, into map[int]bool) {
	if value, ok := node.Props[key].(float64); ok {
		into[int(value)] = true
	}
	for index := range node.Children {
		collectNumericProps(&node.Children[index], key, into)
	}
}

func collectLiteralValues(node *PresentationNode, into map[string]bool) {
	if node.Binding != nil && node.Binding.Source == "literal" {
		into[node.Binding.Value] = true
	}
	for index := range node.Children {
		collectLiteralValues(&node.Children[index], into)
	}
}

func findRepeat(node *PresentationNode) *PresentationRepeat {
	if node.Repeat != nil {
		return node.Repeat
	}
	for index := range node.Children {
		if found := findRepeat(&node.Children[index]); found != nil {
			return found
		}
	}
	return nil
}

// presentationNodeCapability mirrors the definition compiler's node-to-capability mapping.
func presentationNodeCapability(nodeType string) string {
	switch nodeType {
	case "surface", "box", "row", "column", "stack", "grid", "spacer", "divider":
		return "layout." + nodeType
	case "repeat", "conditional", "grouped_sections":
		return "collection." + nodeType
	case "text", "icon", "asset_image", "badge", "progress", "qr_code", "marquee",
		"line_chart", "bar_chart", "donut_chart":
		return "content." + nodeType
	default:
		return ""
	}
}
