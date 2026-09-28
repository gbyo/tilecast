package media

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestProgressWritePath proves the Progress authoring contract end to end:
// field and fixed targets validate, wrong-typed target fields are refused,
// unknown fields are refused, and the Fundraising Thermometer alias keeps
// working as a hidden compatibility identity of the thermometer style.
func TestProgressWritePath(t *testing.T) {
	ctx, service, user, scoresID, _ := nestedValidationService(t)

	created, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "progress", Name: "Drive", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","valueField":"score","targetField":"","staticTarget":100,"label":"Drive","format":"integer","precision":0,"showPercent":true,"style":"ring"}`)})
	if err != nil {
		t.Fatalf("create progress: %v", err)
	}
	if created.Widget == nil || created.Widget.Provider != "progress" {
		t.Fatalf("progress identity changed: %+v", created.Widget)
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "progress", Name: "Bad target", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","valueField":"score","targetField":"label","staticTarget":null}`)}); err == nil {
		t.Fatal("expected a text target field to be refused for Progress")
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "progress", Name: "Unknown", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","valueField":"score","staticTarget":100,"bogus":true}`)}); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected an unknown field to be refused, got %v", err)
	}

	goalConfig, _ := json.Marshal(map[string]any{"label": "Annual Fund", "current": 48250.0, "target": 100000.0})
	goal, err := service.CreateDataSource(ctx, user, DataSourceInput{Provider: "fundraising-goal", Name: "Goal", Configuration: goalConfig})
	if err != nil {
		t.Fatalf("create fundraising goal source: %v", err)
	}
	thermometer, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "fundraising-thermometer", Name: "Thermo", Configuration: json.RawMessage(`{"dataSourceId":"` + goal.ID.String() + `","currentField":"current","targetField":"target","heading":"Our goal","valueFormat":"currency","showPercent":true,"completionText":"Thank you!","foregroundColor":"#ffffff","backgroundColor":"#123b2c"}`)})
	if err != nil {
		t.Fatalf("create fundraising thermometer: %v", err)
	}
	if thermometer.Widget == nil || thermometer.Widget.Provider != "fundraising-thermometer" {
		t.Fatalf("thermometer identity changed: %+v", thermometer.Widget)
	}
}
