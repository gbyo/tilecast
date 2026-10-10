package media

import (
	"encoding/json"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestCanvaCreateEditAndDuplicatePreserveCanonicalLink(t *testing.T) {
	ctx, service, user, _, _ := nestedValidationService(t)
	service.SetContentDefinitions(contentdefs.MustLoad())
	input := WidgetInput{Provider: "canva", Name: "Notice", Configuration: json.RawMessage(`{"canvaUrl":"https://www.canva.com/design/DAGabcdefgh/token_123456/view?access=keep&utm_source=share","refreshIntervalSeconds":1800}`)}
	asset, err := service.CreateWidget(ctx, user, input)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://www.canva.com/design/DAGabcdefgh/token_123456/view?access=keep&embed="
	if got := widgetConfiguration(t, service, asset.ID.String())["canvaUrl"]; got != want {
		t.Fatalf("saved %v", got)
	}
	input.Configuration = json.RawMessage(`{"canvaUrl":"https://www.canva.com/design/DAGabcdefgh/token_123456/view?access=keep&embed=","refreshIntervalSeconds":900}`)
	if _, err := service.UpdateWidget(ctx, asset.ID, user, input); err != nil {
		t.Fatal(err)
	}
	copy, err := service.DuplicateWidget(ctx, asset.ID, user)
	if err != nil {
		t.Fatal(err)
	}
	if got := widgetConfiguration(t, service, copy.ID.String())["canvaUrl"]; got != want {
		t.Fatalf("duplicate %v", got)
	}
	input.Configuration = json.RawMessage(`{"canvaUrl":"https://www.canva.com/design/DAGabcdefgh/edit","refreshIntervalSeconds":900}`)
	if _, err := service.UpdateWidget(ctx, asset.ID, user, input); err == nil {
		t.Fatal("unsupported update accepted")
	}
	if got := widgetConfiguration(t, service, asset.ID.String())["canvaUrl"]; got != want {
		t.Fatal("failed update changed saved URL")
	}
}
