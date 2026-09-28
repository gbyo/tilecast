package playlists

import (
	"encoding/json"
	"testing"
)

func TestProgressCompilesIntoSharedComponent(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	legacy := `{"dataSourceId":"` + source + `","valueField":"raised","targetField":"goal","label":"Campaign","labelField":"","showPercent":true,"completionText":"Done","emptyState":"","foregroundColor":"","backgroundColor":""}`
	presentation, err := service.compileWidgetComponent("progress", json.RawMessage(legacy))
	if err != nil || presentation == nil {
		t.Fatalf("progress component: %v", err)
	}
	if presentation.RequiredCapabilities["widget.tilecast.progress"] != 1 {
		t.Fatalf("progress requires %v", presentation.RequiredCapabilities)
	}
	encoded, _ := json.Marshal(presentation.Component.Config)
	want := `{"background":"","completionText":"Done","dataSourceId":"` + source + `","emptyText":"","foreground":"","format":"number","label":"Campaign","labelField":"","precision":1,"showPercent":true,"staticTarget":null,"style":"bar","targetField":"goal","valueField":"raised"}`
	if string(encoded) != want {
		t.Fatalf("progress compiled to %s, want %s", encoded, want)
	}
	if len(presentation.Component.DataSources) != 1 || presentation.Component.DataSources[0] != source {
		t.Fatalf("progress grants %v", presentation.Component.DataSources)
	}
}

func TestFundraisingThermometerMapsToThermometerStyle(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	presentation, err := service.compileWidgetComponent("fundraising-thermometer", json.RawMessage(`{"dataSourceId":"`+source+`","currentField":"current","targetField":"target","heading":"Our goal","valueFormat":"currency","showPercent":true,"completionText":"Thank you!","foregroundColor":"#ffffff","backgroundColor":"#123b2c"}`))
	if err != nil || presentation == nil {
		t.Fatalf("fundraising-thermometer component: %v", err)
	}
	if presentation.RequiredCapabilities["widget.tilecast.progress"] != 1 {
		t.Fatalf("fundraising-thermometer requires %v", presentation.RequiredCapabilities)
	}
	encoded, _ := json.Marshal(presentation.Component.Config)
	want := `{"background":"#123b2c","completionText":"Thank you!","dataSourceId":"` + source + `","emptyText":"","foreground":"#ffffff","format":"currency","label":"Our goal","labelField":"","precision":1,"showPercent":true,"style":"thermometer","targetField":"target","valueField":"current"}`
	if string(encoded) != want {
		t.Fatalf("fundraising-thermometer compiled to %s, want %s", encoded, want)
	}
}

func TestLegacyPresentationDegradesProgressStylesToGeneric(t *testing.T) {
	service := releaseService()
	source := "11111111-1111-4111-8111-111111111111"
	for _, style := range []string{"bar", "ring", "thermometer"} {
		presentation, err := service.compileWidgetPresentation("progress", json.RawMessage(`{"dataSourceId":"`+source+`","valueField":"raised","targetField":"goal","showPercent":true,"completionText":"","style":"`+style+`"}`))
		if err != nil || presentation == nil || presentation.Native == nil {
			t.Fatalf("%s progress presentation: %v", style, err)
		}
		if presentation.RequiredCapabilities["content.progress"] != 2 {
			t.Fatalf("%s progress requires %v", style, presentation.RequiredCapabilities)
		}
	}
}
