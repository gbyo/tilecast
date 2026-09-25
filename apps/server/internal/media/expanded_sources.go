package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/mail"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	currencydata "golang.org/x/text/currency"
)

var typedFieldTypes = map[string]bool{
	"text": true, "number": true, "integer": true, "percent": true,
	"currency": true, "boolean": true, "date": true, "datetime": true, "url": true,
}

type manualSourceProvider struct{}

func (manualSourceProvider) Normalize(_ context.Context, raw json.RawMessage) (any, error) {
	var c ManualSourceConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	if len(c.Columns) < 1 || len(c.Columns) > 12 {
		return nil, errors.New("manual data must define between 1 and 12 columns")
	}
	if len(c.Rows) > 200 {
		return nil, errors.New("manual data is limited to 200 rows")
	}
	columns := map[string]ManualColumn{}
	for index := range c.Columns {
		column := &c.Columns[index]
		column.Key = sanitizeFieldKey(column.Key)
		column.Label = sanitizeCalendarText(column.Label, 80)
		column.Type = strings.ToLower(strings.TrimSpace(column.Type))
		column.Currency = strings.ToUpper(strings.TrimSpace(column.Currency))
		if column.Key == "" || column.Label == "" || !typedFieldTypes[column.Type] {
			return nil, errors.New("manual data column is invalid")
		}
		if _, exists := columns[column.Key]; exists {
			return nil, errors.New("manual data column keys must be unique")
		}
		if column.Type == "currency" {
			currency, err := currencydata.ParseISO(column.Currency)
			if column.Currency != "" && (err != nil || currency == currencydata.XXX) {
				return nil, errors.New("currency columns require a recognized ISO 4217 currency code")
			}
		}
		columns[column.Key] = *column
	}
	seenRows := map[string]bool{}
	for index := range c.Rows {
		row := &c.Rows[index]
		row.ID = strings.TrimSpace(row.ID)
		if row.ID == "" {
			row.ID = uuid.NewString()
		}
		if _, err := uuid.Parse(row.ID); err != nil || seenRows[row.ID] {
			return nil, errors.New("manual data row IDs must be unique UUIDs")
		}
		seenRows[row.ID] = true
		normalized := map[string]string{}
		for key, value := range row.Values {
			column, ok := columns[key]
			if !ok {
				return nil, fmt.Errorf("manual data row references unknown column %q", key)
			}
			clean, err := normalizeTypedValue(value, column)
			if err != nil {
				return nil, fmt.Errorf("manual data row %d column %s: %w", index+1, column.Label, err)
			}
			normalized[key] = clean
		}
		row.Values = normalized
	}
	if c.DateSelection.Enabled {
		dateColumn := false
		for _, column := range c.Columns {
			if column.Key == c.DateField && (column.Type == "date" || column.Type == "datetime") {
				dateColumn = true
				break
			}
		}
		if !dateColumn {
			return nil, errors.New("date-aware manual data requires a date or datetime column")
		}
		if err := normalizeDateSelection(&c.DateSelection); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func sanitizeFieldKey(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 80 {
		value = value[:80]
	}
	var result strings.Builder
	for index, r := range value {
		if (r >= 'a' && r <= 'z') || (index > 0 && r >= 'A' && r <= 'Z') || (index > 0 && r >= '0' && r <= '9') || (index > 0 && r == '_') {
			result.WriteRune(r)
		}
	}
	return result.String()
}

func normalizeTypedValue(value string, column ManualColumn) (string, error) {
	value = sanitizeCalendarText(value, 500)
	if value == "" {
		return "", nil
	}
	switch column.Type {
	case "number", "percent", "currency":
		number, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return "", errors.New("value must be a finite number")
		}
		return strconv.FormatFloat(number, 'f', -1, 64), nil
	case "integer":
		number, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return "", errors.New("value must be an integer")
		}
		return strconv.FormatInt(number, 10), nil
	case "boolean":
		parsed, err := strconv.ParseBool(strings.ToLower(value))
		if err != nil {
			return "", errors.New("value must be true or false")
		}
		return strconv.FormatBool(parsed), nil
	case "date":
		if _, err := time.Parse("2006-01-02", value); err != nil {
			return "", errors.New("value must use YYYY-MM-DD")
		}
	case "datetime":
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			local, localErr := time.Parse("2006-01-02T15:04", value)
			if localErr != nil {
				return "", errors.New("value must use RFC 3339 or YYYY-MM-DDTHH:MM")
			}
			parsed = local.UTC()
		}
		return parsed.UTC().Format(time.RFC3339), nil
	case "url":
		parsed, err := url.Parse(value)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
			return "", errors.New("value must be a credential-free HTTPS URL")
		}
	}
	return value, nil
}

