package media

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

const liveSourceAttributionAirQuality = "Air quality data: Open-Meteo and CAMS ENSEMBLE (CC BY 4.0)"

type transitSourceProvider struct{ service *Service }

func (p transitSourceProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c TransitSourceConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	for _, candidate := range []*string{&c.StaticURL, &c.TripUpdatesURL} {
		*candidate = strings.TrimSpace(*candidate)
		if _, err := p.service.validateSourceURL(ctx, *candidate); err != nil {
			return nil, errors.New("transit feed URL is invalid")
		}
	}
	c.ServiceAlertsURL = strings.TrimSpace(c.ServiceAlertsURL)
	if c.ServiceAlertsURL != "" {
		if _, err := p.service.validateSourceURL(ctx, c.ServiceAlertsURL); err != nil {
			return nil, errors.New("transit alerts URL is invalid")
		}
	}
	c.StopIDs = normalizeStringList(c.StopIDs, 20, 80)
	c.RouteIDs = normalizeStringList(c.RouteIDs, 50, 80)
	if len(c.StopIDs) < 1 {
		return nil, errors.New("transit requires one to twenty stop IDs")
	}
	if c.Timezone == "" {
		c.Timezone = "UTC"
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		return nil, errors.New("transit timezone is invalid")
	}
	if c.MaximumDepartures == 0 {
		c.MaximumDepartures = 40
	}
	if c.MaximumDepartures < 1 || c.MaximumDepartures > 200 {
		return nil, errors.New("transit maximum departures is invalid")
	}
	if c.RealtimeRefreshSeconds == 0 {
		c.RealtimeRefreshSeconds = 60
	}
	if c.RealtimeRefreshSeconds < 30 || c.RealtimeRefreshSeconds > 300 {
		return nil, errors.New("transit realtime refresh must be between 30 and 300 seconds")
	}
	if c.StaticRefreshHours == 0 {
		c.StaticRefreshHours = 24
	}
	if c.StaticRefreshHours < 6 || c.StaticRefreshHours > 168 {
		return nil, errors.New("transit static refresh must be between 6 and 168 hours")
	}
	if c.StalenessLimitMinutes == 0 {
		c.StalenessLimitMinutes = 30
	}
	if c.StalenessLimitMinutes < 2 || c.StalenessLimitMinutes > 1440 {
		return nil, errors.New("transit staleness limit is invalid")
	}
	return c, nil
}

type capAlertsSourceProvider struct{ service *Service }

func (p capAlertsSourceProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c CAPAlertsSourceConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	c.URL = strings.TrimSpace(c.URL)
	if _, err := p.service.validateSourceURL(ctx, c.URL); err != nil {
		return nil, errors.New("CAP alerts URL is invalid")
	}
	if c.FeedMode == "" {
		c.FeedMode = "auto"
	}
	if c.FeedMode != "auto" && c.FeedMode != "cap" && c.FeedMode != "index" {
		return nil, errors.New("CAP feed mode is invalid")
	}
	c.PreferredLanguage = sanitizeCalendarText(c.PreferredLanguage, 35)
	if c.MinimumSeverity == "" {
		c.MinimumSeverity = "minor"
	}
	if severityRank(c.MinimumSeverity) < 0 {
		return nil, errors.New("CAP minimum severity is invalid")
	}
	c.IncludeAreaKeywords = normalizeStringList(c.IncludeAreaKeywords, 20, 80)
	c.ExcludeAreaKeywords = normalizeStringList(c.ExcludeAreaKeywords, 20, 80)
	if c.MaximumAlerts == 0 {
		c.MaximumAlerts = 50
	}
	if c.MaximumAlerts < 1 || c.MaximumAlerts > 200 {
		return nil, errors.New("CAP maximum alerts is invalid")
	}
	if c.RefreshIntervalSeconds == 0 {
		c.RefreshIntervalSeconds = 300
	}
	if c.RefreshIntervalSeconds < 60 || c.RefreshIntervalSeconds > 21600 {
		return nil, errors.New("CAP refresh interval is invalid")
	}
	if c.StalenessLimitHours == 0 {
		c.StalenessLimitHours = 24
	}
	if c.StalenessLimitHours < 1 || c.StalenessLimitHours > 168 {
		return nil, errors.New("CAP staleness limit is invalid")
	}
	return c, nil
}

