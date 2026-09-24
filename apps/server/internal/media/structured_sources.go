package media

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
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
	"unicode/utf8"

	"github.com/google/uuid"
)

const structuredMaxItems = 200

// A mapping stays readable, and the record it produces stays small, at a dozen values.
const structuredValueFieldLimit = 12

// structuredValueFieldTypes are the types an author may declare for a mapped value. They
// are the Data Source field types a Widget picker filters on; a type outside this set
// would hide the field from every picker instead of narrowing it to the right one.
var structuredValueFieldTypes = map[string]bool{
	"text": true, "number": true, "date": true, "datetime": true, "url": true,
}

// structuredValueText renders one mapped value in the shape its declared type promises, so
// a Widget bound to a datetime always receives an instant it can parse. A remote feed is
// not under the author's control, so a value that does not parse is passed through as text
// rather than failing the refresh: a wrong-looking value on screen is easier to diagnose
// than a Source that quietly stopped updating.
func structuredValueText(raw, fieldType string) string {
	text := sanitizeCalendarText(raw, 240)
	if fieldType == "datetime" {
		if parsed, ok := parseStructuredDateTime(text); ok {
			return parsed.UTC().Format(time.RFC3339)
		}
	}
	return text
}

type structuredSourceProvider struct {
	service  *Service
	provider string
}

