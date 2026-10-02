package media

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func normalizeComponent(t *testing.T, provider, raw string) (map[string]any, error) {
	t.Helper()
	definition, ok := contentdefs.MustLoad().Widget(provider)
	if !ok || definition.Component == nil {
		t.Fatalf("%s has no component", provider)
	}
	normalized, err := (componentConfigNormalizer{definition: definition}).Normalize(context.Background(), json.RawMessage(raw))
	if err != nil {
		return nil, err
	}
	return normalized.(map[string]any), nil
}

func TestComponentConfigNormalizerFillsSchemaDefaults(t *testing.T) {
	clock, err := normalizeComponent(t, "clock", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	if clock["mode"] != "time" || clock["format"] != "locale" || clock["timezone"] != "" {
		t.Fatalf("Clock defaults = %v", clock)
	}
}

func TestComponentConfigNormalizerKeepsSavedLegacyRowsEditable(t *testing.T) {
	// A Clock saved before Widgets V2, with its retired sizing keys.
	clock, err := normalizeComponent(t, "clock", `{"timezone":"Europe/Berlin","format":"12","showSeconds":false,"foregroundColor":"#F5F7FA","backgroundColor":"#0E141B","textScale":150,"contentPadding":5}`)
	if err != nil {
		t.Fatal(err)
	}
	if clock["textScale"] != 150 || clock["contentPadding"] != 5 || clock["timezone"] != "Europe/Berlin" {
		t.Fatalf("retained keys were not kept: %v", clock)
	}
	// A Countdown saved before Widgets V2 keeps its local target.
	countdown, err := normalizeComponent(t, "countdown", `{"target":"2026-12-01T09:00","timezone":"America/New_York","mode":"countdown","recurrence":"weekly","layout":"horizontal","label":"Board","completionText":"","completionAction":"completed_text","showDays":true,"showHours":true,"showMinutes":true,"showSeconds":false,"foregroundColor":"#ffffff","backgroundColor":"#000000"}`)
	if err != nil {
		t.Fatal(err)
	}
	if countdown["target"] != "2026-12-01T09:00" || countdown["layout"] != "horizontal" {
		t.Fatalf("Countdown = %v", countdown)
	}
	// An older release saved RFC 3339 instants.
	if _, err = normalizeComponent(t, "countdown", `{"target":"2026-12-01T14:00:00Z"}`); err != nil {
		t.Fatalf("an RFC 3339 target was refused: %v", err)
	}
	// Date and World Clock rows remain valid under their own schemas.
	if _, err = normalizeComponent(t, "date", `{"timezone":"Asia/Tokyo","format":"short","foregroundColor":"#ffffff","backgroundColor":"#000000"}`); err != nil {
		t.Fatal(err)
	}
	if _, err = normalizeComponent(t, "world_clock", `{"zones":[{"label":"Tokyo","timezone":"Asia/Tokyo"},{"label":"Local","timezone":""}],"format":"24","showSeconds":false,"showDate":true,"columns":2,"foregroundColor":"#ffffff","backgroundColor":"#000000"}`); err != nil {
		t.Fatal(err)
	}
}

func TestComponentConfigNormalizerUpgradesLegacyKeys(t *testing.T) {
	qr, err := normalizeComponent(t, "qrcode", `{"value":"https://example.org","label":"example.org"}`)
	if err != nil {
		t.Fatal(err)
	}
	if qr["payload"] != "https://example.org" || qr["shortLabel"] != "example.org" {
		t.Fatalf("legacy QR keys did not upgrade: %v", qr)
	}
	if _, present := qr["value"]; present {
		t.Fatalf("a consumed legacy key was kept: %v", qr)
	}
}

func TestComponentConfigNormalizerRejects(t *testing.T) {
	for _, test := range []struct{ provider, raw, want string }{
		{"clock", `{"mode":"calendar"}`, "invalid selection"},
		{"clock", `{"zones":[{"label":"x","timezone":"Mars/Olympus"}]}`, "IANA timezone"},
		{"countdown", `{"target":"next tuesday"}`, "local date and time"},
		{"text", `{"body":""}`, "Message"},
		{"text", `{"body":"Hi","script":"alert(1)"}`, "unknown field"},
		// Derived keys come from manifest projection, never from a client.
		{"image-notice", `{"imageVariantId":"33333333-3333-4333-8333-333333333333"}`, "unknown field"},
	} {
		if _, err := normalizeComponent(t, test.provider, test.raw); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s %s: error %v, want %q", test.provider, test.raw, err, test.want)
		}
	}
}

