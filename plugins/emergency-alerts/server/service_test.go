package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestZonesLoadsCountiesAndForecastZonesForAState(t *testing.T) {
	var requests int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Query().Get("area") != "OH" || r.URL.Query().Get("include_geometry") != "false" {
			t.Fatalf("unexpected zone query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/geo+json")
		switch r.URL.Path {
		case "/zones/county":
			_, _ = w.Write([]byte(`{"features":[{"id":"https://api.weather.gov/zones/county/OHC049","properties":{"name":"Franklin","state":"OH"}}]}`))
		case "/zones/forecast":
			_, _ = w.Write([]byte(`{"features":[{"properties":{"id":"OHZ055","name":"Franklin","state":"OH"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	service := &Service{
		client:       upstream.Client(),
		zonesBaseURL: upstream.URL + "/zones",
		userAgent:    "Tilecast/1.0 (test)",
	}
	zones, err := service.Zones(context.Background(), "oh")
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
	want := []Zone{
		{ID: "OHC049", Name: "Franklin", State: "OH", Type: "county"},
		{ID: "OHZ055", Name: "Franklin", State: "OH", Type: "forecast"},
	}
	if !reflect.DeepEqual(zones, want) {
		t.Fatalf("Zones() = %#v, want %#v", zones, want)
	}
}

func TestBuiltinAlertDocumentsContainLiveNWSDetails(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	expires := now.Add(time.Hour)
	configurationJSON, payloadJSON := builtinAlertDocuments(nwsProperties{
		Event:           "Tornado Warning",
		Headline:        "Tornado observed near Columbus",
		Severity:        "Extreme",
		AreaDescription: "Franklin County",
		Instruction:     "Move to an interior room.",
		SenderName:      "NWS Wilmington OH",
	}, expires, now)
	var configuration map[string]any
	if err := json.Unmarshal([]byte(configurationJSON), &configuration); err != nil {
		t.Fatal(err)
	}
	message, _ := configuration["message"].(string)
	for _, want := range []string{"Tornado Warning", "Tornado observed", "Franklin County", "interior room"} {
		if !strings.Contains(message, want) {
			t.Fatalf("built-in message %q does not contain %q", message, want)
		}
	}
	if configuration["severity"] != "Extreme" ||
		configuration["contact"] != "NWS Wilmington OH" ||
		configuration["expiresAt"] != expires.Format(time.RFC3339) {
		t.Fatalf("unexpected built-in configuration: %#v", configuration)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload["datasets"].([]any)) != 1 {
		t.Fatalf("unexpected built-in payload: %#v", payload)
	}
}

func TestNormalizeCodes(t *testing.T) {
	got, err := normalizeCodes([]string{" oh ", "PA", "OH"}, 2, "area")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"OH", "PA"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeCodes() = %#v, want %#v", got, want)
	}
	if _, err = normalizeCodes([]string{"O!"}, 2, "area"); err == nil {
		t.Fatal("normalizeCodes accepted punctuation")
	}
}

func TestFetchIdentifiesTilecastAndDecodesGeoJSON(t *testing.T) {
	var gotQuery, gotAccept, gotAgent string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		gotAccept = r.Header.Get("Accept")
		gotAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/geo+json")
		_, _ = w.Write([]byte(`{"features":[{"id":"alert-1","properties":{"id":"alert-1","event":"Tornado Warning","severity":"Extreme","urgency":"Immediate"}}]}`))
	}))
	defer upstream.Close()
	service := &Service{
		client:    upstream.Client(),
		baseURL:   upstream.URL,
		userAgent: "Tilecast/1.0 (https://tilecast.example)",
	}
	collection, err := service.fetch(context.Background(), "area", "OH,PA")
	if err != nil {
		t.Fatal(err)
	}
	if len(collection.Features) != 1 || collection.Features[0].Properties.Event != "Tornado Warning" {
		t.Fatalf("unexpected decoded collection: %#v", collection)
	}
	if !strings.Contains(gotQuery, "area=OH%2CPA") || !strings.Contains(gotQuery, "message_type=alert") {
		t.Fatalf("unexpected query: %s", gotQuery)
	}
	if gotAccept != "application/geo+json" || !strings.HasPrefix(gotAgent, "Tilecast/") {
		t.Fatalf("headers Accept=%q User-Agent=%q", gotAccept, gotAgent)
	}
}

func TestMatchesUsesClosedSeverityAndUrgencyOrdering(t *testing.T) {
	rule := Rule{
		EventNames:      []string{"Tornado Warning"},
		MinimumSeverity: "Severe",
		MinimumUrgency:  "Expected",
	}
	if !matches(rule, "tornado warning", "Extreme", "Immediate") {
		t.Fatal("expected stronger, case-insensitive alert to match")
	}
	if matches(rule, "Tornado Watch", "Extreme", "Immediate") {
		t.Fatal("unexpected event name match")
	}
	if matches(rule, "Tornado Warning", "Moderate", "Immediate") {
		t.Fatal("unexpected lower-severity match")
	}
	if matches(rule, "Tornado Warning", "Extreme", "Future") {
		t.Fatal("unexpected lower-urgency match")
	}
}

func TestAlertExpiryIsBoundedAndPrefersEnds(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	expires := now.Add(2 * time.Hour)
	ends := now.Add(90 * time.Minute)
	if got := alertExpiry(nwsProperties{Expires: &expires, Ends: &ends}, now, 360); !got.Equal(ends) {
		t.Fatalf("alertExpiry() = %s, want ends %s", got, ends)
	}
	tooLate := now.Add(12 * time.Hour)
	if got := alertExpiry(nwsProperties{Expires: &tooLate}, now, 360); !got.Equal(now.Add(6 * time.Hour)) {
		t.Fatalf("alertExpiry() = %s, want six-hour ceiling", got)
	}
}

func TestNWSAlertActiveUsesTheAuthoritativeEnd(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	expired := now.Add(-time.Minute)
	future := now.Add(time.Hour)
	if nwsAlertActive(nwsProperties{Expires: &expired}, now) {
		t.Fatal("expired alert was treated as active")
	}
	if !nwsAlertActive(nwsProperties{Expires: &future}, now) {
		t.Fatal("future alert was not treated as active")
	}
}

func TestBoundedPreservesUTF8(t *testing.T) {
	if got := bounded("warning 🌪️", 10); got != "warning " || !utf8.ValidString(got) {
		t.Fatalf("bounded() = %q, want valid UTF-8 at the byte limit", got)
	}
}

// The standalone Start/Stop lifecycle is gone with the core service: polling
// is a WorkerProvider worker the generic plugin host runs. The worker
// exposes one named worker and exits promptly when its context ends.
func TestWorkerLifecycle(t *testing.T) {
	service := NewService()
	workers := service.Workers()
	if len(workers) != 1 || workers[0].Name != "nws-monitor" {
		t.Fatalf("Workers() = %#v, want one nws-monitor worker", workers)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if err := service.RunWorker(ctx); err != context.Canceled {
		t.Fatalf("RunWorker on a cancelled context = %v, want context.Canceled", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("RunWorker did not exit promptly on cancellation")
	}
}
