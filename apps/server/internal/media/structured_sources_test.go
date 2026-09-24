package media

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// TestUploadedCSVContentDrivesRecords documents why saved Data Sources must be
// previewed by id: the uploaded CSV payload parses into records, but the API
// strips that payload from detail responses, so re-parsing a stripped config
// (as an older Layout preview did) yields nothing — hence "No items available".
func TestUploadedCSVContentDrivesRecords(t *testing.T) {
	body := "title,option_2\nGrilled Cheese,Veggie Wrap\n"
	config := StructuredSourceConfig{
		MaxItems: 10,
		Sort:     "source",
		Mapping: &StructuredMapping{
			Title:       "title",
			ValueFields: map[string]string{"option_2": "option_2"},
		},
	}
	records, err := parseCSVRecords([]byte(body), config)
	if err != nil || len(records) != 1 || records[0].Title != "Grilled Cheese" ||
		records[0].Values["option_2"] != "Veggie Wrap" {
		t.Fatalf("records=%#v err=%v", records, err)
	}

	raw, _ := json.Marshal(StructuredSourceConfig{Uploaded: true, UploadedContent: body})
	stripped := stripUploadedContent("csv", raw)
	var got StructuredSourceConfig
	if err := json.Unmarshal(stripped, &got); err != nil {
		t.Fatal(err)
	}
	if got.UploadedContent != "" {
		t.Fatalf("expected uploadedContent to be stripped, got %q", got.UploadedContent)
	}
	if !got.Uploaded {
		t.Fatal("expected uploaded flag to be retained after stripping")
	}
}

func TestStructuredSourceParsers(t *testing.T) {
	config := StructuredSourceConfig{MaxItems: 10, Sort: "source", Mapping: &StructuredMapping{RootList: "/items", Title: "/name", Subtitle: "/room"}}
	jsonRecords, err := parseJSONRecords([]byte(`{"items":[{"name":"Lunch","room":"Cafeteria"}]}`), config)
	if err != nil || len(jsonRecords) != 1 || jsonRecords[0].Title != "Lunch" || jsonRecords[0].Subtitle != "Cafeteria" {
		t.Fatalf("json records=%#v err=%v", jsonRecords, err)
	}
	config.Mapping = &StructuredMapping{Title: "name", Subtitle: "room"}
	csvRecords, err := parseCSVRecords([]byte("name,room\nLunch,Cafeteria\n"), config)
	if err != nil || len(csvRecords) != 1 || csvRecords[0].Title != "Lunch" {
		t.Fatalf("csv records=%#v err=%v", csvRecords, err)
	}
	feedRecords, err := parseFeed([]byte(`<?xml version="1.0"?><rss><channel><item><title>Board news</title><description><![CDATA[<b>Approved</b>]]></description><link>https://example.com/news</link></item></channel></rss>`), config)
	if err != nil || len(feedRecords) != 1 || feedRecords[0].Description != "Approved" || !strings.HasPrefix(feedRecords[0].Link, "https://") {
		t.Fatalf("feed records=%#v err=%v", feedRecords, err)
	}
}

func TestFeedParserNormalizesAtomMediaAndDeduplicatesEntries(t *testing.T) {
	config := StructuredSourceConfig{MaxItems: 10, Sort: "source"}
	raw := []byte(`<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>Example Wire</title>
  <entry><id>story-1</id><title>First story</title><summary>Summary</summary><updated>2026-08-08T12:30:00Z</updated><author><name>Reporter</name></author><link href="https://example.com/first"/><media:thumbnail url="https://cdn.example.com/first.jpg"/></entry>
  <entry><id>story-1</id><title>Duplicate story</title></entry>
</feed>`)
	records, err := parseFeed(raw, config)
	if err != nil || len(records) != 1 {
		t.Fatalf("records=%#v err=%v", records, err)
	}
	record := records[0]
	if record.ID == "" || record.Title != "First story" || record.Description != "Summary" || record.Author != "Reporter" || record.Date != "2026-08-08T12:30:00Z" || record.Source != "Example Wire" || record.ImageURL != "https://cdn.example.com/first.jpg" {
		t.Fatalf("record=%#v", record)
	}
}

func TestFeedParserBoundsEntriesAndRejectsMalformedXML(t *testing.T) {
	var items strings.Builder
	for index := 0; index < structuredMaxItems+25; index++ {
		items.WriteString(fmt.Sprintf(`<item><guid>story-%d</guid><title>Story %d</title></item>`, index, index))
	}
	records, err := parseFeed([]byte(`<rss><channel><title>Wire</title>`+items.String()+`</channel></rss>`), StructuredSourceConfig{MaxItems: structuredMaxItems, Sort: "source"})
	if err != nil || len(records) != structuredMaxItems {
		t.Fatalf("count=%d err=%v", len(records), err)
	}
	if _, err = parseFeed([]byte(`<rss><channel><item>`), StructuredSourceConfig{MaxItems: 10}); err == nil {
		t.Fatal("malformed XML was accepted")
	}
}

