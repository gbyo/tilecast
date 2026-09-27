package playlists

import (
	"encoding/json"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// componentOnlyCatalog holds one Widget whose component has no compatibility
// presentation, as a V2-only Widget from a later release would.
func componentOnlyCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{{
		ID: "probe", Version: 1, Name: "Probe", Category: "Test", Runtime: "native",
		PresentationSchemaVersion: 1,
		RequiredCapabilities:      map[string]int{"content.text": 1},
		EmptyStateBehavior:        "text",
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "title", Label: "Title", Control: "text"},
			{Key: "source", Label: "Source", Control: "data_source"},
		}},
		DefaultConfiguration: map[string]any{},
		Component: &contentdefs.ComponentSpec{
			Type: "tilecast.probe", Version: 3, TagName: "tc-widget-probe",
			Entrypoint: "./runtime/index.ts", Empty: "render",
			ConfigTemplate:   json.RawMessage(`{"title":{"$config":"title","default":"Untitled"}}`),
			DataSourceFields: []string{"source"},
		},
		Compatibility: &contentdefs.Compatibility{Fallback: "none"},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestComponentOnlyWidgetCompilesWithoutFallback(t *testing.T) {
	service := &Service{definitions: componentOnlyCatalog(t)}
	raw := json.RawMessage(`{"title":"Lobby","source":"6f5f2f7e-1c1a-4e8e-9b61-3a2d8d2f1c10"}`)
	preset := "leaderboard"
	// A preset on a Widget without a compatibility presentation must not
	// dereference the missing native tree.
	fallback, err := service.compileWidgetPresentationForPreset("probe", &preset, raw)
	if err != nil || fallback != nil {
		t.Fatalf("fallback = %+v, err = %v", fallback, err)
	}
	component, err := service.compileWidgetComponent("probe", raw)
	if err != nil {
		t.Fatal(err)
	}
	if component.SchemaVersion != 2 || component.Kind != "component" || component.RequiredCapabilities["widget.tilecast.probe"] != 3 {
		t.Fatalf("unexpected component presentation: %+v", component)
	}
	if component.Component.Config["title"] != "Lobby" || len(component.Component.DataSources) != 1 {
		t.Fatalf("component did not compile its configuration and sources: %+v", component.Component)
	}
	// Only a well-formed Data Source ID becomes a grant.
	component, _ = service.compileWidgetComponent("probe", json.RawMessage(`{"source":"../../etc"}`))
	if len(component.Component.DataSources) != 0 || component.Component.Config["title"] != "Untitled" {
		t.Fatalf("unexpected grant or default: %+v", component.Component)
	}
}

func TestPresentationSupportedNeedsSchemaAndVersion(t *testing.T) {
	presentation := &WidgetPresentation{SchemaVersion: 2, Kind: "component", RequiredCapabilities: map[string]int{"widget.tilecast.clock": 2}}
	for _, test := range []struct {
		name   string
		player playerPresentationCapabilities
		want   bool
	}{
		{"not reported", playerPresentationCapabilities{}, false},
		{"schema 1 only", playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1}, Native: map[string]int{"widget.tilecast.clock": 2}}, false},
		{"older component", playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.tilecast.clock": 1}}, false},
		{"exact", playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.tilecast.clock": 2}}, true},
		{"newer", playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.tilecast.clock": 5}}, true},
	} {
		if got, _ := presentationSupported(presentation, test.player); got != test.want {
			t.Errorf("%s: supported = %v, want %v", test.name, got, test.want)
		}
	}
}