func TestComponentConfigNormalizerRejectsCustomDerivedVariant(t *testing.T) {
	// A definition-owned variant key the component template reads must be
	// refused exactly like the built-in imageVariantId: projection writes it,
	// clients never submit it.
	definition := contentdefs.WidgetDefinition{
		ID:      "media-sampler",
		Runtime: "native",
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "logoAssetId", Label: "Logo", Control: "media_asset"},
			{Key: "watermark", Label: "Watermark", Control: "media_asset"},
			{Key: "slides", Label: "Slides", Control: "repeating_group", MaximumItems: 3, ItemFields: []contentdefs.FieldDefinition{
				{Key: "poster", Label: "Poster", Control: "media_asset"},
			}},
		}},
		Component: &contentdefs.ComponentSpec{
			Type:           "example.media_sampler",
			Version:        1,
			TagName:        "example-media-sampler",
			ConfigTemplate: json.RawMessage(`{"logo":{"assetId":{"$config":"logoAssetId"},"variantId":{"$config":"logoVariantId"}},"watermark":{"$config":"watermarkVariantId"},"poster":{"$config":"posterVariantId"}}`),
		},
	}
	for _, key := range []string{"logoVariantId", "watermarkVariantId", "posterVariantId"} {
		raw, _ := json.Marshal(map[string]string{key: "33333333-3333-4333-8333-333333333333"})
		_, err := (componentConfigNormalizer{definition: definition}).Normalize(context.Background(), raw)
		if err == nil || !strings.Contains(err.Error(), `unknown field "`+key+`"`) {
			t.Fatalf("custom derived variant %s was accepted, err=%v", key, err)
		}
	}
}

func TestComponentConfigNormalizerAllowsThemeColors(t *testing.T) {
	// An optional color left blank follows the display theme.
	text, err := normalizeComponent(t, "text", `{"body":"Hi","backgroundColor":"","foregroundColor":""}`)
	if err != nil {
		t.Fatalf("a blank optional color was refused: %v", err)
	}
	if text["backgroundColor"] != "" {
		t.Fatalf("a blank color was replaced: %v", text)
	}
	if _, err = normalizeComponent(t, "text", `{"body":"Hi","backgroundColor":"red"}`); err == nil {
		t.Fatal("a non-hexadecimal color was accepted")
	}
}

func TestComponentConfigNormalizerAcceptsRetainedLegacyKeys(t *testing.T) {
	// The payload older API clients send for a QR Code (the real-server
	// end-to-end test sends exactly this).
	qr, err := normalizeComponent(t, "qrcode", `{"value":"https://tilecast.example/visit","label":"Visit us","errorCorrection":"medium","foregroundColor":"#ffffff","backgroundColor":"#111111"}`)
	if err != nil {
		t.Fatalf("a legacy QR Code payload was refused: %v", err)
	}
	if qr["errorCorrection"] != "medium" || qr["payload"] != "https://tilecast.example/visit" {
		t.Fatalf("QR = %v", qr)
	}
	if _, err = normalizeComponent(t, "qrcode", `{"value":"x","errorCorrection":"extreme"}`); err == nil {
		t.Fatal("an invalid retained value was accepted")
	}
}

func TestComponentConfigErrorsAreTyped(t *testing.T) {
	_, err := normalizeComponent(t, "text", `{"body":"Hi","script":"x"}`)
	var configuration *ConfigurationError
	if !errors.As(err, &configuration) {
		t.Fatalf("error %T is not a ConfigurationError", err)
	}
}

func TestChartLegacyTypeMapsToStyleOnResave(t *testing.T) {
	upgraded := map[string]any{"chartType": "bar"}
	applyChartLegacyStyle("chart", map[string]any{"chartType": "bar"}, upgraded)
	if upgraded["style"] != "bar" {
		t.Fatalf("a resaved bar chart became %v", upgraded["style"])
	}
	donut := map[string]any{"chartType": "donut"}
	applyChartLegacyStyle("chart", map[string]any{"chartType": "donut"}, donut)
	if donut["style"] != "bar" {
		t.Fatalf("a resaved donut chart became %v", donut["style"])
	}
	// An explicit new style still wins over the legacy type.
	explicit := map[string]any{"style": "line", "chartType": "bar"}
	applyChartLegacyStyle("chart", map[string]any{"style": "line", "chartType": "bar"}, explicit)
	if explicit["style"] != "line" {
		t.Fatalf("an explicit style was overridden: %v", explicit["style"])
	}
}

func TestMigratedBoundsRejectAtSave(t *testing.T) {
	if err := validateMigratedBounds("progress", map[string]any{"targetField": ""}); err == nil || !strings.Contains(err.Error(), "positive target") {
		t.Fatalf("a missing progress target was accepted: %v", err)
	}
	if err := validateMigratedBounds("progress", map[string]any{"targetField": "", "staticTarget": float64(0)}); err == nil || !strings.Contains(err.Error(), "positive target") {
		t.Fatalf("a zero progress target was accepted: %v", err)
	}
	if err := validateMigratedBounds("progress", map[string]any{"targetField": "", "staticTarget": float64(100)}); err != nil {
		t.Fatalf("a positive progress target was rejected: %v", err)
	}
	if err := validateMigratedBounds("chart", map[string]any{"series": []any{}, "minimum": float64(20), "maximum": float64(10)}); err == nil || !strings.Contains(err.Error(), "bounds are invalid") {
		t.Fatalf("inverted chart bounds were accepted: %v", err)
	}
	if err := validateMigratedBounds("chart", map[string]any{"series": []any{}}); err == nil || !strings.Contains(err.Error(), "one to four series") {
		t.Fatalf("an empty chart series was accepted: %v", err)
	}
	if err := validateMigratedBounds("metric", map[string]any{"metrics": []any{}}); err == nil || !strings.Contains(err.Error(), "at least one metric") {
		t.Fatalf("empty metrics were accepted: %v", err)
	}
}
