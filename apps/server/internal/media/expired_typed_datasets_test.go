package media

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

func TestExpiredTypedDatasetsKeepIdentityAndDropValues(t *testing.T) {
	cachedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	payload, err := json.Marshal(TypedDatasetPayload{Datasets: []TypedDataset{
		{ID: "departures", Kind: "records", Fields: transitDepartureFields(), Records: []TypedRecord{{ID: "a", Values: map[string]string{"x": "y"}}}, CachedAt: &cachedAt, Timezone: "America/Chicago", UsingCachedData: true},
		{ID: "current", Kind: "object", Values: map[string]string{"aqi": "4"}, Units: map[string]string{"aqi": "idx"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	got := expiredTypedDatasets("transit", nil, payload, contentdefs.DataSourceDefinition{}, true)
	if len(got) != 2 || got[0].ID != "departures" || got[1].ID != "current" || got[1].Kind != "object" {
		t.Fatalf("dataset identity was not preserved: %#v", got)
	}
	if len(got[0].Fields) == 0 || got[0].Timezone != "America/Chicago" || got[0].CachedAt == nil || got[1].Units["aqi"] != "idx" {
		t.Fatalf("dataset schema was not preserved: %#v", got)
	}
	for _, dataset := range got {
		if !dataset.Unavailable || dataset.UsingCachedData || len(dataset.Records) != 0 || len(dataset.Values) != 0 {
			t.Fatalf("expired dataset must be unavailable without stale values: %#v", dataset)
		}
	}
	if pending := expiredTypedDatasets("transit", nil, payload, contentdefs.DataSourceDefinition{}, false); pending[0].Unavailable {
		t.Fatal("an expired cache without a recorded failure must not be marked unavailable")
	}
}

func TestExpiredTypedDatasetsRebuildShapeWithoutCachedPayload(t *testing.T) {
	definition, ok := contentdefs.MustLoad().DataSource("weather-alerts-us")
	if !ok {
		t.Fatal("weather-alerts-us definition is missing")
	}
	cases := []struct {
		name     string
		provider string
		raw      string
		def      contentdefs.DataSourceDefinition
		ids      []string
	}{
		{"http records", "weather-alerts-us", `{"area":"OH","severity":"Severe"}`, definition, []string{"records"}},
		{"transit", "transit", `{"timezone":"America/Chicago"}`, contentdefs.DataSourceDefinition{}, []string{"departures", "alerts"}},
		{"cap alerts", "cap_alerts", `{}`, contentdefs.DataSourceDefinition{}, []string{"alerts"}},
		{"air quality", "air_quality", `{"aqiStandard":"us","pollutants":["pm2_5"],"timezone":"UTC"}`, contentdefs.DataSourceDefinition{}, []string{"current", "hourly"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := expiredTypedDatasets(test.provider, json.RawMessage(test.raw), nil, test.def, true)
			if len(got) != len(test.ids) {
				t.Fatalf("datasets = %#v, want ids %v", got, test.ids)
			}
			for index, dataset := range got {
				if dataset.ID != test.ids[index] || len(dataset.Fields) == 0 || !dataset.Unavailable {
					t.Fatalf("dataset %d = %#v", index, dataset)
				}
			}
		})
	}
}