type airQualitySourceProvider struct{ service *Service }

func (p airQualitySourceProvider) Normalize(_ context.Context, raw json.RawMessage) (any, error) {
	var c AirQualitySourceConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	c.LocationLabel = sanitizeCalendarText(c.LocationLabel, 120)
	if c.LocationLabel == "" || c.Latitude < -90 || c.Latitude > 90 || c.Longitude < -180 || c.Longitude > 180 {
		return nil, errors.New("air quality location is invalid")
	}
	c.Latitude = float64(int(c.Latitude*10000+.5)) / 10000
	c.Longitude = float64(int(c.Longitude*10000+.5)) / 10000
	if c.Timezone == "" {
		c.Timezone = "UTC"
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		return nil, errors.New("air quality timezone is invalid")
	}
	if c.AQIStandard == "" {
		c.AQIStandard = "us"
	}
	if c.AQIStandard != "us" && c.AQIStandard != "european" {
		return nil, errors.New("air quality index standard is invalid")
	}
	allowed := map[string]bool{"pm2_5": true, "pm10": true, "ozone": true, "nitrogen_dioxide": true, "alder_pollen": true, "birch_pollen": true, "grass_pollen": true, "mugwort_pollen": true, "olive_pollen": true, "ragweed_pollen": true}
	c.Pollutants = normalizeStringList(c.Pollutants, 10, 40)
	if len(c.Pollutants) == 0 {
		c.Pollutants = []string{"pm2_5", "pm10", "ozone", "nitrogen_dioxide"}
	}
	for _, pollutant := range c.Pollutants {
		if !allowed[pollutant] {
			return nil, errors.New("air quality pollutant is invalid")
		}
	}
	if c.ForecastHours == 0 {
		c.ForecastHours = 48
	}
	if c.ForecastHours < 1 || c.ForecastHours > 168 {
		return nil, errors.New("air quality forecast hours is invalid")
	}
	if c.RefreshIntervalSeconds == 0 {
		c.RefreshIntervalSeconds = 3600
	}
	if c.RefreshIntervalSeconds < 900 || c.RefreshIntervalSeconds > 21600 {
		return nil, errors.New("air quality refresh interval is invalid")
	}
	if c.StalenessLimitHours == 0 {
		c.StalenessLimitHours = 24
	}
	if c.StalenessLimitHours < 1 || c.StalenessLimitHours > 168 {
		return nil, errors.New("air quality staleness limit is invalid")
	}
	base, err := url.Parse(strings.TrimSpace(p.service.cfg.AirQualityBaseURL))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, errors.New("installation air quality endpoint is invalid")
	}
	if strings.EqualFold(base.Hostname(), "air-quality-api.open-meteo.com") && !c.NonCommercialAccepted {
		return nil, errors.New("hosted Open-Meteo use requires noncommercial acknowledgement")
	}
	return c, nil
}