func (p structuredSourceProvider) Normalize(ctx context.Context, raw json.RawMessage) (any, error) {
	var c StructuredSourceConfig
	if err := decodeConfig(raw, &c); err != nil {
		return nil, err
	}
	if p.provider != "csv" || c.UploadedContent == "" {
		c.URL = strings.TrimSpace(c.URL)
		if _, err := p.service.validateSourceURL(ctx, c.URL); err != nil {
			return nil, err
		}
	} else {
		if len(c.UploadedContent) > int(p.service.cfg.SourceFetch.MaximumBytes) {
			return nil, errors.New("uploaded CSV exceeds the configured source size limit")
		}
		if !utf8.ValidString(c.UploadedContent) {
			return nil, errors.New("uploaded CSV must use UTF-8 encoding")
		}
		c.URL = ""
		c.Uploaded = true
	}
	if c.Presentation == "" {
		c.Presentation = "list"
	}
	if c.Presentation != "list" && c.Presentation != "agenda" && c.Presentation != "cards" && c.Presentation != "ticker" {
		return nil, errors.New("source presentation is invalid")
	}
	if c.MaxItems == 0 {
		c.MaxItems = 20
	}
	if c.MaxItems < 1 || c.MaxItems > structuredMaxItems {
		return nil, fmt.Errorf("source maximum item count must be between 1 and %d", structuredMaxItems)
	}
	if !c.Fields.Title && !c.Fields.Subtitle && !c.Fields.Date && !c.Fields.Author && !c.Fields.Description && !c.Fields.Image && !c.Fields.Link {
		c.Fields = StructuredFields{Title: true, Subtitle: true, Date: true}
	}
	c.FilterKeyword = sanitizeCalendarText(c.FilterKeyword, 120)
	if c.Sort == "" {
		c.Sort = "newest"
	}
	if c.Sort != "newest" && c.Sort != "oldest" && c.Sort != "title" && c.Sort != "source" {
		return nil, errors.New("source sort is invalid")
	}
	minimum := int(p.service.cfg.SourceFetch.MinimumRefresh / time.Second)
	maximum := int(p.service.cfg.SourceFetch.MaximumRefresh / time.Second)
	if c.RefreshIntervalSeconds == 0 {
		c.RefreshIntervalSeconds = 900
	}
	if c.RefreshIntervalSeconds < minimum || c.RefreshIntervalSeconds > maximum {
		return nil, fmt.Errorf("source refresh interval must be between %d and %d seconds", minimum, maximum)
	}
	if c.StalenessLimitHours == 0 {
		c.StalenessLimitHours = 168
	}
	if c.StalenessLimitHours < 1 || c.StalenessLimitHours > 2160 {
		return nil, errors.New("source staleness limit must be between 1 and 2160 hours")
	}
	c.EmptyState = sanitizeCalendarText(c.EmptyState, 240)
	if c.EmptyState == "" {
		c.EmptyState = "No items available"
	}
	if p.provider == "json" || p.provider == "csv" {
		if c.Mapping == nil {
			return nil, errors.New("source field mapping is required")
		}
		if err := validateStructuredMapping(*c.Mapping, p.provider); err != nil {
			return nil, err
		}
	}
	if p.provider == "csv" && c.Delimiter != "" && c.Delimiter != "," && c.Delimiter != ";" && c.Delimiter != "\t" && c.Delimiter != "|" {
		return nil, errors.New("CSV delimiter must be comma, semicolon, tab, or pipe")
	}
	if len(c.Filters) > 8 {
		return nil, errors.New("source filters are limited to eight")
	}
	for i := range c.Filters {
		c.Filters[i].Field = sanitizeCalendarText(c.Filters[i].Field, 120)
		c.Filters[i].Value = sanitizeCalendarText(c.Filters[i].Value, 240)
		if c.Filters[i].Field == "" || (c.Filters[i].Operator != "equals" && c.Filters[i].Operator != "contains") {
			return nil, errors.New("source filter is invalid")
		}
	}
	if c.DateSelection.Enabled {
		if c.Mapping == nil || c.Mapping.Date == "" {
			return nil, errors.New("date-aware selection requires a mapped date field")
		}
		if c.DateSelection.DateFormat == "" {
			c.DateSelection.DateFormat = "auto"
		}
		if c.DateSelection.DateFormat != "auto" && c.DateSelection.DateFormat != "iso_date" && c.DateSelection.DateFormat != "us_date" && c.DateSelection.DateFormat != "us_short" && c.DateSelection.DateFormat != "day_first_date" && c.DateSelection.DateFormat != "day_first_short" && c.DateSelection.DateFormat != "day_month_name" && c.DateSelection.DateFormat != "rfc3339" {
			return nil, errors.New("date selection format is invalid")
		}
		if c.DateSelection.Timezone == "" {
			c.DateSelection.Timezone = "UTC"
		}
		if _, err := time.LoadLocation(c.DateSelection.Timezone); err != nil {
			return nil, errors.New("date selection timezone is invalid")
		}
		if c.DateSelection.Mode == "" {
			c.DateSelection.Mode = "today"
		}
		if c.DateSelection.Mode != "today" && c.DateSelection.Mode != "tomorrow" && c.DateSelection.Mode != "next_available" && c.DateSelection.Mode != "current_week" && c.DateSelection.Mode != "custom_range" {
			return nil, errors.New("date selection mode is invalid")
		}
		if c.DateSelection.NoMatchBehavior == "" {
			c.DateSelection.NoMatchBehavior = "empty"
		}
		if c.DateSelection.NoMatchBehavior != "fallback_text" && c.DateSelection.NoMatchBehavior != "next_available" && c.DateSelection.NoMatchBehavior != "empty" && c.DateSelection.NoMatchBehavior != "hide" && c.DateSelection.NoMatchBehavior != "last_known_good" {
			return nil, errors.New("date selection no-match behavior is invalid")
		}
		c.DateSelection.FallbackText = sanitizeCalendarText(c.DateSelection.FallbackText, 240)
		if c.DateSelection.NoMatchBehavior == "fallback_text" && c.DateSelection.FallbackText == "" {
			return nil, errors.New("date selection fallback text is required")
		}
		if c.DateSelection.Mode == "custom_range" && (!validISODate(c.DateSelection.CustomStartDate) || !validISODate(c.DateSelection.CustomEndDate) || c.DateSelection.CustomEndDate < c.DateSelection.CustomStartDate) {
			return nil, errors.New("date selection custom range is invalid")
		}
	}
	return c, nil
}

func validISODate(value string) bool { _, err := time.Parse("2006-01-02", value); return err == nil }

func validateStructuredMapping(m StructuredMapping, provider string) error {
	paths := []string{m.RootList, m.Title, m.Subtitle, m.Date, m.ImageURL, m.Link}
	for _, v := range m.ValueFields {
		paths = append(paths, v)
	}
	for _, path := range paths {
		if path == "" {
			continue
		}
		if provider == "json" && !strings.HasPrefix(path, "/") && path != "" {
			return errors.New("JSON mappings must use JSON Pointer paths")
		}
		if len(path) > 240 {
			return errors.New("source mapping path is too long")
		}
	}
	if m.Title == "" && m.Subtitle == "" && m.Date == "" && len(m.ValueFields) == 0 {
		return errors.New("source mapping must include at least one display or value field")
	}
	if len(m.ValueFields) > structuredValueFieldLimit {
		return errors.New("source value fields are limited to twelve")
	}
	for name, fieldType := range m.ValueFieldTypes {
		if _, ok := m.ValueFields[name]; !ok {
			return fmt.Errorf("source value field type names %q, which is not mapped", name)
		}
		if !structuredValueFieldTypes[fieldType] {
			return fmt.Errorf("source value field type %q is invalid", fieldType)
		}
	}
	return nil
}

