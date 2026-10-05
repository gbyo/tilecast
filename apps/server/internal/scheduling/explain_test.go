package scheduling

import (
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestExplainDecisivePrecedence(t *testing.T) {
	at := time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC)
	base := Schedule{
		ID:   uuid.MustParse("00000000-0000-0000-0000-000000000001"),
		Type: OneTime, Timezone: "UTC", Enabled: true,
		Priority: 10, Specificity: 1,
		OneTimeStart: p(at.Add(-time.Hour)), OneTimeEnd: p(at.Add(time.Hour)),
	}
	for _, test := range []struct {
		name   string
		reason SelectionReason
		change func(*Schedule)
	}{
		{"priority", ReasonLowerPriority, func(s *Schedule) { s.Priority = 9; s.Specificity = 2 }},
		{"specificity", ReasonLessSpecific, func(s *Schedule) { s.Specificity = 0; s.OneTimeStart = p(at.Add(-time.Minute)) }},
		{"start", ReasonEarlierStart, func(s *Schedule) { s.OneTimeStart = p(at.Add(-2 * time.Hour)) }},
		{"stable-id", ReasonStableID, func(s *Schedule) {}},
	} {
		t.Run(test.name, func(t *testing.T) {
			loser := base
			loser.ID = uuid.MustParse("00000000-0000-0000-0000-000000000002")
			test.change(&loser)
			input := []Schedule{loser, base}
			before := append([]Schedule(nil), input...)
			explanation := Explain(at, input)
			if explanation.Resolution.Winner == nil || explanation.Resolution.Winner.Schedule.ID != base.ID {
				t.Fatalf("winner=%+v", explanation.Resolution.Winner)
			}
			selected, rejected := explanation.Candidates[0], explanation.Candidates[1]
			if selected.Status != CandidateSelected || selected.Reason != ReasonSelected || selected.Start == nil || !selected.Start.Equal(*base.OneTimeStart) {
				t.Fatalf("selected=%+v", selected)
			}
			if rejected.Status != CandidateSuperseded || rejected.Reason != test.reason || rejected.End == nil || !rejected.End.Equal(*loser.OneTimeEnd) {
				t.Fatalf("rejected=%+v", rejected)
			}
			if !reflect.DeepEqual(input, before) {
				t.Fatal("explanation mutated the caller's schedules")
			}
			if !reflect.DeepEqual(explanation, Explain(at, []Schedule{base, loser})) {
				t.Fatal("database ordering changed the resolution or explanation")
			}
		})
	}
}

func TestExplainInactiveAndNextTransition(t *testing.T) {
	at := time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC)
	future := Schedule{ID: uuid.MustParse("00000000-0000-0000-0000-000000000001"), Type: OneTime, Timezone: "UTC", Enabled: true, OneTimeStart: p(at.Add(time.Hour)), OneTimeEnd: p(at.Add(2 * time.Hour))}
	disabled := future
	disabled.ID = uuid.MustParse("00000000-0000-0000-0000-000000000002")
	disabled.Enabled = false
	disabled.OneTimeStart = p(at.Add(time.Minute))
	explanation := Explain(at, []Schedule{disabled, future})
	if explanation.Resolution.Winner != nil || explanation.Resolution.NextTransition == nil || !explanation.Resolution.NextTransition.Equal(*future.OneTimeStart) {
		t.Fatalf("resolution=%+v", explanation.Resolution)
	}
	for i, reason := range []SelectionReason{ReasonNotActive, ReasonDisabled} {
		candidate := explanation.Candidates[i]
		if candidate.Status != CandidateInactive || candidate.Reason != reason || candidate.Start != nil || candidate.End != nil {
			t.Fatalf("inactive=%+v", candidate)
		}
	}
	if got := Explain(*future.OneTimeStart, []Schedule{future}); got.Candidates[0].Status != CandidateSelected {
		t.Fatal("inclusive start was not selected")
	}
	if got := Explain(*future.OneTimeEnd, []Schedule{future}); got.Candidates[0].Reason != ReasonNotActive || got.Resolution.NextTransition != nil {
		t.Fatal("exclusive end was still selected or invented a transition")
	}
	if got := Explain(at, nil); got.Candidates == nil || len(got.Candidates) != 0 || got.Resolution.Winner != nil {
		t.Fatalf("empty explanation=%+v", got)
	}
}

func TestExplainUsesResolvedDSTIntervals(t *testing.T) {
	schedule := Schedule{
		ID:   uuid.MustParse("00000000-0000-0000-0000-000000000001"),
		Type: Weekly, Timezone: "America/New_York", Enabled: true,
		DailyStart: p("01:30"), DailyEnd: p("02:00"), DaysOfWeek: []int{0},
	}
	earlier := schedule
	earlier.ID = uuid.MustParse("00000000-0000-0000-0000-000000000002")
	earlier.DailyStart = p("01:00")
	// Both schedules remain active during the second occurrence of 01:40.
	at := time.Date(2026, 11, 1, 6, 40, 0, 0, time.UTC)
	explanation := Explain(at, []Schedule{earlier, schedule})
	selected, rejected := explanation.Candidates[0], explanation.Candidates[1]
	start := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC)
	end := time.Date(2026, 11, 1, 7, 0, 0, 0, time.UTC)
	if selected.Status != CandidateSelected || selected.Start == nil || !selected.Start.Equal(start) || selected.End == nil || !selected.End.Equal(end) {
		t.Fatalf("DST selected=%+v", selected)
	}
	if rejected.Reason != ReasonEarlierStart || explanation.Resolution.NextTransition == nil || !explanation.Resolution.NextTransition.Equal(end) {
		t.Fatalf("DST rejected=%+v transition=%v", rejected, explanation.Resolution.NextTransition)
	}
}
