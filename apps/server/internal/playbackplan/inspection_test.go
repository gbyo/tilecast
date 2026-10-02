package playbackplan

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

type inspectionReaders struct {
	currentCalls, historyCalls int
	screen                     uuid.UUID
	at                         time.Time
	basis                      EvidenceBasis
	err                        error
}

func (r *inspectionReaders) At(_ context.Context, screen uuid.UUID, at time.Time) (CurrentPlan, error) {
	r.currentCalls++
	r.screen = screen
	r.at = at
	return CurrentPlan{ScreenID: screen, At: at, Basis: string(BasisCurrent)}, r.err
}
func (r *inspectionReaders) RecordedAt(_ context.Context, screen uuid.UUID, at time.Time) (HistoricalPlan, error) {
	r.historyCalls++
	r.screen = screen
	r.at = at
	return HistoricalPlan{ScreenID: screen, At: at, Basis: r.basis}, r.err
}

func TestInspectionRoutesTimeAgainstOneCapturedClock(t *testing.T) {
	now := time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC)
	screen := uuid.New()
	past, equal, future := now.Add(-time.Nanosecond), now, now.Add(time.Nanosecond)
	zonePast := past.In(time.FixedZone("test", -4*60*60))
	for _, test := range []struct {
		name       string
		requested  *time.Time
		historical bool
		basis      EvidenceBasis
	}{
		{"default_now", nil, false, BasisCurrent},
		{"equal_now", &equal, false, BasisCurrent},
		{"future", &future, false, BasisCurrent},
		{"past", &past, true, BasisRecorded},
		{"same_past_in_other_zone", &zonePast, true, BasisRecorded},
		{"historical_gap", &past, true, BasisUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := &inspectionReaders{basis: test.basis}
			service := NewInspector(r, r)
			clockCalls := 0
			service.now = func() time.Time { clockCalls++; return now.Add(time.Duration(clockCalls-1) * time.Hour) }
			got, err := service.Inspect(context.Background(), screen, test.requested)
			if err != nil {
				t.Fatal(err)
			}
			if clockCalls != 1 || got.Basis != test.basis || got.ScreenID != screen || !got.EvaluatedAt.Equal(now) || r.screen != screen || !r.at.Equal(got.At) {
				t.Fatalf("inspection=%#v clockCalls=%d reader=%#v", got, clockCalls, r)
			}
			if test.historical {
				if r.historyCalls != 1 || r.currentCalls != 0 || got.Historical == nil || got.Current != nil {
					t.Fatalf("history routed incorrectly: %#v %#v", got, r)
				}
			} else if r.historyCalls != 0 || r.currentCalls != 1 || got.Historical != nil || got.Current == nil {
				t.Fatalf("current routed incorrectly: %#v %#v", got, r)
			}
		})
	}
}

func TestInspectionNeverFallsBackAfterHistoryFailure(t *testing.T) {
	now := time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC)
	past := now.Add(-time.Hour)
	for _, failure := range []error{ErrNotFound, ErrAmbiguousExpectation, errors.New("database unavailable")} {
		r := &inspectionReaders{err: failure}
		service := NewInspector(r, r)
		service.now = func() time.Time { return now }
		if _, err := service.Inspect(context.Background(), uuid.New(), &past); !errors.Is(err, failure) {
			t.Fatalf("error=%v want=%v", err, failure)
		}
		if r.currentCalls != 0 || r.historyCalls != 1 {
			t.Fatalf("fallback after history error: %#v", r)
		}
	}
	r := &inspectionReaders{err: errors.New("current unavailable")}
	service := NewInspector(r, r)
	service.now = func() time.Time { return now }
	if _, err := service.Inspect(context.Background(), uuid.New(), nil); !errors.Is(err, r.err) {
		t.Fatalf("current error=%v", err)
	}
	if r.historyCalls != 0 {
		t.Fatal("current failure consulted history")
	}
	zero := time.Time{}
	service = NewInspector(nil, nil)
	for _, input := range []struct {
		screen uuid.UUID
		at     *time.Time
	}{{uuid.Nil, nil}, {uuid.New(), &zero}} {
		if _, err := service.Inspect(context.Background(), input.screen, input.at); !errors.Is(err, ErrInvalidInspection) {
			t.Fatalf("invalid error=%v", err)
		}
	}
}
