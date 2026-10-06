package scheduling

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Preflight inspects a draft schedule without saving it. It answers one
// question for every screen the draft would reach: at the draft's next
// occurrence, would this schedule win? It reports structured data only; the
// dashboard owns the wording.

const (
	preflightScreenDetailLimit = 50
	preflightCompetitorLimit   = 25
)

type PreflightIssueCode string

const (
	// IssueDisplayControlUnsupported blocks saving: a targeted screen's Player
	// cannot run display-control actions.
	IssueDisplayControlUnsupported PreflightIssueCode = "display_control_unsupported"
	// IssueNoUpcomingRun means the draft never runs again (a past one-time
	// window, an ended date range), so there is nothing to compare.
	IssueNoUpcomingRun PreflightIssueCode = "no_upcoming_run"
)

type IssueSeverity string

const (
	SeverityBlocking IssueSeverity = "blocking"
	SeverityWarning  IssueSeverity = "warning"
)

type PreflightIssue struct {
	Code        PreflightIssueCode `json:"code"`
	Severity    IssueSeverity      `json:"severity"`
	ScreenCount int                `json:"screenCount,omitempty"`
}

type PreflightOutcome string

const (
	OutcomeSuperseded  PreflightOutcome = "superseded"
	OutcomeUnsupported PreflightOutcome = "unsupported"
)

// PreflightScreen is one screen where the draft does not simply win. Wins are
// counted, never listed, so the list stays small for a large fleet.
type PreflightScreen struct {
	ScreenID         uuid.UUID        `json:"screenId"`
	Name             string           `json:"name"`
	Outcome          PreflightOutcome `json:"outcome"`
	Reason           SelectionReason  `json:"reason,omitempty"`
	WinnerScheduleID *uuid.UUID       `json:"winnerScheduleId,omitempty"`
	WinnerName       string           `json:"winnerName,omitempty"`
}

// PreflightCompetitor is another enabled schedule that is running at the
// checked instant on at least one of the draft's screens.
type PreflightCompetitor struct {
	ScheduleID       uuid.UUID `json:"scheduleId"`
	Name             string    `json:"name"`
	Priority         int       `json:"priority"`
	PresentationType string    `json:"presentationType"`
	// AffectedScreenCount is where both schedules run at the checked instant.
	AffectedScreenCount int `json:"affectedScreenCount"`
	// OutranksDraftScreenCount is how many of those screens show this schedule
	// instead of the draft. The rest show the draft.
	OutranksDraftScreenCount int `json:"outranksDraftScreenCount"`
	// Reason is the first decisive rule between the two: why the draft loses
	// when this schedule outranks it on most screens, otherwise why it wins.
	Reason SelectionReason `json:"reason"`
}

type PreflightResult struct {
	// DraftEnabled is the draft's own state. The check always simulates it as
	// enabled, since a disabled schedule would otherwise never compete.
	DraftEnabled bool `json:"draftEnabled"`
	// CheckedAt is the instant evaluated: the start of the next occurrence, or
	// the current time when an occurrence is already running.
	CheckedAt *time.Time `json:"checkedAt,omitempty"`
	// Running is true when CheckedAt is the current time inside an occurrence.
	Running                bool `json:"running"`
	TargetScreenCount      int  `json:"targetScreenCount"`
	WinningScreenCount     int  `json:"winningScreenCount"`
	LosingScreenCount      int  `json:"losingScreenCount"`
	UnsupportedScreenCount int  `json:"unsupportedScreenCount"`
	// Counts always describe the whole target set; only the lists are bounded.
	Competitors          []PreflightCompetitor `json:"competitors"`
	CompetitorsTruncated bool                  `json:"competitorsTruncated"`
	Screens              []PreflightScreen     `json:"screens"`
	ScreensTruncated     bool                  `json:"screensTruncated"`
	Issues               []PreflightIssue      `json:"issues"`
}

type preflightScreen struct {
	ID       uuid.UUID
	Name     string
	Platform string
	// Direct is true when the screen is itself a target, which the engine
	// counts as more specific than reaching it through a Display Group.
	Direct bool
}

