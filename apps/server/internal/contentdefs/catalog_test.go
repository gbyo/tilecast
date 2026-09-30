package contentdefs

import "testing"

func TestReleaseDefinitionsValidateAndFingerprintDeterministically(t *testing.T) {
	first, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	second, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if first.Fingerprint == "" || first.Fingerprint != second.Fingerprint {
		t.Fatal("content-definition fingerprint is not deterministic")
	}
	if _, ok := first.Widget("school-status-banner"); !ok {
		t.Fatal("School Status Banner definition is missing")
	}
	if _, ok := first.DataSource("school-status"); !ok {
		t.Fatal("School Status Data Source definition is missing")
	}
	for _, id := range []string{"news-feed", "espn", "bbc-news", "sky-news", "the-guardian", "custom-rss", "rss-ticker", "atom-feed", "google-sheets-display", "google-slides", "canva", "grafana", "power-bi", "tableau-public", "looker-studio", "airtable", "smartsheet"} {
		definition, ok := first.Widget(id)
		if !ok || !definition.Availability.IsEnabled() {
			t.Fatalf("enabled App definition %q is missing", id)
		}
	}
	if definition, ok := first.Widget("notion"); !ok || definition.Availability.IsEnabled() || definition.Availability.Reason == "" {
		t.Fatal("Notion must remain discoverable with an explicit disabled reason")
	}
	display, ok := first.Widget("google-sheets-display")
	if !ok || display.Name != "Google Sheets — Display" {
		t.Fatalf("Google Sheets visual embed must carry the Display name: %+v", display)
	}
	if _, ok := first.Widget("google-sheets-data"); ok {
		t.Fatal("the Google Sheets Data placeholder must not remain a third Widget concept")
	}
	if _, ok := first.DataSource("google-sheet"); !ok {
		t.Fatal("the Google Sheet structured Data Source is missing")
	}
}

func TestMediaVariantConfigurationKeysIncludeGenericAndNestedFields(t *testing.T) {
	fields := []FieldDefinition{
		{Key: "logoAssetId", Control: "media_asset"},
		{Key: "backgroundAssetId", Control: "media_asset"},
		{Key: "brandMark", Control: "media_asset"},
		{Key: "slides", Control: "repeating_group", ItemFields: []FieldDefinition{
			{Key: "posterAssetId", Control: "media_asset"},
		}},
	}
	for _, key := range []string{"logoVariantId", "backgroundVariantId", "brandMarkVariantId", "posterVariantId"} {
		if !IsDerivedConfigurationKey(fields, key) {
			t.Errorf("%q was not recognized as a derived media variant key", key)
		}
	}
	if IsLevelDerivedConfigurationKey(fields, "posterVariantId") {
		t.Fatal("a repeating-group alias was treated as a root configuration key")
	}
	if !IsLevelDerivedConfigurationKey(fields, "logoVariantId") {
		t.Fatal("a root media alias was not recognized at the root")
	}
	if IsDerivedConfigurationKey(fields, "unrelatedVariantId") {
		t.Fatal("an undeclared media variant key was recognized")
	}
}

func TestMediaVariantConfigurationKeyCannotShadowAnAuthoredField(t *testing.T) {
	fields := []FieldDefinition{
		{Key: "logoAssetId", Control: "media_asset"},
		{Key: "logoVariantId", Control: "text"},
	}
	if err := validateSchemaFields(fields); err == nil {
		t.Fatal("a media variant alias shadowing an authored field was accepted")
	}
}

func TestCatalogRejectsDuplicateIDsAndUnsupportedControls(t *testing.T) {
	duplicate := &Catalog{
		Widgets: []WidgetDefinition{
			{ID: "same", Version: 1, Name: "One", Category: "Test", Runtime: "native", LegacyEditor: true, PresentationSchemaVersion: 1, RequiredCapabilities: map[string]int{"content.text": 1}},
			{ID: "same", Version: 1, Name: "Two", Category: "Test", Runtime: "native", LegacyEditor: true, PresentationSchemaVersion: 1, RequiredCapabilities: map[string]int{"content.text": 1}},
		},
		widgetsByID: map[string]WidgetDefinition{}, dataSourcesByID: map[string]DataSourceDefinition{},
	}
	if err := duplicate.validate(); err == nil {
		t.Fatal("duplicate definition ids were accepted")
	}
	unsupported := &Catalog{
		DataSources: []DataSourceDefinition{{
			ID: "bad", Version: 1, Name: "Bad", Category: "Test", AdapterID: "manual_object",
			ConfigurationSchema: ConfigurationSchema{Fields: []FieldDefinition{{Key: "script", Label: "Script", Control: "javascript"}}},
			OutputSchema:        OutputSchema{Kind: "object"},
		}},
		widgetsByID: map[string]WidgetDefinition{}, dataSourcesByID: map[string]DataSourceDefinition{},
	}
	if err := unsupported.validate(); err == nil {
		t.Fatal("unsupported form control was accepted")
	}
}
