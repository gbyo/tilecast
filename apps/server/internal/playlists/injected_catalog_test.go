package playlists

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// customCatalog builds an in-memory catalog with a single-source and a dual-source
// release-defined Widget plus a manual_object Data Source, none of which ship in the
// embedded default catalog. It proves the service reads the injected catalog rather than
// reloading the embedded default.
func customCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	template := json.RawMessage(`{"type":"surface","children":[{"type":"text","binding":{"source":"literal","value":{"$config":"heading"}}}]}`)
	widgets := []contentdefs.WidgetDefinition{
		{
			ID: "dual-source-banner", Version: 1, Name: "Dual Source Banner", Category: "Test",
			Runtime: "native", PresentationSchemaVersion: 1,
			RequiredCapabilities: map[string]int{"layout.surface": 1, "content.text": 1},
			RequiresManifestV13:  true,
			ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
				{Key: "heading", Label: "Heading", Control: "text"},
				{Key: "primarySource", Label: "Primary", Control: "data_source"},
				{Key: "secondarySource", Label: "Secondary", Control: "data_source"},
				{Key: "sourceRows", Label: "Source rows", Control: "repeating_group", MaximumItems: 6, ItemFields: []contentdefs.FieldDefinition{
					{Key: "source", Label: "Source", Control: "data_source"},
				}},
			}},
			DefaultConfiguration: map[string]any{},
			PresentationTemplate: template,
		},
	}
	sources := []contentdefs.DataSourceDefinition{
		{
			ID: "note-object", Version: 1, Name: "Note Object", Category: "Test",
			AdapterID:            "manual_object",
			RequiresManifestV13:  true,
			ConfigurationSchema:  contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{{Key: "headline", Label: "Headline", Control: "text"}}},
			DefaultConfiguration: map[string]any{},
			OutputSchema:         contentdefs.OutputSchema{Kind: "object", Fields: []contentdefs.OutputField{{Key: "headline", Label: "Headline", Type: "text"}}},
		},
	}
	catalog, err := contentdefs.New(widgets, sources)
	if err != nil {
		t.Fatalf("build custom catalog: %v", err)
	}
	return catalog
}

func TestInjectedCatalogDrivesCompilationAndDiscovery(t *testing.T) {
	catalog := customCatalog(t)
	service := &Service{definitions: catalog}

	// Compilation uses the injected catalog: a Widget defined only there compiles, and
	// one that exists only in the embedded default catalog is unknown here.
	presentation, err := service.compileWidgetPresentation("dual-source-banner", json.RawMessage(`{"heading":"Status"}`))
	if err != nil || presentation == nil || presentation.Native == nil {
		t.Fatalf("injected Widget did not compile: %v", err)
	}
	if _, err := service.compileWidgetPresentation("school-status-banner", json.RawMessage(`{}`)); err == nil {
		t.Fatal("embedded-only Widget compiled against the injected catalog")
	}

	// Dependency discovery uses the injected catalog and returns every data_source field.
	primary, secondary, nestedFirst, nestedSecond := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	config, _ := json.Marshal(map[string]any{
		"heading":         "Status",
		"primarySource":   primary.String(),
		"secondarySource": secondary.String(),
		"sourceRows": []any{
			map[string]any{"source": nestedFirst.String()},
			map[string]any{"source": nestedSecond.String()},
		},
	})
	ids := service.widgetDataSourceIDs("dual-source-banner", config)
	if len(ids) != 4 {
		t.Fatalf("expected four Data Source IDs, got %v", ids)
	}
	found := map[uuid.UUID]bool{}
	for _, id := range ids {
		found[id] = true
	}
	if !found[primary] || !found[secondary] || !found[nestedFirst] || !found[nestedSecond] {
		t.Fatalf("dependency discovery missed a selector: %v", ids)
	}

	// v13 detection uses the injected catalog metadata for both Widgets and Sources.
	if !service.widgetRequiresV13("dual-source-banner") {
		t.Fatal("injected Widget v13 requirement was not read from the catalog")
	}
	if !service.sourceRequiresV13("note-object") {
		t.Fatal("injected Source v13 requirement was not read from the catalog")
	}
	if service.widgetRequiresV13("school-status-banner") {
		t.Fatal("v13 detection consulted the embedded catalog rather than the injected one")
	}

	// Fingerprint reconciliation reads the injected catalog fingerprint.
	if service.definitions.Fingerprint != catalog.Fingerprint || catalog.Fingerprint == "" {
		t.Fatal("service did not expose the injected catalog fingerprint")
	}
	embedded := contentdefs.MustLoad()
	if catalog.Fingerprint == embedded.Fingerprint {
		t.Fatal("custom catalog fingerprint collided with the embedded default")
	}
}