func (s *Service) fetchStructured(ctx context.Context, provider string, c StructuredSourceConfig) ([]byte, string, error) {
	if provider == "csv" && c.UploadedContent != "" {
		return []byte(c.UploadedContent), "uploaded", nil
	}
	u, err := s.validateSourceURL(ctx, c.URL)
	if err != nil {
		return nil, "blocked", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "invalid_request", err
	}
	accept := map[string]string{"rss": "application/rss+xml, application/xml;q=0.9", "atom": "application/atom+xml, application/xml;q=0.9", "json": "application/json", "csv": "text/csv, text/plain;q=0.8"}[provider]
	request.Header.Set("Accept", accept)
	request.Header.Set("User-Agent", "Tilecast-Source-Refresh/1")
	response, err := s.sourceHTTPClient().Do(request)
	if err != nil {
		return nil, "network_error", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Sprintf("http_%d", response.StatusCode), errors.New("source server returned an unsuccessful status")
	}
	contentType := strings.ToLower(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	allowed := map[string]map[string]bool{"rss": {"application/rss+xml": true, "application/xml": true, "text/xml": true}, "atom": {"application/atom+xml": true, "application/xml": true, "text/xml": true}, "json": {"application/json": true, "text/json": true}, "csv": {"text/csv": true, "application/csv": true, "text/plain": true, "application/octet-stream": true}}[provider]
	if !allowed[contentType] {
		return nil, "unsupported_content_type", errors.New("source response content type is not supported")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, s.cfg.SourceFetch.MaximumBytes+1))
	if err != nil {
		return nil, "read_error", err
	}
	if int64(len(body)) > s.cfg.SourceFetch.MaximumBytes {
		return nil, "response_too_large", errors.New("source response exceeds the configured size limit")
	}
	return body, "success", nil
}

type feedDocument struct {
	Channel struct {
		Title string     `xml:"title"`
		Items []feedItem `xml:"item"`
	} `xml:"channel"`
	Title   string     `xml:"title"`
	Entries []feedItem `xml:"entry"`
}
type feedItem struct {
	Title string `xml:"title"`
	Links []struct {
		Href string `xml:"href,attr"`
		Rel  string `xml:"rel,attr"`
		Text string `xml:",chardata"`
	} `xml:"link"`
	Description string `xml:"description"`
	Summary     string `xml:"summary"`
	Content     string `xml:"content"`
	Author      struct {
		Name string `xml:"name"`
		Text string `xml:",chardata"`
	} `xml:"author"`
	PubDate   string `xml:"pubDate"`
	Published string `xml:"published"`
	Updated   string `xml:"updated"`
	GUID      string `xml:"guid"`
	ID        string `xml:"id"`
	Enclosure struct {
		URL  string `xml:"url,attr"`
		Type string `xml:"type,attr"`
	} `xml:"enclosure"`
	MediaThumbnail struct {
		URL string `xml:"url,attr"`
	} `xml:"http://search.yahoo.com/mrss/ thumbnail"`
	MediaContent struct {
		URL    string `xml:"url,attr"`
		Type   string `xml:"type,attr"`
		Medium string `xml:"medium,attr"`
	} `xml:"http://search.yahoo.com/mrss/ content"`
}

