package playlists

import (
	"encoding/json"
	"testing"
)

func TestSpotlightCompilesIntoSharedComponent(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	legacy := `{"dataSourceId":"` + source + `","titleField":"title","subtitleField":"subtitle","bodyField":"body","badgeField":"status","dateField":"date","imageAssetId":"","emptyState":"","foregroundColor":"","backgroundColor":""}`
	presentation, err := service.compileWidgetComponent("spotlight", json.RawMessage(legacy))
	if err != nil || presentation == nil {
		t.Fatalf("spotlight component: %v", err)
	}
	if presentation.RequiredCapabilities["widget.tilecast.spotlight"] != 1 {
		t.Fatalf("spotlight requires %v", presentation.RequiredCapabilities)
	}
	encoded, _ := json.Marshal(presentation.Component.Config)
	want := `{"background":"","badgeField":"status","bodyField":"body","dataSourceId":"` + source + `","emptyText":"","foreground":"","image":{"assetId":"","variantId":""},"metadataField":"date","subtitleField":"subtitle","titleField":"title"}`
	if string(encoded) != want {
		t.Fatalf("spotlight compiled to %s, want %s", encoded, want)
	}
	if len(presentation.Component.DataSources) != 1 || presentation.Component.DataSources[0] != source {
		t.Fatalf("spotlight grants %v", presentation.Component.DataSources)
	}
	// No artwork means no media grant.
	if presentation.Component.Media != nil && len(presentation.Component.Media) != 0 {
		t.Fatalf("spotlight granted media without artwork: %+v", presentation.Component.Media)
	}
}

func TestLegacyPresentationMapsSpotlightMetadataField(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	resaved, err := service.compileWidgetPresentation("spotlight", json.RawMessage(`{"dataSourceId":"`+source+`","titleField":"title","metadataField":"date"}`))
	if err != nil || resaved == nil || resaved.Native == nil {
		t.Fatalf("resaved spotlight presentation: %v", err)
	}
	column := resaved.Native.Root.Children[0]
	found := false
	for _, child := range column.Children {
		if child.Binding != nil && child.Binding.Path == "date" {
			found = true
		}
	}
	if !found {
		t.Fatalf("a resaved Spotlight did not map metadataField: %+v", column)
	}
	legacy, err := service.compileWidgetPresentation("spotlight", json.RawMessage(`{"dataSourceId":"`+source+`","titleField":"title","dateField":"when"}`))
	if err != nil || legacy == nil || legacy.Native == nil {
		t.Fatalf("legacy spotlight presentation: %v", err)
	}
}
