package playlists

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// componentOnlyCatalog holds one Widget whose component has no compatibility
// presentation, as a V2-only Widget from a later release would.
func componentOnlyCatalog(t *testing.T) *contentdefs.Catalog {
	t.Helper()
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{{
		ID: "probe", Version: 1, APIVersion: 1, Name: "Probe", Category: "Test", Runtime: "native",
		PresentationSchemaVersion: 1,
		RequiredCapabilities:      map[string]int{"content.text": 1},
		EmptyStateBehavior:        "text",
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "title", Label: "Title", Control: "text"},
			{Key: "source", Label: "Source", Control: "data_source"},
		}},
		DefaultConfiguration: map[string]any{},
		Component: &contentdefs.ComponentSpec{
			Type: "tilecast.probe", Version: 3, TagName: "tc-widget-probe",
			Entrypoint: "./runtime/index.ts", Empty: "render",
			ConfigTemplate:   json.RawMessage(`{"title":{"$config":"title","default":"Untitled"}}`),
			DataSourceFields: []string{"source"},
		},
		Compatibility: &contentdefs.Compatibility{Fallback: "none"},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestComponentOnlyWidgetCompilesWithoutFallback(t *testing.T) {
	service := &Service{definitions: componentOnlyCatalog(t)}
	raw := json.RawMessage(`{"title":"Lobby","source":"6f5f2f7e-1c1a-4e8e-9b61-3a2d8d2f1c10"}`)
	preset := "leaderboard"
	// A preset on a Widget without a compatibility presentation must not
	// dereference the missing native tree.
	fallback, err := service.compileWidgetPresentationForPreset("probe", &preset, raw, false)
	if err != nil || fallback != nil {
		t.Fatalf("fallback = %+v, err = %v", fallback, err)
	}
	component, err := service.compileWidgetComponent("probe", raw)
	if err != nil {
		t.Fatal(err)
	}
	if component.SchemaVersion != 2 || component.Kind != "component" || component.RequiredCapabilities["widget.tilecast.probe"] != 3 {
		t.Fatalf("unexpected component presentation: %+v", component)
	}
	if component.Component.Config["title"] != "Lobby" || len(component.Component.DataSources) != 1 {
		t.Fatalf("component did not compile its configuration and sources: %+v", component.Component)
	}
	// Only a well-formed Data Source ID becomes a grant.
	component, _ = service.compileWidgetComponent("probe", json.RawMessage(`{"source":"../../etc"}`))
	if len(component.Component.DataSources) != 0 || component.Component.Config["title"] != "Untitled" {
		t.Fatalf("unexpected grant or default: %+v", component.Component)
	}
}

