package media

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestSpotlightWritePath proves the Spotlight authoring contract end to
// end: the title mapping is required, unknown fields are refused, and the
// saved identity stays spotlight.
func TestSpotlightWritePath(t *testing.T) {
	ctx, service, user, scoresID, _ := nestedValidationService(t)

	created, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "spotlight", Name: "Feature", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","titleField":"label","subtitleField":"label","bodyField":"","badgeField":"","metadataField":""}`)})
	if err != nil {
		t.Fatalf("create spotlight: %v", err)
	}
	if created.Widget == nil || created.Widget.Provider != "spotlight" {
		t.Fatalf("spotlight identity changed: %+v", created.Widget)
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "spotlight", Name: "No title", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","titleField":"","subtitleField":"label"}`)}); err == nil {
		t.Fatal("expected a missing title field to be refused for Spotlight")
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "spotlight", Name: "Bad artwork", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","titleField":"label","imageAssetId":"not-a-uuid"}`)}); err == nil {
		t.Fatal("expected an invalid artwork reference to be refused for Spotlight")
	}
	if _, err := service.CreateWidget(ctx, user, WidgetInput{Provider: "spotlight", Name: "Unknown", Configuration: json.RawMessage(`{"dataSourceId":"` + scoresID + `","titleField":"label","bogus":true}`)}); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected an unknown field to be refused, got %v", err)
	}
}
