package plugins

// Noise Meter history: ingestion of the ten-second aggregates a Linux Player
// accumulates locally, and the read layer behind the History page.
//
// What arrives here is derived numbers — an average, a peak, three durations,
// and a trigger count. There is no audio, no waveform, and no sample in the
// contract, and the storage has no column that could hold one.
//
// Ingestion is deliberately idempotent. A Player that never saw the response to
// a heartbeat resends the same batch; screen plus bucket start is the primary
// key, so the retry lands on the same row instead of doubling a room's history.

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxNoiseHistoryBatch bounds one heartbeat. At ten-second buckets this is
// twenty minutes of history per heartbeat, which drains a long outage over
// several ordinary heartbeats rather than in one enormous request.
const MaxNoiseHistoryBatch = 120

// NoiseHistoryBucketMS is the fixed local aggregation window. It is not
// configurable: the Player, the storage, and every presentation aggregation
// agree on it, and a per-installation resolution would make stored history
// mean different things on different screens.
const NoiseHistoryBucketMS = 10_000

// NoiseHistoryRecord is one completed bucket as a Player reports it.
type NoiseHistoryRecord struct {
	StartedAt time.Time `json:"startedAt"`
	// Relative 0-100 Tilecast noise levels, never dB, dBA, or SPL.
	AverageLevel float64 `json:"averageLevel"`
	PeakLevel    float64 `json:"peakLevel"`
	// How much of the bucket the microphone actually covered. A partly
	// monitored bucket must not read as ten full seconds of quiet.
	MonitoredMS int `json:"monitoredMs"`
	WarningMS   int `json:"warningMs"`
	LoudMS      int `json:"loudMs"`
	// Times the Player's state machine entered its loud state in this bucket.
	TriggerCount int `json:"triggerCount"`
}

