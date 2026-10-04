// Package playbackplan assembles expected playback evidence without deriving
// historical expectations from the installation's current configuration.
package playbackplan

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound             = errors.New("playback plan screen not found")
	ErrInvalidInspection    = errors.New("playback plan inspection requires a screen and instant")
	ErrAmbiguousExpectation = errors.New("recorded playback expectation windows overlap")
)

type EvidenceBasis string

const (
	BasisRecorded    EvidenceBasis = "recorded_expectation"
	BasisUnavailable EvidenceBasis = "historical_expectation_unavailable"
)

// RecordedExpectation contains only the recorded identities and interval.
// Names, revisions, dependencies, and capabilities from current resources
// must not be substituted for historical evidence.
type RecordedExpectation struct {
	WindowID             uuid.UUID  `json:"windowId"`
	PresentationType     string     `json:"presentationType"`
	PresentationID       string     `json:"presentationId"`
	PresentationRevision string     `json:"presentationRevision"`
	ManifestVersion      *int64     `json:"manifestVersion,omitempty"`
	ScheduleID           string     `json:"scheduleId,omitempty"`
	Source               string     `json:"source"`
	Timezone             string     `json:"timezone"`
	Start                time.Time  `json:"start"`
	End                  *time.Time `json:"end,omitempty"`
	SupersededAt         *time.Time `json:"supersededAt,omitempty"`
	SupersededReason     *string    `json:"supersededReason,omitempty"`
	ContentType          string     `json:"contentType,omitempty"`
	ContentID            string     `json:"contentId,omitempty"`
}

type HistoricalPlan struct {
	ScreenID    uuid.UUID            `json:"screenId"`
	At          time.Time            `json:"at"`
	Basis       EvidenceBasis        `json:"basis"`
	Expectation *RecordedExpectation `json:"expectation,omitempty"`
}

type History struct{ db *pgxpool.Pool }

func NewHistory(db *pgxpool.Pool) *History { return &History{db: db} }

// RecordedAt reads the half-open window containing at. It never consults
// current assignments or schedules and never manufactures an expectation.
// This is recorded evidence, including an open recorded window; it is not a
// prediction for a future instant or proof that the Player actually displayed it.
func (s *History) RecordedAt(ctx context.Context, screenID uuid.UUID, at time.Time) (HistoricalPlan, error) {
	if screenID == uuid.Nil || at.IsZero() {
		return HistoricalPlan{}, ErrInvalidInspection
	}
	plan := HistoricalPlan{ScreenID: screenID, At: at.UTC(), Basis: BasisUnavailable}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return HistoricalPlan{}, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens WHERE id=$1)`, screenID).Scan(&exists); err != nil {
		return HistoricalPlan{}, err
	}
	if !exists {
		return HistoricalPlan{}, ErrNotFound
	}
	rows, err := tx.Query(ctx, `SELECT id,presentation_type,presentation_id,presentation_revision,manifest_version,
		schedule_id,trigger_source,timezone,expected_start,expected_end,superseded_at,superseded_reason,
		expected_content_type,expected_content_id
		FROM expected_playback_windows
		WHERE screen_id=$1 AND expected_start<=$2
		AND (expected_end IS NULL OR expected_end>$2)
		AND (superseded_at IS NULL OR superseded_at>$2)
		ORDER BY expected_start DESC,id LIMIT 2`, screenID, plan.At)
	if err != nil {
		return HistoricalPlan{}, err
	}
	defer rows.Close()
	for rows.Next() {
		if plan.Expectation != nil {
			return HistoricalPlan{}, ErrAmbiguousExpectation
		}
		var record RecordedExpectation
		if err := rows.Scan(&record.WindowID, &record.PresentationType, &record.PresentationID, &record.PresentationRevision,
			&record.ManifestVersion, &record.ScheduleID, &record.Source, &record.Timezone, &record.Start, &record.End,
			&record.SupersededAt, &record.SupersededReason, &record.ContentType, &record.ContentID); err != nil {
			return HistoricalPlan{}, err
		}
		plan.Expectation = &record
		plan.Basis = BasisRecorded
	}
	if err := rows.Err(); err != nil {
		return HistoricalPlan{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return HistoricalPlan{}, err
	}
	return plan, nil
}