type preflightCompetitor struct {
	Schedule         Schedule
	Name             string
	PresentationType string
	// Screens maps a screen to whether this schedule targets it directly.
	Screens map[uuid.UUID]bool
}

// evaluatePreflight is the pure core of Preflight: no database, no clock.
// draft is simulated as enabled. It applies the engine's own ordering, so the
// answer matches what Players resolve.
func evaluatePreflight(now time.Time, draft Schedule, draftEnabled bool, screens []preflightScreen, competitors []preflightCompetitor) PreflightResult {
	result := PreflightResult{
		DraftEnabled:      draftEnabled,
		TargetScreenCount: len(screens),
		Competitors:       []PreflightCompetitor{},
		Screens:           []PreflightScreen{},
		Issues:            []PreflightIssue{},
	}
	unsupported := make(map[uuid.UUID]bool)
	if draft.DisplayAction != nil {
		for _, screen := range screens {
			if screen.Platform != "linux" {
				unsupported[screen.ID] = true
			}
		}
		result.UnsupportedScreenCount = len(unsupported)
		if len(unsupported) > 0 {
			result.Issues = append(result.Issues, PreflightIssue{Code: IssueDisplayControlUnsupported, Severity: SeverityBlocking, ScreenCount: len(unsupported)})
		}
	}

	next, ok := NextInterval(draft, now)
	if !ok {
		result.Issues = append(result.Issues, PreflightIssue{Code: IssueNoUpcomingRun, Severity: SeverityWarning})
		return result
	}
	at := next.Start
	if !at.After(now) {
		at, result.Running = now, true
	}
	result.CheckedAt = &at

	// A schedule's interval at the checked instant does not depend on the
	// screen, so compute it once per competitor rather than once per screen.
	type running struct {
		competitor *preflightCompetitor
		interval   Active
	}
	active := make([]running, 0, len(competitors))
	for i := range competitors {
		if interval, found := ActiveAt(competitors[i].Schedule, at); found {
			active = append(active, running{&competitors[i], interval})
		}
	}
	type tally struct {
		affected, outranks int
		outranksReason     SelectionReason
		winsReason         SelectionReason
	}
	tallies := make(map[uuid.UUID]*tally, len(active))
	for _, run := range active {
		tallies[run.competitor.Schedule.ID] = &tally{}
	}

	for _, screen := range screens {
		if unsupported[screen.ID] {
			result.Screens = appendScreen(&result, PreflightScreen{ScreenID: screen.ID, Name: screen.Name, Outcome: OutcomeUnsupported})
			continue
		}
		mine := next
		mine.Schedule.Specificity = specificityOf(screen.Direct)
		contenders := []Active{mine}
		present := []running{}
		for _, run := range active {
			direct, reaches := run.competitor.Screens[screen.ID]
			if !reaches {
				continue
			}
			interval := run.interval
			interval.Schedule.Specificity = specificityOf(direct)
			contenders = append(contenders, interval)
			present = append(present, running{run.competitor, interval})
		}
		for _, run := range present {
			t := tallies[run.competitor.Schedule.ID]
			t.affected++
			if before, reason := precedes(run.interval, mine); before {
				t.outranks++
				t.outranksReason = reason
			} else {
				_, t.winsReason = precedes(mine, run.interval)
			}
		}
		Rank(contenders)
		winner := contenders[0]
		if winner.Schedule.ID == mine.Schedule.ID {
			result.WinningScreenCount++
			continue
		}
		result.LosingScreenCount++
		_, reason := precedes(winner, mine)
		winnerID := winner.Schedule.ID
		entry := PreflightScreen{ScreenID: screen.ID, Name: screen.Name, Outcome: OutcomeSuperseded, Reason: reason, WinnerScheduleID: &winnerID}
		for _, run := range present {
			if run.competitor.Schedule.ID == winnerID {
				entry.WinnerName = run.competitor.Name
				break
			}
		}
		result.Screens = appendScreen(&result, entry)
	}

	for _, run := range active {
		t := tallies[run.competitor.Schedule.ID]
		if t.affected == 0 {
			continue
		}
		reason := t.winsReason
		if t.outranks*2 >= t.affected {
			reason = t.outranksReason
		}
		result.Competitors = append(result.Competitors, PreflightCompetitor{
			ScheduleID: run.competitor.Schedule.ID, Name: run.competitor.Name,
			Priority: run.competitor.Schedule.Priority, PresentationType: run.competitor.PresentationType,
			AffectedScreenCount: t.affected, OutranksDraftScreenCount: t.outranks, Reason: reason,
		})
	}
	sort.SliceStable(result.Competitors, func(i, j int) bool {
		a, b := result.Competitors[i], result.Competitors[j]
		if a.AffectedScreenCount != b.AffectedScreenCount {
			return a.AffectedScreenCount > b.AffectedScreenCount
		}
		return a.ScheduleID.String() < b.ScheduleID.String()
	})
	if len(result.Competitors) > preflightCompetitorLimit {
		result.Competitors = result.Competitors[:preflightCompetitorLimit]
		result.CompetitorsTruncated = true
	}
	return result
}

