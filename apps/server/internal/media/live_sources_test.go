package media

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"testing"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

func TestParseGTFSStaticAndNormalizeDepartures(t *testing.T) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	files := map[string]string{
		"stops.txt":      "stop_id,stop_name,platform_code\nSTOP1,Central,2\n",
		"routes.txt":     "route_id,route_short_name,route_long_name\nR1,10,Downtown\n",
		"trips.txt":      "route_id,trip_id,trip_headsign\nR1,T1,Library\n",
		"stop_times.txt": "trip_id,departure_time,stop_id,stop_sequence\nT1,12:00:00,STOP1,1\n",
	}
	for name, body := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = entry.Write([]byte(body))
	}
	_ = writer.Close()
	static, err := parseGTFSStatic(buffer.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	predicted := now.Add(10 * time.Minute).Unix()
	stopID, tripID, routeID, entityID := "STOP1", "T1", "R1", "departure"
	version := "2.0"
	feed := &gtfs.FeedMessage{Header: &gtfs.FeedHeader{GtfsRealtimeVersion: &version}, Entity: []*gtfs.FeedEntity{{
		Id: &entityID,
		TripUpdate: &gtfs.TripUpdate{
			Trip: &gtfs.TripDescriptor{TripId: &tripID, RouteId: &routeID},
			StopTimeUpdate: []*gtfs.TripUpdate_StopTimeUpdate{{
				StopId:    &stopID,
				Departure: &gtfs.TripUpdate_StopTimeEvent{Time: &predicted},
			}},
		},
	}}}
	encoded, err := proto.Marshal(feed)
	if err != nil || len(encoded) == 0 {
		t.Fatalf("encode realtime: %v", err)
	}
	records := normalizeTransitDepartures(feed.Entity, static, TransitSourceConfig{StopIDs: []string{stopID}, Timezone: "UTC", MaximumDepartures: 10}, now)
	if len(records) != 1 || records[0].Values["route"] != "10" || records[0].Values["platform"] != "2" || records[0].Values["headsign"] != "Library" {
		t.Fatalf("departure=%+v", records)
	}
}

func TestNormalizeCAPDocumentsAppliesCancellationAndAreaFilters(t *testing.T) {
	makeAlert := func(id, messageType, references, area string) []byte {
		value := capAlertXML{
			Identifier: id, Sender: "agency@example.org", Status: "Actual",
			MsgType: messageType, Scope: "Public", References: references,
			Infos: []capInfoXML{{Language: "en-US", Event: "Flood", Severity: "Severe", Urgency: "Immediate", Certainty: "Likely", Headline: "Flood warning", Areas: []string{area}, Expires: time.Now().Add(time.Hour).Format(time.RFC3339)}},
		}
		encoded, _ := xml.Marshal(value)
		return encoded
	}
	documents := [][]byte{
		makeAlert("active", "Alert", "", "Downtown"),
		makeAlert("removed", "Alert", "", "Downtown"),
		makeAlert("cancel", "Cancel", "sender,removed,2026-01-01T00:00:00Z", "Downtown"),
		makeAlert("outside", "Alert", "", "Uptown"),
	}
	records, err := normalizeCAPDocuments(documents, CAPAlertsSourceConfig{PreferredLanguage: "en-US", MinimumSeverity: "moderate", IncludeAreaKeywords: []string{"Downtown"}, MaximumAlerts: 20}, time.Now())
	if err != nil || len(records) != 1 || records[0].ID != "active" {
		t.Fatalf("records=%+v err=%v", records, err)
	}
}

func TestAirQualityHostedEndpointRequiresAcknowledgement(t *testing.T) {
	service := &Service{cfg: Config{AirQualityBaseURL: "https://air-quality-api.open-meteo.com"}}
	raw := []byte(`{"locationLabel":"Library","latitude":40,"longitude":-75,"timezone":"UTC","aqiStandard":"us","pollutants":["pm2_5"],"forecastHours":24,"refreshIntervalSeconds":3600,"stalenessLimitHours":24}`)
	if _, err := (airQualitySourceProvider{service}).Normalize(context.Background(), raw); err == nil {
		t.Fatal("expected hosted endpoint acknowledgement to be required")
	}
	raw = []byte(`{"locationLabel":"Library","latitude":40,"longitude":-75,"timezone":"UTC","aqiStandard":"us","pollutants":["pm2_5"],"forecastHours":24,"nonCommercialAccepted":true,"refreshIntervalSeconds":3600,"stalenessLimitHours":24}`)
	if _, err := (airQualitySourceProvider{service}).Normalize(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
}

func TestAirQualityRequiresAnExplicitIndexStandard(t *testing.T) {
	service := &Service{}
	raw := []byte(`{"locationLabel":"Library","latitude":40,"longitude":-75,"timezone":"UTC","pollutants":["pm2_5"],"forecastHours":24,"nonCommercialAccepted":true,"refreshIntervalSeconds":3600,"stalenessLimitHours":24}`)
	if _, err := (airQualitySourceProvider{service}).Normalize(context.Background(), raw); err == nil {
		t.Fatal("missing AQI standard was silently treated as a national default")
	}
}

func TestValidatePresetCompatibility(t *testing.T) {
	preset := "leaderboard"
	if err := validatePreset("list", &preset); err != nil {
		t.Fatal(err)
	}
	if err := validatePreset("cards", &preset); err == nil {
		t.Fatal("expected incompatible preset to fail")
	}
}
