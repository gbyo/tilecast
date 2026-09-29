package playlists

import (
	"encoding/json"
	"testing"
)

func TestChartCompilesIntoSharedComponent(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	legacy := `{"dataSourceId":"` + source + `","series":[{"field":"sales","label":"Sales","color":"#4f9dff"}],"categoryField":"month","chartType":"bar","showLegend":true,"showAxes":true,"emptyState":"","foregroundColor":"","backgroundColor":""}`
	presentation, err := service.compileWidgetComponent("chart", json.RawMessage(legacy))
	if err != nil || presentation == nil {
		t.Fatalf("chart component: %v", err)
	}
	if presentation.RequiredCapabilities["widget.tilecast.chart"] != 1 {
		t.Fatalf("chart requires %v", presentation.RequiredCapabilities)
	}
	encoded, _ := json.Marshal(presentation.Component.Config)
	want := `{"background":"","categoryField":"month","chartType":"bar","dataSourceId":"` + source + `","dataset":"","emptyText":"","foreground":"","maximum":null,"minimum":null,"series":[{"color":"#4f9dff","field":"sales","label":"Sales"}],"showAxes":true,"showLegend":true,"style":null,"timeField":""}`
	if string(encoded) != want {
		t.Fatalf("chart compiled to %s, want %s", encoded, want)
	}
	if len(presentation.Component.DataSources) != 1 || presentation.Component.DataSources[0] != source {
		t.Fatalf("chart grants %v", presentation.Component.DataSources)
	}
}

func TestLegacyPresentationMapsChartStyles(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	series := `"series":[{"field":"sales","label":"Sales","color":"#4f9dff"}]`
	for style, node := range map[string]string{"bar": "bar_chart", "line": "line_chart", "area": "line_chart"} {
		presentation, err := service.compileWidgetPresentation("chart", json.RawMessage(`{"dataSourceId":"`+source+`",`+series+`,"chartType":"line","style":"`+style+`"}`))
		if err != nil || presentation == nil || presentation.Native == nil {
			t.Fatalf("%s chart presentation: %v", style, err)
		}
		child := presentation.Native.Root.Children[0]
		if child.Type != node {
			t.Fatalf("a %s Chart compiled a %s node", style, child.Type)
		}
		if colors, ok := child.Props["seriesColors"].([]string); !ok || len(colors) != 1 || colors[0] != "#4f9dff" {
			t.Fatalf("a %s Chart compiled colors %v", style, child.Props["seriesColors"])
		}
	}
	// A saved legacy donut keeps its old path while it has no style.
	donut, err := service.compileWidgetPresentation("chart", json.RawMessage(`{"dataSourceId":"`+source+`",`+series+`,"chartType":"donut"}`))
	if err != nil || donut == nil || donut.Native == nil {
		t.Fatalf("donut chart presentation: %v", err)
	}
	if child := donut.Native.Root.Children[0]; child.Type != "donut_chart" {
		t.Fatalf("a legacy donut compiled a %s node", child.Type)
	}
}

func TestV2EmptyDatasetAndLabelFallBackForOldPlayers(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	presentation, err := service.compileWidgetPresentation("chart", json.RawMessage(`{"dataSourceId":"`+source+`","dataset":"","series":[{"field":"sales","label":"","color":""}],"chartType":"line","style":"bar"}`))
	if err != nil || presentation == nil || presentation.Native == nil {
		t.Fatalf("v2 chart presentation: %v", err)
	}
	child := presentation.Native.Root.Children[0]
	binding := child.Binding
	if binding == nil || binding.Dataset != source+":records" {
		t.Fatalf("an empty dataset bound %v, want %s:records", binding, source)
	}
	labels, _ := child.Props["seriesLabels"].([]string)
	if len(labels) != 1 || labels[0] != "sales" {
		t.Fatalf("an empty series label compiled %v, want [sales]", child.Props["seriesLabels"])
	}
}