func normalizeStringList(values []string, maximum, length int) []string {
	result := make([]string, 0, min(len(values), maximum))
	seen := map[string]bool{}
	for _, value := range values {
		value = sanitizeCalendarText(value, length)
		if value != "" && !seen[value] && len(result) < maximum {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}

type gtfsStaticData struct {
	Stops     map[string]map[string]string
	Routes    map[string]map[string]string
	Trips     map[string]map[string]string
	StopTimes map[string]map[string]map[string]string
}

func (s *Service) refreshTransit(ctx context.Context, id uuid.UUID, c TransitSourceConfig) (TypedDatasetPayload, DataSourceDiagnostics, error) {
	now := time.Now().UTC()
	var staticBody []byte
	var staticExpiry *time.Time
	if id != uuid.Nil {
		_ = s.db.QueryRow(ctx, `SELECT secondary_cached_payload,secondary_cache_expires_at FROM data_source_refresh_states WHERE data_source_id=$1`, id).Scan(&staticBody, &staticExpiry)
	}
	category := "cached_static"
	var err error
	if len(staticBody) == 0 || staticExpiry == nil || !staticExpiry.After(now) {
		staticBody, category, err = s.fetchLiveSource(ctx, c.StaticURL, "application/zip")
		if err == nil && id != uuid.Nil {
			expires := now.Add(time.Duration(c.StaticRefreshHours) * time.Hour)
			_, _ = s.db.Exec(ctx, `UPDATE data_source_refresh_states SET secondary_cached_payload=$2,secondary_cache_expires_at=$3 WHERE data_source_id=$1`, id, staticBody, expires)
		}
	}
	diagnostics := DataSourceDiagnostics{ParseStatus: "fetch_failed", HTTPResultCategory: &category}
	if err != nil {
		return TypedDatasetPayload{}, diagnostics, err
	}
	static, err := parseGTFSStatic(staticBody)
	if err != nil {
		diagnostics.ParseStatus = "parse_failed"
		return TypedDatasetPayload{}, diagnostics, err
	}
	realtimeBody, category, err := s.fetchLiveSource(ctx, c.TripUpdatesURL, "application/x-protobuf")
	diagnostics.HTTPResultCategory = &category
	if err != nil {
		return TypedDatasetPayload{}, diagnostics, err
	}
	var updates gtfs.FeedMessage
	if err = proto.Unmarshal(realtimeBody, &updates); err != nil {
		diagnostics.ParseStatus = "parse_failed"
		return TypedDatasetPayload{}, diagnostics, errors.New("GTFS Realtime trip updates are malformed")
	}
	departures := normalizeTransitDepartures(updates.GetEntity(), static, c, now)
	alerts := []TypedRecord{}
	if c.ServiceAlertsURL != "" {
		body, _, fetchErr := s.fetchLiveSource(ctx, c.ServiceAlertsURL, "application/x-protobuf")
		if fetchErr == nil {
			var feed gtfs.FeedMessage
			if proto.Unmarshal(body, &feed) == nil {
				alerts = normalizeTransitAlerts(feed.GetEntity(), c, now)
			}
		}
	}
	stale := now.Add(time.Duration(c.StalenessLimitMinutes) * time.Minute)
	diagnostics.ParseStatus = "success"
	diagnostics.AvailableItemCount = len(departures) + len(alerts)
	diagnostics.CacheUpdatedAt = &now
	diagnostics.CacheExpiresAt = &stale
	return TypedDatasetPayload{Datasets: []TypedDataset{
		{ID: "departures", Kind: "records", Fields: transitDepartureFields(), Records: departures, CachedAt: &now, StaleAt: &stale, Timezone: c.Timezone},
		{ID: "alerts", Kind: "records", Fields: transitAlertFields(), Records: alerts, CachedAt: &now, StaleAt: &stale},
	}}, diagnostics, nil
}

func (s *Service) RefreshTransitPreview(ctx context.Context, c TransitSourceConfig) (TypedDatasetPayload, DataSourceDiagnostics, error) {
	return s.refreshTransit(ctx, uuid.Nil, c)
}

func parseGTFSStatic(body []byte) (gtfsStaticData, error) {
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil || len(reader.File) > 200 {
		return gtfsStaticData{}, errors.New("GTFS Static archive is invalid")
	}
	result := gtfsStaticData{Stops: map[string]map[string]string{}, Routes: map[string]map[string]string{}, Trips: map[string]map[string]string{}, StopTimes: map[string]map[string]map[string]string{}}
	for _, file := range reader.File {
		name := strings.ToLower(file.Name)
		if name != "stops.txt" && name != "routes.txt" && name != "trips.txt" && name != "stop_times.txt" {
			continue
		}
		stream, openErr := file.Open()
		if openErr != nil {
			return result, openErr
		}
		rows, readErr := csv.NewReader(io.LimitReader(stream, 16<<20)).ReadAll()
		stream.Close()
		if readErr != nil || len(rows) < 1 || len(rows) > 500000 {
			return result, errors.New("GTFS Static table is invalid")
		}
		header := map[string]int{}
		for index, value := range rows[0] {
			header[value] = index
		}
		value := func(row []string, key string) string {
			if index, ok := header[key]; ok && index < len(row) {
				return row[index]
			}
			return ""
		}
		for _, row := range rows[1:] {
			switch name {
			case "stops.txt":
				id := value(row, "stop_id")
				result.Stops[id] = map[string]string{"name": value(row, "stop_name"), "platform": value(row, "platform_code")}
			case "routes.txt":
				id := value(row, "route_id")
				result.Routes[id] = map[string]string{"short": value(row, "route_short_name"), "long": value(row, "route_long_name")}
			case "trips.txt":
				id := value(row, "trip_id")
				result.Trips[id] = map[string]string{"route": value(row, "route_id"), "headsign": value(row, "trip_headsign")}
			case "stop_times.txt":
				trip, stop := value(row, "trip_id"), value(row, "stop_id")
				if result.StopTimes[trip] == nil {
					result.StopTimes[trip] = map[string]map[string]string{}
				}
				result.StopTimes[trip][stop] = map[string]string{"departure": value(row, "departure_time"), "headsign": value(row, "stop_headsign")}
			}
		}
	}
	if len(result.Stops) == 0 || len(result.Trips) == 0 {
		return result, errors.New("GTFS Static archive is missing required tables")
	}
	return result, nil
}

func normalizeTransitDepartures(entities []*gtfs.FeedEntity, static gtfsStaticData, c TransitSourceConfig, now time.Time) []TypedRecord {
	stopFilter, routeFilter := sliceSet(c.StopIDs), sliceSet(c.RouteIDs)
	location, _ := time.LoadLocation(c.Timezone)
	result := []TypedRecord{}
	for _, entity := range entities {
		update := entity.GetTripUpdate()
		if update == nil {
			continue
		}
		tripID := update.GetTrip().GetTripId()
		trip := static.Trips[tripID]
		routeID := update.GetTrip().GetRouteId()
		if routeID == "" {
			routeID = trip["route"]
		}
		if len(routeFilter) > 0 && !routeFilter[routeID] {
			continue
		}
		for _, stopUpdate := range update.GetStopTimeUpdate() {
			stopID := stopUpdate.GetStopId()
			if !stopFilter[stopID] {
				continue
			}
			event := stopUpdate.GetDeparture()
			if event == nil {
				event = stopUpdate.GetArrival()
			}
			predicted := time.Unix(event.GetTime(), 0)
			scheduled := predicted.Add(-time.Duration(event.GetDelay()) * time.Second)
			if event.GetTime() == 0 {
				scheduled = parseGTFSTime(now.In(location), static.StopTimes[tripID][stopID]["departure"], location)
				predicted = scheduled.Add(time.Duration(event.GetDelay()) * time.Second)
			}
			if predicted.Before(now.Add(-2 * time.Minute)) {
				continue
			}
			status := "on_time"
			if event.GetDelay() >= 60 {
				status = "delayed"
			}
			if stopUpdate.GetScheduleRelationship().String() == "SKIPPED" {
				status = "cancelled"
			}
			route := static.Routes[routeID]
			headsign := static.StopTimes[tripID][stopID]["headsign"]
			if headsign == "" {
				headsign = trip["headsign"]
			}
			result = append(result, TypedRecord{ID: entity.GetId() + ":" + stopID, Values: map[string]string{
				"stopId": stopID, "stopName": static.Stops[stopID]["name"], "routeId": routeID,
				"route": firstNonEmpty(route["short"], route["long"], routeID), "headsign": headsign,
				"scheduledTime": scheduled.UTC().Format(time.RFC3339), "predictedTime": predicted.UTC().Format(time.RFC3339),
				"delaySeconds": strconv.FormatInt(int64(event.GetDelay()), 10), "status": status,
				"platform": static.Stops[stopID]["platform"], "freshness": now.Format(time.RFC3339),
			}})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Values["predictedTime"] < result[j].Values["predictedTime"] })
	return result[:min(len(result), c.MaximumDepartures)]
}

func normalizeTransitAlerts(entities []*gtfs.FeedEntity, c TransitSourceConfig, now time.Time) []TypedRecord {
	routeFilter := sliceSet(c.RouteIDs)
	result := []TypedRecord{}
	for _, entity := range entities {
		alert := entity.GetAlert()
		if alert == nil || !gtfsAlertActive(alert, now) {
			continue
		}
		applies := len(routeFilter) == 0
		routes := []string{}
		for _, informed := range alert.GetInformedEntity() {
			if informed.GetRouteId() != "" {
				routes = append(routes, informed.GetRouteId())
				if routeFilter[informed.GetRouteId()] {
					applies = true
				}
			}
		}
		if !applies {
			continue
		}
		result = append(result, TypedRecord{ID: entity.GetId(), Values: map[string]string{
			"headline": translated(alert.GetHeaderText()), "description": translated(alert.GetDescriptionText()),
			"severity": strings.ToLower(alert.GetSeverityLevel().String()), "effect": strings.ToLower(alert.GetEffect().String()),
			"routes": strings.Join(routes, ", "), "url": translated(alert.GetUrl()), "freshness": now.Format(time.RFC3339),
		}})
	}
	return result
}

func (s *Service) refreshCAPAlerts(ctx context.Context, c CAPAlertsSourceConfig) (TypedDatasetPayload, DataSourceDiagnostics, error) {
	now := time.Now().UTC()
	body, category, err := s.fetchLiveSource(ctx, c.URL, "application/xml")
	diagnostics := DataSourceDiagnostics{ParseStatus: "fetch_failed", HTTPResultCategory: &category}
	if err != nil {
		return TypedDatasetPayload{}, diagnostics, err
	}
	documents := [][]byte{body}
	if c.FeedMode == "index" || (c.FeedMode == "auto" && !bytes.Contains(body, []byte("<alert"))) {
		links := extractFeedLinks(body)
		documents = nil
		for _, link := range links[:min(len(links), 20)] {
			resolved, resolveErr := resolveURL(c.URL, link)
			if resolveErr != nil {
				continue
			}
			child, _, fetchErr := s.fetchLiveSource(ctx, resolved, "application/xml")
			if fetchErr == nil {
				documents = append(documents, child)
			}
		}
	}
	records, parseErr := normalizeCAPDocuments(documents, c, now)
	if parseErr != nil {
		diagnostics.ParseStatus = "parse_failed"
		return TypedDatasetPayload{}, diagnostics, parseErr
	}
	stale := now.Add(time.Duration(c.StalenessLimitHours) * time.Hour)
	diagnostics.ParseStatus = "success"
	diagnostics.AvailableItemCount = len(records)
	diagnostics.CacheUpdatedAt, diagnostics.CacheExpiresAt = &now, &stale
	return TypedDatasetPayload{Datasets: []TypedDataset{{ID: "alerts", Kind: "records", Fields: capAlertFields(), Records: records, CachedAt: &now, StaleAt: &stale}}}, diagnostics, nil
}

func (s *Service) RefreshCAPPreview(ctx context.Context, c CAPAlertsSourceConfig) (TypedDatasetPayload, DataSourceDiagnostics, error) {
	return s.refreshCAPAlerts(ctx, c)
}

type capAlertXML struct {
	Identifier string       `xml:"identifier"`
	Sender     string       `xml:"sender"`
	Sent       string       `xml:"sent"`
	Status     string       `xml:"status"`
	MsgType    string       `xml:"msgType"`
	Scope      string       `xml:"scope"`
	References string       `xml:"references"`
	Infos      []capInfoXML `xml:"info"`
}

type capInfoXML struct {
	Language    string   `xml:"language"`
	Event       string   `xml:"event"`
	Urgency     string   `xml:"urgency"`
	Severity    string   `xml:"severity"`
	Certainty   string   `xml:"certainty"`
	Effective   string   `xml:"effective"`
	Expires     string   `xml:"expires"`
	Headline    string   `xml:"headline"`
	Description string   `xml:"description"`
	Instruction string   `xml:"instruction"`
	Web         string   `xml:"web"`
	Areas       []string `xml:"area>areaDesc"`
}

func normalizeCAPDocuments(documents [][]byte, c CAPAlertsSourceConfig, now time.Time) ([]TypedRecord, error) {
	active := map[string]TypedRecord{}
	cancelled := map[string]bool{}
	for _, document := range documents {
		var alert capAlertXML
		if err := xml.Unmarshal(document, &alert); err != nil || alert.Identifier == "" {
			continue
		}
		if alert.Scope != "Public" || (alert.Status != "Actual" && alert.Status != "Exercise") {
			continue
		}
		if alert.MsgType == "Cancel" {
			for _, reference := range strings.Fields(alert.References) {
				parts := strings.Split(reference, ",")
				if len(parts) > 1 {
					cancelled[parts[1]] = true
				}
			}
			continue
		}
		info := chooseCAPInfo(alert.Infos, c.PreferredLanguage)
		if severityRank(strings.ToLower(info.Severity)) < severityRank(c.MinimumSeverity) {
			continue
		}
		expires := parseFlexibleTime(info.Expires)
		if !expires.IsZero() && !expires.After(now) {
			continue
		}
		area := strings.Join(info.Areas, ", ")
		if !areaAllowed(area, c.IncludeAreaKeywords, c.ExcludeAreaKeywords) {
			continue
		}
		active[alert.Identifier] = TypedRecord{ID: alert.Identifier, Values: map[string]string{
			"event": sanitizeCalendarText(info.Event, 240), "headline": sanitizeCalendarText(info.Headline, 500),
			"description": sanitizeCalendarText(info.Description, 4096), "instruction": sanitizeCalendarText(info.Instruction, 4096),
			"severity": strings.ToLower(info.Severity), "urgency": strings.ToLower(info.Urgency), "certainty": strings.ToLower(info.Certainty),
			"effective": formatOptionalRFC3339(parseFlexibleTime(info.Effective)), "expires": formatOptionalRFC3339(expires),
			"sender": sanitizeCalendarText(alert.Sender, 240), "area": sanitizeCalendarText(area, 1000), "url": strings.TrimSpace(info.Web),
		}}
	}
	result := []TypedRecord{}
	for id, record := range active {
		if !cancelled[id] {
			result = append(result, record)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		left, right := severityRank(result[i].Values["severity"]), severityRank(result[j].Values["severity"])
		if left != right {
			return left > right
		}
		return result[i].Values["effective"] > result[j].Values["effective"]
	})
	return result[:min(len(result), c.MaximumAlerts)], nil
}

func (s *Service) refreshAirQuality(ctx context.Context, c AirQualitySourceConfig) (TypedDatasetPayload, DataSourceDiagnostics, error) {
	now := time.Now().UTC()
	base, err := url.Parse(strings.TrimRight(s.cfg.AirQualityBaseURL, "/") + "/v1/air-quality")
	if err != nil {
		return TypedDatasetPayload{}, DataSourceDiagnostics{}, err
	}
	variables := append([]string{map[string]string{"us": "us_aqi", "european": "european_aqi"}[c.AQIStandard]}, c.Pollutants...)
	query := base.Query()
	query.Set("latitude", strconv.FormatFloat(c.Latitude, 'f', 4, 64))
	query.Set("longitude", strconv.FormatFloat(c.Longitude, 'f', 4, 64))
	query.Set("timezone", c.Timezone)
	query.Set("current", strings.Join(variables, ","))
	query.Set("hourly", strings.Join(variables, ","))
	query.Set("forecast_hours", strconv.Itoa(c.ForecastHours))
	base.RawQuery = query.Encode()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	request.Header.Set("User-Agent", "Tilecast-Air-Quality/1")
	response, err := s.sourceHTTPClient().Do(request)
	category := "network_error"
	diagnostics := DataSourceDiagnostics{ParseStatus: "fetch_failed", HTTPResultCategory: &category}
	if err != nil {
		return TypedDatasetPayload{}, diagnostics, err
	}
	defer response.Body.Close()
	category = fmt.Sprintf("http_%d", response.StatusCode)
	if response.StatusCode != http.StatusOK {
		return TypedDatasetPayload{}, diagnostics, errors.New("air quality service returned an unsuccessful status")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, s.cfg.SourceFetch.MaximumBytes+1))
	if err != nil || int64(len(body)) > s.cfg.SourceFetch.MaximumBytes {
		return TypedDatasetPayload{}, diagnostics, errors.New("air quality response is too large")
	}
	var payload struct {
		Current      map[string]any    `json:"current"`
		CurrentUnits map[string]string `json:"current_units"`
		Hourly       map[string][]any  `json:"hourly"`
		HourlyUnits  map[string]string `json:"hourly_units"`
	}
	if json.Unmarshal(body, &payload) != nil {
		diagnostics.ParseStatus = "parse_failed"
		return TypedDatasetPayload{}, diagnostics, errors.New("air quality response is invalid")
	}
	current := map[string]string{"location": c.LocationLabel}
	units := map[string]string{}
	for _, variable := range variables {
		current[variable] = scalarString(payload.Current[variable])
		units[variable] = payload.CurrentUnits[variable]
	}
	points := []TypedPoint{}
	times := payload.Hourly["time"]
	for index, rawTime := range times {
		at, parseErr := time.ParseInLocation("2006-01-02T15:04", scalarString(rawTime), mustLocation(c.Timezone))
		if parseErr != nil {
			continue
		}
		values := map[string]string{}
		for _, variable := range variables {
			if index < len(payload.Hourly[variable]) {
				values[variable] = scalarString(payload.Hourly[variable][index])
			}
		}
		points = append(points, TypedPoint{At: at.UTC(), Values: values})
	}
	stale := now.Add(time.Duration(c.StalenessLimitHours) * time.Hour)
	diagnostics.ParseStatus = "success"
	diagnostics.AvailableItemCount = len(points) + 1
	diagnostics.CacheUpdatedAt, diagnostics.CacheExpiresAt = &now, &stale
	fields := airQualityFields(c)
	return TypedDatasetPayload{Datasets: []TypedDataset{
		{ID: "current", Kind: "object", Fields: fields, Values: current, CachedAt: &now, StaleAt: &stale, Attribution: liveSourceAttributionAirQuality, Timezone: c.Timezone, Units: units},
		{ID: "hourly", Kind: "time_series", Fields: fields, Points: points, CachedAt: &now, StaleAt: &stale, Attribution: liveSourceAttributionAirQuality, Timezone: c.Timezone, Units: units},
	}}, diagnostics, nil
}

func (s *Service) RefreshAirQualityPreview(ctx context.Context, c AirQualitySourceConfig) (TypedDatasetPayload, DataSourceDiagnostics, error) {
	return s.refreshAirQuality(ctx, c)
}

func (s *Service) fetchLiveSource(ctx context.Context, rawURL, accept string) ([]byte, string, error) {
	parsed, err := s.validateSourceURL(ctx, rawURL)
	if err != nil {
		return nil, "invalid_url", err
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	request.Header.Set("Accept", accept)
	request.Header.Set("User-Agent", "Tilecast-Source-Refresh/1")
	response, err := s.sourceHTTPClient().Do(request)
	if err != nil {
		return nil, "network_error", err
	}
	defer response.Body.Close()
	category := fmt.Sprintf("http_%d", response.StatusCode)
	if response.StatusCode != http.StatusOK {
		return nil, category, errors.New("source returned an unsuccessful status")
	}
	limit := s.cfg.SourceFetch.MaximumBytes
	if strings.Contains(accept, "zip") && limit < 32<<20 {
		limit = 32 << 20
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, category, errors.New("source response is too large")
	}
	return body, category, nil
}

func transitDepartureFields() []DataSourceField {
	return []DataSourceField{{"stopId", "Stop ID", "text", ""}, {"stopName", "Stop", "text", ""}, {"routeId", "Route ID", "text", ""}, {"route", "Route", "text", ""}, {"headsign", "Destination", "text", ""}, {"scheduledTime", "Scheduled time", "datetime", ""}, {"predictedTime", "Predicted time", "datetime", ""}, {"delaySeconds", "Delay", "duration", ""}, {"status", "Status", "text", ""}, {"platform", "Platform", "text", ""}, {"freshness", "Updated", "datetime", ""}}
}

func transitAlertFields() []DataSourceField {
	return []DataSourceField{{"headline", "Headline", "text", ""}, {"description", "Description", "text", ""}, {"severity", "Severity", "text", ""}, {"effect", "Effect", "text", ""}, {"routes", "Routes", "text", ""}, {"url", "Information URL", "url", ""}, {"freshness", "Updated", "datetime", ""}}
}

func capAlertFields() []DataSourceField {
	return []DataSourceField{{"event", "Event", "text", ""}, {"headline", "Headline", "text", ""}, {"description", "Description", "text", ""}, {"instruction", "Instruction", "text", ""}, {"severity", "Severity", "text", ""}, {"urgency", "Urgency", "text", ""}, {"certainty", "Certainty", "text", ""}, {"effective", "Effective", "datetime", ""}, {"expires", "Expires", "datetime", ""}, {"sender", "Sender", "text", ""}, {"area", "Area", "text", ""}, {"url", "Information URL", "url", ""}}
}

func airQualityFields(c AirQualitySourceConfig) []DataSourceField {
	fields := []DataSourceField{{"location", "Location", "text", ""}}
	aqi := map[string]string{"us": "us_aqi", "european": "european_aqi"}[c.AQIStandard]
	fields = append(fields, DataSourceField{aqi, strings.ToUpper(strings.ReplaceAll(aqi, "_", " ")), "integer", ""})
	for _, pollutant := range c.Pollutants {
		fields = append(fields, DataSourceField{pollutant, strings.ToUpper(strings.ReplaceAll(pollutant, "_", " ")), "number", ""})
	}
	return fields
}

func sliceSet(values []string) map[string]bool {
	result := map[string]bool{}
	for _, value := range values {
		result[value] = true
	}
	return result
}

func parseGTFSTime(day time.Time, raw string, location *time.Location) time.Time {
	parts := strings.Split(raw, ":")
	if len(parts) != 3 {
		return day
	}
	hour, _ := strconv.Atoi(parts[0])
	minute, _ := strconv.Atoi(parts[1])
	second, _ := strconv.Atoi(parts[2])
	base := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, location)
	return base.Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute + time.Duration(second)*time.Second)
}