func normalizeDateSelection(selection *DateSelection) error {
	if selection.DateFormat == "" {
		selection.DateFormat = "auto"
	}
	if selection.Timezone == "" {
		selection.Timezone = "UTC"
	}
	if _, err := time.LoadLocation(selection.Timezone); err != nil {
		return errors.New("date selection timezone is invalid")
	}
	if selection.Mode == "" {
		selection.Mode = "today"
	}
	if selection.NoMatchBehavior == "" {
		selection.NoMatchBehavior = "empty"
	}
	validModes := map[string]bool{"today": true, "tomorrow": true, "next_available": true, "current_week": true, "custom_range": true}
	validNoMatch := map[string]bool{"fallback_text": true, "next_available": true, "empty": true, "hide": true, "last_known_good": true}
	if !validModes[selection.Mode] || !validNoMatch[selection.NoMatchBehavior] {
		return errors.New("date selection policy is invalid")
	}
	selection.FallbackText = sanitizeCalendarText(selection.FallbackText, 240)
	if selection.NoMatchBehavior == "fallback_text" && selection.FallbackText == "" {
		return errors.New("date selection fallback text is required")
	}
	if selection.Mode == "custom_range" && (!validISODate(selection.CustomStartDate) || !validISODate(selection.CustomEndDate) || selection.CustomEndDate < selection.CustomStartDate) {
		return errors.New("date selection custom range is invalid")
	}
	return nil
}

type weatherSourceProvider struct{}

func (weatherSourceProvider) Normalize(_ context.Context, raw json.RawMessage) (any, error) {
	var c WeatherSourceConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	c.LocationLabel = sanitizeCalendarText(c.LocationLabel, 120)
	c.Contact = strings.TrimSpace(c.Contact)
	c.Latitude = math.Round(c.Latitude*10000) / 10000
	c.Longitude = math.Round(c.Longitude*10000) / 10000
	if c.LocationLabel == "" || c.Latitude < -90 || c.Latitude > 90 || c.Longitude < -180 || c.Longitude > 180 {
		return nil, errors.New("weather location is invalid")
	}
	if c.Timezone == "" {
		c.Timezone = "UTC"
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		return nil, errors.New("weather timezone is invalid")
	}
	if c.Units == "" {
		c.Units = "metric"
	}
	if c.Units != "metric" && c.Units != "imperial" {
		return nil, errors.New("weather units are invalid")
	}
	if c.ForecastDays == 0 {
		c.ForecastDays = 5
	}
	if c.ForecastDays < 1 || c.ForecastDays > 7 {
		return nil, errors.New("weather forecast days must be between 1 and 7")
	}
	if c.RefreshIntervalSeconds == 0 {
		c.RefreshIntervalSeconds = 1800
	}
	if c.RefreshIntervalSeconds < 300 || c.RefreshIntervalSeconds > 21600 {
		return nil, errors.New("weather refresh interval must be between 300 and 21600 seconds")
	}
	if c.StalenessLimitHours == 0 {
		c.StalenessLimitHours = 24
	}
	if c.StalenessLimitHours < 1 || c.StalenessLimitHours > 168 {
		return nil, errors.New("weather staleness limit must be between 1 and 168 hours")
	}
	if !validWeatherContact(c.Contact) {
		return nil, errors.New("weather contact must be an email address or HTTPS URL")
	}
	return c, nil
}

