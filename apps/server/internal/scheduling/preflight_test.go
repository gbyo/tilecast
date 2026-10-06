package scheduling

import (
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

func weekly(tz, start, end string, days ...int) Schedule {
	return Schedule{
		Type: Weekly, Timezone: tz, Enabled: true,
		DailyStart: p(start), DailyEnd: p(end), DaysOfWeek: days,
	}
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestNextIntervalWeeklyUsesTheScheduleTimezone(t *testing.T) {
	s := weekly("America/Chicago", "07:15", "08:15", 1, 2, 3, 4, 5)
	// Monday 20:00 UTC is Monday 15:00 in Chicago, after that day's window.
	got, ok := NextInterval(s, mustTime(t, "2026-10-05T20:00:00Z"))
	if !ok {
		t.Fatal("no interval")
	}
	if want := mustTime(t, "2026-10-06T12:15:00Z"); !got.Start.Equal(want) {
		t.Fatalf("start = %s, want %s", got.Start, want)
	}
	if want := mustTime(t, "2026-10-06T13:15:00Z"); !got.End.Equal(want) {
		t.Fatalf("end = %s, want %s", got.End, want)
	}
}

func TestNextIntervalPrefersTheOccurrenceInProgress(t *testing.T) {
	s := weekly("UTC", "09:00", "17:00", 1, 2, 3, 4, 5)
	got, ok := NextInterval(s, mustTime(t, "2026-10-06T10:30:00Z"))
	if !ok || !got.Start.Equal(mustTime(t, "2026-10-06T09:00:00Z")) {
		t.Fatalf("got %v %v", got, ok)
	}
}

func TestNextIntervalOvernightWindowSpansMidnight(t *testing.T) {
	s := weekly("UTC", "22:00", "02:00", 5) // Friday night
	// Saturday 01:00 UTC is still inside Friday's window.
	got, ok := NextInterval(s, mustTime(t, "2026-10-10T01:00:00Z"))
	if !ok || !got.Start.Equal(mustTime(t, "2026-10-09T22:00:00Z")) || !got.End.Equal(mustTime(t, "2026-10-10T02:00:00Z")) {
		t.Fatalf("got %v %v", got, ok)
	}
}

func TestNextIntervalSpringForwardSkipsTheMissingHour(t *testing.T) {
	// 02:30 does not exist in New York on 2026-03-08; the engine starts the
	// window at the first valid local time.
	s := weekly("America/New_York", "02:30", "03:30", 0)
	got, ok := NextInterval(s, mustTime(t, "2026-03-08T00:00:00Z"))
	if !ok || !got.Start.Equal(mustTime(t, "2026-03-08T07:00:00Z")) || !got.End.Equal(mustTime(t, "2026-03-08T07:30:00Z")) {
		t.Fatalf("got %v %v", got, ok)
	}
}

func TestNextIntervalFallBackUsesEarlierStartAndLaterEnd(t *testing.T) {
	// 01:30 and 01:45 happen twice in New York on 2026-11-01.
	s := weekly("America/New_York", "01:30", "01:45", 0)
	got, ok := NextInterval(s, mustTime(t, "2026-11-01T00:00:00Z"))
	if !ok || !got.Start.Equal(mustTime(t, "2026-11-01T05:30:00Z")) || !got.End.Equal(mustTime(t, "2026-11-01T06:45:00Z")) {
		t.Fatalf("got %v %v", got, ok)
	}
}

func TestNextIntervalFindsADateRangeThatOpensLater(t *testing.T) {
	s := weekly("UTC", "09:00", "10:00", 1, 2, 3, 4, 5, 6, 0)
	s.StartDate, s.EndDate = p("2027-01-04"), p("2027-01-10")
	got, ok := NextInterval(s, mustTime(t, "2026-10-06T00:00:00Z"))
	if !ok || !got.Start.Equal(mustTime(t, "2027-01-04T09:00:00Z")) {
		t.Fatalf("got %v %v", got, ok)
	}
	if _, ok = NextInterval(s, mustTime(t, "2027-02-01T00:00:00Z")); ok {
		t.Fatal("an ended date range still has an occurrence")
	}
}

func TestNextIntervalOneTime(t *testing.T) {
	start, end := mustTime(t, "2026-10-31T23:00:00Z"), mustTime(t, "2026-11-01T05:00:00Z")
	s := Schedule{Type: OneTime, Timezone: "America/New_York", OneTimeStart: &start, OneTimeEnd: &end}
	if got, ok := NextInterval(s, mustTime(t, "2026-10-06T00:00:00Z")); !ok || !got.Start.Equal(start) {
		t.Fatalf("upcoming: %v %v", got, ok)
	}
	if _, ok := NextInterval(s, end); ok {
		t.Fatal("a finished window has no next interval")
	}
}

func screensNamed(count int, direct bool) []preflightScreen {
	out := make([]preflightScreen, count)
	for i := range out {
		out[i] = preflightScreen{ID: uuid.New(), Name: fmt.Sprintf("Screen %02d", i), Platform: "linux", Direct: direct}
	}
	return out
}

func competitorOn(name string, priority int, base Schedule, screens []preflightScreen, direct bool) preflightCompetitor {
	base.ID, base.Priority = uuid.New(), priority
	reach := map[uuid.UUID]bool{}
	for _, screen := range screens {
		reach[screen.ID] = direct
	}
	return preflightCompetitor{Schedule: base, Name: name, PresentationType: "playlist", Screens: reach}
}

func TestPreflightWinsEverywhereWithoutCompetitors(t *testing.T) {
	screens := screensNamed(4, false)
	draft := weekly("UTC", "09:00", "10:00", 2)
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screens, nil)
	if got.TargetScreenCount != 4 || got.WinningScreenCount != 4 || got.LosingScreenCount != 0 {
		t.Fatalf("%+v", got)
	}
	if got.CheckedAt == nil || !got.CheckedAt.Equal(mustTime(t, "2026-10-06T09:00:00Z")) || got.Running {
		t.Fatalf("checked at %v running=%v", got.CheckedAt, got.Running)
	}
	if len(got.Competitors) != 0 || len(got.Screens) != 0 || len(got.Issues) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightHigherPriorityWinsOnlyWhereItReaches(t *testing.T) {
	screens := screensNamed(3, false)
	draft := weekly("UTC", "09:00", "10:00", 2)
	rival := competitorOn("Friday Night Lights", 100, weekly("UTC", "08:00", "11:00", 2), screens[:2], false)
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screens, []preflightCompetitor{rival})
	if got.WinningScreenCount != 1 || got.LosingScreenCount != 2 {
		t.Fatalf("%+v", got)
	}
	if len(got.Competitors) != 1 {
		t.Fatalf("competitors = %+v", got.Competitors)
	}
	c := got.Competitors[0]
	if c.AffectedScreenCount != 2 || c.OutranksDraftScreenCount != 2 || c.Reason != ReasonLowerPriority {
		t.Fatalf("%+v", c)
	}
	if len(got.Screens) != 2 || got.Screens[0].Outcome != OutcomeSuperseded || got.Screens[0].WinnerName != "Friday Night Lights" || got.Screens[0].Reason != ReasonLowerPriority {
		t.Fatalf("%+v", got.Screens)
	}
}

func TestPreflightLowerPriorityCompetitorLosesToTheDraft(t *testing.T) {
	screens := screensNamed(2, false)
	draft := weekly("UTC", "09:00", "10:00", 2)
	draft.Priority = 100
	rival := competitorOn("Normal", 0, weekly("UTC", "09:00", "10:00", 2), screens, false)
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screens, []preflightCompetitor{rival})
	if got.WinningScreenCount != 2 || got.Competitors[0].OutranksDraftScreenCount != 0 || got.Competitors[0].Reason != ReasonLowerPriority {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightDirectTargetBeatsGroupTargetAtEqualPriority(t *testing.T) {
	direct := screensNamed(1, true)
	grouped := screensNamed(1, false)
	screens := append(append([]preflightScreen{}, direct...), grouped...)
	draft := weekly("UTC", "09:00", "10:00", 2)
	// Already running, and the rival started later, so the engine's start-time
	// tie-break favours it wherever specificity does not decide first.
	rival := competitorOn("Group schedule", 0, weekly("UTC", "09:30", "10:00", 2), screens, false)
	got := evaluatePreflight(mustTime(t, "2026-10-06T09:45:00Z"), draft, true, screens, []preflightCompetitor{rival})
	if !got.Running {
		t.Fatal("expected a running occurrence")
	}
	if got.WinningScreenCount != 1 || got.LosingScreenCount != 1 {
		t.Fatalf("%+v", got)
	}
	if got.Screens[0].ScreenID != grouped[0].ID || got.Screens[0].Reason != ReasonEarlierStart {
		t.Fatalf("%+v", got.Screens)
	}
}

func TestPreflightEqualPriorityTiesFollowTheEngine(t *testing.T) {
	screens := screensNamed(1, false)
	draft := weekly("UTC", "09:00", "10:00", 2)
	rival := competitorOn("Same", 0, weekly("UTC", "09:00", "10:00", 2), screens, false)
	rival.Schedule.ID = uuid.MustParse("00000000-0000-0000-0000-000000000001")
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screens, []preflightCompetitor{rival})
	// A draft with no saved ID sorts first, so a full tie keeps the draft.
	if got.WinningScreenCount != 1 || got.Competitors[0].Reason != ReasonStableID {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightSimulatesADisabledDraftAsEnabled(t *testing.T) {
	screens := screensNamed(1, false)
	draft := weekly("UTC", "09:00", "10:00", 2)
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, false, screens, nil)
	if got.DraftEnabled || got.WinningScreenCount != 1 {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightReportsUnsupportedDisplayControlScreens(t *testing.T) {
	screens := screensNamed(3, false)
	screens[1].Platform = "android"
	draft := weekly("UTC", "09:00", "10:00", 2)
	draft.DisplayAction = &displaycontrol.Action{Type: displaycontrol.CommandPowerOn}
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screens, nil)
	if got.UnsupportedScreenCount != 1 || got.WinningScreenCount != 2 || got.LosingScreenCount != 0 {
		t.Fatalf("%+v", got)
	}
	if len(got.Issues) != 1 || got.Issues[0].Code != IssueDisplayControlUnsupported || got.Issues[0].Severity != SeverityBlocking || got.Issues[0].ScreenCount != 1 {
		t.Fatalf("%+v", got.Issues)
	}
	if len(got.Screens) != 1 || got.Screens[0].Outcome != OutcomeUnsupported || got.Screens[0].ScreenID != screens[1].ID {
		t.Fatalf("%+v", got.Screens)
	}
}

func TestPreflightNeverRunsAgain(t *testing.T) {
	start, end := mustTime(t, "2026-01-01T00:00:00Z"), mustTime(t, "2026-01-01T01:00:00Z")
	draft := Schedule{Type: OneTime, Timezone: "UTC", OneTimeStart: &start, OneTimeEnd: &end}
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screensNamed(2, false), nil)
	if got.CheckedAt != nil || len(got.Issues) != 1 || got.Issues[0].Code != IssueNoUpcomingRun || got.Issues[0].Severity != SeverityWarning {
		t.Fatalf("%+v", got)
	}
	if got.TargetScreenCount != 2 {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightWithNoTargetsHasNothingToCheck(t *testing.T) {
	draft := weekly("UTC", "09:00", "10:00", 2)
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, nil, nil)
	if got.TargetScreenCount != 0 || got.WinningScreenCount != 0 || got.LosingScreenCount != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightBoundsDetailButKeepsExactCounts(t *testing.T) {
	screens := screensNamed(preflightScreenDetailLimit+70, false)
	draft := weekly("UTC", "09:00", "10:00", 2)
	rival := competitorOn("Everywhere", 500, weekly("UTC", "09:00", "10:00", 2), screens, false)
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screens, []preflightCompetitor{rival})
	if got.LosingScreenCount != len(screens) || got.WinningScreenCount != 0 {
		t.Fatalf("%+v", got)
	}
	if len(got.Screens) != preflightScreenDetailLimit || !got.ScreensTruncated {
		t.Fatalf("details = %d truncated=%v", len(got.Screens), got.ScreensTruncated)
	}
	if got.Competitors[0].AffectedScreenCount != len(screens) {
		t.Fatalf("%+v", got.Competitors[0])
	}
}

func TestPreflightIgnoresCompetitorsThatAreNotRunningAtTheCheckedInstant(t *testing.T) {
	screens := screensNamed(1, false)
	draft := weekly("UTC", "09:00", "10:00", 2)
	later := competitorOn("Afternoon", 900, weekly("UTC", "15:00", "16:00", 2), screens, false)
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screens, []preflightCompetitor{later})
	if got.WinningScreenCount != 1 || len(got.Competitors) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightOnATimezoneAheadOfTheServer(t *testing.T) {
	// 09:00 in Auckland on Tuesday 6 Oct is Monday 5 Oct 20:00 UTC (NZDT, +13).
	draft := weekly("Pacific/Auckland", "09:00", "10:00", 2)
	got := evaluatePreflight(mustTime(t, "2026-10-05T12:00:00Z"), draft, true, screensNamed(1, false), nil)
	if got.CheckedAt == nil || !got.CheckedAt.Equal(mustTime(t, "2026-10-05T20:00:00Z")) {
		t.Fatalf("checked at %v", got.CheckedAt)
	}
}
