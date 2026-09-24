package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
)

type dataSourceAdapterFactory func(*Service, string) configNormalizer

var dataSourceAdapterRegistry = map[string]dataSourceAdapterFactory{
	"calendar": func(service *Service, _ string) configNormalizer {
		return calendarSourceProvider{service}
	},
	"structured": func(service *Service, provider string) configNormalizer {
		return structuredSourceProvider{service, provider}
	},
	"manual_table": func(_ *Service, _ string) configNormalizer {
		return manualSourceProvider{}
	},
	"weather": func(_ *Service, _ string) configNormalizer {
		return weatherSourceProvider{}
	},
	"transit": func(service *Service, _ string) configNormalizer {
		return transitSourceProvider{service}
	},
	"cap_alerts": func(service *Service, _ string) configNormalizer {
		return capAlertsSourceProvider{service}
	},
	"air_quality": func(service *Service, _ string) configNormalizer {
		return airQualitySourceProvider{service}
	},
	"manual_object": func(service *Service, provider string) configNormalizer {
		definition, _ := service.definitions.DataSource(provider)
		return definitionConfigNormalizer{service: service, schema: definition.ConfigurationSchema}
	},
	"manual_records": func(service *Service, provider string) configNormalizer {
		definition, _ := service.definitions.DataSource(provider)
		return definitionConfigNormalizer{service: service, schema: definition.ConfigurationSchema}
	},
	"http_records": func(service *Service, provider string) configNormalizer {
		definition, _ := service.definitions.DataSource(provider)
		return definitionConfigNormalizer{service: service, schema: definition.ConfigurationSchema}
	},
	"form_records": func(service *Service, _ string) configNormalizer {
		return formSourceProvider{service}
	},
}

func ValidateContentAdapters(catalog *contentdefs.Catalog) error {
	for _, definition := range catalog.DataSources {
		if _, ok := dataSourceAdapterRegistry[definition.AdapterID]; !ok {
			return fmt.Errorf("Data Source definition %q references unregistered adapter %q", definition.ID, definition.AdapterID)
		}
		if definition.AdapterID == "http_records" && definition.Fetch == nil {
			return fmt.Errorf("Data Source definition %q uses the http_records adapter without a fetch specification", definition.ID)
		}
	}
	return nil
}

// dataSourceProvider resolves a release definition to a trusted Server adapter.
func (s *Service) dataSourceProvider(name string) (configNormalizer, error) {
	definition, ok := s.definitions.DataSource(name)
	if !ok {
		return nil, errors.New("data source provider is not supported")
	}
	factory, ok := dataSourceAdapterRegistry[definition.AdapterID]
	if !ok {
		return nil, fmt.Errorf("data source adapter %q is not registered", definition.AdapterID)
	}
	return factory(s, name), nil
}

func (s *Service) DataSourceNormalizer(name string) (configNormalizer, error) {
	return s.dataSourceProvider(name)
}

// manualRefreshSeed is the cached refresh state a Studio-maintained Data Source is stored
// with. It replaces a network fetch: the payload is projected from the configuration the
// author just saved.
type manualRefreshSeed struct {
	Payload []byte
	// ItemCount is the number of rows visible at save time.
	ItemCount int
	// NextRefresh is when the Server must re-project because the visible set changes on
	// its own, or nil when only an edit can change it.
	NextRefresh *time.Time
}

// manualRefreshPayload builds the cached payload for a Studio-maintained Data Source from
// its normalized configuration. ok is false when the provider is not one of them, letting
// callers fall back to the network refresh path.
func (s *Service) manualRefreshPayload(provider string, configuration any) (manualRefreshSeed, bool, error) {
	definition, ok := s.definitions.DataSource(provider)
	if !ok || (definition.AdapterID != "manual_object" && definition.AdapterID != "manual_records") {
		return manualRefreshSeed{}, false, nil
	}
	config, err := manualObjectConfiguration(configuration)
	if err != nil {
		return manualRefreshSeed{}, false, err
	}
	if definition.AdapterID == "manual_object" {
		payload, marshalErr := json.Marshal(manualObjectPayload(definition, config, time.Now().UTC()))
		if marshalErr != nil {
			return manualRefreshSeed{}, false, marshalErr
		}
		return manualRefreshSeed{Payload: payload, ItemCount: 1}, true, nil
	}
	projection := manualRecordsPayload(definition, config, time.Now())
	payload, err := json.Marshal(projection.Payload)
	if err != nil {
		return manualRefreshSeed{}, false, err
	}
	return manualRefreshSeed{Payload: payload, ItemCount: projection.Visible, NextRefresh: projection.NextBoundary}, true, nil
}

