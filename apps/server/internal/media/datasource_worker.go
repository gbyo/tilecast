package media

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/manifestchanges"
)

// DataSourceRefreshWorker periodically fetches, parses, and caches Data Source data.
type DataSourceRefreshWorker struct {
	service *Service
	logger  *slog.Logger
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	id      string
	gate    func() bool
}

func NewDataSourceRefreshWorker(service *Service, logger *slog.Logger) *DataSourceRefreshWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &DataSourceRefreshWorker{service: service, logger: logger, id: uuid.NewString()}
}

// SetGate installs a check consulted before claiming work; backup and
// restore operations pause refreshes through it.
func (worker *DataSourceRefreshWorker) SetGate(gate func() bool) { worker.gate = gate }

func (worker *DataSourceRefreshWorker) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	worker.cancel = cancel
	worker.wg.Add(1)
	go func() {
		defer worker.wg.Done()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			if worker.gate != nil && !worker.gate() {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
				continue
			}
			worked, err := worker.runOne(ctx)
			if err != nil && ctx.Err() == nil {
				worker.logger.Error("data source refresh failed", "error", err)
			}
			if worked {
				continue
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (worker *DataSourceRefreshWorker) Stop() {
	if worker.cancel != nil {
		worker.cancel()
	}
	worker.wg.Wait()
}

func (worker *DataSourceRefreshWorker) runOne(ctx context.Context) (bool, error) {
	tx, err := worker.service.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var dataSourceID uuid.UUID
	var provider string
	var raw json.RawMessage
	err = tx.QueryRow(ctx, `SELECT state.data_source_id,ds.provider,ds.configuration
		FROM data_source_refresh_states state
		JOIN data_sources ds ON ds.id=state.data_source_id AND ds.deleted_at IS NULL
		WHERE state.next_refresh_at<=now()
		  AND (state.locked_at IS NULL OR state.locked_at<now()-interval '10 minutes')
		ORDER BY state.next_refresh_at,state.data_source_id
		LIMIT 1 FOR UPDATE OF state SKIP LOCKED`).Scan(&dataSourceID, &provider, &raw)
	if err == pgx.ErrNoRows {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	// A preserved row whose plugin is not installed stays inert: no fetch,
	// no attempt, and no diagnostics. Its next look moves forward so it
	// cannot hold the head of the queue, and reinstalling the plugin makes
	// it refresh again at that look.
	inert, err := worker.service.pluginSourceInert(ctx, tx, provider)
	if err != nil {
		return false, err
	}
	if inert {
		if _, err = tx.Exec(ctx, `UPDATE data_source_refresh_states SET next_refresh_at=now()+make_interval(secs => $2),updated_at=now() WHERE data_source_id=$1`, dataSourceID, inertRecheckSeconds); err != nil {
			return false, err
		}
		return true, tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, `UPDATE data_source_refresh_states SET locked_at=now(),locked_by=$2,last_attempt_at=now(),updated_at=now() WHERE data_source_id=$1`, dataSourceID, worker.id); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	refreshSeconds := 300
	var prepared any
	var diagnostics DataSourceDiagnostics
	var refreshErr error
	var upstreamLastModified string
	var upstreamExpiresAt *time.Time
	var notModified bool
	// A manual_records Data Source is re-projected rather than fetched: its visible rows
	// change when a publish window opens or closes, and it is scheduled to wake exactly at
	// the next such boundary rather than polled.
	if definition, ok := worker.service.definitions.DataSource(provider); ok && definition.AdapterID == "manual_records" {
		return true, worker.reprojectManualRecords(ctx, dataSourceID, definition, raw)
	}
	if definition, ok := worker.service.httpRecordsSpec(provider); ok {
		var configuration map[string]any
		if err = json.Unmarshal(raw, &configuration); err != nil {
			return true, worker.fail(ctx, dataSourceID, 300, DataSourceDiagnostics{ParseStatus: "invalid_configuration"}, "invalid_configuration")
		}
		refreshSeconds = httpRecordsRefreshSeconds(*definition.Fetch)
		prepared, diagnostics, refreshErr = worker.service.refreshHTTPRecords(ctx, definition, configuration)
	} else if provider == "calendar" {
		var config CalendarConfig
		if err = json.Unmarshal(raw, &config); err == nil {
			refreshSeconds = config.RefreshIntervalSeconds
			prepared, diagnostics, refreshErr = worker.service.refreshCalendar(ctx, dataSourceID, config)
		}
	} else if provider == "weather" {
		var config WeatherSourceConfig
		if err = json.Unmarshal(raw, &config); err == nil {
			refreshSeconds = config.RefreshIntervalSeconds
			var previousLastModified *string
			_ = worker.service.db.QueryRow(ctx, `SELECT upstream_last_modified FROM data_source_refresh_states WHERE data_source_id=$1`, dataSourceID).Scan(&previousLastModified)
			lastModified := ""
			if previousLastModified != nil {
				lastModified = *previousLastModified
			}
			prepared, diagnostics, upstreamLastModified, upstreamExpiresAt, notModified, refreshErr = worker.service.refreshWeather(ctx, dataSourceID, config, lastModified)
		}
	} else if provider == "transit" {
		var config TransitSourceConfig
		if err = json.Unmarshal(raw, &config); err == nil {
			refreshSeconds = config.RealtimeRefreshSeconds
			prepared, diagnostics, refreshErr = worker.service.refreshTransit(ctx, dataSourceID, config)
		}
	} else if provider == "cap_alerts" {
		var config CAPAlertsSourceConfig
		if err = json.Unmarshal(raw, &config); err == nil {
			refreshSeconds = config.RefreshIntervalSeconds
			prepared, diagnostics, refreshErr = worker.service.refreshCAPAlerts(ctx, config)
		}
	} else if provider == "air_quality" {
		var config AirQualitySourceConfig
		if err = json.Unmarshal(raw, &config); err == nil {
			refreshSeconds = config.RefreshIntervalSeconds
			prepared, diagnostics, refreshErr = worker.service.refreshAirQuality(ctx, config)
		}
	} else {
		var config StructuredSourceConfig
		if err = json.Unmarshal(raw, &config); err == nil {
			refreshSeconds = config.RefreshIntervalSeconds
			prepared, diagnostics, refreshErr = worker.service.refreshStructured(ctx, dataSourceID, provider, config)
		}
	}
	if err != nil {
		return true, worker.fail(ctx, dataSourceID, refreshSeconds, DataSourceDiagnostics{ParseStatus: "invalid_configuration"}, "invalid_configuration")
	}
	if refreshErr != nil {
		return true, worker.fail(ctx, dataSourceID, refreshSeconds, diagnostics, "source_refresh_failed")
	}
	if notModified {
		next := nextDataSourceRefresh(refreshSeconds, upstreamExpiresAt)
		_, err = worker.service.db.Exec(ctx, `UPDATE data_source_refresh_states SET next_refresh_at=$2,last_success_at=now(),http_result_category=$3,parse_status='success',using_cached_data=FALSE,error_code=NULL,upstream_expires_at=$4,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE data_source_id=$1`, dataSourceID, next, diagnostics.HTTPResultCategory, upstreamExpiresAt)
		return true, err
	}
	payload, err := json.Marshal(prepared)
	if err != nil {
		return true, worker.fail(ctx, dataSourceID, refreshSeconds, diagnostics, "cache_encoding_failed")
	}
	next := nextDataSourceRefresh(refreshSeconds, upstreamExpiresAt)
	err = worker.commitProjection(ctx, dataSourceID, "data_source.refreshed", func(tx pgx.Tx) (bool, error) {
		var playerDataChanged bool
		err := tx.QueryRow(ctx, `WITH previous AS MATERIALIZED (
			SELECT cached_payload,using_cached_data,error_code FROM data_source_refresh_states WHERE data_source_id=$1
		), updated AS (
			UPDATE data_source_refresh_states SET next_refresh_at=$2,last_success_at=now(),http_result_category=$3,parse_status=$4,available_event_count=$5,available_item_count=$6,using_cached_data=FALSE,cache_updated_at=$7,cache_expires_at=$8,cached_payload=$9::jsonb,error_code=NULL,upstream_last_modified=NULLIF($10,''),upstream_expires_at=$11,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE data_source_id=$1 RETURNING data_source_id
		) SELECT previous.cached_payload IS DISTINCT FROM $9::jsonb OR previous.using_cached_data OR previous.error_code IS NOT NULL FROM previous,updated`, dataSourceID, next, diagnostics.HTTPResultCategory, diagnostics.ParseStatus, diagnostics.AvailableEventCount, diagnostics.AvailableItemCount, diagnostics.CacheUpdatedAt, diagnostics.CacheExpiresAt, string(payload), upstreamLastModified, upstreamExpiresAt).Scan(&playerDataChanged)
		return playerDataChanged, err
	})
	return true, err
}

// reprojectManualRecords recomputes a manual_records payload from its stored
// configuration, stores it, and schedules the next wake-up for the moment the visible set
// changes again. It notifies the manifest invalidator only when the payload actually
// changed, so a boundary that removes nothing does not churn every screen's manifest.
func (worker *DataSourceRefreshWorker) reprojectManualRecords(ctx context.Context, dataSourceID uuid.UUID, definition contentdefs.DataSourceDefinition, raw json.RawMessage) error {
	var configuration map[string]any
	if err := json.Unmarshal(raw, &configuration); err != nil {
		return worker.fail(ctx, dataSourceID, 300, DataSourceDiagnostics{ParseStatus: "invalid_configuration"}, "invalid_configuration")
	}
	projection := manualRecordsPayload(definition, configuration, time.Now())
	payload, err := json.Marshal(projection.Payload)
	if err != nil {
		return worker.fail(ctx, dataSourceID, 300, DataSourceDiagnostics{ParseStatus: "cache_encoding_failed"}, "cache_encoding_failed")
	}
	return worker.commitProjection(ctx, dataSourceID, "data_source.refreshed", func(tx pgx.Tx) (bool, error) {
		var playerDataChanged bool
		err := tx.QueryRow(ctx, `WITH previous AS MATERIALIZED (
			SELECT cached_payload,using_cached_data,error_code FROM data_source_refresh_states WHERE data_source_id=$1
		), updated AS (
			UPDATE data_source_refresh_states SET next_refresh_at=COALESCE($2,now()+interval '100 years'),last_success_at=now(),http_result_category='manual',parse_status='success',available_item_count=$3,using_cached_data=FALSE,cache_updated_at=now(),cache_expires_at=now()+interval '100 years',cached_payload=$4::jsonb,error_code=NULL,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE data_source_id=$1 RETURNING data_source_id
		) SELECT previous.cached_payload IS DISTINCT FROM $4::jsonb OR previous.error_code IS NOT NULL FROM previous,updated`,
			dataSourceID, projection.NextBoundary, projection.Visible, string(payload)).Scan(&playerDataChanged)
		return playerDataChanged, err
	})
}

func nextDataSourceRefresh(refreshSeconds int, upstreamExpiresAt *time.Time) time.Time {
	next := time.Now().Add(time.Duration(refreshSeconds) * time.Second)
	if upstreamExpiresAt != nil && upstreamExpiresAt.After(next) {
		return *upstreamExpiresAt
	}
	return next
}

func (worker *DataSourceRefreshWorker) fail(ctx context.Context, dataSourceID uuid.UUID, refreshSeconds int, diagnostics DataSourceDiagnostics, code string) error {
	if refreshSeconds < 30 {
		refreshSeconds = 30
	}
	next := time.Now().Add(time.Duration(refreshSeconds) * time.Second)
	return worker.commitProjection(ctx, dataSourceID, "data_source.cache_state_changed", func(tx pgx.Tx) (bool, error) {
		var playerDataChanged bool
		err := tx.QueryRow(ctx, `WITH previous AS MATERIALIZED (
			SELECT using_cached_data,error_code FROM data_source_refresh_states WHERE data_source_id=$1
		), updated AS (
			UPDATE data_source_refresh_states SET next_refresh_at=$2,http_result_category=$3,parse_status=$4,using_cached_data=(cache_updated_at IS NOT NULL AND cache_expires_at>now()),error_code=$5,locked_at=NULL,locked_by=NULL,updated_at=now() WHERE data_source_id=$1 RETURNING using_cached_data,error_code
		) SELECT previous.using_cached_data IS DISTINCT FROM updated.using_cached_data OR (previous.error_code IS NULL) IS DISTINCT FROM (updated.error_code IS NULL) FROM previous,updated`, dataSourceID, next, diagnostics.HTTPResultCategory, diagnostics.ParseStatus, code).Scan(&playerDataChanged)
		return playerDataChanged, err
	})
}

// commitProjection keeps a refreshed payload and its manifest-version bumps in
// the same database transaction. A notification is emitted only after commit,
// so a failed write cannot leave a player looking at a version that never made
// it to durable storage.
func (worker *DataSourceRefreshWorker) commitProjection(ctx context.Context, dataSourceID uuid.UUID, reason string, update func(pgx.Tx) (bool, error)) error {
	tx, err := worker.service.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	changed, err := update(tx)
	if err != nil {
		return err
	}
	var changes []manifestchanges.Change
	transactionalUsed := false
	if changed && worker.service.invalidator != nil {
		if transactional, ok := worker.service.invalidator.(TransactionalAssetInvalidator); ok {
			transactionalUsed = true
			changes, err = transactional.DataSourceChangedInTx(ctx, tx, dataSourceID, reason)
			if err != nil {
				return err
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if !changed || worker.service.invalidator == nil {
		return nil
	}
	if transactionalUsed {
		worker.service.invalidator.(TransactionalAssetInvalidator).NotifyManifestChanges(changes)
		return nil
	}
	return worker.service.invalidator.DataSourceChanged(ctx, dataSourceID, reason)
}