func TestGenericMediaFieldsCompileComponentGrants(t *testing.T) {
	definition := contentdefs.WidgetDefinition{
		ID: "generic-media-probe", Version: 1, APIVersion: 1,
		Name: "Generic Media Probe", Category: "Test", Runtime: "native",
		PresentationSchemaVersion: 1,
		RequiredCapabilities:      map[string]int{"content.text": 1},
		EmptyStateBehavior:        "text",
		ConfigurationSchema: contentdefs.ConfigurationSchema{Fields: []contentdefs.FieldDefinition{
			{Key: "logoAssetId", Label: "Logo", Control: "media_asset"},
			{Key: "backgroundAssetId", Label: "Background", Control: "media_asset"},
			{Key: "watermark", Label: "Watermark", Control: "media_asset"},
			{Key: "slides", Label: "Slides", Control: "repeating_group", MaximumItems: 3, ItemFields: []contentdefs.FieldDefinition{
				{Key: "posterAssetId", Label: "Poster", Control: "media_asset"},
			}},
		}},
		DefaultConfiguration: map[string]any{},
		Component: &contentdefs.ComponentSpec{
			Type: "tilecast.generic-media-probe", Version: 1, TagName: "tc-widget-generic-media-probe",
			Entrypoint: "./runtime/index.ts", Empty: "render",
			ConfigTemplate: json.RawMessage(`{
				"logoVariantId":{"$config":"logoVariantId","default":""},
				"backgroundVariantId":{"$config":"backgroundVariantId","default":""},
				"watermarkVariantId":{"$config":"watermarkVariantId","default":""},
				"slides":{"$config":"slides","default":[]}
			}`),
		},
		Compatibility: &contentdefs.Compatibility{Fallback: "none"},
	}
	catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{definition}, nil)
	if err != nil {
		t.Fatal(err)
	}
	assetIDs := []uuid.UUID{
		uuid.MustParse("11111111-1111-4111-8111-111111111111"),
		uuid.MustParse("22222222-2222-4222-8222-222222222222"),
		uuid.MustParse("33333333-3333-4333-8333-333333333333"),
		uuid.MustParse("44444444-4444-4444-8444-444444444444"),
	}
	variantIDs := []uuid.UUID{
		uuid.MustParse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		uuid.MustParse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
		uuid.MustParse("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
		uuid.MustParse("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
	}
	configuration := map[string]any{
		"logoAssetId":         assetIDs[0].String(),
		"logoVariantId":       variantIDs[0].String(),
		"backgroundAssetId":   assetIDs[1].String(),
		"backgroundVariantId": variantIDs[1].String(),
		"watermark":           assetIDs[2].String(),
		"watermarkVariantId":  variantIDs[2].String(),
		"slides": []any{
			map[string]any{"posterAssetId": assetIDs[3].String(), "posterVariantId": variantIDs[3].String()},
		},
	}

	raw, err := json.Marshal(configuration)
	if err != nil {
		t.Fatal(err)
	}
	presentation, err := (&Service{definitions: catalog}).compileWidgetComponent(definition.ID, raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(presentation.Component.Media) != len(assetIDs) {
		t.Fatalf("component media grants = %+v", presentation.Component.Media)
	}
	for index, grant := range presentation.Component.Media {
		if grant.AssetID != assetIDs[index].String() || grant.VariantID != variantIDs[index].String() {
			t.Fatalf("media grant %d = %+v", index, grant)
		}
	}
	compiledSlides := presentation.Component.Config["slides"].([]any)
	if compiledSlides[0].(map[string]any)["posterVariantId"] != variantIDs[3].String() {
		t.Fatalf("component config lost nested media variant: %+v", compiledSlides)
	}
}

// TestLegacyQrProvidersProjectIntoQrCode keeps every persisted QR provider
// generation compiling into the one V2 component: the legacy qrcode keys,
// the call-to-action keys, and the canonical QR Code keys all normalize to
// tilecast.qr-code configuration for capable Players.
func TestLegacyQrProvidersProjectIntoQrCode(t *testing.T) {
	service := &Service{definitions: contentdefs.MustLoad()}
	legacy := json.RawMessage(`{"value":"https://example.org","label":"example.org","errorCorrection":"medium","foregroundColor":"#000000","backgroundColor":"#FFFFFF"}`)
	component, err := service.compileWidgetComponent("qrcode", legacy)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.qr-code" || component.Component.Config["payload"] != "https://example.org" || component.Component.Config["shortLabel"] != "example.org" {
		t.Fatalf("legacy qrcode config did not project: %+v", component.Component)
	}
	callToAction := json.RawMessage(`{"url":"https://example.org","heading":"Scan","body":"Point your camera.","showBody":true,"foregroundColor":"#ffffff","backgroundColor":"#12253a"}`)
	component, err = service.compileWidgetComponent("qr-call-to-action", callToAction)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.qr-code" || component.Component.Config["payload"] != "https://example.org" || component.Component.Config["heading"] != "Scan" || component.Component.Config["instruction"] != "Point your camera." {
		t.Fatalf("call-to-action config did not project: %+v", component.Component)
	}
	hiddenBody := json.RawMessage(`{"url":"https://example.org","heading":"Scan","body":"Point your camera.","showBody":false,"foregroundColor":"#ffffff","backgroundColor":"#12253a"}`)
	component, err = service.compileWidgetComponent("qr-call-to-action", hiddenBody)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.qr-code" || component.Component.Config["instruction"] != "" {
		t.Fatalf("hidden call-to-action body leaked into instruction: %+v", component.Component)
	}
	canonical := json.RawMessage(`{"payload":"https://example.org","heading":"","instruction":"","shortLabel":"","style":"standard","backgroundColor":"#FFFFFF","foregroundColor":"#101418"}`)
	component, err = service.compileWidgetComponent("qr-code", canonical)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.qr-code" || component.RequiredCapabilities["widget.tilecast.qr-code"] != 1 {
		t.Fatalf("canonical qr-code config did not compile: %+v", component)
	}
}

