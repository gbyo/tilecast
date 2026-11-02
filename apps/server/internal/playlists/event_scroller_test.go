package playlists

import (
	"encoding/json"
	"testing"
)

func TestEventScrollerComponentGrantsAndCompatibility(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	raw := json.RawMessage(`{"dataSourceId":"` + source + `","titleField":"title","startField":"startTime","scrollSpeed":4.5,"textScale":160,"headingScale":120,"rowLayout":"natural","rowSpacing":10,"contentPadding":30,"headingSpacing":25}`)
	component, err := service.compileWidgetComponent("event-scroller", raw)
	if err != nil || component == nil {
		t.Fatalf("compile Event Scroller: %+v, %v", component, err)
	}
	if component.SchemaVersion != 3 || component.RequiredCapabilities["widget.tilecast.event-scroller"] != 1 {
		t.Fatalf("component requirements: %+v", component)
	}
	if component.Component.Empty != "skip-eligible" || component.Component.Config["scrollSpeed"] != 4.5 || component.Component.Config["flow"] != "auto" {
		t.Fatalf("component configuration: %+v", component.Component)
	}
	if len(component.Component.DataSources) != 1 || component.Component.DataSources[0] != source || len(component.Component.Media) != 0 {
		t.Fatalf("component grants: %+v", component.Component)
	}
	for key, expected := range map[string]any{"textScale": float64(160), "headingScale": float64(120), "rowLayout": "natural", "rowSpacing": float64(10), "contentPadding": float64(30), "headingSpacing": float64(25)} {
		if component.Component.Config[key] != expected {
			t.Fatalf("author sizing %s lost in component projection: %+v", key, component.Component.Config)
		}
	}
	fallback, err := service.compileWidgetPresentationForPreset("event-scroller", nil, raw, false)
	if err != nil || fallback != nil {
		t.Fatalf("Event Scroller must have no legacy fallback: %+v, %v", fallback, err)
	}
	for _, schema := range []int{2, 3} {
		presentation, err := service.compileWidgetComponentForSchema("event-scroller", raw, schema)
		if err != nil {
			t.Fatal(err)
		}
		if supported, _ := presentationSupported(presentation, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{int32(schema)}, Native: map[string]int{"widget.tilecast.event-scroller": 1}}); !supported {
			t.Fatalf("capable schema %d player rejected", schema)
		}
	}
	if supported, _ := presentationSupported(component, playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{3}, Native: map[string]int{"widget.tilecast.ticker": 1}}); supported {
		t.Fatal("a Player without the Event Scroller capability must not accept it")
	}
}
