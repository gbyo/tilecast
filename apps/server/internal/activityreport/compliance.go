package activityreport

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Expected playback is what should have been on a screen, recorded when the
// selection became effective. It is deliberately not reconstructed from
// current configuration: schedules and assignments change, and reporting last
// month against this month's plan would measure compliance with a plan that
// never existed then.

// Match statuses of an expected playback window.
const (
	MatchConfirmed        = "confirmed"
	MatchStartedLate      = "started_late"
	MatchEndedEarly       = "ended_early"
	MatchPartial          = "partial"
	MatchFailed           = "failed"
	MatchNeverStarted     = "never_started"
	MatchScreenOffline    = "screen_offline"
	MatchTakeoverOverride = "overridden_by_takeover"
	MatchCancelled        = "cancelled"
	MatchNotMeasurable    = "not_measurable"
)

// Slack on each edge. A player that starts two seconds after the window opens
// did what was asked; calling that a late start would make compliance a
// measure of clock skew.
const (
	ExpectedStartGrace = 90 * time.Second
	ExpectedEndGrace   = 90 * time.Second
	// ExpectedMinimumMeasurable is the shortest window that can be judged
	// fairly: below it a window is shorter than the reporting grace itself.
	ExpectedMinimumMeasurable = 2 * time.Minute
)

// expectedCancellingReasons end a window without it counting as missed
// playback. Each one means normal playback was not supposed to happen, so
// scoring it as a miss would penalise the operator for their own decision.
var expectedCancellingReasons = map[string]bool{
	"screen_disabled":                true,
	"active_hours_changed":           true,
	"deployment_suppressed_playback": true,
	"screen_archived":                true,
}

// EvaluateExpectedWindows matches root playback against every closed window
// that has not been judged yet. Open windows are left alone: a window still in
// force has not finished, and judging it early would report a screen as having
// missed playback that is still running. A nil screen judges every screen.
func (r *Reports) EvaluateExpectedWindows(ctx context.Context, now time.Time, screenID *uuid.UUID) error {
	clause, args := "", []any{now.UTC()}
	if screenID != nil {
		clause = " AND w.screen_id=$2"
		args = append(args, *screenID)
	}
	rows, err := r.db.Query(ctx, `
		SELECT w.id,w.screen_id,w.expected_start,w.expected_end,w.superseded_reason,
		       w.overridden_by_takeover_id,w.trigger_source
		FROM expected_playback_windows w
		WHERE w.expected_end IS NOT NULL AND w.expected_end <= $1
		  AND (w.match_evaluated_at IS NULL OR w.match_evaluated_at < w.expected_end)`+clause+`
		ORDER BY w.expected_start LIMIT 2000`, args...)
	if err != nil {
		return err
	}
	type pending struct {
		ID         uuid.UUID
		ScreenID   uuid.UUID
		Start, End time.Time
		Reason     *string
		TakeoverID *uuid.UUID
		Trigger    string
	}
	windows := []pending{}
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.ID, &item.ScreenID, &item.Start, &item.End, &item.Reason,
			&item.TakeoverID, &item.Trigger); err != nil {
			rows.Close()
			return err
		}
		windows = append(windows, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, window := range windows {
		match, err := r.MatchExpectedWindow(ctx, window.ScreenID, window.Start, window.End, window.Reason, window.TakeoverID)
		if err != nil {
			return err
		}
		if _, err := r.db.Exec(ctx, `
			UPDATE expected_playback_windows
			SET match_status=$2,confirmed_duration_ms=$3,actual_start=$4,actual_end=$5,
			    matched_session_id=$6,match_evaluated_at=now()
			WHERE id=$1`,
			window.ID, match.Status, match.ConfirmedMS, match.ActualStart, match.ActualEnd, match.SessionID); err != nil {
			return err
		}
	}
	return nil
}

// WindowMatch is what actually happened during one expected window.
type WindowMatch struct {
	Status      string
	ConfirmedMS int64
	ActualStart *time.Time
	ActualEnd   *time.Time
	SessionID   *uuid.UUID
}