// RecordNoiseHistory stores one heartbeat's worth of buckets for the
// authenticated screen and reports how many records the server has taken
// responsibility for.
//
// A record the server rejects as malformed still counts as accepted: it has
// been dealt with, and telling the Player otherwise would make it retry the
// same unusable bucket on every heartbeat forever.
func (s *Service) RecordNoiseHistory(ctx context.Context, screenID uuid.UUID, records []NoiseHistoryRecord) (int, error) {
	if len(records) == 0 {
		return 0, nil
	}
	if len(records) > MaxNoiseHistoryBatch {
		return 0, fmt.Errorf("%w: a heartbeat may carry at most %d noise history records", ErrInvalid, MaxNoiseHistoryBatch)
	}
	// An uninstalled Noise Meter projects no meter, so a Player should have
	// nothing to report; anything that arrives anyway is consumed and dropped
	// rather than rejected, which would make the Player resend it forever.
	installed, err := s.IsInstalled(ctx, NoiseMeterID)
	if err != nil {
		return 0, err
	}
	if !installed {
		return len(records), nil
	}
	// The instance is resolved from the screen's own targeting, never from the
	// request: a Player does not get to name which meter it is reporting for.
	var instanceID *uuid.UUID
	var retentionDays int
	var historyEnabled bool
	row := s.db.QueryRow(ctx, `SELECT DISTINCT i.id,i.history_enabled,i.history_retention_days
		`+targetScopeFilter("noise_meter_instances", "noise_meter_targets")+`
		ORDER BY i.id LIMIT 1`, screenID)
	var resolved uuid.UUID
	switch err := row.Scan(&resolved, &historyEnabled, &retentionDays); {
	case errors.Is(err, pgx.ErrNoRows):
		// The meter was disabled or retargeted while the Player was offline.
		// The backlog is still consumed so it cannot accumulate forever.
		return len(records), nil
	case err != nil:
		return 0, err
	default:
		instanceID = &resolved
	}
	if !historyEnabled {
		return len(records), nil
	}
	now := time.Now().UTC()
	oldest := now.Add(-time.Duration(retentionDays) * 24 * time.Hour)
	// A clock ahead of the server's must not create history in the future, and
	// a bucket already past its retention window would be pruned on the next
	// sweep anyway.
	newest := now.Add(2 * time.Minute)
	rows := make([][]any, 0, len(records))
	for _, record := range records {
		clean, ok := sanitizeNoiseHistoryRecord(record, oldest, newest)
		if !ok {
			continue
		}
		rows = append(rows, []any{screenID, clean.StartedAt, instanceID, clean.AverageLevel, clean.PeakLevel,
			clean.MonitoredMS, clean.WarningMS, clean.LoudMS, clean.TriggerCount})
	}
	if len(rows) == 0 {
		return len(records), nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	for _, values := range rows {
		if _, err = tx.Exec(ctx, `INSERT INTO noise_meter_history
			(screen_id,bucket_started_at,plugin_instance_id,average_level,peak_level,monitored_ms,warning_ms,loud_ms,trigger_count)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (screen_id,bucket_started_at) DO NOTHING`, values...); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(records), nil
}

// sanitizeNoiseHistoryRecord clamps what can be clamped and rejects what cannot.
// A NaN level, a duration longer than the bucket, or a timestamp from next year
// is a bug or a tampered payload either way; neither may become stored history.
func sanitizeNoiseHistoryRecord(record NoiseHistoryRecord, oldest, newest time.Time) (NoiseHistoryRecord, bool) {
	if record.StartedAt.IsZero() || record.StartedAt.Before(oldest) || record.StartedAt.After(newest) {
		return record, false
	}
	if math.IsNaN(record.AverageLevel) || math.IsInf(record.AverageLevel, 0) ||
		math.IsNaN(record.PeakLevel) || math.IsInf(record.PeakLevel, 0) {
		return record, false
	}
	clamp := func(value float64) float64 { return math.Min(100, math.Max(0, value)) }
	clampMS := func(value int) int {
		if value < 0 {
			return 0
		}
		if value > NoiseHistoryBucketMS {
			return NoiseHistoryBucketMS
		}
		return value
	}
	record.AverageLevel = clamp(record.AverageLevel)
	record.PeakLevel = clamp(record.PeakLevel)
	// A peak below the average is not a reading, it is a broken aggregate.
	if record.PeakLevel < record.AverageLevel {
		record.PeakLevel = record.AverageLevel
	}
	record.MonitoredMS = clampMS(record.MonitoredMS)
	record.WarningMS = clampMS(record.WarningMS)
	record.LoudMS = clampMS(record.LoudMS)
	// The two coloured durations are inside the monitored time by definition.
	if record.WarningMS+record.LoudMS > record.MonitoredMS {
		record.MonitoredMS = record.WarningMS + record.LoudMS
		if record.MonitoredMS > NoiseHistoryBucketMS {
			return record, false
		}
	}
	if record.TriggerCount < 0 || record.TriggerCount > 1000 {
		return record, false
	}
	// Buckets are aligned to a fixed grid so a reconnecting Player cannot open
	// an arbitrary window that overlaps one already stored.
	record.StartedAt = record.StartedAt.UTC().Truncate(NoiseHistoryBucketMS * time.Millisecond)
	return record, true
}

// PruneNoiseHistory removes buckets past their instance's retention window. It
// is bounded so a maintenance pass cannot become an unbounded table scan, and
// deletes only rows older than the window: shortening retention expires old
// history, and never touches anything newer.
func (s *Service) PruneNoiseHistory(ctx context.Context, batch int) (int64, error) {
	if batch < 1 || batch > 50_000 {
		batch = 5_000
	}
	tag, err := s.db.Exec(ctx, `WITH expired AS (
			SELECT h.screen_id,h.bucket_started_at
			FROM noise_meter_history h
			LEFT JOIN noise_meter_instances i ON i.id=h.plugin_instance_id
			WHERE h.bucket_started_at < now() - (COALESCE(i.history_retention_days,7)::int * interval '1 day')
			ORDER BY h.bucket_started_at
			LIMIT $1::int)
		DELETE FROM noise_meter_history h USING expired e
		WHERE h.screen_id=e.screen_id AND h.bucket_started_at=e.bucket_started_at`, batch)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
