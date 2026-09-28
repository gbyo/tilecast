package media

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func mustParseUUID(t *testing.T, raw string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func repeatMetricItem(t *testing.T, _ string, count int) []map[string]any {
	t.Helper()
	items := make([]map[string]any, 0, count)
	for range count {
		items = append(items, map[string]any{"valueField": "score", "format": "number", "precision": 1})
	}
	return items
}

// TestMetricWritePath proves the Metrics authoring contract end to end:
// legacy singular Metric rows upgrade into one canonical item, nested bad
// field choices are refused, unknown fields are refused, and the Stat Grid
// alias keeps its wider saved-row bound while sharing the component.
func TestMetricWritePath(t *testing.T) {
	ctx, service, user, scoresID, _ := nestedValidationService(t)

	stored := func(assetID string) map[string]any {
		t.Helper()
		asset, err := service.GetAsset(ctx, mustParseUUID(t, assetID))
		if err != nil || asset.Widget == nil {
			t.Fatalf("read back widget: %v", err)
		}
		var configuration map[string]any
		if err := json.Unmarshal(asset.Widget.Configuration, &configuration); err != nil {
			t.Fatal(err)
		}
		return configuration
	}

	legacy := `{"dataSourceId":"` + scoresID + `","valueField":"score","label":"Score","labelField":"","secondaryField":"label","format":"number","precision":2,"prefix":"","suffix":"","alignment":"center","emptyState":"","foregroundColor":"","backgroundColor":""}`
	created, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "metric", Name: "Score", Configuration: json.RawMessage(legacy)})
	if err != nil {
		t.Fatalf("create legacy metric: %v", err)
	}
	configuration := stored(created.ID.String())
	items, ok := configuration["metrics"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("legacy metric stored %v, want one metrics item", configuration["metrics"])
	}
	first, _ := items[0].(map[string]any)
	if first["valueField"] != "score" || first["detailField"] != "label" || first["precision"] != float64(2) {
		t.Fatalf("legacy metric upgraded to %v", first)
	}
	if _, present := configuration["secondaryField"]; present {
		t.Fatalf("legacy secondaryField was not consumed: %v", configuration)
	}

	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "metric", Name: "Bad type", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","metrics":[{"valueField":"label","format":"number","precision":1}]}`)}); err == nil {
		t.Fatal("expected a text value field to be refused for Metrics")
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "metric", Name: "Unknown", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","metrics":[],"frobnicate":true}`)}); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected an unknown field to be refused, got %v", err)
	}

	// Twelve saved Stat Grid metrics stay valid; thirteen do not.
	twelve, _ := json.Marshal(map[string]any{
		"dataSourceId": scoresID,
		"metrics":      repeatMetricItem(t, scoresID, 12),
		"columns":      4,
	})
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "stat_grid", Name: "Twelve", Configuration: twelve}); err != nil {
		t.Fatalf("twelve stat grid metrics were refused: %v", err)
	}
	thirteen, _ := json.Marshal(map[string]any{
		"dataSourceId": scoresID,
		"metrics":      repeatMetricItem(t, scoresID, 13),
		"columns":      2,
	})
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "stat_grid", Name: "Thirteen", Configuration: thirteen}); err == nil {
		t.Fatal("expected thirteen stat grid metrics to be refused")
	}

	// Editing a Metric through the new shape keeps working and keeps identity.
	updated, err := service.UpdateWidget(ctx, created.ID, user, WidgetInput{Provider: "metric", Name: "Score", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","metrics":[{"valueField":"score","label":"Score","format":"number","precision":2}],"emptyText":"None"}`)})
	if err != nil {
		t.Fatalf("update metric: %v", err)
	}
	if updated.Widget == nil || updated.Widget.Provider != "metric" {
		t.Fatalf("metric update changed identity: %+v", updated.Widget)
	}
	if stored(updated.ID.String())["emptyText"] != "None" {
		t.Fatal("metric update did not persist")
	}
}
