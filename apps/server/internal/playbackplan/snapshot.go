package playbackplan

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

type TransactionalAssignments interface {
	ReadAssignmentStateInTx(context.Context, pgx.Tx, uuid.UUID) (playlists.Assignment, error)
	ActiveTakeoverAtInTx(context.Context, pgx.Tx, uuid.UUID, time.Time) (*playlists.ManifestTakeover, error)
}
type TransactionalSchedules interface {
	RelevantForInspectionInTx(context.Context, pgx.Tx, uuid.UUID) ([]scheduling.Record, error)
}
type TransactionalOverrides interface {
	ActiveForScreenAtInTx(context.Context, pgx.Tx, uuid.UUID, time.Time) (*playlists.PresentationOverride, error)
}

// SnapshotCurrent binds all selection authorities to one read-only snapshot.
// It uses the same Current selector and does not implement another precedence
// engine. A snapshot is evidence for inspection, not a reservation for a change.
type SnapshotCurrent struct {
	db          *pgxpool.Pool
	assignments TransactionalAssignments
	schedules   TransactionalSchedules
	overrides   TransactionalOverrides
}

func NewSnapshotCurrent(db *pgxpool.Pool, assignments TransactionalAssignments, schedules TransactionalSchedules, overrides TransactionalOverrides) *SnapshotCurrent {
	return &SnapshotCurrent{db: db, assignments: assignments, schedules: schedules, overrides: overrides}
}

func (s *SnapshotCurrent) At(ctx context.Context, screen uuid.UUID, at time.Time) (CurrentPlan, error) {
	if screen == uuid.Nil || at.IsZero() {
		return CurrentPlan{}, ErrInvalidCurrentInspection
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return CurrentPlan{}, err
	}
	defer tx.Rollback(ctx)
	readers := snapshotReaders{tx: tx, assignments: s.assignments, schedules: s.schedules, overrides: s.overrides}
	plan, err := NewCurrent(readers, readers, readers).At(ctx, screen, at)
	if err != nil {
		return CurrentPlan{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CurrentPlan{}, err
	}
	return plan, nil
}

type snapshotReaders struct {
	tx          pgx.Tx
	assignments TransactionalAssignments
	schedules   TransactionalSchedules
	overrides   TransactionalOverrides
}

func (r snapshotReaders) ReadAssignment(ctx context.Context, screen uuid.UUID) (playlists.Assignment, error) {
	a, err := r.assignments.ReadAssignmentStateInTx(ctx, r.tx, screen)
	if errors.Is(err, playlists.ErrNotFound) {
		return playlists.Assignment{}, ErrNotFound
	}
	return a, err
}
func (r snapshotReaders) ActiveTakeoverAt(ctx context.Context, screen uuid.UUID, at time.Time) (*playlists.ManifestTakeover, error) {
	return r.assignments.ActiveTakeoverAtInTx(ctx, r.tx, screen, at)
}
func (r snapshotReaders) Relevant(ctx context.Context, screen uuid.UUID) ([]scheduling.Record, error) {
	return r.schedules.RelevantForInspectionInTx(ctx, r.tx, screen)
}
func (r snapshotReaders) ActiveForScreenAt(ctx context.Context, screen uuid.UUID, at time.Time) (*playlists.PresentationOverride, error) {
	return r.overrides.ActiveForScreenAtInTx(ctx, r.tx, screen, at)
}