func parseFeed(body []byte, c StructuredSourceConfig) ([]StructuredRecord, error) {
	var d feedDocument
	if err := xml.Unmarshal(body, &d); err != nil {
		return nil, err
	}
	items := d.Channel.Items
	source := d.Channel.Title
	if len(items) == 0 {
		items = d.Entries
		source = d.Title
	}
	records := make([]StructuredRecord, 0, min(len(items), structuredMaxItems))
	seen := map[string]bool{}
	for _, item := range items {
		if len(records) >= structuredMaxItems {
			break
		}
		description := item.Description
		if description == "" {
			description = item.Summary
		}
		if description == "" {
			description = item.Content
		}
		link := ""
		for _, candidate := range item.Links {
			if link == "" && strings.TrimSpace(candidate.Text) != "" {
				link = strings.TrimSpace(candidate.Text)
			}
			if link == "" && (candidate.Rel == "" || candidate.Rel == "alternate") {
				link = candidate.Href
			}
		}
		image := ""
		if strings.HasPrefix(strings.ToLower(item.Enclosure.Type), "image/") {
			image = item.Enclosure.URL
		}
		if image == "" {
			image = item.MediaThumbnail.URL
		}
		if image == "" && (strings.HasPrefix(strings.ToLower(item.MediaContent.Type), "image/") || strings.EqualFold(item.MediaContent.Medium, "image")) {
			image = item.MediaContent.URL
		}
		date := firstNonempty(item.PubDate, item.Published, item.Updated)
		id := firstNonempty(item.GUID, item.ID, link, item.Title+date)
		stableID := stableRecordID(id)
		if seen[stableID] {
			continue
		}
		seen[stableID] = true
		records = append(records, StructuredRecord{ID: stableID, Title: sanitizeCalendarText(item.Title, 240), Date: normalizeRecordDate(date), Author: sanitizeCalendarText(firstNonempty(item.Author.Name, item.Author.Text), 160), Description: sanitizeCalendarText(description, 500), Source: sanitizeCalendarText(source, 160), ImageURL: safeRemoteRecordURL(image), Link: safeRemoteRecordURL(link)})
	}
	return applyStructuredOptions(records, c), nil
}

func parseJSONRecords(body []byte, c StructuredSourceConfig) ([]StructuredRecord, error) {
	var document any
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("JSON response must contain one document")
	}
	root, err := jsonPointer(document, c.Mapping.RootList)
	if err != nil {
		return nil, err
	}
	list, ok := root.([]any)
	if !ok {
		return nil, errors.New("JSON root list path does not select an array")
	}
	records := make([]StructuredRecord, 0, min(len(list), structuredMaxItems))
	for index, item := range list {
		value := func(path string) string {
			if path == "" {
				return ""
			}
			v, _ := jsonPointer(item, path)
			return scalarText(v)
		}
		values := map[string]string{}
		for name, path := range c.Mapping.ValueFields {
			values[sanitizeCalendarText(name, 80)] = structuredValueText(value(path), c.Mapping.ValueFieldTypes[name])
		}
		title := sanitizeCalendarText(value(c.Mapping.Title), 240)
		subtitle := sanitizeCalendarText(value(c.Mapping.Subtitle), 240)
		date := normalizeStructuredDate(value(c.Mapping.Date), c.DateSelection)
		identity := structuredRecordIdentity(title, subtitle, date, values)
		records = append(records, StructuredRecord{ID: stableRecordID(fmt.Sprintf("%d:%s", index, identity)), Title: title, Subtitle: subtitle, Date: date, ImageURL: safeRemoteRecordURL(value(c.Mapping.ImageURL)), Link: safeRemoteRecordURL(value(c.Mapping.Link)), Values: values})
	}
	return applyStructuredOptions(records, c), nil
}

func jsonPointer(document any, pointer string) (any, error) {
	if pointer == "" {
		return document, nil
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, errors.New("invalid JSON Pointer")
	}
	current := document
	for _, token := range strings.Split(pointer[1:], "/") {
		token = strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		switch value := current.(type) {
		case map[string]any:
			var ok bool
			current, ok = value[token]
			if !ok {
				return nil, fmt.Errorf("JSON Pointer field %q was not found", token)
			}
		case []any:
			var index int
			if _, err := fmt.Sscanf(token, "%d", &index); err != nil || index < 0 || index >= len(value) {
				return nil, errors.New("JSON Pointer array index is invalid")
			}
			current = value[index]
		default:
			return nil, errors.New("JSON Pointer traverses a scalar value")
		}
	}
	return current, nil
}