// MatchExpectedWindow decides what actually happened during one window.
func (r *Reports) MatchExpectedWindow(ctx context.Context, screenID uuid.UUID, start, end time.Time, reason *string, takeoverID *uuid.UUID) (WindowMatch, error) {
	// A takeover replaced normal playback on purpose; that time is not a
	// missed normal play and is excluded from the compliance denominator.
	if takeoverID != nil {
		return WindowMatch{Status: MatchTakeoverOverride}, nil
	}
	if reason != nil && expectedCancellingReasons[*reason] {
		return WindowMatch{Status: MatchCancelled}, nil
	}
	if end.Sub(start) < ExpectedMinimumMeasurable {
		return WindowMatch{Status: MatchNotMeasurable}, nil
	}

	var match WindowMatch
	var failed bool
	// Root sessions only: child content is exposure inside the presentation,
	// not the screen's wall clock, so counting it would inflate compliance.
	if err := r.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(p.ended_at,$3),$3) - GREATEST(p.started_at,$2))))*1000,0)::bigint,
		       MIN(GREATEST(p.started_at,$2)),MAX(LEAST(COALESCE(p.ended_at,$3),$3)),
		       (array_agg(p.id ORDER BY p.started_at))[1],
		       -- No matching session means nothing was observed to fail; the
		       -- aggregate is NULL there and must not be read as a failure.
		       COALESCE(bool_or(p.result='failed'),FALSE)
		FROM playback_sessions p
		WHERE p.screen_id=$1 AND p.session_type='presentation'
		  AND p.started_at<$3 AND COALESCE(p.ended_at,$3)>$2
		  AND p.result IN('playing','completed','recovered','partial','failed')`,
		screenID, start, end).Scan(&match.ConfirmedMS, &match.ActualStart, &match.ActualEnd, &match.SessionID, &failed); err != nil {
		return WindowMatch{}, err
	}

	if match.ConfirmedMS <= 0 {
		// Nothing played. Whether that is the screen's fault depends on
		// whether it was reachable, which is a different operational problem
		// from a player that was up and showing nothing.
		offline, err := r.screenWasOffline(ctx, screenID, start, end)
		if err != nil {
			return WindowMatch{}, err
		}
		if offline {
			return WindowMatch{Status: MatchScreenOffline}, nil
		}
		return WindowMatch{Status: MatchNeverStarted}, nil
	}

	expected := end.Sub(start).Milliseconds()
	late := match.ActualStart != nil && match.ActualStart.Sub(start) > ExpectedStartGrace
	early := match.ActualEnd != nil && end.Sub(*match.ActualEnd) > ExpectedEndGrace
	switch {
	case failed:
		match.Status = MatchFailed
	case late && early:
		// Both ends missing is not a late start or an early end; it is a
		// window that was only partly covered.
		match.Status = MatchPartial
	case late:
		match.Status = MatchStartedLate
	case early:
		match.Status = MatchEndedEarly
	case match.ConfirmedMS*100 < expected*95:
		// Covered at both ends but with a hole in the middle.
		match.Status = MatchPartial
	default:
		match.Status = MatchConfirmed
	}
	return match, nil
}

// screenWasOffline reports whether the screen was unreachable for most of the
// window, which distinguishes an outage from a player that was up and idle.
func (r *Reports) screenWasOffline(ctx context.Context, screenID uuid.UUID, start, end time.Time) (bool, error) {
	var offlineSeconds float64
	if err := r.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(i.ended_at,$3),$3) - GREATEST(i.started_at,$2)))),0)::float8
		FROM screen_state_intervals i
		WHERE i.screen_id=$1 AND i.state IN('offline','unknown')
		  AND i.started_at<$3 AND COALESCE(i.ended_at,$3)>$2`, screenID, start, end).Scan(&offlineSeconds); err != nil {
		return false, err
	}
	return offlineSeconds >= end.Sub(start).Seconds()/2, nil
}

// ComplianceFilter narrows the expected windows a compliance report reads.
type ComplianceFilter struct {
	Screen   *uuid.UUID
	Schedule string
}

// ComplianceTotals are the report-wide compliance facts. The meanings are
// those of docs/activity.md.
type ComplianceTotals struct {
	// MeasurableExpectedMS is expected screen time that could be judged.
	// Cancelled and takeover-overridden time is excluded, because neither is
	// playback that went missing.
	MeasurableExpectedMS int64
	ConfirmedMS          int64
	MissedMS             int64
	// CompliancePercent is nil rather than zero when nothing measurable was
	// expected. Zero would read as total non-compliance.
	CompliancePercent *float64
	// Excluded time, reported so the exclusion is visible rather than
	// silently improving the percentage.
	TakeoverOverriddenMS int64
	CancelledMS          int64
	NotMeasurableMS      int64
	Windows              int64
	LateStarts           int64
	EarlyEndings         int64
	NeverStarted         int64
	OfflineMisses        int64
	FailedWindows        int64
	PartialWindows       int64
}

