package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/activityreport"
)

// Expected playback is what should have been on a screen, recorded when the
// selection became effective. It is deliberately not reconstructed from
// current configuration: schedules and assignments change, and reporting last
// month against this month's plan would measure compliance with a plan that
// never existed then.

// The match vocabulary and the window judgement are owned by activityreport,
// which the compliance report and the activity.read@1 service share.
const (
	matchConfirmed        = activityreport.MatchConfirmed
	matchStartedLate      = activityreport.MatchStartedLate
	matchEndedEarly       = activityreport.MatchEndedEarly
	matchPartial          = activityreport.MatchPartial
	matchFailed           = activityreport.MatchFailed
	matchNeverStarted     = activityreport.MatchNeverStarted
	matchScreenOffline    = activityreport.MatchScreenOffline
	matchTakeoverOverride = activityreport.MatchTakeoverOverride
	matchCancelled        = activityreport.MatchCancelled
	matchNotMeasurable    = activityreport.MatchNotMeasurable
)

type expectedWindowInput struct {
	ScreenID         uuid.UUID
	PresentationType string
	PresentationID   string
	PresentationRev  string
	ManifestVersion  *int64
	ScheduleID       string
	TriggerSource    string
	Timezone         string
	TakeoverID       *uuid.UUID
	ContentType      string
	ContentID        string
}

// openExpectedWindow supersedes whatever was expected before and records what
// is expected from now on. Called when a selection becomes effective, so the
// expectation is written at the moment it becomes true rather than inferred
// later.
func openExpectedWindow(ctx context.Context, tx pgx.Tx, at time.Time, reason string, input expectedWindowInput) error {
	if err := supersedeExpectedWindows(ctx, tx, input.ScreenID, at, reason); err != nil {
		return err
	}
	if input.TriggerSource == "" {
		input.TriggerSource = "direct"
	}
	if input.Timezone == "" {
		input.Timezone = "UTC"
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO expected_playback_windows(
			id,screen_id,presentation_type,presentation_id,presentation_revision,manifest_version,
			schedule_id,trigger_source,expected_start,timezone,overridden_by_takeover_id,
			expected_content_type,expected_content_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		uuid.New(), input.ScreenID, input.PresentationType, input.PresentationID, input.PresentationRev,
		input.ManifestVersion, input.ScheduleID, input.TriggerSource, at, input.Timezone,
		input.TakeoverID, input.ContentType, input.ContentID)
	return err
}

// supersedeExpectedWindows closes the open window for a screen. The window is
// never edited: closing it preserves exactly what was expected, and the reason
// is what later decides whether the unplayed time was a miss.
func supersedeExpectedWindows(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, at time.Time, reason string) error {
	_, err := tx.Exec(ctx, `
		UPDATE expected_playback_windows
		SET expected_end=GREATEST(expected_start,$2),superseded_at=$2,superseded_reason=$3
		WHERE screen_id=$1 AND superseded_at IS NULL AND expected_end IS NULL`,
		screenID, at, reason)
	return err
}

// evaluateExpectedWindows judges every closed window that has not been
// judged yet. See activityreport.EvaluateExpectedWindows.
func (s *server) evaluateExpectedWindows(ctx context.Context, screenID *uuid.UUID) error {
	return activityreport.New(s.db).EvaluateExpectedWindows(ctx, time.Now(), screenID)
}

// syncExpectedWindowsFromStatus keeps the expected model in step with what the
// server currently believes each screen should be playing. It runs on the
// heartbeat path, which is the one signal every player sends, so an expectation
// exists even for a player whose event vocabulary the server does not recognise.
func (s *server) syncExpectedWindowFromStatus(r *http.Request, tx pgx.Tx, screenID uuid.UUID, status heartbeatActivityState, now time.Time) error {
	ctx := activityContextWithoutCancel(r.Context())

	// What the server believes should be playing, from the status authority.
	presentationID, presentationType := "", ""
	if status.ScheduleID != nil {
		presentationID, presentationType = status.ScheduleID.String(), "schedule"
	}
	trigger := status.SelectionSource
	if trigger == "" {
		trigger = "direct"
	}
	scheduleID := ""
	if status.ScheduleID != nil {
		scheduleID = status.ScheduleID.String()
	}

	var open struct {
		ID         uuid.UUID
		Schedule   string
		Manifest   *int64
		TakeoverID *uuid.UUID
		Trigger    string
	}
	err := tx.QueryRow(ctx, `
		SELECT id,schedule_id,manifest_version,overridden_by_takeover_id,trigger_source
		FROM expected_playback_windows
		WHERE screen_id=$1 AND superseded_at IS NULL AND expected_end IS NULL
		ORDER BY expected_start DESC LIMIT 1`, screenID).Scan(
		&open.ID, &open.Schedule, &open.Manifest, &open.TakeoverID, &open.Trigger)
	hasOpen := err == nil

	// Playback that is not supposed to happen closes the window rather than
	// opening one, so off-hours and disabled time never become missed playback.
	if !playbackExpected(fleetScreenSignals{
		PlaybackState:   status.PlaybackState,
		PlaybackDisable: status.PlaybackState == "disabled",
		ActiveManifest:  status.ManifestVersion,
	}) {
		if hasOpen {
			return supersedeExpectedWindows(ctx, tx, screenID, now, suppressionReason(status))
		}
		return nil
	}

	changed := !hasOpen ||
		open.Schedule != scheduleID ||
		!sameInt64(open.Manifest, status.ManifestVersion) ||
		!sameUUID(open.TakeoverID, status.TakeoverID) ||
		open.Trigger != trigger
	if !changed {
		return nil
	}
	return openExpectedWindow(ctx, tx, now, expectationChangeReason(open.Schedule, scheduleID, status), expectedWindowInput{
		ScreenID:         screenID,
		PresentationType: presentationType,
		PresentationID:   presentationID,
		ManifestVersion:  status.ManifestVersion,
		ScheduleID:       scheduleID,
		TriggerSource:    trigger,
		TakeoverID:       status.TakeoverID,
	})
}

// suppressionReason names why normal playback is not expected right now, from
// the closed set the schema allows.
func suppressionReason(status heartbeatActivityState) string {
	switch normalizePlaybackState(status.PlaybackState) {
	case "off_hours":
		return "active_hours_changed"
	case "disabled":
		return "screen_disabled"
	default:
		return "deployment_suppressed_playback"
	}
}

func expectationChangeReason(previousSchedule, nextSchedule string, status heartbeatActivityState) string {
	switch {
	case status.TakeoverID != nil:
		return "takeover_started"
	case previousSchedule != "" && nextSchedule == "":
		return "schedule_ended"
	case nextSchedule != "" && previousSchedule != nextSchedule:
		return "schedule_started"
	case previousSchedule == nextSchedule && nextSchedule == "":
		return "assignment_changed"
	default:
		return "manifest_changed"
	}
}
