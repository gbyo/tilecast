package media

import (
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func alertsSpec(t *testing.T) contentdefs.FetchSpec {
	t.Helper()
	definition, ok := contentdefs.MustLoad().DataSource("weather-alerts-us")
	if !ok || definition.Fetch == nil {
		t.Fatal("weather-alerts-us definition is missing a fetch specification")
	}
	return *definition.Fetch
}

func TestHTTPRecordsSubstitutesConfiguredPlaceholders(t *testing.T) {
	target, err := buildHTTPRecordsURL(alertsSpec(t), map[string]any{"area": "OH", "severity": "Severe"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(target, "https://api.weather.gov/alerts/active?") {
		t.Fatalf("expected the release host to be preserved, got %s", target)
	}
	if !strings.Contains(target, "area=OH") || !strings.Contains(target, "severity=Severe") {
		t.Fatalf("expected both placeholders substituted, got %s", target)
	}
}

// TestHTTPRecordsEscapesAuthorValues is the security-relevant case: a configuration value
// must never be able to add a path segment, another query parameter, or a different host.
func TestHTTPRecordsEscapesAuthorValues(t *testing.T) {
	for _, hostile := range []string{
		"OH&area=XX",
		"OH/../../evil",
		"OH#fragment",
		"OH?x=1",
		"OH severity=Extreme",
		"//evil.example.com/",
	} {
		target, err := buildHTTPRecordsURL(alertsSpec(t), map[string]any{"area": hostile, "severity": "Severe"})
		if err != nil {
			continue
		}
		if !strings.HasPrefix(target, "https://api.weather.gov/alerts/active?") {
			t.Fatalf("value %q escaped the pinned endpoint: %s", hostile, target)
		}
		query := strings.SplitN(target, "?", 2)[1]
		if strings.Count(query, "area=") != 1 || strings.Count(query, "severity=") != 1 {
			t.Fatalf("value %q introduced an extra parameter: %s", hostile, target)
		}
		// No delimiter from the value may survive into the request unencoded.
		if strings.ContainsAny(query[strings.Index(query, "area=")+len("area="):strings.Index(query, "&severity=")], "&?#/ ") {
			t.Fatalf("value %q reached the query unescaped: %s", hostile, target)
		}
	}
}

func TestHTTPRecordsRejectsMissingPlaceholderValues(t *testing.T) {
	if _, err := buildHTTPRecordsURL(alertsSpec(t), map[string]any{"severity": "Severe"}); err == nil {
		t.Fatal("expected a missing placeholder to be rejected")
	}
	if _, err := buildHTTPRecordsURL(alertsSpec(t), map[string]any{"area": "  ", "severity": "Severe"}); err == nil {
		t.Fatal("expected a blank placeholder to be rejected")
	}
}

func TestHTTPRecordsMapsJSONRecords(t *testing.T) {
	spec := alertsSpec(t)
	body := []byte(`{"features":[
		{"properties":{"event":"Winter Storm Warning","headline":"Snow tonight","severity":"Severe","areaDesc":"Franklin","effective":"2026-01-05T18:00:00Z","expires":"2026-01-06T12:00:00Z"}},
		{"properties":{"event":"Wind Advisory","headline":"Gusts to 45 mph","severity":"Moderate","areaDesc":"Delaware","effective":"2026-01-05T19:00:00Z","expires":"2026-01-06T06:00:00Z"}}
	]}`)
	rows, err := httpRecordsFromJSON(body, spec, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected two rows, got %d", len(rows))
	}
	if rows[0]["title"] != "Winter Storm Warning" || rows[0]["area"] != "Franklin" || rows[0]["end"] != "2026-01-06T12:00:00Z" {
		t.Fatalf("nested mapping did not resolve: %#v", rows[0])
	}
}

func TestHTTPRecordsPreviewSelectsDateAndActiveRangeRows(t *testing.T) {
	catalog := contentdefs.MustLoad()
	holidayDefinition, ok := catalog.DataSource("public-holidays")
	if !ok {
		t.Fatal("public-holidays definition is missing")
	}
	holidayPayload := TypedDatasetPayload{Datasets: []TypedDataset{{ID: "records", Records: []TypedRecord{
		{ID: "holiday-1", Values: map[string]string{"date": "2026-04-01"}},
		{ID: "holiday-2", Values: map[string]string{"date": "2026-04-02"}},
	}}}}
	selectedHolidays := httpRecordsPreviewForDate(holidayPayload, holidayDefinition, "2026-04-02")
	if got := selectedHolidays.Datasets[0].Records; len(got) != 1 || got[0].ID != "holiday-2" {
		t.Fatalf("holiday preview records = %+v", got)
	}

	alertDefinition, ok := catalog.DataSource("weather-alerts-us")
	if !ok {
		t.Fatal("weather-alerts-us definition is missing")
	}
	alertPayload := TypedDatasetPayload{Datasets: []TypedDataset{{ID: "records", Records: []TypedRecord{
		{ID: "active", Values: map[string]string{"start": "2026-04-01T18:00:00Z", "end": "2026-04-02T12:00:00Z"}},
		{ID: "expired", Values: map[string]string{"start": "2026-04-01T00:00:00Z", "end": "2026-04-01T12:00:00Z"}},
		{ID: "future", Values: map[string]string{"start": "2026-04-03T00:00:00Z", "end": "2026-04-04T00:00:00Z"}},
	}}}}
	selectedAlerts := httpRecordsPreviewForDate(alertPayload, alertDefinition, "2026-04-02")
	if got := selectedAlerts.Datasets[0].Records; len(got) != 1 || got[0].ID != "active" {
		t.Fatalf("alert preview records = %+v", got)
	}
}

func TestHTTPRecordsHonorsTheRecordLimit(t *testing.T) {
	spec := alertsSpec(t)
	body := []byte(`{"features":[
		{"properties":{"event":"One"}},{"properties":{"event":"Two"}},{"properties":{"event":"Three"}}
	]}`)
	rows, err := httpRecordsFromJSON(body, spec, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected the limit to bound the result, got %d rows", len(rows))
	}
}

func TestHTTPRecordsRejectsAResponseThatIsNotAList(t *testing.T) {
	spec := alertsSpec(t)
	if _, err := httpRecordsFromJSON([]byte(`{"features":{"event":"One"}}`), spec, 10); err == nil {
		t.Fatal("expected an object at the records path to be rejected")
	}
	if _, err := httpRecordsFromJSON([]byte(`not json`), spec, 10); err == nil {
		t.Fatal("expected invalid JSON to be rejected")
	}
	if _, err := httpRecordsFromJSON([]byte(`{"other":[]}`), spec, 10); err == nil {
		t.Fatal("expected a missing records path to be rejected")
	}
}

func TestHTTPRecordsMapsCSVColumnsByHeader(t *testing.T) {
	definition, ok := contentdefs.MustLoad().DataSource("google-sheet")
	if !ok || definition.Fetch == nil {
		t.Fatal("google-sheet definition is missing a fetch specification")
	}
	body := []byte("\ufeffdate,title,detail,ignored\n2026-04-01,Book Sale,Front lobby,x\n2026-04-02,Story Time,Room 2,y\n")
	rows, err := httpRecordsFromCSV(body, *definition.Fetch, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected two rows, got %d", len(rows))
	}
	if rows[0]["title"] != "Book Sale" || rows[0]["detail"] != "Front lobby" || rows[0]["date"] != "2026-04-01" {
		t.Fatalf("columns were not mapped by header name: %#v", rows[0])
	}
	if _, present := rows[0]["ignored"]; present {
		t.Fatal("an unmapped column reached the record")
	}
}

func TestHTTPRecordsRejectsMalformedCSV(t *testing.T) {
	definition, ok := contentdefs.MustLoad().DataSource("google-sheet")
	if !ok || definition.Fetch == nil {
		t.Fatal("google-sheet definition is missing a fetch specification")
	}
	// The unterminated quote swallows the rest of the body. Returning the
	// valid prefix would publish a partial snapshot as a successful refresh.
	body := []byte("date,title,detail\n2026-04-01,Good record,Front lobby\n2026-04-02,\"unterminated,Room 2\n2026-04-03,Later record,Hall\n")
	rows, err := httpRecordsFromCSV(body, *definition.Fetch, 10)
	if err == nil {
		t.Fatalf("expected malformed CSV to fail, got %d rows", len(rows))
	}
}

// TestEveryFetchDefinitionPinsItsHost is the standing guard on the adapter's core promise:
// no release definition may let an author choose which service is contacted.
func TestEveryFetchDefinitionPinsItsHost(t *testing.T) {
	catalog := contentdefs.MustLoad()
	checked := 0
	for _, definition := range catalog.DataSources {
		if definition.Fetch == nil {
			continue
		}
		checked++
		template := definition.Fetch.URLTemplate
		host := template
		if index := strings.Index(strings.TrimPrefix(template, "https://"), "/"); index >= 0 {
			host = strings.TrimPrefix(template, "https://")[:index]
		}
		if !strings.HasPrefix(template, "https://") {
			t.Errorf("%s: fetch template is not HTTPS: %s", definition.ID, template)
		}
		if strings.ContainsAny(host, "{}") {
			t.Errorf("%s: fetch host contains a placeholder: %s", definition.ID, host)
		}
	}
	if checked == 0 {
		t.Fatal("expected the embedded catalog to contain fetch definitions")
	}
}