// ManualObjectPreview projects an unsaved manual_object configuration into the same
// typed object payload the Player receives, so Studio previews match stored behavior.
func (s *Service) ManualObjectPreview(ctx context.Context, provider string, raw json.RawMessage) (TypedDatasetPayload, error) {
	definition, ok := s.definitions.DataSource(provider)
	if !ok || definition.AdapterID != "manual_object" {
		return TypedDatasetPayload{}, errors.New("data source provider is not a manual object")
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
	return manualObjectPayload(definition, config, time.Now().UTC()), nil
}

func (s *Service) CreateDataSource(ctx context.Context, user uuid.UUID, input DataSourceInput) (DataSource, error) {
	input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len(input.Name) > 180 || len(input.Description) > 2000 {
		return DataSource{}, errors.New("data source name or description is invalid")
	}
	if input.Provider == "form" {
		return DataSource{}, errors.New("form Data Sources are created through the forms API")
	}
	provider, err := s.dataSourceProvider(input.Provider)
	if err != nil {
		return DataSource{}, err
	}
	configuration, err := provider.Normalize(ctx, input.Configuration)
	if err != nil {
		return DataSource{}, err
	}
	encoded, _ := json.Marshal(configuration)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return DataSource{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var organizationID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		return DataSource{}, err
	}
	id := uuid.New()
	if _, err = tx.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by) VALUES($1,$2,$3,$4,$5,1,$6::jsonb,$7)`, id, organizationID, input.Name, input.Description, input.Provider, string(encoded), user); err != nil {
		return DataSource{}, err
	}
	if input.Provider == "manual" {
		manual := configuration.(ManualSourceConfig)
		payload, _ := json.Marshal(manualPlayerData(manual))
		if _, err = tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_attempt_at,last_success_at,http_result_category,parse_status,available_item_count,cache_updated_at,cache_expires_at,cached_payload) VALUES($1,now()+interval '100 years',now(),now(),'manual','success',$2,now(),now()+interval '100 years',$3::jsonb)`, id, len(manual.Rows), string(payload)); err != nil {
			return DataSource{}, err
		}
	} else if seed, ok, payloadErr := s.manualRefreshPayload(input.Provider, configuration); ok {
		if payloadErr != nil {
			return DataSource{}, payloadErr
		}
		if _, err = tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_attempt_at,last_success_at,http_result_category,parse_status,available_item_count,cache_updated_at,cache_expires_at,cached_payload) VALUES($1,COALESCE($2,now()+interval '100 years'),now(),now(),'manual','success',$3,now(),now()+interval '100 years',$4::jsonb)`, id, seed.NextRefresh, seed.ItemCount, string(seed.Payload)); err != nil {
			return DataSource{}, err
		}
	} else if _, err = tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id) VALUES($1)`, id); err != nil {
		return DataSource{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'data_source.created','data_source',$3,jsonb_build_object('provider',$4::text))`, uuid.New(), user, id.String(), input.Provider); err != nil {
		return DataSource{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return DataSource{}, err
	}
	return s.GetDataSource(ctx, id)
}

func (s *Service) UpdateDataSource(ctx context.Context, id, user uuid.UUID, input DataSourceInput) (DataSource, error) {
	existing, err := s.rawDataSource(ctx, id)
	if err != nil {
		return DataSource{}, err
	}
	if input.Provider == "" {
		input.Provider = existing.Provider
	}
	if input.Provider != existing.Provider {
		return DataSource{}, errors.New("data source provider cannot be changed")
	}
	if existing.Provider == "form" {
		return DataSource{}, errors.New("form Data Sources are edited through the forms API")
	}
	// Preserve previously uploaded CSV content when the client omits it on update.
	if input.Provider == "csv" {
		var incoming StructuredSourceConfig
		if json.Unmarshal(input.Configuration, &incoming) == nil && incoming.Uploaded && incoming.UploadedContent == "" {
			var previous StructuredSourceConfig
			if json.Unmarshal(existing.Configuration, &previous) == nil {
				incoming.UploadedContent = previous.UploadedContent
				input.Configuration, _ = json.Marshal(incoming)
			}
		}
	}
	provider, err := s.dataSourceProvider(input.Provider)
	if err != nil {
		return DataSource{}, err
	}
	configuration, err := provider.Normalize(ctx, input.Configuration)
	if err != nil {
		return DataSource{}, err
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 180 || len(input.Description) > 2000 {
		return DataSource{}, errors.New("data source name or description is invalid")
	}
	encoded, _ := json.Marshal(configuration)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return DataSource{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `UPDATE data_sources SET name=$2,description=$3,configuration=$4::jsonb,config_version=1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, input.Name, strings.TrimSpace(input.Description), string(encoded))
	if err != nil || tag.RowsAffected() == 0 {
		return DataSource{}, ErrNotFound
	}
	if input.Provider == "manual" {
		manual := configuration.(ManualSourceConfig)
		payload, _ := json.Marshal(manualPlayerData(manual))
		if _, err = tx.Exec(ctx, `UPDATE data_source_refresh_states SET next_refresh_at=now()+interval '100 years',last_attempt_at=now(),last_success_at=now(),http_result_category='manual',parse_status='success',available_event_count=0,available_item_count=$2,using_cached_data=FALSE,cache_updated_at=now(),cache_expires_at=now()+interval '100 years',cached_payload=$3::jsonb,error_code=NULL,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE data_source_id=$1`, id, len(manual.Rows), string(payload)); err != nil {
			return DataSource{}, err
		}
	} else if seed, ok, payloadErr := s.manualRefreshPayload(input.Provider, configuration); ok {
		if payloadErr != nil {
			return DataSource{}, payloadErr
		}
		if _, err = tx.Exec(ctx, `UPDATE data_source_refresh_states SET next_refresh_at=COALESCE($2,now()+interval '100 years'),last_attempt_at=now(),last_success_at=now(),http_result_category='manual',parse_status='success',available_item_count=$3,using_cached_data=FALSE,cache_updated_at=now(),cache_expires_at=now()+interval '100 years',cached_payload=$4::jsonb,error_code=NULL,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE data_source_id=$1`, id, seed.NextRefresh, seed.ItemCount, string(seed.Payload)); err != nil {
			return DataSource{}, err
		}
	} else if _, err = tx.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at) VALUES($1,now()) ON CONFLICT(data_source_id) DO UPDATE SET next_refresh_at=now(),error_code=NULL,locked_at=NULL,locked_by=NULL,updated_at=now()`, id); err != nil {
		return DataSource{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'data_source.updated','data_source',$3)`, uuid.New(), user, id.String()); err != nil {
		return DataSource{}, err
	}
	var changes []manifestchanges.Change
	transactionalUsed := false
	if transactional, ok := s.invalidator.(TransactionalAssetInvalidator); ok {
		transactionalUsed = true
		changes, err = transactional.DataSourceChangedInTx(ctx, tx, id, "data_source.updated")
		if err != nil {
			return DataSource{}, fmt.Errorf("invalidate data source manifest: %w", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return DataSource{}, err
	}
	if transactionalUsed {
		s.invalidator.(TransactionalAssetInvalidator).NotifyManifestChanges(changes)
	} else if s.invalidator != nil {
		if err := s.invalidator.DataSourceChanged(ctx, id, "data_source.updated"); err != nil {
			return DataSource{}, fmt.Errorf("invalidate data source manifest: %w", err)
		}
	}
	return s.GetDataSource(ctx, id)
}

func (s *Service) DuplicateDataSource(ctx context.Context, id, user uuid.UUID) (DataSource, error) {
	existing, err := s.rawDataSource(ctx, id)
	if err != nil {
		return DataSource{}, err
	}
	if existing.Provider == "form" {
		return DataSource{}, errors.New("form Data Sources cannot be duplicated")
	}
	return s.CreateDataSource(ctx, user, DataSourceInput{Provider: existing.Provider, Name: existing.Name + " copy", Description: existing.Description, Configuration: existing.Configuration})
}

const dataSourceSelect = `SELECT d.id,d.provider,d.name,d.description,d.config_version,d.configuration,u.id,u.name,d.created_at,d.updated_at FROM data_sources d LEFT JOIN users u ON u.id=d.created_by`

func scanDataSource(row rowScanner) (DataSource, error) {
	var d DataSource
	var creatorID *uuid.UUID
	var creatorName *string
	if err := row.Scan(&d.ID, &d.Provider, &d.Name, &d.Description, &d.ConfigVersion, &d.Configuration, &creatorID, &creatorName, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return DataSource{}, err
	}
	if creatorID != nil {
		d.Creator = &Creator{ID: *creatorID, Name: *creatorName}
	}
	return d, nil
}

// rawDataSource returns the stored Data Source including any uploaded CSV payload.
func (s *Service) rawDataSource(ctx context.Context, id uuid.UUID) (DataSource, error) {
	d, err := scanDataSource(s.db.QueryRow(ctx, dataSourceSelect+` WHERE d.id=$1 AND d.deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return DataSource{}, ErrNotFound
	}
	return d, err
}

// GetDataSource returns the Data Source with bulky uploaded content stripped for the API.
func (s *Service) GetDataSource(ctx context.Context, id uuid.UUID) (DataSource, error) {
	d, err := s.rawDataSource(ctx, id)
	if err != nil {
		return DataSource{}, err
	}
	d.Configuration = stripUploadedContent(d.Provider, d.Configuration)
	return d, nil
}

// PreviewDataSourceByID resolves a saved Data Source using its full stored
// configuration, including any uploaded CSV payload that the API responses strip.
// It returns the same StructuredPreview/CalendarPreview shape the provider preview
// endpoint produces so consumers (e.g. the Layout preview) get the Player's records.
func (s *Service) PreviewDataSourceByID(ctx context.Context, id uuid.UUID, previewDate string) (any, error) {
	raw, err := s.rawDataSource(ctx, id)
	if err != nil {
		return nil, err
	}
	if raw.Provider == "calendar" {
		return s.CalendarPreview(ctx, raw.Configuration)
	}
	if raw.Provider == "manual" {
		return s.ManualPreview(ctx, raw.Configuration)
	}
	if definition, ok := s.definitions.DataSource(raw.Provider); ok && (definition.AdapterID == "manual_object" || definition.AdapterID == "manual_records") {
		projected, projectErr := s.PlayerTypedDataSourceConfiguration(ctx, raw.ID, raw.Provider, raw.Configuration)
		if projectErr != nil {
			return nil, projectErr
		}
		var payload TypedDatasetPayload
		if err := json.Unmarshal(projected, &payload); err != nil {
			return nil, err
		}
		return payload, nil
	}
	if raw.Provider == "weather" {
		return s.WeatherPreview(ctx, raw.Configuration)
	}
	_, fetchesRecords := s.httpRecordsSpec(raw.Provider)
	if raw.Provider == "transit" || raw.Provider == "cap_alerts" || raw.Provider == "air_quality" || fetchesRecords {
		projected, projectErr := s.PlayerTypedDataSourceConfiguration(ctx, raw.ID, raw.Provider, raw.Configuration)
		if projectErr != nil {
			return nil, projectErr
		}
		var payload TypedDatasetPayload
		if err := json.Unmarshal(projected, &payload); err != nil {
			return nil, err
		}
		return payload, nil
	}
	return s.StructuredPreview(ctx, raw.Provider, raw.Configuration, previewDate)
}

func stripUploadedContent(provider string, raw json.RawMessage) json.RawMessage {
	if provider != "csv" {
		return raw
	}
	var config map[string]any
	if json.Unmarshal(raw, &config) == nil {
		if _, uploaded := config["uploadedContent"]; uploaded {
			delete(config, "uploadedContent")
			config["uploaded"] = true
			if encoded, err := json.Marshal(config); err == nil {
				return encoded
			}
		}
	}
	return raw
}

func (s *Service) ListDataSources(ctx context.Context, o DataSourceListOptions) (DataSourceListResult, error) {
	if o.Page < 1 {
		o.Page = 1
	}
	if o.PageSize < 1 {
		o.PageSize = 24
	}
	if o.PageSize > 100 {
		o.PageSize = 100
	}
	sortSQL := "d.updated_at DESC,d.id DESC"
	switch o.Sort {
	case "oldest":
		sortSQL = "d.created_at ASC,d.id ASC"
	case "name":
		sortSQL = "lower(d.name) ASC,d.id ASC"
	}
	where := []string{"d.deleted_at IS NULL", "d.system_managed=FALSE"}
	args := []any{}
	add := func(query string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(query, len(args)))
	}
	if q := strings.TrimSpace(o.Search); q != "" {
		add("d.name ILIKE '%%' || $%d || '%%'", q)
	}
	if o.Provider != "" {
		add("d.provider=$%d", o.Provider)
	}
	clause := strings.Join(where, " AND ")
	var total int
	if err := s.db.QueryRow(ctx, "SELECT count(*) FROM data_sources d WHERE "+clause, args...).Scan(&total); err != nil {
		return DataSourceListResult{}, err
	}
	args = append(args, o.PageSize, (o.Page-1)*o.PageSize)
	rows, err := s.db.Query(ctx, dataSourceSelect+" WHERE "+clause+" ORDER BY "+sortSQL+fmt.Sprintf(" LIMIT $%d OFFSET $%d", len(args)-1, len(args)), args...)
	if err != nil {
		return DataSourceListResult{}, err
	}
	defer rows.Close()
	items := []DataSourceListItem{}
	itemIndexes := map[uuid.UUID]int{}
	for rows.Next() {
		d, err := scanDataSource(rows)
		if err != nil {
			return DataSourceListResult{}, err
		}
		d.Configuration = stripUploadedContent(d.Provider, d.Configuration)
		itemIndexes[d.ID] = len(items)
		items = append(items, DataSourceListItem{
			DataSource: d,
			Status:     "pending",
		})
	}
	if err := rows.Err(); err != nil {
		return DataSourceListResult{}, err
	}
	rows.Close()

	if len(items) > 0 {
		ids := make([]uuid.UUID, 0, len(items))
		for _, item := range items {
			ids = append(ids, item.ID)
		}
		refreshRows, err := s.db.Query(ctx, `SELECT data_source_id,last_success_at,using_cached_data,error_code,available_event_count,available_item_count FROM data_source_refresh_states WHERE data_source_id=ANY($1)`, ids)
		if err != nil {
			return DataSourceListResult{}, err
		}
		defer refreshRows.Close()
		for refreshRows.Next() {
			var diagnostics DataSourceDiagnostics
			if err := refreshRows.Scan(
				&diagnostics.DataSourceID,
				&diagnostics.LastSuccessfulAt,
				&diagnostics.UsingCachedData,
				&diagnostics.ErrorCode,
				&diagnostics.AvailableEventCount,
				&diagnostics.AvailableItemCount,
			); err != nil {
				return DataSourceListResult{}, err
			}
			if index, ok := itemIndexes[diagnostics.DataSourceID]; ok {
				items[index].Status = dataSourceStatus(diagnostics)
				items[index].CachedRecords = diagnostics.AvailableEventCount + diagnostics.AvailableItemCount
			}
		}
		if err := refreshRows.Err(); err != nil {
			return DataSourceListResult{}, err
		}
	}

	return DataSourceListResult{Items: items, Total: total, Page: o.Page, PageSize: o.PageSize}, nil
}

// GetDataSourceDetail assembles the full Data Source detail view.
func (s *Service) GetDataSourceDetail(ctx context.Context, id uuid.UUID) (DataSourceDetail, error) {
	raw, err := s.rawDataSource(ctx, id)
	if err != nil {
		return DataSourceDetail{}, err
	}
	detail := DataSourceDetail{DataSource: raw}
	detail.Configuration = stripUploadedContent(raw.Provider, raw.Configuration)
	detail.Diagnostics, err = s.DataSourceRefreshDiagnostics(ctx, id)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return DataSourceDetail{}, err
	}
	detail.Diagnostics.DataSourceID = id
	detail.Fields = s.availableDataSourceFields(raw.Provider, raw.Configuration)
	detail.CachedRecords = detail.Diagnostics.AvailableEventCount + detail.Diagnostics.AvailableItemCount
	detail.Status = dataSourceStatus(detail.Diagnostics)
	if raw.Provider == "rss" || raw.Provider == "atom" || raw.Provider == "json" || raw.Provider == "csv" {
		var config StructuredSourceConfig
		if json.Unmarshal(raw.Configuration, &config) == nil && config.DateSelection.Enabled {
			selection := config.DateSelection
			detail.DateSelection = &selection
		}
	}
	if raw.Provider == "manual" {
		var config ManualSourceConfig
		if json.Unmarshal(raw.Configuration, &config) == nil && config.DateSelection.Enabled {
			selection := config.DateSelection
			detail.DateSelection = &selection
		}
	}
	detail.WidgetUsage, err = s.dataSourceWidgetUsage(ctx, id)
	if err != nil {
		return DataSourceDetail{}, err
	}
	detail.BindingUsage, err = s.dataSourceBindingUsage(ctx, id)
	if err != nil {
		return DataSourceDetail{}, err
	}
	return detail, nil
}

func dataSourceStatus(d DataSourceDiagnostics) string {
	switch {
	case d.ErrorCode != nil && !d.UsingCachedData:
		return "error"
	case d.UsingCachedData:
		return "stale"
	case d.LastSuccessfulAt != nil:
		return "ready"
	default:
		return "pending"
	}
}

// dataSourceProviderAndFields returns the provider and the set of selectable field keys.
func (s *Service) dataSourceProviderAndFields(ctx context.Context, id uuid.UUID) (string, map[string]bool, error) {
	var provider string
	var configuration json.RawMessage
	err := s.db.QueryRow(ctx, `SELECT provider,configuration FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&provider, &configuration)
	if err != nil {
		return "", nil, err
	}
	fields := map[string]bool{}
	for _, f := range s.availableDataSourceFields(provider, configuration) {
		fields[f.Key] = true
	}
	return provider, fields, nil
}

func (s *Service) dataSourceProviderAndTypedFields(ctx context.Context, id uuid.UUID) (string, map[string]string, error) {
	var provider string
	var configuration json.RawMessage
	err := s.db.QueryRow(ctx, `SELECT provider,configuration FROM data_sources WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&provider, &configuration)
	if err != nil {
		return "", nil, err
	}
	fields := map[string]string{}
	for _, field := range s.availableDataSourceFields(provider, configuration) {
		fields[field.Key] = field.Type
	}
	return provider, fields, nil
}

// availableDataSourceFields derives the typed field schema a Data Source exposes.
// Release-defined (non-legacy) Sources derive their selectable fields directly from
// the definition's output schema, so new definitions need no entry in the legacy
// provider switch below. Only legacy Sources whose fields depend on their runtime
// configuration (CSV, JSON mappings, manual tables, calendar selections) keep their
// provider-specific logic.
func (s *Service) availableDataSourceFields(provider string, raw json.RawMessage) []DataSourceField {
	if definition, ok := s.definitions.DataSource(provider); ok && !definition.LegacyEditor {
		fields := make([]DataSourceField, 0, len(definition.OutputSchema.Fields))
		for _, field := range definition.OutputSchema.Fields {
			fields = append(fields, DataSourceField{Key: field.Key, Label: field.Label, Type: field.Type})
		}
		return fields
	}
	fields := []DataSourceField{}
	if provider == "form" {
		var config FormSourceConfig
		_ = json.Unmarshal(raw, &config)
		for _, field := range config.Fields {
			fields = append(fields, DataSourceField{Key: field.Key, Label: field.Label, Type: field.Type})
		}
		return fields
	}
	if provider == "calendar" {
		var config CalendarConfig
		_ = json.Unmarshal(raw, &config)
		add := func(on bool, key, label, typ string) {
			if on {
				fields = append(fields, DataSourceField{Key: key, Label: label, Type: typ})
			}
		}
		add(config.Fields.Title, "title", "Title", "text")
		add(config.Fields.StartTime, "startTime", "Start time", "datetime")
		add(config.Fields.EndTime, "endTime", "End time", "datetime")
		add(config.Fields.Date, "date", "Date", "date")
		add(config.Fields.Location, "location", "Location", "text")
		add(config.Fields.DescriptionExcerpt, "descriptionExcerpt", "Description", "text")
		return fields
	}
	if provider == "manual" {
		var config ManualSourceConfig
		_ = json.Unmarshal(raw, &config)
		for _, column := range config.Columns {
			fields = append(fields, DataSourceField{Key: column.Key, Label: column.Label, Type: column.Type, Currency: column.Currency})
		}
		return fields
	}
	if provider == "weather" {
		return []DataSourceField{
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
	}
	if provider == "transit" {
		fields := transitDepartureFields()
		fields = append(fields, transitAlertFields()...)
		return uniqueDataSourceFields(fields)
	}
	if provider == "cap_alerts" {
		return capAlertFields()
	}
	if provider == "air_quality" {
		var config AirQualitySourceConfig
		_ = json.Unmarshal(raw, &config)
		return airQualityFields(config)
	}
	var config StructuredSourceConfig
	_ = json.Unmarshal(raw, &config)
	add := func(on bool, key, label, typ string) {
		if on {
			fields = append(fields, DataSourceField{Key: key, Label: label, Type: typ})
		}
	}
	add(config.Fields.Title, "title", "Title", "text")
	add(config.Fields.Subtitle, "subtitle", "Subtitle", "text")
	dateType := "date"
	if provider == "rss" || provider == "atom" {
		dateType = "datetime"
	}
	add(config.Fields.Date, "date", "Publication time", dateType)
	add(config.Fields.Author, "author", "Author", "text")
	add(config.Fields.Description, "description", "Description", "text")
	add(provider == "rss" || provider == "atom", "source", "Source", "text")
	add(config.Fields.Image, "imageUrl", "Image", "url")
	add(config.Fields.Link, "link", "Link", "url")
	if config.Mapping != nil {
		// Map iteration order is random, and these become the options in a Widget's field
		// picker: sorting keeps the list in one order between requests.
		names := make([]string, 0, len(config.Mapping.ValueFields))
		for name := range config.Mapping.ValueFields {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			fieldType := config.Mapping.ValueFieldTypes[name]
			if !structuredValueFieldTypes[fieldType] {
				fieldType = "text"
			}
			fields = append(fields, DataSourceField{Key: name, Label: name, Type: fieldType})
		}
	}
	return fields
}

func uniqueDataSourceFields(fields []DataSourceField) []DataSourceField {
	result := make([]DataSourceField, 0, len(fields))
	seen := map[string]bool{}
	for _, field := range fields {
		if !seen[field.Key] {
			result = append(result, field)
			seen[field.Key] = true
		}
	}
	return result
}

func (s *Service) dataSourceWidgetUsage(ctx context.Context, id uuid.UUID) ([]DataSourceWidgetUsage, error) {
	return s.dataSourceWidgetUsageWith(ctx, s.db, id, nil)
}

func (s *Service) dataSourceBindingUsage(ctx context.Context, id uuid.UUID) ([]DataSourceBindingUsage, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT l.id,l.name FROM layouts l WHERE l.deleted_at IS NULL AND (EXISTS(SELECT 1 FROM layout_draft_dependencies d WHERE d.layout_id=l.id AND d.dependency_id=$1 AND d.dependency_type='data_source') OR EXISTS(SELECT 1 FROM layout_revisions r JOIN layout_revision_dependencies d ON d.revision_id=r.id WHERE r.layout_id=l.id AND d.dependency_id=$1 AND d.dependency_type='data_source')) ORDER BY l.name`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	usage := []DataSourceBindingUsage{}
	for rows.Next() {
		var u DataSourceBindingUsage
		if err = rows.Scan(&u.LayoutID, &u.LayoutName); err != nil {
			return nil, err
		}
		usage = append(usage, u)
	}
	return usage, rows.Err()
}

// DeleteDataSource removes a Data Source, refusing when a Widget or Layout binding uses it.
func (s *Service) DeleteDataSource(ctx context.Context, id, user uuid.UUID) error {
	widgets, err := s.dataSourceWidgetUsage(ctx, id)
	if err != nil {
		return err
	}
	bindings, err := s.dataSourceBindingUsage(ctx, id)
	if err != nil {
		return err
	}
	if len(widgets) > 0 || len(bindings) > 0 {
		names := []string{}
		for _, w := range widgets {
			names = append(names, "widget "+w.Name)
		}
		for _, b := range bindings {
			names = append(names, "Layout "+b.LayoutName)
		}
		return &DependencyError{Resource: "data source", UsedBy: names}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE data_sources SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'data_source.deleted','data_source',$3)`, uuid.New(), user, id.String()); err != nil {
		return err
	}
	var changes []manifestchanges.Change
	transactionalUsed := false
	if transactional, ok := s.invalidator.(TransactionalAssetInvalidator); ok {
		transactionalUsed = true
		changes, err = transactional.DataSourceChangedInTx(ctx, tx, id, "data_source.deleted")
		if err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if transactionalUsed {
		s.invalidator.(TransactionalAssetInvalidator).NotifyManifestChanges(changes)
	} else if s.invalidator != nil {
		if err := s.invalidator.DataSourceChanged(ctx, id, "data_source.deleted"); err != nil {
			return err
		}
	}
	return nil
}

// DependencyError reports that a record could not be deleted because other records use it.
type DependencyError struct {
	Resource string
	UsedBy   []string
}

func (e *DependencyError) Error() string {
	return e.Resource + " is in use by " + strings.Join(e.UsedBy, ", ")
}

// ManualRowWrite is one row supplied by an integration. Values are keyed by
// column key; a key the source does not declare is rejected rather than stored,
// so a renamed column upstream fails loudly instead of writing rows that no
// Widget can bind to.
type ManualRowWrite struct {
	Values map[string]string `json:"values"`
}

// MaxManualRowsPerWrite bounds one integration write. A signage row set is a
// menu or a scoreboard, not a database export.
const MaxManualRowsPerWrite = 500

// ReplaceManualRows replaces every row of a Manual Table Data Source, keeping
// its columns, date field, and date selection as they are.
//
// This is the only write an integration token can perform. Columns are
// deliberately immutable here: changing them would silently break the Widgets
// bound to them, and that is a decision for a person in Studio.
func (s *Service) ReplaceManualRows(ctx context.Context, id, user uuid.UUID, rows []ManualRowWrite) (DataSource, error) {
	if len(rows) > MaxManualRowsPerWrite {
		return DataSource{}, fmt.Errorf("no more than %d rows in one write", MaxManualRowsPerWrite)
	}
	existing, err := s.rawDataSource(ctx, id)
	if err != nil {
		return DataSource{}, err
	}
	if existing.Provider != "manual" {
		return DataSource{}, fmt.Errorf("%s Data Sources cannot be written to; only a Manual Table can", existing.Provider)
	}
	var config ManualSourceConfig
	if err := json.Unmarshal(existing.Configuration, &config); err != nil {
		return DataSource{}, err
	}

	allowed := make(map[string]bool, len(config.Columns))
	for _, column := range config.Columns {
		allowed[column.Key] = true
	}
	replacement := make([]ManualRow, 0, len(rows))
	for index, row := range rows {
		values := make(map[string]string, len(row.Values))
		for key, value := range row.Values {
			if !allowed[key] {
				return DataSource{}, fmt.Errorf("row %d has no column %q in this Data Source", index+1, key)
			}
			values[key] = value
		}
		// Row identity is generated: an integration replaces the whole set, so a
		// caller-supplied id would only be a way to collide with another row.
		replacement = append(replacement, ManualRow{ID: uuid.NewString(), Values: values})
	}
	config.Rows = replacement

	encoded, err := json.Marshal(config)
	if err != nil {
		return DataSource{}, err
	}
	// Routed through the ordinary update so the cached player payload, the
	// audit entry, and the assets that bind to this source are all handled by
	// the one code path that already knows how.
	return s.UpdateDataSource(ctx, id, user, DataSourceInput{
		Provider:      existing.Provider,
		Name:          existing.Name,
		Description:   existing.Description,
		Configuration: encoded,
	})
}
