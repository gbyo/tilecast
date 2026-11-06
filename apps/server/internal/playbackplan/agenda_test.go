package playbackplan

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestAgendaCoalescesUnchangedSelectionAcrossCheckpoints(t *testing.T) {
	from := time.Date(2027, 3, 13, 23, 0, 0, 0, time.UTC)
	to := from.Add(7 * 24 * time.Hour)
	calls := 0
	segments, err := agendaSegments(t.Context(), from, to, func(context.Context, time.Time) (CurrentPlan, error) {
		calls++
		return CurrentPlan{}, nil
	})
	if err != nil || calls != 7 || len(segments) != 1 || segments[0].Selected != nil ||
		!segments[0].Start.Equal(from) || !segments[0].End.Equal(to) {
		t.Fatalf("segments=%#v calls=%d err=%v", segments, calls, err)
	}
}

func TestAgendaRejectsExcessBoundariesWithoutPartialResults(t *testing.T) {
	from := time.Now()
	segments, err := agendaSegments(t.Context(), from, from.Add(time.Hour), func(_ context.Context, at time.Time) (CurrentPlan, error) {
		next := at.Add(time.Second)
		return CurrentPlan{NextEvaluationAt: &next}, nil
	})
	if segments != nil || !errors.Is(err, ErrAgendaTooManyChanges) {
		t.Fatalf("segments=%#v err=%v", segments, err)
	}
}
