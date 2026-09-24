package media

import (
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func announcementsDefinition(t *testing.T) contentdefs.DataSourceDefinition {
	t.Helper()
	definition, ok := contentdefs.MustLoad().DataSource("announcements")
	if !ok {
		t.Fatal("announcements definition is missing from the embedded catalog")
	}
	if definition.AdapterID != "manual_records" {
		t.Fatalf("expected the manual_records adapter, got %q", definition.AdapterID)
	}
	return definition
}

func rowValues(payload TypedDatasetPayload, key string) []string {
	if len(payload.Datasets) == 0 {
		return nil
	}
	values := make([]string, 0, len(payload.Datasets[0].Records))
	for _, record := range payload.Datasets[0].Records {
		values = append(values, record.Values[key])
	}
	return values
}

func TestManualRecordsHidesRowsOutsideTheirWindow(t *testing.T) {
	definition := announcementsDefinition(t)
	now := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	configuration := map[string]any{"records": []any{
		map[string]any{"title": "Live now", "priority": 0},
		map[string]any{"title": "Not yet", "priority": 0, "publishAt": "2026-03-10T18:00:00Z"},
		map[string]any{"title": "Already over", "priority": 0, "expiresAt": "2026-03-10T09:00:00Z"},
		map[string]any{"title": "Ends later", "priority": 0, "expiresAt": "2026-03-10T15:00:00Z"},
	}}
	projection := manualRecordsPayload(definition, configuration, now)
	titles := rowValues(projection.Payload, "title")
	if len(titles) != 2 {
		t.Fatalf("expected two visible rows, got %v", titles)
	}
	for _, title := range titles {
		if title == "Not yet" || title == "Already over" {
			t.Fatalf("row outside its window reached the payload: %v", titles)
		}
	}
	if projection.Visible != 2 {
		t.Fatalf("expected a visible count of 2, got %d", projection.Visible)
	}
}

func TestManualRecordsReportsTheNextWindowBoundary(t *testing.T) {
	definition := announcementsDefinition(t)
	now := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	configuration := map[string]any{"records": []any{
		map[string]any{"title": "Ends at three", "priority": 0, "expiresAt": "2026-03-10T15:00:00Z"},
		map[string]any{"title": "Starts at six", "priority": 0, "publishAt": "2026-03-10T18:00:00Z"},
		map[string]any{"title": "Never changes", "priority": 0},
	}}
	projection := manualRecordsPayload(definition, configuration, now)
	if projection.NextBoundary == nil {
		t.Fatal("expected a next boundary when rows enter or leave on a schedule")
	}
	want := time.Date(2026, 3, 10, 15, 0, 0, 0, time.UTC)
	if !projection.NextBoundary.Equal(want) {
		t.Fatalf("expected the earliest boundary %s, got %s", want, projection.NextBoundary)
	}
}

func TestManualRecordsHasNoBoundaryWithoutWindows(t *testing.T) {
	definition := announcementsDefinition(t)
	configuration := map[string]any{"records": []any{
		map[string]any{"title": "Always", "priority": 0},
	}}
	projection := manualRecordsPayload(definition, configuration, time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC))
	if projection.NextBoundary != nil {
		t.Fatalf("expected no boundary when nothing is scheduled, got %s", projection.NextBoundary)
	}
}

func TestMenuItemCurrencyMetadataFlowsToTypedPreview(t *testing.T) {
	definition, ok := contentdefs.MustLoad().DataSource("menu-items")
	if !ok {
		t.Fatal("menu-items definition is missing")
	}
	configuration := map[string]any{
		"priceCurrency": "EUR",
		"records":       []any{map[string]any{"title": "Soup", "price": 4.5}},
	}
	payload := manualRecordsPayload(definition, configuration, time.Now()).Payload
	fields := payload.Datasets[0].Fields
	for _, field := range fields {
		if field.Key == "price" {
			if field.Currency != "EUR" {
				t.Fatalf("expected EUR field metadata, got %#v", field)
			}
			return
		}
	}
	t.Fatal("price field is missing")
}

