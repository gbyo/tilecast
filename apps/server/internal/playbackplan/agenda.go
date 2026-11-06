package playbackplan

import (
	"context"
	"errors"
	"reflect"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
)

const (
	maxAgendaDuration   = 8 * 24 * time.Hour
	maxAgendaBoundaries = 512
)

var (
	ErrInvalidAgendaRange   = errors.New("agenda requires a positive range of at most eight days")
	ErrAgendaTooManyChanges = errors.New("agenda range contains too many schedule boundaries")
)

type Agenda struct {
	EvaluatedAt time.Time       `json:"evaluatedAt"`
	Segments    []AgendaSegment `json:"segments"`
}

type AgendaSegment struct {
	Start      time.Time            `json:"start"`
	End        time.Time            `json:"end"`
	Selected   *Selection           `json:"selected,omitempty"`
	Superseded []SelectionCandidate `json:"superseded"`
}

// Agenda forecasts from current configuration in one consistent snapshot.
// It uses the same selection and boundary rules as point inspection.
func (s *SnapshotCurrent) Agenda(ctx context.Context, screen uuid.UUID, from, to time.Time) (Agenda, error) {
	if screen == uuid.Nil || from.IsZero() || !from.Before(to) || to.Sub(from) > maxAgendaDuration {
		return Agenda{}, ErrInvalidAgendaRange
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Agenda{}, err
	}
	defer tx.Rollback(ctx)
	readers := &snapshotReaders{tx: tx, assignments: s.assignments, schedules: s.schedules, overrides: s.overrides}
	current := NewCurrent(readers, readers, readers)
	inputs, err := current.loadSelectionInputs(ctx, screen)
	if err != nil {
		return Agenda{}, err
	}
	now := time.Now().UTC()
	if from.Before(now) {
		from = now
	}
	type contentKey struct {
		kind string
		id   uuid.UUID
	}
	identities := map[contentKey]playlists.PresentationIdentity{}
	segments, err := agendaSegments(ctx, from.UTC(), to.UTC(), func(ctx context.Context, at time.Time) (CurrentPlan, error) {
		plan, err := current.selectAt(ctx, screen, at, inputs)
		if err != nil || plan.Selected == nil {
			return plan, err
		}
		selected := plan.Selected
		key := contentKey{selected.ContentType, selected.ContentID}
		identity, found := identities[key]
		if !found {
			identity, err = s.assignments.PresentationIdentityInTx(ctx, tx, key.kind, key.id)
			if err != nil && !errors.Is(err, playlists.ErrNotFound) {
				return CurrentPlan{}, err
			}
			identities[key] = identity
		}
		selected.Name = identity.Name
		selected.Revision = identity.Revision
		return plan, nil
	})
	if err != nil {
		return Agenda{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agenda{}, err
	}
	return Agenda{EvaluatedAt: now, Segments: segments}, nil
}

func agendaSegments(ctx context.Context, from, to time.Time, selectAt func(context.Context, time.Time) (CurrentPlan, error)) ([]AgendaSegment, error) {
	segments := []AgendaSegment{}
	for at, count := from, 0; at.Before(to); count++ {
		if count == maxAgendaBoundaries {
			return nil, ErrAgendaTooManyChanges
		}
		plan, err := selectAt(ctx, at)
		if err != nil {
			return nil, err
		}
		// The scheduler looks ahead seven local dates. Recheck after a day
		// to cover ranges that cross differing offsets or date boundaries.
		end := at.Add(24 * time.Hour)
		if to.Before(end) {
			end = to
		}
		if next := plan.NextEvaluationAt; next != nil && next.After(at) && next.Before(end) {
			end = next.UTC()
		}
		superseded := []SelectionCandidate{}
		for _, candidate := range plan.Candidates {
			if candidate.Source == "schedule" && candidate.Status == "superseded" {
				superseded = append(superseded, candidate)
			}
		}
		previous := len(segments) - 1
		if previous >= 0 && reflect.DeepEqual(segments[previous].Selected, plan.Selected) &&
			reflect.DeepEqual(segments[previous].Superseded, superseded) {
			segments[previous].End = end
		} else {
			segments = append(segments, AgendaSegment{Start: at, End: end, Selected: plan.Selected, Superseded: superseded})
		}
		at = end
	}
	return segments, nil
}
