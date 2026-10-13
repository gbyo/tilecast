package media

import (
	"encoding/json"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestCanvaCreateEditAndDuplicatePreserveCanonicalLink(t *testing.T) {
	ctx, service, user, _, _ := nestedValidationService(t)
	service.SetContentDefinitions(contentdefs.MustLoad())
	input := WidgetInput{Provider: "canva", Name: "Notice", Configuration: json.RawMessage(`{"canvaUrl":"https://www.canva.com/design/DAGabcdefgh/token_123456/view?access=keep&utm_source=share","slideshow":true,"refreshIntervalSeconds":1800}`)}
	asset, err := service.CreateWidget(ctx, user, input)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://www.canva.com/design/DAGabcdefgh/token_123456/watch?access=keep&autoplay=1&embed="
	if got := widgetConfiguration(t, service, asset.ID.String())["canvaUrl"]; got != want {
		t.Fatalf("saved %v", got)
	}
	input.Configuration = json.RawMessage(`{"canvaUrl":"https://www.canva.com/design/DAGabcdefgh/token_123456/watch?access=keep&autoplay=1&embed=","slideshow":false,"refreshIntervalSeconds":900}`)
	if _, err := service.UpdateWidget(ctx, asset.ID, user, input); err != nil {
		t.Fatal(err)
	}
	want = "https://www.canva.com/design/DAGabcdefgh/token_123456/view?access=keep&embed="
	if got := widgetConfiguration(t, service, asset.ID.String())["canvaUrl"]; got != want {
		t.Fatalf("manual update saved %v", got)
	}
	copy, err := service.DuplicateWidget(ctx, asset.ID, user)
	if err != nil {
		t.Fatal(err)
	}
	if got := widgetConfiguration(t, service, copy.ID.String())["canvaUrl"]; got != want {
		t.Fatalf("duplicate %v", got)
	}
	input.Configuration = json.RawMessage(`{"canvaUrl":"https://www.canva.com/design/DAGabcdefgh/edit","slideshow":false,"refreshIntervalSeconds":900}`)
	if _, err := service.UpdateWidget(ctx, asset.ID, user, input); err == nil {
		t.Fatal("unsupported update accepted")
	}
	if got := widgetConfiguration(t, service, asset.ID.String())["canvaUrl"]; got != want {
		t.Fatal("failed update changed saved URL")
	}
}
