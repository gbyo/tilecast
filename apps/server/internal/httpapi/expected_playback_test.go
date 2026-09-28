package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

// insertWindow writes a closed expected window directly, so a test can state
// exactly what was expected without driving a whole heartbeat sequence.
func insertWindow(t *testing.T, env activityTestEnvironment, start, end time.Time, apply func(*expectedWindowRow)) uuid.UUID {
	t.Helper()
	row := expectedWindowRow{ID: uuid.New(), Trigger: "schedule"}
	if apply != nil {
		apply(&row)
	}
	if _, err := env.pool.Exec(context.Background(), `
		INSERT INTO expected_playback_windows(
			id,screen_id,presentation_type,presentation_id,schedule_id,trigger_source,
			expected_start,expected_end,superseded_at,superseded_reason,overridden_by_takeover_id,timezone)
		VALUES($1,$2,'playlist','playlist-a',$3,$4,$5,$6,$6,$7,$8,'UTC')`,
		row.ID, env.screenID, row.ScheduleID, row.Trigger, start, end,
		nullableString(row.SupersededReason), row.TakeoverID); err != nil {
		t.Fatal(err)
	}
	return row.ID
}

type expectedWindowRow struct {
	ID               uuid.UUID
	ScheduleID       string
	Trigger          string
	SupersededReason string
	TakeoverID       *uuid.UUID
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func insertRootSession(t *testing.T, env activityTestEnvironment, start, end time.Time, result string) {
	t.Helper()
	if _, err := env.pool.Exec(context.Background(), `
		INSERT INTO playback_sessions(id,screen_id,activity_session_id,started_at,ended_at,actual_duration_ms,result,session_type)
		VALUES($1,$2,$3,$4,$5,$6,$7,'presentation')`,
		uuid.New(), env.screenID, uuid.NewString(), start, end,
		end.Sub(start).Milliseconds(), result); err != nil {
		t.Fatal(err)
	}
}

func windowStatus(t *testing.T, env activityTestEnvironment, id uuid.UUID) (string, int64) {
	t.Helper()
	var status string
	var confirmed int64
	if err := env.pool.QueryRow(context.Background(),
		`SELECT match_status,confirmed_duration_ms FROM expected_playback_windows WHERE id=$1`,
		id).Scan(&status, &confirmed); err != nil {
		t.Fatal(err)
	}
	return status, confirmed
}

func TestExpectedWindowMatchStatuses(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		// Every window is in the past: an unfinished window is deliberately not
		// judged, so a future one would stay unevaluated and prove nothing.
		base := time.Now().UTC().Add(-40 * time.Hour).Truncate(time.Second)
		hour := time.Hour

		takeoverID := createTakeoverFixture(t, env)

		cases := []struct {
			name    string
			offset  time.Duration
			prepare func(start, end time.Time)
			window  func(*expectedWindowRow)
			want    string
		}{
			{
				name: "played for the whole window", offset: 0,
				prepare: func(start, end time.Time) { insertRootSession(t, env, start, end, "completed") },
				want:    matchConfirmed,
			},
			{
				name: "started well after the window opened", offset: 2 * hour,
				prepare: func(start, end time.Time) {
					insertRootSession(t, env, start.Add(20*time.Minute), end, "completed")
				},
				want: matchStartedLate,
			},
			{
				name: "stopped well before the window closed", offset: 4 * hour,
				prepare: func(start, end time.Time) {
					insertRootSession(t, env, start, end.Add(-20*time.Minute), "completed")
				},
				want: matchEndedEarly,
			},
			{
				name: "missing at both ends", offset: 6 * hour,
				prepare: func(start, end time.Time) {
					insertRootSession(t, env, start.Add(15*time.Minute), end.Add(-15*time.Minute), "completed")
				},
				want: matchPartial,
			},
			{
				name: "playback failed", offset: 8 * hour,
				prepare: func(start, end time.Time) { insertRootSession(t, env, start, end, "failed") },
				want:    matchFailed,
			},
			{
				name: "nothing played and the screen was up", offset: 10 * hour,
				prepare: func(start, end time.Time) {},
				want:    matchNeverStarted,
			},
			{
				name: "nothing played because the screen was offline", offset: 12 * hour,
				prepare: func(start, end time.Time) {
					if _, err := env.pool.Exec(context.Background(), `
						INSERT INTO screen_state_intervals(id,screen_id,state,started_at,ended_at)
						VALUES($1,$2,'offline',$3,$4)`, uuid.New(), env.screenID, start, end); err != nil {
						t.Fatal(err)
					}
				},
				want: matchScreenOffline,
			},
			{
				name: "a takeover replaced normal playback", offset: 14 * hour,
				prepare: func(start, end time.Time) {},
				window:  func(row *expectedWindowRow) { row.TakeoverID = &takeoverID },
				want:    matchTakeoverOverride,
			},
			{
				name: "playback was intentionally stopped", offset: 16 * hour,
				prepare: func(start, end time.Time) {},
				window:  func(row *expectedWindowRow) { row.SupersededReason = "screen_disabled" },
				want:    matchCancelled,
			},
			{
				name: "the window was too short to judge", offset: 18 * hour,
				prepare: func(start, end time.Time) {},
				want:    matchNotMeasurable,
			},
		}

		for _, testCase := range cases {
			t.Run(testCase.name, func(t *testing.T) {
				start := base.Add(testCase.offset)
				end := start.Add(hour)
				if testCase.want == matchNotMeasurable {
					end = start.Add(30 * time.Second)
				}
				testCase.prepare(start, end)
				id := insertWindow(t, env, start, end, testCase.window)

				if err := env.server.evaluateExpectedWindows(context.Background(), &env.screenID); err != nil {
					t.Fatal(err)
				}
				if got, _ := windowStatus(t, env, id); got != testCase.want {
					t.Fatalf("match status = %q, want %q", got, testCase.want)
				}
			})
		}
	})
}

