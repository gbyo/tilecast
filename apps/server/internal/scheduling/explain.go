package scheduling

import (
	"sort"
	"time"

	"github.com/google/uuid"
)

// SelectionReason identifies the first decisive precedence rule. Callers
// translate these codes; the scheduling authority does not produce UI prose.
type SelectionReason string

const (
	ReasonSelected      SelectionReason = "schedule_highest_precedence"
	ReasonDisabled      SelectionReason = "schedule_disabled"
	ReasonNotActive     SelectionReason = "schedule_not_active"
	ReasonLowerPriority SelectionReason = "schedule_lower_priority"
	ReasonLessSpecific  SelectionReason = "schedule_less_specific"
	ReasonEarlierStart  SelectionReason = "schedule_earlier_start"
	ReasonStableID      SelectionReason = "schedule_stable_id_tiebreak"
)

type CandidateStatus string

const (
	CandidateSelected   CandidateStatus = "selected"
	CandidateSuperseded CandidateStatus = "superseded"
	CandidateInactive   CandidateStatus = "inactive"
)

type Candidate struct {
	ScheduleID  uuid.UUID       `json:"scheduleId"`
	Status      CandidateStatus `json:"status"`
	Reason      SelectionReason `json:"reason"`
	Priority    int             `json:"priority"`
	Specificity int             `json:"specificity"`
	Start       *time.Time      `json:"start,omitempty"`
	End         *time.Time      `json:"end,omitempty"`
}

type Explanation struct {
	Resolution Result      `json:"resolution"`
	Candidates []Candidate `json:"candidates"`
}

// Explain evaluates the supplied validated schedules at an explicit instant.
// It explains this configuration, not historical expected playback. A caller
// inspecting the past must use recorded expectations rather than current rows.
func Explain(at time.Time, schedules []Schedule) Explanation {
	result := Resolve(at, schedules)
	activeByID := make(map[uuid.UUID]Active, len(result.Applicable))
	for _, active := range result.Applicable {
		activeByID[active.Schedule.ID] = active
	}
	trace := make([]Candidate, 0, len(schedules))
	for _, schedule := range schedules {
		candidate := Candidate{
			ScheduleID: schedule.ID, Priority: schedule.Priority,
			Specificity: schedule.Specificity,
			Status:      CandidateInactive, Reason: ReasonNotActive,
		}
		if !schedule.Enabled {
			candidate.Reason = ReasonDisabled
		} else if active, ok := activeByID[schedule.ID]; ok {
			candidate.Start, candidate.End = &active.Start, &active.End
			if result.Winner.Schedule.ID == schedule.ID {
				candidate.Status, candidate.Reason = CandidateSelected, ReasonSelected
			} else {
				candidate.Status = CandidateSuperseded
				_, candidate.Reason = precedes(*result.Winner, active)
			}
		}
		trace = append(trace, candidate)
	}
	// Database row order does not determine explanation order.
	sort.Slice(trace, func(i, j int) bool {
		return trace[i].ScheduleID.String() < trace[j].ScheduleID.String()
	})
	return Explanation{Resolution: result, Candidates: trace}
}

// Both selection and its explanation use this comparator. The reason names
// describe why b loses when a precedes it.
func precedes(a, b Active) (bool, SelectionReason) {
	if a.Schedule.Priority != b.Schedule.Priority {
		return a.Schedule.Priority > b.Schedule.Priority, ReasonLowerPriority
	}
	if a.Schedule.Specificity != b.Schedule.Specificity {
		return a.Schedule.Specificity > b.Schedule.Specificity, ReasonLessSpecific
	}
	if !a.Start.Equal(b.Start) {
		return a.Start.After(b.Start), ReasonEarlierStart
	}
	return a.Schedule.ID.String() < b.Schedule.ID.String(), ReasonStableID
}