func appendScreen(result *PreflightResult, screen PreflightScreen) []PreflightScreen {
	if len(result.Screens) >= preflightScreenDetailLimit {
		result.ScreensTruncated = true
		return result.Screens
	}
	return append(result.Screens, screen)
}

func specificityOf(direct bool) int {
	if direct {
		return 1
	}
	return 0
}

// unsavedDraftID stands in for the ID of a draft that has none yet. It sorts
// after every real ID, so the stable-ID tie-break never favors the draft.
var unsavedDraftID = uuid.MustParse("ffffffff-ffff-ffff-ffff-ffffffffffff")

// Preflight evaluates a proposed schedule at its next occurrence across every
// screen it targets. editing is the saved schedule being changed, if any; its
// stored copy is left out of the comparison so a schedule never competes with
// its own previous version. The input must already be authorized.
func (s *Service) Preflight(ctx context.Context, editing *uuid.UUID, in Input) (PreflightResult, error) {
	return s.preflightAt(ctx, time.Now(), editing, in)
}

func (s *Service) preflightAt(ctx context.Context, now time.Time, editing *uuid.UUID, in Input) (PreflightResult, error) {
	var err error
	// The name and description never change what plays, so a draft that is
	// still unnamed can be inspected. Nothing below reads them.
	if strings.TrimSpace(in.Name) == "" {
		in.Name = "Draft"
	}
	if in, err = s.withDefaultTimezone(ctx, in); err != nil {
		return PreflightResult{}, err
	}
	if in, err = s.normalizeSyncGroupTargets(ctx, in); err != nil {
		return PreflightResult{}, err
	}
	if in, err = s.applyOrganizationDefaults(ctx, in); err != nil {
		return PreflightResult{}, err
	}
	if err = s.validateInputFor(ctx, in, false); err != nil {
		return PreflightResult{}, err
	}
	directIDs, groupIDs := []uuid.UUID{}, []uuid.UUID{}
	for _, target := range in.Targets {
		if target.Type == "screen" {
			directIDs = append(directIDs, target.ID)
		} else {
			groupIDs = append(groupIDs, target.ID)
		}
	}
	screens, err := s.preflightScreens(ctx, directIDs, groupIDs)
	if err != nil {
		return PreflightResult{}, err
	}
	screenIDs := make([]uuid.UUID, len(screens))
	for i, screen := range screens {
		screenIDs[i] = screen.ID
	}
	competitors, err := s.preflightCompetitors(ctx, screenIDs, editing)
	if err != nil {
		return PreflightResult{}, err
	}
	// A schedule that is not saved has no stable ID, so a full tie with another
	// schedule cannot be called a win. The highest possible ID makes the draft
	// lose such ties, which keeps the check from promising what it cannot know.
	draftID := unsavedDraftID
	if editing != nil {
		draftID = *editing
	}
	draft := Schedule{
		ID: draftID, PlaylistID: in.PlaylistID, LayoutID: in.LayoutID, DisplayAction: in.DisplayAction,
		Type: in.Type, Timezone: in.Timezone, Priority: in.Priority, Enabled: true,
		StartDate: in.StartDate, EndDate: in.EndDate, OneTimeStart: in.OneTimeStart, OneTimeEnd: in.OneTimeEnd,
		DailyStart: in.DailyStart, DailyEnd: in.DailyEnd, DaysOfWeek: in.DaysOfWeek,
	}
	return evaluatePreflight(now, draft, in.Enabled, screens, competitors), nil
}

