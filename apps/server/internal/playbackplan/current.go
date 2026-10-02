package playbackplan

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

var ErrInvalidCurrentInspection = errors.New("screen and inspection instant are required")

type AssignmentReader interface {
	ReadAssignment(context.Context, uuid.UUID) (playlists.Assignment, error)
	ActiveTakeoverAt(context.Context, uuid.UUID, time.Time) (*playlists.ManifestTakeover, error)
}
type ScheduleReader interface {
	Relevant(context.Context, uuid.UUID) ([]scheduling.Record, error)
}
type OverrideReader interface {
	ActiveForScreenAt(context.Context, uuid.UUID, time.Time) (*playlists.PresentationOverride, error)
}

type Selection struct {
	Source      string     `json:"source"`
	ContentType string     `json:"contentType"`
	ContentID   uuid.UUID  `json:"contentId"`
	SelectionID *uuid.UUID `json:"selectionId,omitempty"`
	Revision    *int64     `json:"revision,omitempty"`
	Reason      string     `json:"reason"`
}
type SelectionCandidate struct {
	Source         string                     `json:"source"`
	ID             *uuid.UUID                 `json:"id,omitempty"`
	Status         string                     `json:"status"`
	Reason         string                     `json:"reason"`
	ScheduleReason scheduling.SelectionReason `json:"scheduleReason,omitempty"`
}
type CurrentPlan struct {
	ScreenID   uuid.UUID            `json:"screenId"`
	At         time.Time            `json:"at"`
	Basis      string               `json:"basis"`
	Selected   *Selection           `json:"selected,omitempty"`
	Candidates []SelectionCandidate `json:"candidates"`
	// This is a reevaluation boundary, not a promise that the winner changes.
	NextEvaluationAt    *time.Time             `json:"nextEvaluationAt,omitempty"`
	ScheduleExplanation scheduling.Explanation `json:"scheduleExplanation"`
	Synchronization     *Synchronization       `json:"synchronization,omitempty"`
	Capabilities        *CapabilityAssessment  `json:"capabilities,omitempty"`
}
type Current struct {
	assignments AssignmentReader
	schedules   ScheduleReader
	overrides   OverrideReader
}

func NewCurrent(a AssignmentReader, s ScheduleReader, o OverrideReader) *Current {
	return &Current{a, s, o}
}

// At predicts selection from current configuration. Past inspection must use
// recorded expectations. It does not report content readiness or actual play.
func (s *Current) At(ctx context.Context, screen uuid.UUID, at time.Time) (CurrentPlan, error) {
	if screen == uuid.Nil || at.IsZero() {
		return CurrentPlan{}, ErrInvalidCurrentInspection
	}
	assignment, err := s.assignments.ReadAssignment(ctx, screen)
	if err != nil {
		return CurrentPlan{}, err
	}
	records, err := s.schedules.Relevant(ctx, screen)
	if err != nil {
		return CurrentPlan{}, err
	}
	base := make([]scheduling.Schedule, 0, len(records))
	for _, record := range records {
		// Display-control schedules have their own authority and do not replace
		// a presentation. They must not win the content selection trace.
		if record.PlaylistID != uuid.Nil || record.LayoutID != nil {
			base = append(base, record.Schedule)
		}
	}
	trace := scheduling.Explain(at, base)
	quick, err := s.overrides.ActiveForScreenAt(ctx, screen, at)
	if err != nil {
		return CurrentPlan{}, err
	}
	takeover, err := s.assignments.ActiveTakeoverAt(ctx, screen, at)
	if err != nil {
		return CurrentPlan{}, err
	}
	plan := CurrentPlan{ScreenID: screen, At: at.UTC(), Basis: "current_configuration", Candidates: []SelectionCandidate{}, ScheduleExplanation: trace, NextEvaluationAt: trace.Resolution.NextTransition}
	boundary := func(t *time.Time) {
		if t != nil && t.After(at) && (plan.NextEvaluationAt == nil || t.Before(*plan.NextEvaluationAt)) {
			x := t.UTC()
			plan.NextEvaluationAt = &x
		}
	}
	if quick != nil {
		boundary(quick.ExpiresAt)
	}
	if takeover != nil {
		boundary(&takeover.ExpiresAt)
	}
	if takeover != nil {
		plan.Selected = &Selection{Source: "takeover", ContentType: "playlist", ContentID: takeover.PlaylistID, SelectionID: &takeover.ID, Reason: "active_takeover"}
	} else if quick != nil {
		plan.Selected = &Selection{Source: "quick_present", ContentType: quick.ContentType, ContentID: quick.ContentID, SelectionID: &quick.ID, Reason: "active_quick_present"}
	} else if trace.Resolution.Winner != nil {
		winner := trace.Resolution.Winner.Schedule
		selection := Selection{Source: "schedule", ContentType: "playlist", ContentID: winner.PlaylistID, SelectionID: &winner.ID, Reason: string(scheduling.ReasonSelected)}
		if winner.LayoutID != nil {
			selection.ContentType = "layout"
			selection.ContentID = *winner.LayoutID
		}
		plan.Selected = &selection
	} else if assignment.LayoutID != nil {
		plan.Selected = &Selection{Source: "assignment", ContentType: "layout", ContentID: *assignment.LayoutID, Revision: assignment.LayoutRevision, Reason: "assigned_fallback"}
	} else if assignment.PlaylistID != nil {
		plan.Selected = &Selection{Source: "assignment", ContentType: "playlist", ContentID: *assignment.PlaylistID, Revision: assignment.PlaylistRevision, Reason: "assigned_fallback"}
	}
	add := func(source string, id *uuid.UUID, active bool, inactiveReason string) {
		candidate := SelectionCandidate{Source: source, ID: id, Status: "inactive", Reason: inactiveReason}
		if active {
			if plan.Selected != nil && plan.Selected.Source == source {
				candidate.Status = "selected"
				candidate.Reason = plan.Selected.Reason
			} else {
				candidate.Status = "superseded"
				candidate.Reason = plan.Selected.Reason
			}
		}
		plan.Candidates = append(plan.Candidates, candidate)
	}
	var takeoverID, quickID *uuid.UUID
	if takeover != nil {
		takeoverID = &takeover.ID
	}
	if quick != nil {
		quickID = &quick.ID
	}
	add("takeover", takeoverID, takeover != nil, "no_active_takeover")
	add("quick_present", quickID, quick != nil, "no_active_quick_present")
	for _, candidate := range trace.Candidates {
		status, reason := string(candidate.Status), string(candidate.Reason)
		if candidate.Status != scheduling.CandidateInactive && plan.Selected != nil && (plan.Selected.Source == "takeover" || plan.Selected.Source == "quick_present") {
			status = "superseded"
			reason = plan.Selected.Reason
		}
		id := candidate.ScheduleID
		plan.Candidates = append(plan.Candidates, SelectionCandidate{Source: "schedule", ID: &id, Status: status, Reason: reason, ScheduleReason: candidate.Reason})
	}
	add("assignment", nil, assignment.PlaylistID != nil || assignment.LayoutID != nil, "no_assignment")
	return plan, nil
}
