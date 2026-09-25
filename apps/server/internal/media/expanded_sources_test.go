package media

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestManualSourceNormalizesTypedRows(t *testing.T) {
	raw, _ := json.Marshal(ManualSourceConfig{
		Columns: []ManualColumn{
			{Key: "title", Label: "Title", Type: "text"},
			{Key: "price", Label: "Price", Type: "currency", Currency: "usd"},
			{Key: "active", Label: "Active", Type: "boolean"},
		},
		Rows: []ManualRow{{ID: "d43f00ab-b7d9-4c39-a67b-24f7649c558d", Values: map[string]string{
			"title": "  Soup  ", "price": "5.50", "active": "TRUE",
		}}},
	})
	normalized, err := (manualSourceProvider{}).Normalize(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	config := normalized.(ManualSourceConfig)
	if config.Columns[1].Currency != "USD" || config.Rows[0].Values["price"] != "5.5" || config.Rows[0].Values["active"] != "true" {
		t.Fatalf("unexpected normalized manual data: %#v", config)
	}
}

func TestManualSourceAllowsLegacyCurrencyWithoutMetadata(t *testing.T) {
	raw, _ := json.Marshal(ManualSourceConfig{
		Columns: []ManualColumn{{Key: "price", Label: "Price", Type: "currency"}},
		Rows:    []ManualRow{{ID: "d43f00ab-b7d9-4c39-a67b-24f7649c558d", Values: map[string]string{"price": "5.5"}}},
	})
	normalized, err := (manualSourceProvider{}).Normalize(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.(ManualSourceConfig).Columns[0].Currency != "" {
		t.Fatal("legacy currency metadata should remain empty")
	}
}

func TestManualCurrencyMetadataIsRequiredForNewFieldsAndPreservesLegacyFields(t *testing.T) {
	if err := validateManualCurrencyMetadata([]ManualColumn{{Key: "price", Label: "Price", Type: "currency"}}, nil); err == nil {
		t.Fatal("new currency columns must declare their ISO 4217 code")
	}
	legacy := []ManualColumn{{Key: "price", Label: "Price", Type: "currency"}}
	if err := validateManualCurrencyMetadata(legacy, legacy); err != nil {
		t.Fatalf("legacy metadata-less currency field should remain editable: %v", err)
	}
	saved := []ManualColumn{{Key: "price", Label: "Price", Type: "currency", Currency: "EUR"}}
	if err := validateManualCurrencyMetadata(saved, saved); err != nil {
		t.Fatalf("saved currency code should be preserved: %v", err)
	}
	if err := validateManualCurrencyMetadata(legacy, saved); err == nil {
		t.Fatal("clearing a saved explicit code must be rejected")
	}
}

func TestManualSourceRequiresRecognizedISOCurrencyWhenProvided(t *testing.T) {
	for _, code := range []string{"ABC", "XXX"} {
		t.Run(code, func(t *testing.T) {
			raw, _ := json.Marshal(ManualSourceConfig{
				Columns: []ManualColumn{{Key: "price", Label: "Price", Type: "currency", Currency: code}},
				Rows:    []ManualRow{{ID: "d43f00ab-b7d9-4c39-a67b-24f7649c558d", Values: map[string]string{"price": "5.5"}}},
			})
			if _, err := (manualSourceProvider{}).Normalize(context.Background(), raw); err == nil {
				t.Fatalf("currency code %q was accepted", code)
			}
		})
	}
}

func TestManualSourceRejectsUnknownRowFields(t *testing.T) {
	raw, _ := json.Marshal(ManualSourceConfig{
		Columns: []ManualColumn{{Key: "title", Label: "Title", Type: "text"}},
		Rows:    []ManualRow{{ID: "d43f00ab-b7d9-4c39-a67b-24f7649c558d", Values: map[string]string{"missing": "value"}}},
	})
	if _, err := (manualSourceProvider{}).Normalize(context.Background(), raw); err == nil {
		t.Fatal("expected an unknown manual field to be rejected")
	}
}

func TestNormalizeWeatherForecastProducesCurrentAndDailyRecords(t *testing.T) {
	var forecast metForecast
	for index, at := range []string{"2026-07-16T12:00:00Z", "2026-07-17T12:00:00Z"} {
		var point struct {
			Time time.Time `json:"time"`
			Data struct {
				Instant struct {
					Details map[string]float64 `json:"details"`
				} `json:"instant"`
				Next1 struct {
					Summary struct {
						SymbolCode string `json:"symbol_code"`
					} `json:"summary"`
					Details map[string]float64 `json:"details"`
				} `json:"next_1_hours"`
				Next6 struct {
					Summary struct {
						SymbolCode string `json:"symbol_code"`
					} `json:"summary"`
					Details map[string]float64 `json:"details"`
				} `json:"next_6_hours"`
			} `json:"data"`
		}
		point.Time, _ = time.Parse(time.RFC3339, at)
		point.Data.Instant.Details = map[string]float64{"air_temperature": 20 + float64(index), "relative_humidity": 55, "wind_speed": 3}
		point.Data.Next1.Details = map[string]float64{"precipitation_amount": 1}
		point.Data.Next1.Summary.SymbolCode = "partlycloudy_day"
		point.Data.Next6.Summary.SymbolCode = "partlycloudy_day"
		forecast.Properties.Timeseries = append(forecast.Properties.Timeseries, point)
	}
	data, err := normalizeWeatherForecast(forecast, WeatherSourceConfig{LocationLabel: "Town Hall", Timezone: "UTC", Units: "metric", ForecastDays: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Records) != 3 || data.Records[0].Values["condition"] != "Partlycloudy" || data.Records[1].Values["high"] != "20" {
		t.Fatalf("unexpected weather records: %#v", data.Records)
	}
}

func TestCountdownWidgetDefaultsVisibleUnits(t *testing.T) {
	raw := json.RawMessage(`{"target":"2026-12-01T09:00","timezone":"America/New_York","mode":"countdown","completionAction":"completed_text","foregroundColor":"#ffffff","backgroundColor":"#000000"}`)
	normalized, err := (countdownWidgetProvider{}).Normalize(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	config := normalized.(CountdownWidgetConfig)
	if !config.ShowDays || !config.ShowHours || !config.ShowMinutes {
		t.Fatalf("expected default countdown units: %#v", config)
	}
	if config.Recurrence != "none" || config.Layout != "stacked" {
		t.Fatalf("expected non-recurring stacked defaults: %#v", config)
	}
}

func TestCountdownWidgetValidatesRecurrenceAndLayout(t *testing.T) {
	valid := json.RawMessage(`{"target":"2026-12-01T09:00","timezone":"UTC","mode":"countdown","recurrence":"weekly","layout":"horizontal","completionAction":"completed_text","foregroundColor":"#ffffff","backgroundColor":"#000000"}`)
	normalized, err := (countdownWidgetProvider{}).Normalize(context.Background(), valid)
	if err != nil {
		t.Fatal(err)
	}
	config := normalized.(CountdownWidgetConfig)
	if config.Recurrence != "weekly" || config.Layout != "horizontal" {
		t.Fatalf("unexpected normalized countdown: %#v", config)
	}

	invalid := json.RawMessage(`{"target":"2026-12-01T09:00","timezone":"UTC","mode":"count_up","recurrence":"daily","layout":"stacked","completionAction":"completed_text","foregroundColor":"#ffffff","backgroundColor":"#000000"}`)
	if _, err = (countdownWidgetProvider{}).Normalize(context.Background(), invalid); err == nil {
		t.Fatal("expected recurring count-up configuration to be rejected")
	}
}

func TestParseHTTPExpiryPrefersCacheControl(t *testing.T) {
	date := time.Date(2026, time.July, 16, 12, 0, 0, 0, time.UTC)
	header := http.Header{
		"Date":          []string{date.Format(http.TimeFormat)},
		"Cache-Control": []string{"public, max-age=900"},
		"Expires":       []string{date.Add(time.Hour).Format(http.TimeFormat)},
	}
	expires := parseHTTPExpiry(header)
	if expires == nil || !expires.Equal(date.Add(15*time.Minute)) {
		t.Fatalf("expiry=%v", expires)
	}
}

func TestNextDataSourceRefreshHonorsUpstreamExpiry(t *testing.T) {
	upstream := time.Now().Add(2 * time.Hour)
	next := nextDataSourceRefresh(300, &upstream)
	if !next.Equal(upstream) {
		t.Fatalf("next=%v want=%v", next, upstream)
	}
}
