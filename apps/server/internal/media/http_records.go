package media

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// The http_records adapter fetches a public endpoint pinned by a release definition and
// projects the response into typed records using the definition's declared mapping. It
// exists so a guided, brand-name Data Source ("a published Google Sheet", "active weather
// alerts for a state") can ship as a definition rather than as another bespoke provider.
//
// It is deliberately narrower than the JSON and CSV providers, which let an author supply
// any URL and map fields by hand:
//
//   - the scheme and host come from the release, never from the author
//   - the author only fills placeholders the definition declares, each URL-escaped
//   - the field mapping is fixed by the release
//   - there are no expressions, scripts, or templates in the response mapping
//
// Every request goes through the same source-fetch policy as the other network providers,
// so private-network, size, redirect, and timeout limits all still apply.

const httpRecordsDefaultRecords = 50

// httpRecordsSpec resolves the fetch specification for a provider, or reports that the
// provider is not an http_records definition.
func (s *Service) httpRecordsSpec(provider string) (contentdefs.DataSourceDefinition, bool) {
	definition, ok := s.definitions.DataSource(provider)
	if !ok || definition.AdapterID != "http_records" || definition.Fetch == nil {
		return contentdefs.DataSourceDefinition{}, false
	}
	return definition, true
}

// buildHTTPRecordsURL substitutes the author's configuration into the release's URL
// template. Every substituted value is path-escaped, so a value can never introduce a new
// path segment, query parameter, or host.
func buildHTTPRecordsURL(spec contentdefs.FetchSpec, configuration map[string]any) (string, error) {
	result := spec.URLTemplate
	for _, key := range spec.FetchPlaceholders() {
		raw, present := configuration[key]
		if !present {
			return "", fmt.Errorf("%s is required", key)
		}
		value := strings.TrimSpace(manualObjectValueString(raw))
		if value == "" {
			return "", fmt.Errorf("%s is required", key)
		}
		result = strings.ReplaceAll(result, "{"+key+"}", escapeFetchValue(value))
	}
	if strings.ContainsAny(result, "{}") {
		return "", errors.New("data source address is incomplete")
	}
	return result, nil
}