func validWeatherContact(value string) bool {
	if address, err := mail.ParseAddress(value); err == nil && address.Address == value {
		return true
	}
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil
}

type metForecast struct {
	Properties struct {
		Timeseries []struct {
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
		} `json:"timeseries"`
	} `json:"properties"`
}

func (s *Service) refreshWeather(ctx context.Context, id uuid.UUID, c WeatherSourceConfig, lastModified string) (TypedRecordData, DataSourceDiagnostics, string, *time.Time, bool, error) {
	endpoint := fmt.Sprintf("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=%.4f&lon=%.4f", c.Latitude, c.Longitude)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return TypedRecordData{}, DataSourceDiagnostics{}, "", nil, false, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Tilecast/1 "+c.Contact)
	if lastModified != "" {
		request.Header.Set("If-Modified-Since", lastModified)
	}
	response, err := s.sourceHTTPClient().Do(request)
	diagnostics := DataSourceDiagnostics{DataSourceID: id, ParseStatus: "failed"}
	if err != nil {
		return TypedRecordData{}, diagnostics, "", nil, false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
		category := "not_modified"
		diagnostics.HTTPResultCategory = &category
		return TypedRecordData{}, diagnostics, lastModified, parseHTTPExpiry(response.Header), true, nil
	}
	category := fmt.Sprintf("http_%d", response.StatusCode)
	diagnostics.HTTPResultCategory = &category
	if response.StatusCode != http.StatusOK {
		return TypedRecordData{}, diagnostics, "", nil, false, errors.New("weather service returned an unsuccessful status")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, s.cfg.SourceFetch.MaximumBytes+1))
	if err != nil || int64(len(body)) > s.cfg.SourceFetch.MaximumBytes {
		return TypedRecordData{}, diagnostics, "", nil, false, errors.New("weather response could not be read")
	}
	var forecast metForecast
	if err = json.Unmarshal(body, &forecast); err != nil {
		return TypedRecordData{}, diagnostics, "", nil, false, errors.New("weather response is invalid")
	}
	data, err := normalizeWeatherForecast(forecast, c)
	if err != nil {
		return TypedRecordData{}, diagnostics, "", nil, false, err
	}
	now := time.Now().UTC()
	stale := now.Add(time.Duration(c.StalenessLimitHours) * time.Hour)
	data.CachedAt, data.StaleAt = &now, &stale
	data.Attribution = "Data from MET Norway"
	diagnostics.ParseStatus = "success"
	diagnostics.AvailableItemCount = len(data.Records)
	diagnostics.CacheUpdatedAt, diagnostics.CacheExpiresAt = &now, &stale
	return data, diagnostics, response.Header.Get("Last-Modified"), parseHTTPExpiry(response.Header), false, nil
}

func parseHTTPExpiry(header http.Header) *time.Time {
	if directives := header.Values("Cache-Control"); len(directives) > 0 {
		for _, directive := range strings.Split(strings.Join(directives, ","), ",") {
			name, value, found := strings.Cut(strings.TrimSpace(directive), "=")
			if !found || !strings.EqualFold(name, "max-age") {
				continue
			}
			seconds, err := strconv.Atoi(strings.Trim(value, `"`))
			if err == nil && seconds >= 0 {
				base := time.Now().UTC()
				if date := header.Get("Date"); date != "" {
					if parsed, parseErr := http.ParseTime(date); parseErr == nil {
						base = parsed
					}
				}
				expires := base.Add(time.Duration(seconds) * time.Second)
				return &expires
			}
		}
	}
	if value := header.Get("Expires"); value != "" {
		if parsed, err := http.ParseTime(value); err == nil {
			return &parsed
		}
	}
	return nil
}