// A window still in force has not finished. Judging it early would report a
// screen as having missed playback that is still running.
func TestOpenExpectedWindowsAreNotJudged(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		id := uuid.New()
		if _, err := env.pool.Exec(context.Background(), `
			INSERT INTO expected_playback_windows(id,screen_id,expected_start,trigger_source)
			VALUES($1,$2,now()-interval '10 minutes','schedule')`, id, env.screenID); err != nil {
			t.Fatal(err)
		}
		if err := env.server.evaluateExpectedWindows(context.Background(), &env.screenID); err != nil {
			t.Fatal(err)
		}
		var evaluated *time.Time
		if err := env.pool.QueryRow(context.Background(),
			`SELECT match_evaluated_at FROM expected_playback_windows WHERE id=$1`, id).Scan(&evaluated); err != nil {
			t.Fatal(err)
		}
		if evaluated != nil {
			t.Fatal("an open window must not be judged before it closes")
		}
	})
}

func readCompliance(t *testing.T, env activityTestEnvironment, query string) complianceReport {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/compliance"+query, nil)
	request = requestWithTestPrincipal(request, env.owner)
	response := httptest.NewRecorder()
	env.server.playbackCompliance(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("compliance status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data complianceReport `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

// The central claim of the compliance metric: intentional non-playback is not
// missed playback, and must not drag the percentage down.
func TestComplianceExcludesIntentionalNonPlayback(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		base := time.Now().UTC().Add(-8 * time.Hour).Truncate(time.Second)
		hour := time.Hour

		// One hour expected and fully played.
		played := base
		insertRootSession(t, env, played, played.Add(hour), "completed")
		insertWindow(t, env, played, played.Add(hour), nil)

		// One hour expected and never played: a real miss.
		missed := base.Add(2 * hour)
		insertWindow(t, env, missed, missed.Add(hour), nil)

		// One hour deliberately stopped, and one hour taken by a takeover.
		// Neither is playback that went missing.
		cancelled := base.Add(4 * hour)
		insertWindow(t, env, cancelled, cancelled.Add(hour), func(row *expectedWindowRow) {
			row.SupersededReason = "active_hours_changed"
		})
		takeoverID := createTakeoverFixture(t, env)
		overridden := base.Add(6 * hour)
		insertWindow(t, env, overridden, overridden.Add(hour), func(row *expectedWindowRow) {
			row.TakeoverID = &takeoverID
		})

		report := readCompliance(t, env, "?range=30d")
		if report.MeasurableExpectedMS != (2 * hour).Milliseconds() {
			t.Fatalf("measurable expected = %dms, want two hours: the cancelled hour is excluded", report.MeasurableExpectedMS)
		}
		if report.ConfirmedMS != hour.Milliseconds() {
			t.Fatalf("confirmed = %dms, want one hour", report.ConfirmedMS)
		}
		if report.MissedMS != hour.Milliseconds() {
			t.Fatalf("missed = %dms, want one hour", report.MissedMS)
		}
		if report.CompliancePercent == nil || *report.CompliancePercent != 50 {
			t.Fatalf("compliance = %v, want 50%%", report.CompliancePercent)
		}
		// The excluded time is reported rather than silently improving the score.
		if report.CancelledMS != hour.Milliseconds() {
			t.Fatalf("cancelled = %dms, want the excluded hour to be visible", report.CancelledMS)
		}
		if report.TakeoverOverriddenMS != hour.Milliseconds() {
			t.Fatalf("takeover overridden = %dms, want the excluded hour to be visible", report.TakeoverOverriddenMS)
		}
		if report.NeverStarted != 1 {
			t.Fatalf("never started = %d, want 1", report.NeverStarted)
		}
	})
}

// Nothing expected is not the same as everything missed.
func TestComplianceReportsNoDataRatherThanZeroPercent(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		report := readCompliance(t, env, "?range=24h")
		if report.CompliancePercent != nil {
			t.Fatalf("compliance = %v, want no percentage when nothing was expected", *report.CompliancePercent)
		}
		if report.MeasurableExpectedMS != 0 {
			t.Fatalf("measurable expected = %d, want 0", report.MeasurableExpectedMS)
		}
	})
}

