package playlists

import (
	"encoding/json"
	"testing"
)

func TestTimelineCompilesIntoSharedComponent(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	legacy := `{"dataSourceId":"` + source + `","dateField":"date","titleField":"title","bodyField":"body","statusField":"status","orientation":"vertical","maximumItems":8,"emptyState":"","foregroundColor":"","backgroundColor":""}`
	presentation, err := service.compileWidgetComponent("timeline", json.RawMessage(legacy))
	if err != nil || presentation == nil {
		t.Fatalf("timeline component: %v", err)
	}
	if presentation.RequiredCapabilities["widget.tilecast.timeline"] != 1 {
		t.Fatalf("timeline requires %v", presentation.RequiredCapabilities)
	}
	encoded, _ := json.Marshal(presentation.Component.Config)
	want := `{"background":"","bodyField":"body","dataSourceId":"` + source + `","dateField":"date","emptyText":"","foreground":"","maximumItems":8,"orientation":"vertical","statusField":"status","titleField":"title"}`
	if string(encoded) != want {
		t.Fatalf("timeline compiled to %s, want %s", encoded, want)
	}
	if len(presentation.Component.DataSources) != 1 || presentation.Component.DataSources[0] != source {
		t.Fatalf("timeline grants %v", presentation.Component.DataSources)
	}
}

func TestLegacyPresentationKeepsTimelineWorking(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	vertical, err := service.compileWidgetPresentation("timeline", json.RawMessage(`{"dataSourceId":"`+source+`","dateField":"date","titleField":"title","bodyField":"body","statusField":"status","orientation":"vertical","maximumItems":8}`))
	if err != nil || vertical == nil || vertical.Native == nil {
		t.Fatalf("vertical timeline presentation: %v", err)
	}
	container := vertical.Native.Root.Children[0]
	if container.Type != "column" {
		t.Fatalf("a vertical Timeline compiled a %s container", container.Type)
	}
	horizontal, err := service.compileWidgetPresentation("timeline", json.RawMessage(`{"dataSourceId":"`+source+`","dateField":"date","titleField":"title","orientation":"horizontal","maximumItems":5}`))
	if err != nil || horizontal == nil || horizontal.Native == nil {
		t.Fatalf("horizontal timeline presentation: %v", err)
	}
	if container := horizontal.Native.Root.Children[0]; container.Type != "row" {
		t.Fatalf("a horizontal Timeline compiled a %s container", container.Type)
	}
}
