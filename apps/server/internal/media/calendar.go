package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	ical "github.com/emersion/go-ical"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	calendarConfigVersion = 1
	calendarWindowDays    = 90
	calendarMaxFeeds      = 8
	calendarMaxEvents     = 100
)

type SourceFetchPolicy struct {
	AllowPrivateNetworks bool
	Timeout              time.Duration
	MaximumBytes         int64
	MaximumRedirects     int
	MinimumRefresh       time.Duration
	MaximumRefresh       time.Duration
}

type calendarSourceProvider struct{ service *Service }

func (p calendarSourceProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var config CalendarConfig
	if err := decodeConfig(raw, &config); err != nil {
		return nil, err
	}
	if len(config.Calendars) < 1 || len(config.Calendars) > calendarMaxFeeds {
		return nil, fmt.Errorf("calendar source must contain between 1 and %d calendars", calendarMaxFeeds)
	}
	seen := map[string]bool{}
	for index := range config.Calendars {
		feed := &config.Calendars[index]
		feed.Name = sanitizeCalendarText(feed.Name, 120)
		feed.URL = strings.TrimSpace(feed.URL)
		if feed.Name == "" || seen[strings.ToLower(feed.Name)] {
			return nil, errors.New("calendar names must be unique and non-empty")
		}
		seen[strings.ToLower(feed.Name)] = true
		if _, err := p.service.validateSourceURL(ctx, feed.URL); err != nil {
			return nil, err
		}
	}
	if config.DisplayMode == "" {
		config.DisplayMode = "upcoming"
	}
	if config.DisplayMode != "today" && config.DisplayMode != "upcoming" && config.DisplayMode != "this_week" && config.DisplayMode != "agenda" {
		return nil, errors.New("calendar display mode is invalid")
	}
	if config.MaxEvents == 0 {
		config.MaxEvents = 10
	}
	if config.MaxEvents < 1 || config.MaxEvents > calendarMaxEvents {
		return nil, fmt.Errorf("calendar maximum event count must be between 1 and %d", calendarMaxEvents)
	}
	if !config.Fields.Title && !config.Fields.StartTime && !config.Fields.EndTime && !config.Fields.Date && !config.Fields.Location && !config.Fields.DescriptionExcerpt {
		config.Fields = CalendarFields{Title: true, StartTime: true, Date: true}
	}
	config.FilterKeyword = sanitizeCalendarText(config.FilterKeyword, 120)
	for _, name := range config.FilterCalendars {
		if !seen[strings.ToLower(strings.TrimSpace(name))] {
			return nil, errors.New("calendar filter references an unknown calendar")
		}
	}
	if config.Timezone == "" {
		config.Timezone = "UTC"
	}
	if _, err := time.LoadLocation(config.Timezone); err != nil {
		return nil, errors.New("calendar timezone is invalid")
	}
	minimum := int(p.service.cfg.SourceFetch.MinimumRefresh / time.Second)
	maximum := int(p.service.cfg.SourceFetch.MaximumRefresh / time.Second)
	if config.RefreshIntervalSeconds == 0 {
		config.RefreshIntervalSeconds = 900
	}
	if config.RefreshIntervalSeconds < minimum || config.RefreshIntervalSeconds > maximum {
		return nil, fmt.Errorf("calendar refresh interval must be between %d and %d seconds", minimum, maximum)
	}
	if config.StalenessLimitHours == 0 {
		config.StalenessLimitHours = 168
	}
	if config.StalenessLimitHours < 1 || config.StalenessLimitHours > 24*90 {
		return nil, errors.New("calendar staleness limit must be between 1 and 2160 hours")
	}
	config.EmptyState = sanitizeCalendarText(config.EmptyState, 240)
	if config.EmptyState == "" {
		config.EmptyState = "No events scheduled"
	}
	return config, nil
}

func (s *Service) validateSourceURL(ctx context.Context, raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return nil, errors.New("Source URL is invalid")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, errors.New("Source URL must use HTTP or HTTPS")
	}
	if port := u.Port(); port != "" && !((u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80")) {
		host := strings.ToLower(u.Hostname())
		ip := net.ParseIP(host)
		localName := host == "localhost" || strings.HasSuffix(host, ".local")
		if !s.cfg.SourceFetch.AllowPrivateNetworks || (!localName && (ip == nil || !isPrivateSourceIP(ip))) {
			return nil, errors.New("public Source URL uses a disallowed port")
		}
	}
	if u.Scheme == "http" {
		host := strings.ToLower(u.Hostname())
		ip := net.ParseIP(host)
		localName := host == "localhost" || strings.HasSuffix(host, ".local")
		if !s.cfg.SourceFetch.AllowPrivateNetworks || (!localName && (ip == nil || !isPrivateSourceIP(ip))) {
			return nil, errors.New("public Source URLs must use HTTPS")
		}
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, u.Hostname())
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("Source URL host could not be resolved")
	}
	if !s.cfg.SourceFetch.AllowPrivateNetworks {
		for _, address := range addresses {
			if isPrivateSourceIP(address.IP) {
				return nil, errors.New("Source URL resolves to a private network")
			}
		}
	}
	return u, nil
}