func TestJSONPointerIsConstrained(t *testing.T) {
	value, err := jsonPointer(map[string]any{"a/b": []any{"ok"}}, "/a~1b/0")
	if err != nil || value != "ok" {
		t.Fatalf("value=%v err=%v", value, err)
	}
	if _, err = jsonPointer(map[string]any{}, "$.items"); err == nil {
		t.Fatal("expected non-pointer path to fail")
	}
}

func TestSelectStructuredRecordsUsesConfiguredLocalDate(t *testing.T) {
	records := []StructuredRecord{
		{ID: "monday", Date: "2026-11-02"},
		{ID: "sunday", Date: "2026-11-01"},
	}
	selection := DateSelection{
		Enabled:         true,
		Timezone:        "America/New_York",
		Mode:            "today",
		NoMatchBehavior: "empty",
	}

	selected := selectStructuredRecords(records, selection, "2026-11-01")
	if len(selected) != 1 || selected[0].ID != "sunday" {
		t.Fatalf("selected=%#v", selected)
	}
}

func TestSelectStructuredRecordsDoesNotReusePastByDefault(t *testing.T) {
	records := []StructuredRecord{{ID: "yesterday", Date: "2026-08-02"}}
	selection := DateSelection{
		Enabled:         true,
		Timezone:        "America/New_York",
		Mode:            "today",
		NoMatchBehavior: "empty",
	}

	if selected := selectStructuredRecords(records, selection, "2026-08-03"); len(selected) != 0 {
		t.Fatalf("expected empty selection, got %#v", selected)
	}
	selection.NoMatchBehavior = "last_known_good"
	selected := selectStructuredRecords(records, selection, "2026-08-03")
	if len(selected) != 1 || selected[0].ID != "yesterday" {
		t.Fatalf("selected=%#v", selected)
	}
}

func TestStructuredDateParsingSupportsExplicitOrderAndSafeAutoDetection(t *testing.T) {
	cases := []struct {
		name, value, format, want string
	}{
		{name: "ISO date", value: "2026-04-03", format: "auto", want: "2026-04-03"},
		{name: "RFC3339 datetime", value: "2026-04-03T12:30:00+02:00", format: "auto", want: "2026-04-03T10:30:00Z"},
		{name: "named month", value: "Apr 3, 2026", format: "auto", want: "2026-04-03"},
		{name: "unambiguous day first", value: "13/04/2026", format: "auto", want: "2026-04-13"},
		{name: "unambiguous month first", value: "04/13/2026", format: "auto", want: "2026-04-13"},
		{name: "legacy month first zero padded", value: "03/04/2026", format: "us_date", want: "2026-03-04"},
		{name: "legacy month first short", value: "3/4/2026", format: "us_short", want: "2026-03-04"},
		{name: "explicit day first zero padded", value: "03/04/2026", format: "day_first_date", want: "2026-04-03"},
		{name: "explicit day first short", value: "3/4/2026", format: "day_first_short", want: "2026-04-03"},
		{name: "existing named month id", value: "03-Apr-2026", format: "day_month_name", want: "2026-04-03"},
		{name: "ambiguous auto remains text", value: "03/04/2026", format: "auto", want: "03/04/2026"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := normalizeStructuredDate(test.value, DateSelection{DateFormat: test.format})
			if got != test.want {
				t.Fatalf("normalizeStructuredDate(%q, %q) = %q, want %q", test.value, test.format, got, test.want)
			}
		})
	}
}

func TestStructuredCurrentWeekUsesRegionalFirstDay(t *testing.T) {
	records := []StructuredRecord{
		{ID: "sunday", Date: "2026-07-12"},
		{ID: "monday", Date: "2026-07-13"},
		{ID: "friday", Date: "2026-07-17"},
		{ID: "next-sunday", Date: "2026-07-19"},
	}
	selection := DateSelection{Enabled: true, Timezone: "UTC", Mode: "current_week"}
	cases := []struct {
		locale string
		want   []string
	}{
		{locale: "en-US", want: []string{"sunday", "monday", "friday"}},
		{locale: "en-GB", want: []string{"monday", "friday", "next-sunday"}},
		{locale: "de-DE", want: []string{"monday", "friday", "next-sunday"}},
		{locale: "dv-MV", want: []string{"sunday", "monday"}},
	}
	for _, test := range cases {
		t.Run(test.locale, func(t *testing.T) {
			firstDay := firstDayForRegionalSettings("locale", test.locale)
			selected := selectStructuredRecords(records, selection, "2026-07-15", firstDay)
			got := make([]string, 0, len(selected))
			for _, record := range selected {
				got = append(got, record.ID)
			}
			if strings.Join(got, ",") != strings.Join(test.want, ",") {
				t.Fatalf("selected=%v, want %v", got, test.want)
			}
		})
	}
}