func normalizeWeatherForecast(forecast metForecast, c WeatherSourceConfig) (TypedRecordData, error) {
	if len(forecast.Properties.Timeseries) == 0 {
		return TypedRecordData{}, errors.New("weather response contains no forecast")
	}
	location, _ := time.LoadLocation(c.Timezone)
	unitTemperature, unitWind, unitPrecipitation := "°C", "m/s", "mm"
	tempMultiplier, tempOffset, windMultiplier, precipMultiplier := 1.0, 0.0, 1.0, 1.0
	if c.Units == "imperial" {
		unitTemperature, unitWind, unitPrecipitation = "°F", "mph", "in"
		tempMultiplier, tempOffset, windMultiplier, precipMultiplier = 9.0/5.0, 32.0, 2.236936, 0.0393701
	}
	fields := []DataSourceField{
		{Key: "kind", Label: "Kind", Type: "text"},
		{Key: "location", Label: "Location", Type: "text"},
		{Key: "date", Label: "Date", Type: "date"},
		{Key: "condition", Label: "Condition", Type: "text"},
		{Key: "temperature", Label: "Temperature", Type: "number"},
		{Key: "temperatureUnit", Label: "Temperature unit", Type: "text"},
		{Key: "high", Label: "High", Type: "number"},
		{Key: "low", Label: "Low", Type: "number"},
		{Key: "humidity", Label: "Humidity", Type: "percent"},
		{Key: "windSpeed", Label: "Wind speed", Type: "number"},
		{Key: "windUnit", Label: "Wind unit", Type: "text"},
		{Key: "precipitation", Label: "Precipitation", Type: "number"},
		{Key: "precipitationUnit", Label: "Precipitation unit", Type: "text"},
	}
	first := forecast.Properties.Timeseries[0]
	currentDetails := first.Data.Instant.Details
	currentCondition := first.Data.Next1.Summary.SymbolCode
	if currentCondition == "" {
		currentCondition = first.Data.Next6.Summary.SymbolCode
	}
	records := []TypedRecord{{
		ID: "current",
		Values: map[string]string{
			"kind": "current", "location": c.LocationLabel,
			"date":              first.Time.In(location).Format("2006-01-02"),
			"condition":         weatherConditionLabel(currentCondition),
			"temperature":       formatWeatherNumber(currentDetails["air_temperature"]*tempMultiplier + tempOffset),
			"temperatureUnit":   unitTemperature,
			"humidity":          formatWeatherNumber(currentDetails["relative_humidity"]),
			"windSpeed":         formatWeatherNumber(currentDetails["wind_speed"] * windMultiplier),
			"windUnit":          unitWind,
			"precipitation":     formatWeatherNumber(first.Data.Next1.Details["precipitation_amount"] * precipMultiplier),
			"precipitationUnit": unitPrecipitation,
		},
	}}
	type aggregate struct {
		date, condition   string
		high, low, precip float64
		set               bool
	}
	days := map[string]*aggregate{}
	order := []string{}
	for _, point := range forecast.Properties.Timeseries {
		date := point.Time.In(location).Format("2006-01-02")
		day := days[date]
		if day == nil {
			day = &aggregate{date: date, high: -math.MaxFloat64, low: math.MaxFloat64}
			days[date] = day
			order = append(order, date)
		}
		temp, ok := point.Data.Instant.Details["air_temperature"]
		if ok {
			temp = temp*tempMultiplier + tempOffset
			day.high, day.low, day.set = max(day.high, temp), min(day.low, temp), true
		}
		day.precip += point.Data.Next1.Details["precipitation_amount"] * precipMultiplier
		localHour := point.Time.In(location).Hour()
		if day.condition == "" || localHour == 12 {
			code := point.Data.Next6.Summary.SymbolCode
			if code == "" {
				code = point.Data.Next1.Summary.SymbolCode
			}
			if code != "" {
				day.condition = weatherConditionLabel(code)
			}
		}
	}
	sort.Strings(order)
	for _, date := range order {
		if len(records) > c.ForecastDays {
			break
		}
		day := days[date]
		if !day.set {
			continue
		}
		records = append(records, TypedRecord{ID: "day-" + date, Values: map[string]string{
			"kind": "forecast", "location": c.LocationLabel, "date": date,
			"condition": day.condition, "high": formatWeatherNumber(day.high),
			"low": formatWeatherNumber(day.low), "temperatureUnit": unitTemperature,
			"precipitation": formatWeatherNumber(day.precip), "precipitationUnit": unitPrecipitation,
		}})
	}
	return TypedRecordData{Fields: fields, Records: records}, nil
}

