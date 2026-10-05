package playbackplan

import (
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

type Synchronization struct {
	Status                 string `json:"status"`
	ManifestVersion        int64  `json:"manifestVersion"`
	ActiveManifestVersion  *int64 `json:"activeManifestVersion,omitempty"`
	PendingManifestVersion *int64 `json:"pendingManifestVersion,omitempty"`
}

type CapabilityAssessment struct {
	Status   string                        `json:"status"`
	Reason   string                        `json:"reason"`
	Evidence *playlists.CapabilityEvidence `json:"evidence,omitempty"`
}

// Response exposes evidence without publishing the scheduler's internal
// resolution object or unrelated assignment status fields.
type Response struct {
	ScreenID    uuid.UUID           `json:"screenId"`
	At          time.Time           `json:"at"`
	EvaluatedAt time.Time           `json:"evaluatedAt"`
	Basis       EvidenceBasis       `json:"basis"`
	Current     *CurrentEvidence    `json:"current,omitempty"`
	Historical  *HistoricalEvidence `json:"historical,omitempty"`
}

type CurrentEvidence struct {
	Selected         *Selection            `json:"selected,omitempty"`
	Candidates       []CandidateEvidence   `json:"candidates"`
	NextEvaluationAt *time.Time            `json:"nextEvaluationAt,omitempty"`
	Synchronization  *Synchronization      `json:"synchronization,omitempty"`
	Capabilities     *CapabilityAssessment `json:"capabilities,omitempty"`
}

type CandidateEvidence struct {
	SelectionCandidate
	Schedule *scheduling.Candidate `json:"schedule,omitempty"`
}

type HistoricalEvidence struct {
	Expectation *RecordedExpectation `json:"expectation,omitempty"`
}

func (inspection Inspection) Response() Response {
	response := Response{ScreenID: inspection.ScreenID, At: inspection.At, EvaluatedAt: inspection.EvaluatedAt, Basis: inspection.Basis}
	if inspection.Current != nil {
		plan := inspection.Current
		current := &CurrentEvidence{Selected: plan.Selected, Candidates: []CandidateEvidence{}, NextEvaluationAt: plan.NextEvaluationAt, Synchronization: plan.Synchronization, Capabilities: plan.Capabilities}
		schedules := make(map[uuid.UUID]scheduling.Candidate, len(plan.ScheduleExplanation.Candidates))
		for _, candidate := range plan.ScheduleExplanation.Candidates {
			schedules[candidate.ScheduleID] = candidate
		}
		for _, candidate := range plan.Candidates {
			evidence := CandidateEvidence{SelectionCandidate: candidate}
			if candidate.Source == "schedule" && candidate.ID != nil {
				if schedule, ok := schedules[*candidate.ID]; ok {
					evidence.Schedule = &schedule
				}
			}
			current.Candidates = append(current.Candidates, evidence)
		}
		response.Current = current
	}
	if inspection.Historical != nil {
		response.Historical = &HistoricalEvidence{Expectation: inspection.Historical.Expectation}
	}
	return response
}