func isPrivateSourceIP(ip net.IP) bool {
	if ip == nil || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() || !ip.IsGlobalUnicast() {
		return true
	}
	_, shared, _ := net.ParseCIDR("100.64.0.0/10")
	return shared.Contains(ip)
}

func (s *Service) sourceHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: s.cfg.SourceFetch.Timeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, resolved := range addresses {
				if !s.cfg.SourceFetch.AllowPrivateNetworks && isPrivateSourceIP(resolved.IP) {
					continue
				}
				connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(resolved.IP.String(), port))
				if dialErr == nil {
					return connection, nil
				}
			}
			return nil, errors.New("Source URL has no permitted address")
		},
		TLSHandshakeTimeout:   s.cfg.SourceFetch.Timeout,
		ResponseHeaderTimeout: s.cfg.SourceFetch.Timeout,
		IdleConnTimeout:       30 * time.Second,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   s.cfg.SourceFetch.Timeout,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= s.cfg.SourceFetch.MaximumRedirects {
				return errors.New("Source redirect limit exceeded")
			}
			_, err := s.validateSourceURL(request.Context(), request.URL.String())
			return err
		},
	}
}

func (s *Service) fetchCalendar(ctx context.Context, feed CalendarFeed) ([]byte, string, error) {
	u, err := s.validateSourceURL(ctx, feed.URL)
	if err != nil {
		return nil, "blocked", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "invalid_request", err
	}
	request.Header.Set("Accept", "text/calendar, application/ics;q=0.9, text/plain;q=0.5")
	request.Header.Set("User-Agent", "Tilecast-Source-Refresh/1")
	response, err := s.sourceHTTPClient().Do(request)
	if err != nil {
		return nil, "network_error", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Sprintf("http_%d", response.StatusCode), errors.New("calendar server returned an unsuccessful status")
	}
	contentType := strings.ToLower(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if contentType != "text/calendar" && contentType != "application/ics" && contentType != "text/plain" && contentType != "application/octet-stream" {
		return nil, "unsupported_content_type", errors.New("calendar response content type is not supported")
	}
	limited := io.LimitReader(response.Body, s.cfg.SourceFetch.MaximumBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, "read_error", err
	}
	if int64(len(body)) > s.cfg.SourceFetch.MaximumBytes {
		return nil, "response_too_large", errors.New("calendar response exceeds the configured size limit")
	}
	if !bytesContainsCalendar(body) {
		return nil, "invalid_calendar", errors.New("calendar response is not iCalendar data")
	}
	return body, "success", nil
}

func bytesContainsCalendar(body []byte) bool {
	prefix := strings.ToUpper(strings.TrimSpace(string(body[:min(len(body), 256)])))
	return strings.Contains(prefix, "BEGIN:VCALENDAR")
}

func ParseCalendar(body []byte, calendarName string, loc *time.Location, windowStart, windowEnd time.Time) ([]CalendarEvent, error) {
	calendar, err := ical.NewDecoder(strings.NewReader(string(body))).Decode()
	if err != nil {
		return nil, err
	}
	result := []CalendarEvent{}
	events := calendar.Events()
	overridden := map[string]bool{}
	for _, event := range events {
		recurrenceID := event.Props.Get(ical.PropRecurrenceID)
		uid, _ := event.Props.Text(ical.PropUID)
		if recurrenceID != nil {
			if original, recurrenceErr := recurrenceID.DateTime(loc); recurrenceErr == nil {
				overridden[uid+"\x00"+original.UTC().Format(time.RFC3339Nano)] = true
			}
		}
	}
	for _, event := range events {
		status, statusErr := event.Status()
		if statusErr == nil && status == ical.EventCancelled {
			continue
		}
		start, err := event.DateTimeStart(loc)
		if err != nil {
			continue
		}
		startProperty := event.Props.Get(ical.PropDateTimeStart)
		allDay := startProperty != nil && startProperty.ValueType() == ical.ValueDate
		end, endErr := event.DateTimeEnd(loc)
		if endErr != nil {
			end = start
			if duration := event.Props.Get(ical.PropDuration); duration != nil {
				if parsed, durationErr := duration.Duration(); durationErr == nil {
					end = start.Add(parsed)
				}
			}
			if !end.After(start) {
				if allDay {
					end = start.AddDate(0, 0, 1)
				} else {
					end = start.Add(time.Hour)
				}
			}
		}
		title, _ := event.Props.Text(ical.PropSummary)
		location, _ := event.Props.Text(ical.PropLocation)
		description, _ := event.Props.Text(ical.PropDescription)
		uid, _ := event.Props.Text(ical.PropUID)
		duration := end.Sub(start)
		occurrences := []time.Time{start}
		if event.Props.Get(ical.PropRecurrenceRule) != nil {
			set, recurrenceErr := event.RecurrenceSet(loc)
			if recurrenceErr != nil {
				return nil, recurrenceErr
			}
			occurrences = set.Between(windowStart, windowEnd, true)
		}
		for _, occurrence := range occurrences {
			if event.Props.Get(ical.PropRecurrenceID) == nil && overridden[uid+"\x00"+occurrence.UTC().Format(time.RFC3339Nano)] {
				continue
			}
			occurrenceEnd := occurrence.Add(duration)
			if occurrenceEnd.Before(windowStart) || occurrence.After(windowEnd) {
				continue
			}
			hash := sha256.Sum256([]byte(uid + "\x00" + calendarName + "\x00" + occurrence.UTC().Format(time.RFC3339Nano)))
			result = append(result, CalendarEvent{
				ID:                 hex.EncodeToString(hash[:12]),
				Calendar:           sanitizeCalendarText(calendarName, 120),
				Title:              sanitizeCalendarText(title, 300),
				Start:              occurrence.UTC(),
				End:                occurrenceEnd.UTC(),
				AllDay:             allDay,
				Location:           sanitizeCalendarText(location, 300),
				DescriptionExcerpt: sanitizeCalendarText(description, 500),
			})
			if len(result) >= 2000 {
				return result, nil
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Start.Equal(result[j].Start) {
			return result[i].ID < result[j].ID
		}
		return result[i].Start.Before(result[j].Start)
	})
	return result, nil
}

var calendarTagPattern = regexp.MustCompile(`<[^>]{0,500}>`)

func sanitizeCalendarText(value string, maximum int) string {
	value = calendarTagPattern.ReplaceAllString(value, " ")
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	if utf8.RuneCountInString(value) <= maximum {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:maximum]))
}