func TestComplianceDrillDowns(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		start := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
		insertRootSession(t, env, start, start.Add(30*time.Minute), "completed")
		insertWindow(t, env, start, start.Add(time.Hour), func(row *expectedWindowRow) {
			row.ScheduleID = "schedule-a"
		})

		for _, dimension := range []string{"screen", "location", "group", "presentation", "schedule", "date", "reason"} {
			report := readCompliance(t, env, "?range=7d&dimension="+dimension)
			if report.Dimension != dimension {
				t.Fatalf("dimension = %q, want %q", report.Dimension, dimension)
			}
			if len(report.Breakdown) == 0 {
				t.Fatalf("%s breakdown is empty", dimension)
			}
		}

		byScreen := readCompliance(t, env, "?range=7d&dimension=screen")
		if byScreen.Breakdown[0].Label != "Cafeteria TV" {
			t.Fatalf("screen breakdown label = %q", byScreen.Breakdown[0].Label)
		}
		// Half the expected hour was played, and the reason is named rather
		// than left for the reader to work out.
		if byScreen.Breakdown[0].TopFailureReason == "" {
			t.Fatal("a partly-missed window should name why time went missing")
		}

		bySchedule := readCompliance(t, env, "?range=7d&dimension=schedule")
		if bySchedule.Breakdown[0].Key != "schedule-a" {
			t.Fatalf("schedule breakdown key = %q", bySchedule.Breakdown[0].Key)
		}
	})
}

// Compliance must be measured against the plan that was in force at the time,
// which is the entire reason expectations are materialized rather than derived.
func TestExpectationsSurviveALaterConfigurationChange(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		start := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
		insertRootSession(t, env, start, start.Add(time.Hour), "completed")
		id := insertWindow(t, env, start, start.Add(time.Hour), func(row *expectedWindowRow) {
			row.ScheduleID = "schedule-morning"
		})

		// The schedule is replaced afterwards, as schedules are.
		if _, err := env.pool.Exec(ctx, `DELETE FROM schedules WHERE id IS NOT NULL`); err != nil {
			// The fixture may have no schedules; the point stands either way.
			t.Logf("no schedules to remove: %v", err)
		}

		if err := env.server.evaluateExpectedWindows(ctx, &env.screenID); err != nil {
			t.Fatal(err)
		}
		var scheduleID string
		var status string
		if err := env.pool.QueryRow(ctx,
			`SELECT schedule_id,match_status FROM expected_playback_windows WHERE id=$1`, id).
			Scan(&scheduleID, &status); err != nil {
			t.Fatal(err)
		}
		if scheduleID != "schedule-morning" {
			t.Fatalf("the recorded expectation changed to %q after the schedule was replaced", scheduleID)
		}
		if status != matchConfirmed {
			t.Fatalf("match status = %q, want the historical plan still to be judged confirmed", status)
		}
	})
}

// createTakeoverFixture writes the minimum a takeover needs so the override
// branch can be exercised end to end rather than only in isolation.
func createTakeoverFixture(t *testing.T, env activityTestEnvironment) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var organizationID uuid.UUID
	if err := env.pool.QueryRow(ctx, `SELECT organization_id FROM screens WHERE id=$1`, env.screenID).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	playlistID := uuid.New()
	if _, err := env.pool.Exec(ctx,
		`INSERT INTO playlists(id,organization_id,name) VALUES($1,$2,'Takeover playlist')`,
		playlistID, organizationID); err != nil {
		t.Fatal(err)
	}
	takeoverID := uuid.New()
	if _, err := env.pool.Exec(ctx, `
		INSERT INTO takeovers(id,organization_id,name,playlist_id,status,expires_at)
		VALUES($1,$2,'Fire drill',$3,'active',now()+interval '1 hour')`,
		takeoverID, organizationID, playlistID); err != nil {
		t.Fatal(err)
	}
	return takeoverID
}