func TestStructuredSourceParsersAllowDataOnlyMappings(t *testing.T) {
	mapping := StructuredMapping{Date: "date", ValueFields: map[string]string{"option_1": "option_1", "option_2": "option_2"}}
	if err := validateStructuredMapping(mapping, "csv"); err != nil {
		t.Fatalf("data-only mapping rejected: %v", err)
	}
	config := StructuredSourceConfig{MaxItems: 10, Sort: "source", Mapping: &mapping, DateSelection: DateSelection{Enabled: true, DateFormat: "iso_date", Timezone: "America/New_York", Mode: "today", NoMatchBehavior: "empty"}}
	records, err := parseCSVRecords([]byte("date,option_1,option_2\n2026-08-03,Chicken tenders,Cheeseburger\n"), config)
	if err != nil || len(records) != 1 {
		t.Fatalf("records=%#v err=%v", records, err)
	}
	if records[0].Title != "" || records[0].Values["option_1"] != "Chicken tenders" || records[0].Values["option_2"] != "Cheeseburger" {
		t.Fatalf("unexpected data-only record: %#v", records[0])
	}
}

// A typed value is what a Widget binds to, so the fields a Source advertises have to carry
// the type the author declared. Reported as text, a mapped start time is invisible to
// every picker that asks for a datetime — the Widget's dropdown is simply empty.
func TestStructuredValueFieldsAdvertiseTheirDeclaredType(t *testing.T) {
	config := StructuredSourceConfig{Mapping: &StructuredMapping{
		Title:           "/title",
		ValueFields:     map[string]string{"startTime": "/startTime", "endTime": "/endTime", "room": "/room"},
		ValueFieldTypes: map[string]string{"startTime": "datetime", "endTime": "datetime"},
	}, Fields: StructuredFields{Title: true}}
	raw, _ := json.Marshal(config)
	catalog, err := contentdefs.New(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{}
	service.SetContentDefinitions(catalog)
	fields := service.availableDataSourceFields("json", raw)
	types := map[string]string{}
	keys := []string{}
	for _, field := range fields {
		types[field.Key] = field.Type
		keys = append(keys, field.Key)
	}
	if types["startTime"] != "datetime" || types["endTime"] != "datetime" || types["room"] != "text" {
		t.Fatalf("fields=%#v", fields)
	}
	// Map iteration is random; a picker whose options reorder between requests is not.
	if strings.Join(keys, ",") != "title,endTime,room,startTime" {
		t.Fatalf("field order=%q", strings.Join(keys, ","))
	}
}

func TestStructuredMappingRejectsUnusableValueTypes(t *testing.T) {
	unmapped := StructuredMapping{Title: "title", ValueFieldTypes: map[string]string{"startTime": "datetime"}}
	if err := validateStructuredMapping(unmapped, "csv"); err == nil {
		t.Fatal("expected a type naming an unmapped value to be rejected")
	}
	unknown := StructuredMapping{Title: "title", ValueFields: map[string]string{"startTime": "startTime"}, ValueFieldTypes: map[string]string{"startTime": "instant"}}
	if err := validateStructuredMapping(unknown, "csv"); err == nil {
		t.Fatal("expected an unknown value type to be rejected")
	}
}

// A datetime value reaches the Player as an instant whatever spelling the feed used, and a
// value that cannot be read stays as text rather than failing the whole refresh.
func TestStructuredDatetimeValuesNormalizeBestEffort(t *testing.T) {
	mapping := StructuredMapping{
		Title:           "title",
		ValueFields:     map[string]string{"startTime": "start", "endTime": "end"},
		ValueFieldTypes: map[string]string{"startTime": "datetime", "endTime": "datetime"},
	}
	config := StructuredSourceConfig{MaxItems: 10, Sort: "source", Mapping: &mapping}
	records, err := parseCSVRecords([]byte("title,start,end\nPeriod 1,2026-07-30 08:25,first bell\n"), config)
	if err != nil || len(records) != 1 {
		t.Fatalf("records=%#v err=%v", records, err)
	}
	if records[0].Values["startTime"] != "2026-07-30T08:25:00Z" {
		t.Fatalf("startTime=%q", records[0].Values["startTime"])
	}
	if records[0].Values["endTime"] != "first bell" {
		t.Fatalf("endTime=%q", records[0].Values["endTime"])
	}
}