func parseCSVRecords(body []byte, c StructuredSourceConfig) ([]StructuredRecord, error) {
	if !utf8.Valid(body) {
		return nil, errors.New("CSV must use UTF-8 encoding")
	}
	reader := csv.NewReader(strings.NewReader(string(body)))
	reader.FieldsPerRecord = -1
	if c.Delimiter != "" {
		reader.Comma = []rune(c.Delimiter)[0]
	} else {
		reader.Comma = detectDelimiter(string(body))
	}
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(rows) < 1 {
		return []StructuredRecord{}, nil
	}
	headers := rows[0]
	lookup := map[string]int{}
	for i, h := range headers {
		lookup[strings.TrimSpace(h)] = i
	}
	field := func(row []string, name string) (string, error) {
		index, ok := lookup[name]
		if !ok {
			return "", fmt.Errorf("CSV header %q was not found", name)
		}
		if index >= len(row) {
			return "", errors.New("CSV contains a malformed row")
		}
		return row[index], nil
	}
	records := []StructuredRecord{}
	for index, row := range rows[1:] {
		if len(row) != len(headers) {
			return nil, fmt.Errorf("CSV row %d has %d columns; expected %d", index+2, len(row), len(headers))
		}
		value := func(name string) string { v, _ := field(row, name); return v }
		values := map[string]string{}
		for name, column := range c.Mapping.ValueFields {
			values[sanitizeCalendarText(name, 80)] = structuredValueText(value(column), c.Mapping.ValueFieldTypes[name])
		}
		title := sanitizeCalendarText(value(c.Mapping.Title), 240)
		subtitle := sanitizeCalendarText(value(c.Mapping.Subtitle), 240)
		date := normalizeStructuredDate(value(c.Mapping.Date), c.DateSelection)
		identity := structuredRecordIdentity(title, subtitle, date, values)
		records = append(records, StructuredRecord{ID: stableRecordID(fmt.Sprintf("%d:%s", index, identity)), Title: title, Subtitle: subtitle, Date: date, ImageURL: safeRemoteRecordURL(value(c.Mapping.ImageURL)), Link: safeRemoteRecordURL(value(c.Mapping.Link)), Values: values})
	}
	return applyStructuredOptions(records, c), nil
}

func detectDelimiter(value string) rune {
	first := strings.SplitN(value, "\n", 2)[0]
	best := rune(',')
	count := -1
	for _, candidate := range []rune{',', ';', '\t', '|'} {
		n := strings.Count(first, string(candidate))
		if n > count {
			best = candidate
			count = n
		}
	}
	return best
}
func applyStructuredOptions(records []StructuredRecord, c StructuredSourceConfig) []StructuredRecord {
	keyword := strings.ToLower(c.FilterKeyword)
	result := records[:0]
	for _, record := range records {
		text := record.Title + " " + record.Subtitle + " " + record.Description + " " + strings.Join(mapValues(record.Values), " ")
		if keyword != "" && !strings.Contains(strings.ToLower(text), keyword) {
			continue
		}
		matched := true
		for _, filter := range c.Filters {
			candidate := recordValue(record, filter.Field)
			if filter.Operator == "equals" {
				matched = matched && strings.EqualFold(candidate, filter.Value)
			} else {
				matched = matched && strings.Contains(strings.ToLower(candidate), strings.ToLower(filter.Value))
			}
		}
		if matched {
			result = append(result, record)
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		switch c.Sort {
		case "title":
			return strings.ToLower(result[i].Title) < strings.ToLower(result[j].Title)
		case "oldest":
			return result[i].Date < result[j].Date
		case "source":
			return false
		default:
			return result[i].Date > result[j].Date
		}
	})
	if len(result) > c.MaxItems {
		result = result[:c.MaxItems]
	}
	return result
}
func structuredRecordIdentity(title, subtitle, date string, values map[string]string) string {
	if identity := firstNonempty(title, subtitle, date); identity != "" {
		return identity
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if value := strings.TrimSpace(values[key]); value != "" {
			return key + ":" + value
		}
	}
	return "record"
}

