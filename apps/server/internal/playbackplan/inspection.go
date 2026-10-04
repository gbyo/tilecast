package playbackplan

import (
	"context"
	"time"

	"github.com/google/uuid"
)

const BasisCurrent EvidenceBasis = "current_configuration"

type CurrentReader interface {
	At(context.Context, uuid.UUID, time.Time) (CurrentPlan, error)
}

type RecordedReader interface {
	RecordedAt(context.Context, uuid.UUID, time.Time) (HistoricalPlan, error)
}

// Inspection keeps predictions separate from recorded expectations. Exactly
// one evidence branch is populated after a successful inspection.
type Inspection struct {
	ScreenID    uuid.UUID       `json:"screenId"`
	At          time.Time       `json:"at"`
	EvaluatedAt time.Time       `json:"evaluatedAt"`
	Basis       EvidenceBasis   `json:"basis"`
	Current     *CurrentPlan    `json:"current,omitempty"`
	Historical  *HistoricalPlan `json:"historical,omitempty"`
}

type Inspector struct {
	current CurrentReader
	history RecordedReader
	now     func() time.Time
}

func NewInspector(current CurrentReader, history RecordedReader) *Inspector {
	return &Inspector{current: current, history: history, now: time.Now}
}

// Inspect captures the clock once. A missing instant means that captured now;
// explicit past instants read history, including gaps with unavailable evidence.
// A gap or reader error must never fall back to today's configuration.
func (s *Inspector) Inspect(ctx context.Context, screenID uuid.UUID, requested *time.Time) (Inspection, error) {
	if screenID == uuid.Nil || (requested != nil && requested.IsZero()) {
		return Inspection{}, ErrInvalidInspection
	}
	now := s.now().UTC()
	at := now
	if requested != nil {
		at = requested.UTC()
	}
	inspection := Inspection{ScreenID: screenID, At: at, EvaluatedAt: now}
	if at.Before(now) {
		historical, err := s.history.RecordedAt(ctx, screenID, at)
		if err != nil {
			return Inspection{}, err
		}
		inspection.Basis = historical.Basis
		inspection.Historical = &historical
	} else {
		current, err := s.current.At(ctx, screenID, at)
		if err != nil {
			return Inspection{}, err
		}
		inspection.Basis = BasisCurrent
		inspection.Current = &current
	}
	return inspection, nil
}
