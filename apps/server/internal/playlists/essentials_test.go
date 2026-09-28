package playlists

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func releaseService() *Service { return &Service{definitions: contentdefs.MustLoad()} }

func compiledComponent(t *testing.T, provider, raw string) *ComponentPresentation {
	t.Helper()
	presentation, err := releaseService().compileWidgetComponent(provider, json.RawMessage(raw))
	if err != nil || presentation == nil {
		t.Fatalf("%s: %v", provider, err)
	}
	return presentation.Component
}

func TestCollapsedEssentialsCompileIntoTheirComponents(t *testing.T) {
	for _, test := range []struct {
		provider, raw, want string
		capability          string
	}{
		{
			provider:   "date",
			raw:        `{"timezone":"Asia/Tokyo","format":"short","foregroundColor":"#ffffff","backgroundColor":"#000000","textScale":150}`,
			want:       `{"background":"#000000","dateFormat":"short","foreground":"#ffffff","format":"locale","mode":"date","showDate":false,"showSeconds":false,"style":"standard","timeZone":"Asia/Tokyo","zones":[]}`,
			capability: "widget.tilecast.clock",
		},
		{
			provider:   "world_clock",
			raw:        `{"zones":[{"label":"Tokyo","timezone":"Asia/Tokyo"}],"format":"24","showSeconds":true,"showDate":true,"columns":2,"foregroundColor":"#ffffff","backgroundColor":"#000000"}`,
			want:       `{"background":"#000000","dateFormat":"locale","foreground":"#ffffff","format":"24","mode":"world","showDate":true,"showSeconds":true,"style":"standard","timeZone":"","zones":[{"label":"Tokyo","timezone":"Asia/Tokyo"}]}`,
			capability: "widget.tilecast.clock",
		},
		{
			provider:   "text-notice",
			raw:        `{"heading":"Board","showHeading":false,"body":"Tonight","align":"left","bodyLines":4,"foregroundColor":"#ffffff","backgroundColor":"#12253a"}`,
			want:       `{"align":"left","background":"#12253a","body":"Tonight","foreground":"#ffffff","heading":"","style":"standard"}`,
			capability: "widget.tilecast.text",
		},
		{
			provider:   "countdown",
			raw:        `{"target":"2026-12-01T09:00","timezone":"","layout":"countdown_only","showSeconds":true}`,
			want:       `{"background":"","completionAction":"completed_text","completionText":"","foreground":"","label":"","mode":"countdown","recurrence":"none","showDays":true,"showHours":true,"showMinutes":true,"showSeconds":true,"style":"countdown_only","target":"2026-12-01T09:00","timeZone":""}`,
			capability: "widget.tilecast.countdown",
		},
	} {
		presentation, err := releaseService().compileWidgetComponent(test.provider, json.RawMessage(test.raw))
		if err != nil {
			t.Fatalf("%s: %v", test.provider, err)
		}
		if presentation.RequiredCapabilities[test.capability] == 0 {
			t.Errorf("%s requires %v, want %s", test.provider, presentation.RequiredCapabilities, test.capability)
		}
		encoded, _ := json.Marshal(presentation.Component.Config)
		if string(encoded) != test.want {
			t.Errorf("%s compiled to %s, want %s", test.provider, encoded, test.want)
		}
	}
}

func TestComponentMediaGrantsOnlyProjectedVariants(t *testing.T) {
	asset := "22222222-2222-4222-8222-222222222222"
	variant := "33333333-3333-4333-8333-333333333333"
	component := compiledComponent(t, "image-notice", `{"imageAssetId":"`+asset+`","imageVariantId":"`+variant+`","fit":"cover","caption":"Hi","showCaption":true}`)
	if len(component.Media) != 1 || component.Media[0].AssetID != asset || component.Media[0].VariantID != variant {
		t.Fatalf("media = %+v", component.Media)
	}
	image, _ := component.Config["image"].(map[string]any)
	if image["assetId"] != asset || image["variantId"] != variant {
		t.Fatalf("config = %+v", component.Config)
	}
	// Before projection resolves a variant there is nothing to grant.
	if component = compiledComponent(t, "image-notice", `{"imageAssetId":"`+asset+`"}`); len(component.Media) != 0 {
		t.Fatalf("an unprojected asset was granted: %+v", component.Media)
	}
	if component = compiledComponent(t, "image-notice", `{"imageAssetId":"../x","imageVariantId":"y"}`); len(component.Media) != 0 {
		t.Fatalf("a malformed reference was granted: %+v", component.Media)
	}
}

func TestCompatibilityConfigurationUsesTheOrganizationTimezone(t *testing.T) {
	service := releaseService()
	got := string(service.compatibilityConfiguration("countdown", json.RawMessage(`{"target":"2026-12-01T09:00","timezone":""}`), "America/Chicago"))
	if !strings.Contains(got, `"timezone":"America/Chicago"`) {
		t.Fatalf("blank zone was not resolved: %s", got)
	}
	explicit := `{"target":"2026-12-01T09:00","timezone":"Europe/Paris"}`
	if got = string(service.compatibilityConfiguration("countdown", json.RawMessage(explicit), "America/Chicago")); got != explicit {
		t.Fatalf("an explicit zone changed: %s", got)
	}
	// A provider without a component keeps its configuration exactly.
	website := `{"url":"https://example.org","timezone":""}`
	if got = string(service.compatibilityConfiguration("website", json.RawMessage(website), "America/Chicago")); got != website {
		t.Fatalf("a non-component provider changed: %s", got)
	}
}

func TestLegacyPresentationFollowsClockModesAndQrKeys(t *testing.T) {
	service := releaseService()
	date, err := service.compileWidgetPresentation("clock", json.RawMessage(`{"mode":"date","dateFormat":"long","timezone":"UTC"}`))
	if err != nil {
		t.Fatal(err)
	}
	if format := date.Native.Root.Children[0].Binding.Format; !strings.HasPrefix(format, "date:long:") {
		t.Fatalf("a date-mode Clock compiled %q", format)
	}
	world, err := service.compileWidgetPresentation("clock", json.RawMessage(`{"mode":"world","zones":[{"label":"","timezone":"America/New_York"},{"label":"HQ","timezone":"Europe/London"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	grid := world.Native.Root.Children[0]
	if grid.Type != "grid" || len(grid.Children) != 2 || grid.Props["columns"] != 2 {
		t.Fatalf("a world-mode Clock compiled %+v", grid)
	}
	if label := grid.Children[0].Children[0].Binding.Value; label != "New York" {
		t.Fatalf("a blank zone label compiled %q", label)
	}
	qr, err := service.compileWidgetPresentation("qrcode", json.RawMessage(`{"payload":"https://example.com","shortLabel":"example.com","value":"https://old.example"}`))
	if err != nil {
		t.Fatal(err)
	}
	if value := qr.Native.Root.Children[0].Binding.Value; value != "https://example.com" {
		t.Fatalf("QR compiled %q", value)
	}
}