// TestLegacyDisplayProvidersProjectIntoV2 keeps every persisted display
// provider compiling into its V2 component: legacy DisplayWidget keys,
// per-column presentations and card slots all normalize for capable
// Players, while the provider switch keeps serving older ones.
func TestLegacyDisplayProvidersProjectIntoV2(t *testing.T) {
	service := &Service{definitions: contentdefs.MustLoad()}
	list := json.RawMessage(`{"dataSourceId":"11111111-1111-4111-8111-111111111111","primaryField":"title","maximumItems":6,"rowSpacing":"compact","showDividers":true,"textScale":2}`)
	component, err := service.compileWidgetComponent("list", list)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.list" || component.Component.Config["primaryField"] != "title" || component.Component.Config["density"] != "compact" {
		t.Fatalf("legacy list config did not project: %+v", component.Component)
	}
	table := json.RawMessage(`{"dataSourceId":"11111111-1111-4111-8111-111111111111","fields":["title","budget"],"columns":[{"field":"budget","label":"Budget","format":"currency","alignment":"right"}],"maximumItems":10,"showHeader":true}`)
	component, err = service.compileWidgetComponent("table", table)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.table" || component.Component.Config["maximumRows"] != float64(10) {
		t.Fatalf("legacy table config did not project: %+v", component.Component)
	}
	columns, _ := component.Component.Config["columns"].([]any)
	if len(columns) != 1 {
		t.Fatalf("legacy table columns did not project: %+v", component.Component.Config)
	}
	cards := json.RawMessage(`{"dataSourceId":"11111111-1111-4111-8111-111111111111","titleField":"title","badgeField":"status","columns":2,"maximumItems":6,"density":"comfortable","emptyState":"Nothing here."}`)
	component, err = service.compileWidgetComponent("cards", cards)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.cards" || component.Component.Config["titleField"] != "title" || component.Component.Config["emptyText"] != "Nothing here." {
		t.Fatalf("legacy cards config did not project: %+v", component.Component)
	}
	if component.RequiredCapabilities["widget.tilecast.cards"] != 1 {
		t.Fatalf("cards capability missing: %+v", component.RequiredCapabilities)
	}
}