func formatWeatherNumber(value float64) string {
	return strconv.FormatFloat(math.Round(value*10)/10, 'f', -1, 64)
}

func weatherConditionLabel(code string) string {
	code = strings.TrimSuffix(strings.TrimSuffix(code, "_day"), "_night")
	return strings.Title(strings.ReplaceAll(code, "_", " ")) //nolint:staticcheck
}

func manualPlayerData(c ManualSourceConfig) TypedRecordData {
	fields := make([]DataSourceField, 0, len(c.Columns))
	for _, column := range c.Columns {
		fields = append(fields, DataSourceField{Key: column.Key, Label: column.Label, Type: column.Type, Currency: column.Currency})
	}
	records := make([]TypedRecord, 0, len(c.Rows))
	for _, row := range c.Rows {
		records = append(records, TypedRecord{ID: row.ID, Values: row.Values})
	}
	now := time.Now().UTC()
	var selection *DateSelection
	if c.DateSelection.Enabled {
		copy := c.DateSelection
		selection = &copy
	}
	return TypedRecordData{Fields: fields, Records: records, CachedAt: &now, StaleAt: &now, DateSelection: selection, DateField: c.DateField}
}

func (s *Service) ManualPreview(ctx context.Context, raw json.RawMessage) (TypedRecordData, error) {
	normalized, err := (manualSourceProvider{}).Normalize(ctx, raw)
	if err != nil {
		return TypedRecordData{}, err
	}
	return manualPlayerData(normalized.(ManualSourceConfig)), nil
}

func (s *Service) WeatherPreview(ctx context.Context, raw json.RawMessage) (TypedRecordData, error) {
	normalized, err := (weatherSourceProvider{}).Normalize(ctx, raw)
	if err != nil {
		return TypedRecordData{}, err
	}
	data, _, _, _, _, err := s.refreshWeather(ctx, uuid.Nil, normalized.(WeatherSourceConfig), "")
	return data, err
}