func filterCalendarEvents(events []CalendarEvent, config CalendarConfig) []CalendarEvent {
	keyword := strings.ToLower(config.FilterKeyword)
	calendars := map[string]bool{}
	for _, name := range config.FilterCalendars {
		calendars[strings.ToLower(name)] = true
	}
	filtered := make([]CalendarEvent, 0, len(events))
	for _, event := range events {
		if len(calendars) > 0 && !calendars[strings.ToLower(event.Calendar)] {
			continue
		}
		if keyword != "" && !strings.Contains(strings.ToLower(event.Title+" "+event.Location+" "+event.DescriptionExcerpt), keyword) {
			continue
		}
		filtered = append(filtered, event)
	}
	return filtered
}

func (s *Service) refreshCalendar(ctx context.Context, assetID uuid.UUID, config CalendarConfig) (CalendarPreparedData, DataSourceDiagnostics, error) {
	loc, _ := time.LoadLocation(config.Timezone)
	now := time.Now().UTC()
	windowStart := now.Add(-24 * time.Hour)
	windowEnd := now.AddDate(0, 0, calendarWindowDays)
	all := []CalendarEvent{}
	httpCategory := "success"
	parseStatus := "not_attempted"
	successfulFeeds := 0
	for _, feed := range config.Calendars {
		body, category, err := s.fetchCalendar(ctx, feed)
		if err != nil {
			httpCategory = category
			continue
		}
		events, err := ParseCalendar(body, feed.Name, loc, windowStart, windowEnd)
		if err != nil {
			parseStatus = "failed"
			continue
		}
		if parseStatus == "not_attempted" {
			parseStatus = "success"
		}
		successfulFeeds++
		all = append(all, events...)
	}
	if successfulFeeds == 0 {
		return CalendarPreparedData{}, DataSourceDiagnostics{DataSourceID: assetID, HTTPResultCategory: &httpCategory, ParseStatus: parseStatus}, errors.New("no calendar could be refreshed")
	}
	if successfulFeeds != len(config.Calendars) {
		parseStatus = "partial"
		httpCategory = "partial_failure"
	}
	all = filterCalendarEvents(all, config)
	sort.Slice(all, func(i, j int) bool { return all[i].Start.Before(all[j].Start) })
	prepared := CalendarPreparedData{Events: all, CachedAt: now, StaleAt: now.Add(time.Duration(config.StalenessLimitHours) * time.Hour)}
	diagnostics := DataSourceDiagnostics{DataSourceID: assetID, HTTPResultCategory: &httpCategory, ParseStatus: parseStatus, AvailableEventCount: len(all), CacheUpdatedAt: &prepared.CachedAt, CacheExpiresAt: &prepared.StaleAt}
	return prepared, diagnostics, nil
}