func TestMenuItemsRequireCurrencyForNewSourceButKeepLegacyConfigReadable(t *testing.T) {
	definition, ok := contentdefs.MustLoad().DataSource("menu-items")
	if !ok {
		t.Fatal("menu-items definition is missing")
	}
	if err := validateDefinitionCurrencyMetadata(definition, map[string]any{"priceCurrency": ""}, nil); err == nil {
		t.Fatal("new Menu Items source must declare a price currency")
	}
	if err := validateDefinitionCurrencyMetadata(definition, map[string]any{"priceCurrency": "EUR"}, nil); err != nil {
		t.Fatalf("explicit EUR source should be accepted: %v", err)
	}
	if err := validateDefinitionCurrencyMetadata(
		definition,
		map[string]any{"priceCurrency": ""},
		map[string]any{"priceCurrency": ""},
	); err != nil {
		t.Fatalf("legacy source without metadata should remain editable: %v", err)
	}
}

func TestManualRecordsSortsByPriorityThenDate(t *testing.T) {
	definition := announcementsDefinition(t)
	now := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	configuration := map[string]any{"records": []any{
		map[string]any{"title": "Routine", "priority": 0},
		map[string]any{"title": "Urgent", "priority": 50},
		map[string]any{"title": "Also urgent", "priority": 50},
	}}
	titles := rowValues(manualRecordsPayload(definition, configuration, now).Payload, "title")
	if len(titles) != 3 || titles[0] != "Urgent" || titles[1] != "Also urgent" || titles[2] != "Routine" {
		t.Fatalf("expected priority ordering with authored order preserved inside a tier, got %v", titles)
	}
}

// TestManualRecordsEmitsTheRecordsDataset pins the dataset identity the declarative
// presentation templates bind to. Changing it would silently blank every Widget that reads
// a manual_records Data Source.
func TestManualRecordsEmitsTheRecordsDataset(t *testing.T) {
	definition := announcementsDefinition(t)
	projection := manualRecordsPayload(definition, map[string]any{"records": []any{
		map[string]any{"title": "One", "priority": 0},
	}}, time.Now())
	if len(projection.Payload.Datasets) != 1 {
		t.Fatalf("expected exactly one dataset, got %d", len(projection.Payload.Datasets))
	}
	dataset := projection.Payload.Datasets[0]
	if dataset.ID != "records" || dataset.Kind != "records" {
		t.Fatalf("expected a records dataset named \"records\", got id=%q kind=%q", dataset.ID, dataset.Kind)
	}
	if len(dataset.Fields) != len(definition.OutputSchema.Fields) {
		t.Fatalf("expected every declared output field, got %d of %d", len(dataset.Fields), len(definition.OutputSchema.Fields))
	}
}

// TestManualRecordsIgnoresUndeclaredWindowKeys proves the window convention is driven by
// the output schema: a definition that does not declare expiresAt is never filtered by a
// stray configuration value of that name.
func TestManualRecordsIgnoresUndeclaredWindowKeys(t *testing.T) {
	definition, ok := contentdefs.MustLoad().DataSource("directory-entries")
	if !ok {
		t.Fatal("directory-entries definition is missing")
	}
	for _, field := range definition.OutputSchema.Fields {
		if field.Key == manualRecordsExpiresAtKey {
			t.Skip("directory-entries now declares an expiry window")
		}
	}
	configuration := map[string]any{"records": []any{
		map[string]any{"title": "Reception", "priority": 0, "expiresAt": "2000-01-01T00:00:00Z"},
	}}
	projection := manualRecordsPayload(definition, configuration, time.Now())
	if projection.Visible != 1 {
		t.Fatalf("expected the row to stay visible, got %d rows", projection.Visible)
	}
}

func TestManualRecordsBoundsTheRowCount(t *testing.T) {
	definition := announcementsDefinition(t)
	rows := make([]any, 0, manualRecordsMaximumRecords+25)
	for index := 0; index < manualRecordsMaximumRecords+25; index++ {
		rows = append(rows, map[string]any{"title": "Row", "priority": 0})
	}
	projection := manualRecordsPayload(definition, map[string]any{"records": rows}, time.Now())
	if projection.Visible != manualRecordsMaximumRecords {
		t.Fatalf("expected the row count to be bounded at %d, got %d", manualRecordsMaximumRecords, projection.Visible)
	}
}