func (s *Service) PlayerTypedDataSourceConfiguration(ctx context.Context, id uuid.UUID, provider string, raw json.RawMessage) (json.RawMessage, error) {
	if provider == "manual" {
		var config ManualSourceConfig
		if err := json.Unmarshal(raw, &config); err != nil {
			return nil, err
		}
		return json.Marshal(manualPlayerData(config))
	}
	if definition, ok := s.definitions.DataSource(provider); ok && (definition.AdapterID == "manual_object" || definition.AdapterID == "manual_records") {
		// Both adapters cache a complete typed payload at save time, and manual_records is
		// re-projected by the refresh worker at each publish-window boundary.
		var payload json.RawMessage
		if err := s.db.QueryRow(ctx, `SELECT cached_payload FROM data_source_refresh_states WHERE data_source_id=$1`, id).Scan(&payload); err != nil {
			return nil, err
		}
		return payload, nil
	}
	if provider == "form" {
		// Form Data Sources are projected internally by the forms package into a typed-dataset
		// payload (one dataset per saved view). Only approved, output-eligible records reach this
		// payload, so unapproved records and their attachments never enter a manifest.
		var payload json.RawMessage
		if err := s.db.QueryRow(ctx, `SELECT cached_payload FROM data_source_refresh_states WHERE data_source_id=$1`, id).Scan(&payload); err != nil {
			return nil, err
		}
		if len(payload) == 0 {
			return json.RawMessage(`{"datasets":[]}`), nil
		}
		return payload, nil
	}
	var payload json.RawMessage
	var expires *time.Time
	var usingCache bool
	var errorCode *string
	err := s.db.QueryRow(ctx, `SELECT cached_payload,cache_expires_at,using_cached_data,error_code FROM data_source_refresh_states WHERE data_source_id=$1`, id).Scan(&payload, &expires, &usingCache, &errorCode)
	if err != nil {
		return nil, err
	}
	_, fetchesRecords := s.httpRecordsSpec(provider)
	if provider == "transit" || provider == "cap_alerts" || provider == "air_quality" || fetchesRecords {
		data := TypedDatasetPayload{Datasets: []TypedDataset{}}
		if expires != nil && expires.After(time.Now()) {
			if err := json.Unmarshal(payload, &data); err != nil {
				return nil, err
			}
			for index := range data.Datasets {
				data.Datasets[index].UsingCachedData = usingCache
			}
		} else if errorCode != nil {
			for index := range data.Datasets {
				data.Datasets[index].Unavailable = true
			}
		}
		if provider == "air_quality" {
			for index := range data.Datasets {
				data.Datasets[index].Attribution = liveSourceAttributionAirQuality
			}
		}
		return json.Marshal(data)
	}
	if provider == "weather" {
		data := TypedRecordData{Fields: s.availableDataSourceFields(provider, raw), Records: []TypedRecord{}}
		if expires != nil && expires.After(time.Now()) {
			if err := json.Unmarshal(payload, &data); err != nil {
				return nil, err
			}
			data.UsingCachedData = usingCache
		} else if errorCode != nil {
			data.Unavailable = true
		}
		data.Attribution = "Data from MET Norway"
		return json.Marshal(data)
	}
	if provider == "calendar" {
		var config CalendarConfig
		if err := json.Unmarshal(raw, &config); err != nil {
			return nil, err
		}
		prepared := CalendarPreparedData{Events: []CalendarEvent{}}
		if expires != nil && expires.After(time.Now()) {
			if err := json.Unmarshal(payload, &prepared); err != nil {
				return nil, err
			}
			prepared.UsingCachedData = usingCache
		} else if errorCode != nil {
			prepared.Unavailable = true
		}
		fields := s.availableDataSourceFields(provider, raw)
		records := make([]TypedRecord, 0, len(prepared.Events))
		location, _ := time.LoadLocation(config.Timezone)
		for _, event := range prepared.Events {
			values := map[string]string{
				"title": event.Title, "startTime": event.Start.Format(time.RFC3339),
				"endTime": event.End.Format(time.RFC3339), "date": event.Start.In(location).Format("2006-01-02"),
				"location": event.Location, "descriptionExcerpt": event.DescriptionExcerpt,
			}
			records = append(records, TypedRecord{ID: event.ID, Values: values})
		}
		return json.Marshal(TypedRecordData{Fields: fields, Records: records, CachedAt: &prepared.CachedAt, StaleAt: &prepared.StaleAt, UsingCachedData: prepared.UsingCachedData, Unavailable: prepared.Unavailable})
	}
	var config StructuredSourceConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, err
	}
	prepared := StructuredPreparedData{Records: []StructuredRecord{}}
	if expires != nil && expires.After(time.Now()) {
		if err := json.Unmarshal(payload, &prepared); err != nil {
			return nil, err
		}
		prepared.UsingCachedData = usingCache
	} else if errorCode != nil {
		prepared.Unavailable = true
	}
	records := make([]TypedRecord, 0, len(prepared.Records))
	for _, record := range prepared.Records {
		values := map[string]string{
			"title": record.Title, "subtitle": record.Subtitle, "date": record.Date,
			"author": record.Author, "description": record.Description, "source": record.Source,
			"imageUrl": record.ImageURL, "link": record.Link,
		}
		for key, value := range record.Values {
			values[key] = value
		}
		records = append(records, TypedRecord{ID: record.ID, Values: values})
	}
	var selection *DateSelection
	if config.DateSelection.Enabled {
		copy := config.DateSelection
		selection = &copy
	}
	cachedAt, staleAt := prepared.CachedAt, prepared.StaleAt
	return json.Marshal(TypedRecordData{
		Fields: s.availableDataSourceFields(provider, raw), Records: records,
		CachedAt: &cachedAt, StaleAt: &staleAt, UsingCachedData: prepared.UsingCachedData,
		Unavailable: prepared.Unavailable, DateSelection: selection, DateField: "date",
	})
}