// preflightScreens expands direct screen targets and Display Group members
// into one list with each screen once. Archived and deleted screens are
// detached from groups and schedules, so they never count.
func (s *Service) preflightScreens(ctx context.Context, direct, groups []uuid.UUID) ([]preflightScreen, error) {
	rows, err := s.db.Query(ctx, `SELECT sc.id, sc.name, sc.platform, bool_or(x.direct)
FROM (
	SELECT unnest($1::uuid[]) AS screen_id, true AS direct
	UNION ALL
	SELECT m.screen_id, false FROM screen_group_memberships m WHERE m.screen_group_id = ANY($2::uuid[])
) x JOIN screens sc ON sc.id = x.screen_id AND sc.archived_at IS NULL AND sc.deleted_at IS NULL
GROUP BY sc.id, sc.name, sc.platform
ORDER BY sc.name, sc.id`, direct, groups)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []preflightScreen{}
	for rows.Next() {
		var screen preflightScreen
		if err = rows.Scan(&screen.ID, &screen.Name, &screen.Platform, &screen.Direct); err != nil {
			return nil, err
		}
		out = append(out, screen)
	}
	return out, rows.Err()
}

// preflightCompetitors loads every enabled schedule that reaches any of the
// screens, in two batched queries rather than one per screen.
func (s *Service) preflightCompetitors(ctx context.Context, screens []uuid.UUID, editing *uuid.UUID) ([]preflightCompetitor, error) {
	if len(screens) == 0 {
		return []preflightCompetitor{}, nil
	}
	rows, err := s.db.Query(ctx, `SELECT c.schedule_id, c.screen_id, bool_or(c.direct)
FROM (
	SELECT t.schedule_id, t.screen_id, true AS direct FROM schedule_targets t WHERE t.screen_id = ANY($1::uuid[])
	UNION ALL
	SELECT t.schedule_id, m.screen_id, false FROM schedule_targets t
		JOIN screen_group_memberships m ON m.screen_group_id = t.screen_group_id WHERE m.screen_id = ANY($1::uuid[])
) c JOIN schedules s ON s.id = c.schedule_id AND s.deleted_at IS NULL AND s.enabled
WHERE ($2::uuid IS NULL OR s.id <> $2::uuid)
GROUP BY c.schedule_id, c.screen_id`, screens, editing)
	if err != nil {
		return nil, err
	}
	reach := map[uuid.UUID]map[uuid.UUID]bool{}
	order := []uuid.UUID{}
	for rows.Next() {
		var scheduleID, screenID uuid.UUID
		var direct bool
		if err = rows.Scan(&scheduleID, &screenID, &direct); err != nil {
			rows.Close()
			return nil, err
		}
		if reach[scheduleID] == nil {
			reach[scheduleID] = map[uuid.UUID]bool{}
			order = append(order, scheduleID)
		}
		reach[scheduleID][screenID] = direct
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(order) == 0 {
		return []preflightCompetitor{}, nil
	}
	records, err := s.db.Query(ctx, recordSelect+` WHERE s.id = ANY($1::uuid[]) ORDER BY s.id`, order)
	if err != nil {
		return nil, err
	}
	defer records.Close()
	out := make([]preflightCompetitor, 0, len(order))
	for records.Next() {
		record, scanErr := scanRecord(records)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, preflightCompetitor{Schedule: record.Schedule, Name: record.Name, PresentationType: record.PresentationType, Screens: reach[record.ID]})
	}
	return out, records.Err()
}
