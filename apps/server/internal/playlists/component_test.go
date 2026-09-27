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
		ID: "probe", Version: 1, APIVersion: 1, Name: "Probe", Category: "Test", Runtime: "native",
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
	fallback, err := service.compileWidgetPresentationForPreset("probe", &preset, raw, false)
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

// TestLegacyQrProvidersProjectIntoQrCode keeps every persisted QR provider
// generation compiling into the one V2 component: the legacy qrcode keys,
// the call-to-action keys, and the canonical QR Code keys all normalize to
// tilecast.qr-code configuration for capable Players.
func TestLegacyQrProvidersProjectIntoQrCode(t *testing.T) {
	service := &Service{definitions: contentdefs.MustLoad()}
	legacy := json.RawMessage(`{"value":"https://example.org","label":"example.org","errorCorrection":"medium","foregroundColor":"#000000","backgroundColor":"#FFFFFF"}`)
	component, err := service.compileWidgetComponent("qrcode", legacy)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.qr-code" || component.Component.Config["payload"] != "https://example.org" || component.Component.Config["shortLabel"] != "example.org" {
		t.Fatalf("legacy qrcode config did not project: %+v", component.Component)
	}
	callToAction := json.RawMessage(`{"url":"https://example.org","heading":"Scan","body":"Point your camera.","showBody":true,"foregroundColor":"#ffffff","backgroundColor":"#12253a"}`)
	component, err = service.compileWidgetComponent("qr-call-to-action", callToAction)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.qr-code" || component.Component.Config["payload"] != "https://example.org" || component.Component.Config["heading"] != "Scan" || component.Component.Config["instruction"] != "Point your camera." {
		t.Fatalf("call-to-action config did not project: %+v", component.Component)
	}
	canonical := json.RawMessage(`{"payload":"https://example.org","heading":"","instruction":"","shortLabel":"","style":"standard","backgroundColor":"#FFFFFF","foregroundColor":"#101418"}`)
	component, err = service.compileWidgetComponent("qr-code", canonical)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.qr-code" || component.RequiredCapabilities["widget.tilecast.qr-code"] != 1 {
		t.Fatalf("canonical qr-code config did not compile: %+v", component)
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
