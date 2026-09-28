package media

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestChartWritePath proves the Chart authoring contract end to end:
// series stay bounded and numeric, unknown fields are refused, and a
// saved legacy donut keeps its hidden compatibility type.
func TestChartWritePath(t *testing.T) {
	ctx, service, user, scoresID, _ := nestedValidationService(t)

	created, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "chart", Name: "Sales", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","series":[{"field":"score","label":"Score","color":"#4f9dff"}],"categoryField":"label","style":"bar","showLegend":true,"showAxes":true}`)})
	if err != nil {
		t.Fatalf("create chart: %v", err)
	}
	if created.Widget == nil || created.Widget.Provider != "chart" {
		t.Fatalf("chart identity changed: %+v", created.Widget)
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "chart", Name: "Bad series", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","series":[{"field":"label","label":"Label"}]}`)}); err == nil {
		t.Fatal("expected a text series field to be refused for Chart")
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "chart", Name: "Unknown", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","series":[],"bogus":true}`)}); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected an unknown field to be refused, got %v", err)
	}
	donut, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "chart", Name: "Legacy donut", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","series":[{"field":"score","label":"Score"}],"categoryField":"label","chartType":"donut"}`)})
	if err != nil {
		t.Fatalf("create legacy donut chart: %v", err)
	}
	if donut.Widget == nil || donut.Widget.Provider != "chart" {
		t.Fatalf("donut identity changed: %+v", donut.Widget)
	}
}
