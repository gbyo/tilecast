package httpapi

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/activityreport"
)

type complianceReport struct {
	Range struct {
		From time.Time `json:"from"`
		To   time.Time `json:"to"`
	} `json:"range"`

	// Expected screen-time that could be judged. Cancelled and
	// takeover-overridden time is excluded, because neither is playback that
	// went missing.
	MeasurableExpectedMS int64 `json:"measurableExpectedMs"`
	ConfirmedMS          int64 `json:"confirmedMs"`
	MissedMS             int64 `json:"missedMs"`
	// Null rather than zero when nothing measurable was expected. Zero would
	// read as total non-compliance instead of "nothing to measure".
	CompliancePercent *float64 `json:"compliancePercent"`

	// Time deliberately excluded, reported so the exclusion is visible rather
	// than silently improving the percentage.
	TakeoverOverriddenMS int64 `json:"takeoverOverriddenMs"`
	CancelledMS          int64 `json:"cancelledMs"`
	NotMeasurableMS      int64 `json:"notMeasurableMs"`

	Windows        int64 `json:"windows"`
	LateStarts     int64 `json:"lateStarts"`
	EarlyEndings   int64 `json:"earlyEndings"`
	NeverStarted   int64 `json:"neverStarted"`
	OfflineMisses  int64 `json:"offlineMisses"`
	FailedWindows  int64 `json:"failedWindows"`
	PartialWindows int64 `json:"partialWindows"`

	Breakdown []complianceBreakdown `json:"breakdown"`
	Dimension string                `json:"dimension"`
}

type complianceBreakdown struct {
	Key                  string   `json:"key"`
	Label                string   `json:"label"`
	MeasurableExpectedMS int64    `json:"measurableExpectedMs"`
	ConfirmedMS          int64    `json:"confirmedMs"`
	MissedMS             int64    `json:"missedMs"`
	CompliancePercent    *float64 `json:"compliancePercent"`
	Windows              int64    `json:"windows"`
	LateStarts           int64    `json:"lateStarts"`
	EarlyEndings         int64    `json:"earlyEndings"`
	NeverStarted         int64    `json:"neverStarted"`
	OfflineMisses        int64    `json:"offlineMisses"`
	// The most common reason time went missing in this group, or empty when
	// nothing was missed.
	TopFailureReason string `json:"topFailureReason,omitempty"`
}

// complianceBreakdownLimit is the number of groups the Studio compliance
// route returns.
const complianceBreakdownLimit = 200

func (s *server) playbackCompliance(w http.ResponseWriter, r *http.Request) {
	window, err := parseActivityWindow(r)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "activity_range_invalid", err.Error())
		return
	}
	reports := activityreport.New(s.db)
	// Judge everything that has finished before reporting on it, so a window
	// that closed a moment ago is not reported as unmeasured.
	if err := reports.EvaluateExpectedWindows(r.Context(), time.Now(), nil); err != nil {
		s.internalError(w, r, err)
		return
	}

	dimension := queryValue(r, "dimension")
	if dimension == "" {
		dimension = "screen"
	}
	if !activityreport.IsComplianceDimension(dimension) {
		writeError(w, http.StatusUnprocessableEntity, "compliance_dimension_invalid",
			"Dimension must be screen, location, group, presentation, schedule, date, or reason.")
		return
	}
	filter := activityreport.ComplianceFilter{Schedule: queryValue(r, "schedule")}
	if value := queryValue(r, "screen"); value != "" {
		id, err := uuid.Parse(value)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "screen_invalid", "Screen must be a UUID.")
			return
		}
		filter.Screen = &id
	}

	totals, err := reports.ComplianceTotals(r.Context(), filter, window)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	groups, err := reports.ComplianceBreakdown(r.Context(), filter, window, dimension, 0, complianceBreakdownLimit)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	report := complianceReport{
		MeasurableExpectedMS: totals.MeasurableExpectedMS, ConfirmedMS: totals.ConfirmedMS, MissedMS: totals.MissedMS,
		CompliancePercent:    totals.CompliancePercent,
		TakeoverOverriddenMS: totals.TakeoverOverriddenMS, CancelledMS: totals.CancelledMS, NotMeasurableMS: totals.NotMeasurableMS,
		Windows: totals.Windows, LateStarts: totals.LateStarts, EarlyEndings: totals.EarlyEndings,
		NeverStarted: totals.NeverStarted, OfflineMisses: totals.OfflineMisses,
		FailedWindows: totals.FailedWindows, PartialWindows: totals.PartialWindows,
		Breakdown: make([]complianceBreakdown, 0, len(groups)), Dimension: dimension,
	}
	report.Range.From, report.Range.To = window.From, window.To
	for _, group := range groups {
		report.Breakdown = append(report.Breakdown, complianceBreakdown(group))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": report})
}