func (s *Service) CalendarPreview(ctx context.Context, raw json.RawMessage) (CalendarPreview, error) {
	normalized, err := (calendarSourceProvider{s}).Normalize(ctx, raw)
	if err != nil {
		return CalendarPreview{}, err
	}
	config := normalized.(CalendarConfig)
	prepared, diagnostics, err := s.refreshCalendar(ctx, uuid.Nil, config)
	if err != nil {
		return CalendarPreview{}, err
	}
	return CalendarPreview{Configuration: CalendarPlayerConfig{DisplayMode: config.DisplayMode, MaxEvents: config.MaxEvents, Fields: config.Fields, Timezone: config.Timezone, EmptyState: config.EmptyState, Data: prepared}, Diagnostics: diagnostics}, nil
}

func (s *Service) DataSourceRefreshDiagnostics(ctx context.Context, id uuid.UUID) (DataSourceDiagnostics, error) {
	var diagnostics DataSourceDiagnostics
	diagnostics.DataSourceID = id
	err := s.db.QueryRow(ctx, `SELECT last_success_at,last_attempt_at,http_result_category,parse_status,available_event_count,available_item_count,using_cached_data,cache_updated_at,cache_expires_at,error_code FROM data_source_refresh_states WHERE data_source_id=$1`, id).Scan(&diagnostics.LastSuccessfulAt, &diagnostics.LastAttemptedAt, &diagnostics.HTTPResultCategory, &diagnostics.ParseStatus, &diagnostics.AvailableEventCount, &diagnostics.AvailableItemCount, &diagnostics.UsingCachedData, &diagnostics.CacheUpdatedAt, &diagnostics.CacheExpiresAt, &diagnostics.ErrorCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return DataSourceDiagnostics{}, ErrNotFound
	}
	return diagnostics, err
}

func (s *Service) PlayerDataSourceConfiguration(ctx context.Context, assetID uuid.UUID, provider string, raw json.RawMessage) (json.RawMessage, error) {
	if provider != "calendar" && provider != "rss" && provider != "atom" && provider != "feed" && provider != "json" && provider != "csv" {
		return raw, nil
	}
	if provider != "calendar" {
		var config StructuredSourceConfig
		if err := json.Unmarshal(raw, &config); err != nil {
			return nil, err
		}
		prepared := StructuredPreparedData{Records: []StructuredRecord{}}
		var payload json.RawMessage
		var expires *time.Time
		var usingCache bool
		var errorCode *string
		err := s.db.QueryRow(ctx, `SELECT cached_payload,cache_expires_at,using_cached_data,error_code FROM data_source_refresh_states WHERE data_source_id=$1`, assetID).Scan(&payload, &expires, &usingCache, &errorCode)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err == nil && expires != nil && expires.After(time.Now()) {
			if err = json.Unmarshal(payload, &prepared); err != nil {
				return nil, err
			}
			prepared.UsingCachedData = usingCache
		} else if errorCode != nil {
			prepared.Unavailable = true
		}
		return json.Marshal(StructuredPlayerConfig{Presentation: config.Presentation, Fields: config.Fields, EmptyState: config.EmptyState, DateSelection: config.DateSelection, Data: prepared})
	}
	var config CalendarConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, err
	}
	prepared := CalendarPreparedData{Events: []CalendarEvent{}}
	var payload json.RawMessage
	var expires *time.Time
	var usingCache bool
	var errorCode *string
	err := s.db.QueryRow(ctx, `SELECT cached_payload,cache_expires_at,using_cached_data,error_code FROM data_source_refresh_states WHERE data_source_id=$1`, assetID).Scan(&payload, &expires, &usingCache, &errorCode)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil && expires != nil && expires.After(time.Now()) {
		if unmarshalErr := json.Unmarshal(payload, &prepared); unmarshalErr != nil {
			return nil, unmarshalErr
		}
		prepared.UsingCachedData = usingCache
	} else if errorCode != nil {
		prepared.Unavailable = true
	}
	player := CalendarPlayerConfig{DisplayMode: config.DisplayMode, MaxEvents: config.MaxEvents, Fields: config.Fields, Timezone: config.Timezone, EmptyState: config.EmptyState, Data: prepared}
	return json.Marshal(player)
}