// escapeFetchValue percent-encodes everything outside the unreserved set, so a substituted
// value is inert wherever the template places it. url.PathEscape is not sufficient here: it
// leaves "&" and "=" intact, which would let a value in query position append another query
// parameter to the release's pinned request.
func escapeFetchValue(value string) string {
	// QueryEscape encodes a space as "+", which is only correct inside a query, so it is
	// rewritten to the form that is correct in both a path and a query.
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

// refreshHTTPRecords fetches and projects one http_records Data Source.
func (s *Service) refreshHTTPRecords(ctx context.Context, definition contentdefs.DataSourceDefinition, configuration map[string]any) (TypedDatasetPayload, DataSourceDiagnostics, error) {
	spec := *definition.Fetch
	diagnostics := DataSourceDiagnostics{ParseStatus: "success"}
	target, err := buildHTTPRecordsURL(spec, configuration)
	if err != nil {
		diagnostics.ParseStatus = "invalid_configuration"
		return TypedDatasetPayload{}, diagnostics, err
	}
	if _, err = s.validateSourceURL(ctx, target); err != nil {
		diagnostics.ParseStatus = "invalid_configuration"
		return TypedDatasetPayload{}, diagnostics, err
	}
	accept := spec.Accept
	if accept == "" {
		if spec.Format == "csv" {
			accept = "text/csv"
		} else {
			accept = "application/json"
		}
	}
	body, category, err := s.fetchLiveSource(ctx, target, accept)
	if category != "" {
		diagnostics.HTTPResultCategory = &category
	}
	if err != nil {
		diagnostics.ParseStatus = "fetch_failed"
		return TypedDatasetPayload{}, diagnostics, err
	}
	limit := spec.MaximumRecords
	if limit <= 0 {
		limit = httpRecordsDefaultRecords
	}
	var rows []map[string]string
	if spec.Format == "csv" {
		rows, err = httpRecordsFromCSV(body, spec, limit)
	} else {
		rows, err = httpRecordsFromJSON(body, spec, limit)
	}
	if err != nil {
		diagnostics.ParseStatus = "parse_failed"
		return TypedDatasetPayload{}, diagnostics, err
	}
	now := time.Now().UTC()
	fields := outputDataSourceFields(definition.OutputSchema, configuration)
	records := make([]TypedRecord, 0, len(rows))
	for index, row := range rows {
		values := make(map[string]string, len(definition.OutputSchema.Fields))
		for _, field := range definition.OutputSchema.Fields {
			values[field.Key] = row[field.Key]
		}
		records = append(records, TypedRecord{ID: "row-" + strconv.Itoa(index+1), Values: values})
	}
	diagnostics.AvailableItemCount = len(records)
	diagnostics.CacheUpdatedAt = &now
	expires := now.Add(time.Duration(httpRecordsRefreshSeconds(spec)) * time.Second)
	diagnostics.CacheExpiresAt = &expires
	dataset := TypedDataset{
		ID: "records", Kind: "records", Fields: fields, Records: records,
		CachedAt: &now, StaleAt: &expires, Attribution: definition.Attribution,
	}
	return TypedDatasetPayload{Datasets: []TypedDataset{dataset}}, diagnostics, nil
}

func httpRecordsRefreshSeconds(spec contentdefs.FetchSpec) int {
	if spec.RefreshSeconds > 0 {
		return spec.RefreshSeconds
	}
	return 900
}

// httpRecordsFromJSON walks the declared records path and maps each element.
func httpRecordsFromJSON(body []byte, spec contentdefs.FetchSpec, limit int) ([]map[string]string, error) {
	var document any
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, errors.New("source response is not valid JSON")
	}
	node := document
	if spec.RecordsPath != "" {
		resolved, ok := jsonPathValue(document, spec.RecordsPath)
		if !ok {
			return nil, fmt.Errorf("source response has no %s array", spec.RecordsPath)
		}
		node = resolved
	}
	items, ok := node.([]any)
	if !ok {
		return nil, errors.New("source response does not contain a list of records")
	}
	rows := make([]map[string]string, 0, limit)
	for _, item := range items {
		if len(rows) >= limit {
			break
		}
		row := make(map[string]string, len(spec.Mapping))
		for key, path := range spec.Mapping {
			if value, found := jsonPathValue(item, path); found {
				row[key] = scalarString(value)
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// jsonPathValue resolves a dot path such as "properties.periods" or "geometry.0.lat".
// Only object keys and numeric array indexes are understood; there are no expressions.
func jsonPathValue(node any, path string) (any, bool) {
	current := node
	for _, segment := range strings.Split(path, ".") {
		if segment == "" {
			return nil, false
		}
		switch typed := current.(type) {
		case map[string]any:
			value, ok := typed[segment]
			if !ok {
				return nil, false
			}
			current = value
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(typed) {
				return nil, false
			}
			current = typed[index]
		default:
			return nil, false
		}
	}
	return current, true
}

// httpRecordsFromCSV maps columns by header name.
func httpRecordsFromCSV(body []byte, spec contentdefs.FetchSpec, limit int) ([]map[string]string, error) {
	reader := csv.NewReader(strings.NewReader(string(body)))
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return nil, errors.New("source response has no CSV header row")
	}
	columns := make(map[string]int, len(header))
	for index, name := range header {
		// Published spreadsheets commonly start with a UTF-8 byte order mark.
		columns[strings.TrimSpace(strings.TrimPrefix(name, "\ufeff"))] = index
	}
	rows := make([]map[string]string, 0, limit)
	for len(rows) < limit {
		record, readErr := reader.Read()
		if readErr != nil {
			break
		}
		row := make(map[string]string, len(spec.Mapping))
		for key, column := range spec.Mapping {
			index, ok := columns[column]
			if !ok || index >= len(record) {
				continue
			}
			row[key] = strings.TrimSpace(record[index])
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// HTTPRecordsPreview projects an unsaved http_records configuration, so Studio previews
// exercise the same request and mapping the Player will receive.
func (s *Service) HTTPRecordsPreview(ctx context.Context, provider string, raw json.RawMessage) (TypedDatasetPayload, error) {
	definition, ok := s.httpRecordsSpec(provider)
	if !ok {
		return TypedDatasetPayload{}, errors.New("data source provider does not fetch records")
	}
	normalizer, err := s.dataSourceProvider(provider)
	if err != nil {
		return TypedDatasetPayload{}, err
	}
	configuration, err := normalizer.Normalize(ctx, raw)
	if err != nil {
		return TypedDatasetPayload{}, err
	}
	config, err := manualObjectConfiguration(configuration)
	if err != nil {
		return TypedDatasetPayload{}, err
	}
	payload, _, err := s.refreshHTTPRecords(ctx, definition, config)
	return payload, err
}
