package playlists

import (
	"encoding/json"
	"testing"
)

func TestMetricsCompileIntoSharedComponent(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	legacy := `{"dataSourceId":"` + source + `","valueField":"score","label":"Score","labelField":"","secondaryField":"note","format":"number","precision":2,"prefix":"","suffix":"","alignment":"center","emptyState":"","foregroundColor":"","backgroundColor":""}`
	presentation, err := service.compileWidgetComponent("metric", json.RawMessage(legacy))
	if err != nil || presentation == nil {
		t.Fatalf("metric component: %v", err)
	}
	if presentation.RequiredCapabilities["widget.tilecast.metrics"] != 1 {
		t.Fatalf("metric requires %v", presentation.RequiredCapabilities)
	}
	encoded, _ := json.Marshal(presentation.Component.Config)
	want := `{"background":"","dataSourceId":"` + source + `","emptyText":"","foreground":"","metrics":[{"detailField":"note","format":"number","label":"Score","labelField":"","precision":2,"prefix":"","suffix":"","valueField":"score"}]}`
	if string(encoded) != want {
		t.Fatalf("metric compiled to %s, want %s", encoded, want)
	}
	if len(presentation.Component.DataSources) != 1 || presentation.Component.DataSources[0] != source {
		t.Fatalf("metric grants %v", presentation.Component.DataSources)
	}

	grid, err := service.compileWidgetComponent("stat_grid", json.RawMessage(`{"dataSourceId":"`+source+`","metrics":[{"valueField":"score","label":"Score","format":"number","precision":2}],"columns":2,"emptyState":"","foregroundColor":"","backgroundColor":""}`))
	if err != nil || grid == nil {
		t.Fatalf("stat_grid component: %v", err)
	}
	if grid.RequiredCapabilities["widget.tilecast.metrics"] != 1 {
		t.Fatalf("stat_grid requires %v", grid.RequiredCapabilities)
	}
	gridEncoded, _ := json.Marshal(grid.Component.Config)
	gridWant := `{"background":"","dataSourceId":"` + source + `","emptyText":"","foreground":"","metrics":[{"format":"number","label":"Score","precision":2,"valueField":"score"}]}`
	if string(gridEncoded) != gridWant {
		t.Fatalf("stat_grid compiled to %s, want %s", gridEncoded, gridWant)
	}
}

func TestLegacyPresentationKeepsResavedMetricsWorking(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	resaved, err := service.compileWidgetPresentation("metric", json.RawMessage(`{"dataSourceId":"`+source+`","metrics":[{"valueField":"score","label":"Score","format":"number","precision":2},{"valueField":"total","label":"Total","format":"integer","precision":0}],"emptyText":"Nothing yet"}`))
	if err != nil || resaved == nil || resaved.Native == nil {
		t.Fatalf("resaved metric presentation: %v", err)
	}
	grid := resaved.Native.Root.Children[0]
	if grid.Type != "grid" || len(grid.Children) != 2 {
		t.Fatalf("a resaved Metric compiled %+v, want a two-card grid", grid)
	}
	if fallback := grid.Children[0].Children[1].Binding.Fallback; fallback != "Nothing yet" {
		t.Fatalf("a resaved Metric fallback compiled %q", fallback)
	}

	singular, err := service.compileWidgetPresentation("metric", json.RawMessage(`{"dataSourceId":"`+source+`","valueField":"score","labelField":"","secondaryField":"note","format":"number"}`))
	if err != nil || singular == nil || singular.Native == nil {
		t.Fatalf("legacy singular Metric presentation: %v", err)
	}

	legacy, err := service.compileWidgetPresentation("stat_grid", json.RawMessage(`{"dataSourceId":"`+source+`","metrics":[{"valueField":"score","label":"Score"}],"columns":3,"emptyState":"Empty"}`))
	if err != nil || legacy == nil || legacy.Native == nil {
		t.Fatalf("stat_grid presentation: %v", err)
	}
	legacyGrid := legacy.Native.Root.Children[0]
	if legacyGrid.Type != "grid" || legacyGrid.Props["columns"] != 3 || len(legacyGrid.Children) != 1 {
		t.Fatalf("a Stat Grid compiled %+v", legacyGrid)
	}
	if fallback := legacyGrid.Children[0].Children[1].Binding.Fallback; fallback != "Empty" {
		t.Fatalf("a Stat Grid fallback compiled %q", fallback)
	}
}