func mapValues(values map[string]string) []string {
	result := make([]string, 0, len(values))
	for _, v := range values {
		result = append(result, v)
	}
	return result
}
func recordValue(r StructuredRecord, field string) string {
	switch strings.ToLower(field) {
	case "title":
		return r.Title
	case "subtitle":
		return r.Subtitle
	case "date":
		return r.Date
	case "author":
		return r.Author
	case "description":
		return r.Description
	case "source":
		return r.Source
	case "link":
		return r.Link
	default:
		return r.Values[field]
	}
}
func stableRecordID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:12])
}
func safeRemoteRecordURL(value string) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return ""
	}
	return u.String()
}
func scalarText(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case json.Number:
		return v.String()
	case float64:
		return fmt.Sprint(v)
	case bool:
		return fmt.Sprint(v)
	default:
		return ""
	}
}
func normalizeRecordDate(value string) string {
	return normalizeStructuredDate(value, DateSelection{DateFormat: "auto"})
}
func normalizeStructuredDate(value string, selection DateSelection) string {
	value = strings.TrimSpace(value)
	formats := map[string][]string{
		"iso_date":        {"2006-01-02"},
		"us_date":         {"01/02/2006"},
		"us_short":        {"1/2/2006"},
		"day_first_date":  {"02/01/2006"},
		"day_first_short": {"2/1/2006"},
		"day_month_name":  {"02-Jan-2006"},
		"rfc3339":         {time.RFC3339, time.RFC3339Nano},
	}
	layouts := formats[selection.DateFormat]
	if selection.DateFormat == "" || selection.DateFormat == "auto" {
		// Automatic parsing accepts only slash dates whose order is unambiguous.
		// Values such as 03/04/2026 remain text until the author selects a format.
		if parsed, ok := parseUnambiguousSlashDate(value); ok {
			return parsed
		}
		layouts = []string{
			time.RFC3339Nano, time.RFC3339, time.RFC1123Z, time.RFC1123,
			time.RFC822Z, time.RFC822, "2006-01-02", "02-Jan-2006",
			"Jan 2, 2006", "January 2, 2006", "2 January 2006",
			"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02 15:04",
		}
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			if isDateOnlyLayout(layout) {
				return parsed.Format("2006-01-02")
			}
			return parsed.UTC().Format(time.RFC3339)
		}
	}
	return sanitizeCalendarText(value, 80)
}

func isDateOnlyLayout(layout string) bool {
	switch layout {
	case "2006-01-02", "01/02/2006", "1/2/2006", "02/01/2006", "2/1/2006",
		"02-Jan-2006", "Jan 2, 2006", "January 2, 2006", "2 January 2006":
		return true
	default:
		return false
	}
}

func parseUnambiguousSlashDate(value string) (string, bool) {
	parts := strings.Split(value, "/")
	if len(parts) != 3 || len(strings.TrimSpace(parts[2])) != 4 {
		return "", false
	}
	first, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	second, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil {
		return "", false
	}
	layout := ""
	switch {
	case first > 12 && second >= 1 && second <= 12:
		layout = "2/1/2006"
	case second > 12 && first >= 1 && first <= 12:
		layout = "1/2/2006"
	default:
		return "", false
	}
	parsed, err := time.Parse(layout, value)
	if err != nil {
		return "", false
	}
	return parsed.Format("2006-01-02"), true
}
func firstNonempty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (s *Service) refreshStructured(ctx context.Context, assetID uuid.UUID, provider string, c StructuredSourceConfig) (StructuredPreparedData, DataSourceDiagnostics, error) {
	body, category, err := s.fetchStructured(ctx, provider, c)
	diagnostics := DataSourceDiagnostics{DataSourceID: assetID, HTTPResultCategory: &category, ParseStatus: "failed"}
	if err != nil {
		return StructuredPreparedData{}, diagnostics, err
	}
	var records []StructuredRecord
	switch provider {
	case "rss", "atom":
		records, err = parseFeed(body, c)
	case "json":
		records, err = parseJSONRecords(body, c)
	case "csv":
		records, err = parseCSVRecords(body, c)
	}
	if err != nil {
		return StructuredPreparedData{}, diagnostics, fmt.Errorf("source parse failed: %w", err)
	}
	now := time.Now().UTC()
	prepared := StructuredPreparedData{Records: records, CachedAt: now, StaleAt: now.Add(time.Duration(c.StalenessLimitHours) * time.Hour)}
	diagnostics.ParseStatus = "success"
	diagnostics.AvailableItemCount = len(records)
	diagnostics.CacheUpdatedAt = &prepared.CachedAt
	diagnostics.CacheExpiresAt = &prepared.StaleAt
	return prepared, diagnostics, nil
}

func (s *Service) StructuredPreview(ctx context.Context, provider string, raw json.RawMessage, previewDate string) (StructuredPreview, error) {
	normalized, err := (structuredSourceProvider{s, provider}).Normalize(ctx, raw)
	if err != nil {
		return StructuredPreview{}, err
	}
	c := normalized.(StructuredSourceConfig)
	prepared, diagnostics, err := s.refreshStructured(ctx, uuid.Nil, provider, c)
	if err != nil {
		return StructuredPreview{}, err
	}
	if c.DateSelection.Enabled {
		prepared.Records = selectStructuredRecords(prepared.Records, c.DateSelection, previewDate, s.organizationFirstDayOfWeek(ctx))
	}
	return StructuredPreview{Configuration: StructuredPlayerConfig{Presentation: c.Presentation, Fields: c.Fields, EmptyState: c.EmptyState, DateSelection: c.DateSelection, Data: prepared}, Diagnostics: diagnostics}, nil
}