// TestFeedProvidersProjectIntoV2 keeps every persisted feed and news
// provider compiling into its V2 component: news-feed keys project
// directly, source-specific Apps resolve their recipe-managed source into
// the component grant, and rss-ticker content modes become ticker field
// slots, while the template fallback keeps serving older Players.
func TestFeedProvidersProjectIntoV2(t *testing.T) {
	service := &Service{definitions: contentdefs.MustLoad()}
	news := json.RawMessage(`{"sourceId":"11111111-1111-4111-8111-111111111111","heading":"Top stories","maxStories":5,"displayStyle":"featured","showDescription":false,"emptyState":"Quiet today."}`)
	component, err := service.compileWidgetComponent("news-feed", news)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.news" || component.Component.Config["dataSourceId"] != "11111111-1111-4111-8111-111111111111" || component.Component.Config["displayStyle"] != "featured" || component.Component.Config["showSummary"] != false || component.Component.Config["emptyText"] != "Quiet today." {
		t.Fatalf("news-feed config did not project: %+v", component.Component)
	}
	if len(component.Component.DataSources) != 1 || component.Component.DataSources[0] != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("news-feed source grant missing: %+v", component.Component)
	}
	app := json.RawMessage(`{"managedDataSourceId":"22222222-2222-4222-8222-222222222222","feedUrl":"https://example.com/feed.xml","heading":"BBC","maxStories":6,"showDescription":true}`)
	component, err = service.compileWidgetComponent("bbc-news", app)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.news" || component.Component.Config["dataSourceId"] != "22222222-2222-4222-8222-222222222222" || component.Component.Config["heading"] != "BBC" {
		t.Fatalf("news app config did not project: %+v", component.Component)
	}
	if len(component.Component.DataSources) != 1 || component.Component.DataSources[0] != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("news app managed source grant missing: %+v", component.Component)
	}
	ticker := json.RawMessage(`{"managedDataSourceId":"33333333-3333-4333-8333-333333333333","feedUrl":"https://example.com/feed.xml","leadingLabel":"NEWS","contentMode":"title_time","separator":" /// ","speed":"fast","direction":"right","maxStories":12}`)
	component, err = service.compileWidgetComponent("rss-ticker", ticker)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.ticker" || component.Component.Config["primaryField"] != "title" || component.Component.Config["legacyContentMode"] != "title_time" || component.Component.Config["separator"] != " /// " || component.Component.Config["speed"] != "fast" || component.Component.Config["maxItems"] != float64(12) {
		t.Fatalf("rss-ticker config did not project: %+v", component.Component)
	}
	if len(component.Component.DataSources) != 1 || component.Component.DataSources[0] != "33333333-3333-4333-8333-333333333333" {
		t.Fatalf("rss-ticker managed source grant missing: %+v", component.Component)
	}
	if component.RequiredCapabilities["widget.tilecast.ticker"] != 1 {
		t.Fatalf("ticker capability missing: %+v", component.RequiredCapabilities)
	}
	legacy := json.RawMessage(`{"dataSourceId":"44444444-4444-4444-8444-444444444444","fields":["title","source"],"separator":" • "}`)
	component, err = service.compileWidgetComponent("ticker", legacy)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.ticker" {
		t.Fatalf("ticker config did not project: %+v", component.Component)
	}
	if fields, ok := component.Component.Config["legacyFields"].([]any); !ok || len(fields) != 2 || fields[0] != "title" {
		t.Fatalf("ticker legacy fields did not project: %+v", component.Component)
	}
}

// TestLegacyDomainProvidersProjectIntoV2 keeps every persisted domain
// provider compiling into its V2 component: legacy DisplayWidget label and
// value keys, agenda date/time keys and weather toggles all normalize for
// capable Players, while the provider switch keeps serving older ones.
func TestLegacyDomainProvidersProjectIntoV2(t *testing.T) {
	service := &Service{definitions: contentdefs.MustLoad()}
	menu := json.RawMessage(`{"dataSourceId":"11111111-1111-4111-8111-111111111111","labelField":"dish","valueField":"cost","maximumItems":6,"rowSpacing":"compact","emptyState":"Kitchen closed."}`)
	component, err := service.compileWidgetComponent("menu", menu)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.menu-board" || component.Component.Config["titleField"] != "dish" || component.Component.Config["priceField"] != "cost" || component.Component.Config["density"] != "compact" || component.Component.Config["emptyText"] != "Kitchen closed." {
		t.Fatalf("legacy menu config did not project: %+v", component.Component)
	}
	agenda := json.RawMessage(`{"dataSourceId":"11111111-1111-4111-8111-111111111111","titleField":"name","dateField":"day","timeField":"hour","locationField":"room","maximumItems":10}`)
	component, err = service.compileWidgetComponent("agenda", agenda)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.agenda" || component.Component.Config["titleField"] != "name" || component.Component.Config["startField"] != "day" || component.Component.Config["locationField"] != "room" || component.Component.Config["maximumItems"] != float64(10) {
		t.Fatalf("legacy agenda config did not project: %+v", component.Component)
	}
	schedule, err := service.compileWidgetComponent("schedule-board", json.RawMessage(`{"dataSourceId":"11111111-1111-4111-8111-111111111111","cardBackgroundColor":"#19324d"}`))
	if err != nil {
		t.Fatal(err)
	}
	if schedule.Component.Config["cardBackground"] != "#19324d" {
		t.Fatalf("Schedule Board lost its saved card background: %+v", schedule.Component.Config)
	}
	weather := json.RawMessage(`{"dataSourceId":"11111111-1111-4111-8111-111111111111","showLocation":false,"forecastDays":3,"textScale":2}`)
	component, err = service.compileWidgetComponent("weather", weather)
	if err != nil {
		t.Fatal(err)
	}
	if component.Component.Type != "tilecast.weather" || component.Component.Config["showLocation"] != false || component.Component.Config["forecastDays"] != float64(3) {
		t.Fatalf("legacy weather config did not project: %+v", component.Component)
	}
	if component.RequiredCapabilities["widget.tilecast.weather"] != 1 {
		t.Fatalf("weather capability missing: %+v", component.RequiredCapabilities)
	}
}