// ComplianceGroup is one group of a compliance breakdown.
type ComplianceGroup struct {
	Key                  string
	Label                string
	MeasurableExpectedMS int64
	ConfirmedMS          int64
	MissedMS             int64
	CompliancePercent    *float64
	Windows              int64
	LateStarts           int64
	EarlyEndings         int64
	NeverStarted         int64
	OfflineMisses        int64
	// TopFailureReason is the most common reason time went missing in this
	// group, or empty when nothing was missed.
	TopFailureReason string
}

// expectedClippedMS is a window's expected milliseconds, clipped to the
// range. An open window is clipped at the range end rather than treated as
// infinite.
const expectedClippedMS = `
	GREATEST(0, EXTRACT(EPOCH FROM (
		LEAST(COALESCE(w.expected_end, $2::timestamptz), $2::timestamptz)
		- GREATEST(w.expected_start, $1::timestamptz)))*1000)::bigint`

// measurableFilter excludes cancelled, takeover-overridden, and unmeasurable
// windows from the denominator; counting them would report an operator's own
// decision as a compliance failure.
const measurableFilter = `w.match_status NOT IN ('cancelled','overridden_by_takeover','not_measurable')`

var complianceDimensions = map[string][2]string{
	"screen":       {"w.screen_id::text", "COALESCE(s.name,'Unknown screen')"},
	"location":     {"COALESCE(s.location_id::text,'')", "COALESCE(l.name,'No location')"},
	"group":        {"COALESCE(g.id::text,'')", "COALESCE(g.name,'No group')"},
	"presentation": {"w.presentation_id", "COALESCE(NULLIF(w.presentation_id,''),'No presentation')"},
	"schedule":     {"w.schedule_id", "COALESCE(NULLIF(w.schedule_id,''),'Direct assignment')"},
	"date":         {"to_char(w.expected_start,'YYYY-MM-DD')", "to_char(w.expected_start,'YYYY-MM-DD')"},
	"reason":       {"w.match_status", "w.match_status"},
}

// IsComplianceDimension reports whether value is a compliance breakdown
// dimension.
func IsComplianceDimension(value string) bool {
	_, ok := complianceDimensions[value]
	return ok
}

func complianceWhere(filter ComplianceFilter, window Window) (string, []any) {
	clauses := []string{"w.expected_start < $2", "COALESCE(w.expected_end,$2) > $1"}
	args := []any{window.From, window.To}
	if filter.Screen != nil {
		args = append(args, *filter.Screen)
		clauses = append(clauses, "w.screen_id = $"+strconv.Itoa(len(args)))
	}
	if filter.Schedule != "" {
		args = append(args, filter.Schedule)
		clauses = append(clauses, "w.schedule_id = $"+strconv.Itoa(len(args)))
	}
	return strings.Join(clauses, " AND "), args
}

