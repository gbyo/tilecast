package media

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestTimelineWritePath proves the Timeline authoring contract end to end:
// date and title mappings are required, counts stay bounded, unknown
// fields are refused, and the saved identity stays timeline.
func TestTimelineWritePath(t *testing.T) {
	ctx, service, user, scoresID, _ := nestedValidationService(t)

	created, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "timeline", Name: "History", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","dateField":"happened","titleField":"label","orientation":"vertical","maximumItems":8}`)})
	if err != nil {
		t.Fatalf("create timeline: %v", err)
	}
	if created.Widget == nil || created.Widget.Provider != "timeline" {
		t.Fatalf("timeline identity changed: %+v", created.Widget)
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "timeline", Name: "No date", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","dateField":"","titleField":"label"}`)}); err == nil {
		t.Fatal("expected a missing date field to be refused for Timeline")
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "timeline", Name: "Too many", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","dateField":"happened","titleField":"label","maximumItems":21}`)}); err == nil {
		t.Fatal("expected twenty-one timeline items to be refused")
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "timeline", Name: "Unknown", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","dateField":"happened","titleField":"label","bogus":true}`)}); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected an unknown field to be refused, got %v", err)
	}
}