func translated(value *gtfs.TranslatedString) string {
	if value == nil || len(value.GetTranslation()) == 0 {
		return ""
	}
	return value.GetTranslation()[0].GetText()
}

func gtfsAlertActive(alert *gtfs.Alert, now time.Time) bool {
	if len(alert.GetActivePeriod()) == 0 {
		return true
	}
	for _, period := range alert.GetActivePeriod() {
		start, end := time.Unix(int64(period.GetStart()), 0), time.Unix(int64(period.GetEnd()), 0)
		if (period.Start == nil || !now.Before(start)) && (period.End == nil || now.Before(end)) {
			return true
		}
	}
	return false
}

func extractFeedLinks(body []byte) []string {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	result := []string{}
	for {
		token, err := decoder.Token()
		if err != nil {
			break
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "link" {
			continue
		}
		for _, attr := range start.Attr {
			if attr.Name.Local == "href" && attr.Value != "" {
				result = append(result, attr.Value)
			}
		}
		var text string
		if decoder.DecodeElement(&text, &start) == nil && strings.TrimSpace(text) != "" {
			result = append(result, strings.TrimSpace(text))
		}
	}
	return normalizeStringList(result, 50, 2048)
}

func resolveURL(base, reference string) (string, error) {
	b, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	r, err := url.Parse(reference)
	if err != nil {
		return "", err
	}
	return b.ResolveReference(r).String(), nil
}

func severityRank(value string) int {
	switch strings.ToLower(value) {
	case "unknown":
		return 0
	case "minor":
		return 1
	case "moderate":
		return 2
	case "severe":
		return 3
	case "extreme":
		return 4
	default:
		return -1
	}
}

func chooseCAPInfo(values []capInfoXML, language string) capInfoXML {
	for _, value := range values {
		if language != "" && strings.EqualFold(value.Language, language) {
			return value
		}
	}
	if len(values) > 0 {
		return values[0]
	}
	return capInfoXML{}
}

func areaAllowed(area string, includes, excludes []string) bool {
	value := strings.ToLower(area)
	for _, exclude := range excludes {
		if strings.Contains(value, strings.ToLower(exclude)) {
			return false
		}
	}
	if len(includes) == 0 {
		return true
	}
	for _, include := range includes {
		if strings.Contains(value, strings.ToLower(include)) {
			return true
		}
	}
	return false
}

func parseFlexibleTime(raw string) time.Time {
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano} {
		if parsed, err := time.Parse(layout, strings.TrimSpace(raw)); err == nil {
			return parsed
		}
	}
	return time.Time{}
}

func formatOptionalRFC3339(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

func scalarString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func mustLocation(name string) *time.Location {
	location, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return location
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