// ComplianceTotals reads the report-wide facts of the windows overlapping
// the window. Callers judge finished windows first with
// EvaluateExpectedWindows.
func (r *Reports) ComplianceTotals(ctx context.Context, filter ComplianceFilter, window Window) (ComplianceTotals, error) {
	where, args := complianceWhere(filter, window)
	var totals ComplianceTotals
	if err := r.db.QueryRow(ctx, `
		SELECT
			COALESCE(SUM(`+expectedClippedMS+`) FILTER (WHERE `+measurableFilter+`),0),
			COALESCE(SUM(w.confirmed_duration_ms) FILTER (WHERE `+measurableFilter+`),0),
			COALESCE(SUM(`+expectedClippedMS+`) FILTER (WHERE w.match_status='overridden_by_takeover'),0),
			COALESCE(SUM(`+expectedClippedMS+`) FILTER (WHERE w.match_status='cancelled'),0),
			COALESCE(SUM(`+expectedClippedMS+`) FILTER (WHERE w.match_status='not_measurable'),0),
			count(*),
			count(*) FILTER (WHERE w.match_status='started_late'),
			count(*) FILTER (WHERE w.match_status='ended_early'),
			count(*) FILTER (WHERE w.match_status='never_started'),
			count(*) FILTER (WHERE w.match_status='screen_offline'),
			count(*) FILTER (WHERE w.match_status='failed'),
			count(*) FILTER (WHERE w.match_status='partial')
		FROM expected_playback_windows w WHERE `+where, args...).Scan(
		&totals.MeasurableExpectedMS, &totals.ConfirmedMS,
		&totals.TakeoverOverriddenMS, &totals.CancelledMS, &totals.NotMeasurableMS,
		&totals.Windows, &totals.LateStarts, &totals.EarlyEndings,
		&totals.NeverStarted, &totals.OfflineMisses, &totals.FailedWindows, &totals.PartialWindows,
	); err != nil {
		return totals, err
	}
	totals.MissedMS = max(0, totals.MeasurableExpectedMS-totals.ConfirmedMS)
	totals.CompliancePercent = CompliancePercent(totals.ConfirmedMS, totals.MeasurableExpectedMS)
	return totals, nil
}

// ComplianceBreakdown groups the windows by dimension, largest measurable
// expected time first, then label and key, and returns at most limit groups
// after offset.
func (r *Reports) ComplianceBreakdown(ctx context.Context, filter ComplianceFilter, window Window, dimension string, offset, limit int) ([]ComplianceGroup, error) {
	expressions, ok := complianceDimensions[dimension]
	if !ok {
		return nil, filterError{"dimension is invalid"}
	}
	where, args := complianceWhere(filter, window)
	joins := `LEFT JOIN screens s ON s.id=w.screen_id
		LEFT JOIN locations l ON l.id=s.location_id`
	if dimension == "group" {
		joins += ` LEFT JOIN screen_group_memberships m ON m.screen_id=w.screen_id
			LEFT JOIN screen_groups g ON g.id=m.screen_group_id`
	}
	args = append(args, limit, offset)
	rows, err := r.db.Query(ctx, `
		SELECT `+expressions[0]+`,`+expressions[1]+`,
			COALESCE(SUM(`+expectedClippedMS+`) FILTER (WHERE `+measurableFilter+`),0),
			COALESCE(SUM(w.confirmed_duration_ms) FILTER (WHERE `+measurableFilter+`),0),
			count(*),
			count(*) FILTER (WHERE w.match_status='started_late'),
			count(*) FILTER (WHERE w.match_status='ended_early'),
			count(*) FILTER (WHERE w.match_status='never_started'),
			count(*) FILTER (WHERE w.match_status='screen_offline'),
			COALESCE((array_agg(w.match_status ORDER BY `+expectedClippedMS+` DESC)
			          FILTER (WHERE w.match_status IN('never_started','screen_offline','failed','partial','started_late','ended_early')))[1],'')
		FROM expected_playback_windows w
		`+joins+`
		WHERE `+where+`
		GROUP BY 1,2 ORDER BY 3 DESC,2,1 LIMIT $`+strconv.Itoa(len(args)-1)+` OFFSET $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	groups := []ComplianceGroup{}
	for rows.Next() {
		var item ComplianceGroup
		if err := rows.Scan(&item.Key, &item.Label, &item.MeasurableExpectedMS, &item.ConfirmedMS,
			&item.Windows, &item.LateStarts, &item.EarlyEndings, &item.NeverStarted,
			&item.OfflineMisses, &item.TopFailureReason); err != nil {
			return nil, err
		}
		item.MissedMS = max(0, item.MeasurableExpectedMS-item.ConfirmedMS)
		item.CompliancePercent = CompliancePercent(item.ConfirmedMS, item.MeasurableExpectedMS)
		groups = append(groups, item)
	}
	return groups, rows.Err()
}

// CompliancePercent is nil when nothing measurable was expected. Reporting 0%
// would say every expected play was missed, when in fact none was expected.
func CompliancePercent(confirmed, expected int64) *float64 {
	if expected <= 0 {
		return nil
	}
	value := float64(confirmed) / float64(expected) * 100
	if value > 100 {
		// Playback beyond the window is still only full coverage of it.
		value = 100
	}
	return &value
}