func TestAutoSkipWidgetsStayOnCompatibilityPresentations(t *testing.T) {
	service := &Service{definitions: contentdefs.MustLoad()}
	for _, test := range []struct {
		provider string
	}{
		{"now-and-next"},
		{"recognition-board"},
		{"schedule-board"},
	} {
		t.Run(test.provider, func(t *testing.T) {
			definition, ok := service.definitions.Widget(test.provider)
			if !ok {
				t.Fatal("Widget definition not found")
			}
			configuration := make(map[string]any, len(definition.DefaultConfiguration)+2)
			for key, value := range definition.DefaultConfiguration {
				configuration[key] = value
			}
			configuration["dataSourceId"] = "11111111-1111-4111-8111-111111111111"
			configuration["autoSkipWhenEmpty"] = true
			raw, err := json.Marshal(configuration)
			if err != nil {
				t.Fatal(err)
			}
			component, err := service.compileWidgetComponent(test.provider, raw)
			if err != nil {
				t.Fatal(err)
			}
			if component != nil {
				t.Fatalf("auto-skip Widget selected component presentation: %+v", component)
			}
			fallback, err := service.compileWidgetPresentation(test.provider, raw)
			if err != nil {
				t.Fatal(err)
			}
			if fallback == nil || fallback.Native == nil || fallback.Native.Root.Props["autoSkipWhenEmpty"] != true || fallback.RequiredCapabilities["playback.auto_skip"] != 1 {
				t.Fatalf("compatibility presentation lost auto-skip behavior: %+v", fallback)
			}
		})
	}
}

func TestPresentationSupportedNeedsSchemaAndVersion(t *testing.T) {
	presentation := &WidgetPresentation{SchemaVersion: 2, Kind: "component", RequiredCapabilities: map[string]int{"widget.tilecast.clock": 2}}
	for _, test := range []struct {
		name   string
		player playerPresentationCapabilities
		want   bool
	}{
		{"not reported", playerPresentationCapabilities{}, false},
		{"schema 1 only", playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1}, Native: map[string]int{"widget.tilecast.clock": 2}}, false},
		{"older component", playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.tilecast.clock": 1}}, false},
		{"exact", playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.tilecast.clock": 2}}, true},
		{"newer", playerPresentationCapabilities{Reported: true, SchemaVersions: []int32{1, 2}, Native: map[string]int{"widget.tilecast.clock": 5}}, true},
	} {
		if got, _ := presentationSupported(presentation, test.player); got != test.want {
			t.Errorf("%s: supported = %v, want %v", test.name, got, test.want)
		}
	}
}