func selectStructuredRecords(records []StructuredRecord, selection DateSelection, previewDate string, firstDays ...time.Weekday) []StructuredRecord {
	firstDay := time.Monday
	if len(firstDays) > 0 && firstDays[0] >= time.Sunday && firstDays[0] <= time.Saturday {
		firstDay = firstDays[0]
	}
	loc, _ := time.LoadLocation(selection.Timezone)
	target := time.Now().In(loc)
	if parsed, err := time.ParseInLocation("2006-01-02", previewDate, loc); err == nil {
		target = parsed
	}
	today := target.Format("2006-01-02")
	targetDate := today
	if selection.Mode == "tomorrow" {
		targetDate = target.AddDate(0, 0, 1).Format("2006-01-02")
	}
	matches := []StructuredRecord{}
	dated := []StructuredRecord{}
	for _, record := range records {
		date := recordDateInLocation(record.Date, loc)
		if date == "" {
			continue
		}
		dated = append(dated, record)
		if selection.ExcludePast && date < today {
			continue
		}
		switch selection.Mode {
		case "next_available":
			if date >= targetDate {
				matches = append(matches, record)
			}
		case "current_week":
			daysBack := (int(target.Weekday()) - int(firstDay) + 7) % 7
			startDate := target.AddDate(0, 0, -daysBack)
			start := startDate.Format("2006-01-02")
			end := startDate.AddDate(0, 0, 6).Format("2006-01-02")
			if date >= start && date <= end {
				matches = append(matches, record)
			}
		case "custom_range":
			if date >= selection.CustomStartDate && date <= selection.CustomEndDate {
				matches = append(matches, record)
			}
		default:
			if date == targetDate {
				matches = append(matches, record)
			}
		}
	}
	if selection.Mode == "next_available" && len(matches) > 0 {
		sort.SliceStable(matches, func(i, j int) bool {
			return recordDateInLocation(matches[i].Date, loc) < recordDateInLocation(matches[j].Date, loc)
		})
		return filterRecordDate(matches, loc, recordDateInLocation(matches[0].Date, loc))
	}
	if len(matches) > 0 {
		return matches
	}
	switch selection.NoMatchBehavior {
	case "next_available":
		future := []StructuredRecord{}
		for _, record := range dated {
			if recordDateInLocation(record.Date, loc) > targetDate {
				future = append(future, record)
			}
		}
		sort.SliceStable(future, func(i, j int) bool {
			return recordDateInLocation(future[i].Date, loc) < recordDateInLocation(future[j].Date, loc)
		})
		if len(future) > 0 {
			return filterRecordDate(future, loc, recordDateInLocation(future[0].Date, loc))
		}
	case "last_known_good":
		past := []StructuredRecord{}
		for _, record := range dated {
			if recordDateInLocation(record.Date, loc) < targetDate {
				past = append(past, record)
			}
		}
		sort.SliceStable(past, func(i, j int) bool {
			return recordDateInLocation(past[i].Date, loc) > recordDateInLocation(past[j].Date, loc)
		})
		if len(past) > 0 {
			return filterRecordDate(past, loc, recordDateInLocation(past[0].Date, loc))
		}
	case "fallback_text":
		return []StructuredRecord{{ID: "date-fallback", Title: selection.FallbackText}}
	}
	return []StructuredRecord{}
}

func recordDateInLocation(value string, loc *time.Location) string {
	if len(value) >= 10 && !strings.Contains(value, "T") {
		if _, err := time.Parse("2006-01-02", value[:10]); err == nil {
			return value[:10]
		}
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed.In(loc).Format("2006-01-02")
	}
	return ""
}
func filterRecordDate(records []StructuredRecord, loc *time.Location, date string) []StructuredRecord {
	result := []StructuredRecord{}
	for _, record := range records {
		if recordDateInLocation(record.Date, loc) == date {
			result = append(result, record)
		}
	}
	return result
}
