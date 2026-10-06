package scheduling

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
)

type preflightFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	service *Service
	user    uuid.UUID
	org     uuid.UUID
	// lobby is a Display Group of three Linux screens; annex is ungrouped.
	lobby    uuid.UUID
	members  []uuid.UUID
	annex    uuid.UUID
	phone    uuid.UUID // an Android screen with no group
	playlist uuid.UUID
}

func newPreflightFixture(t *testing.T) *preflightFixture {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`TRUNCATE schedule_targets,schedules,screen_group_memberships,screen_groups,playlists,screens,audit_logs,users,organization_settings CASCADE`)
	f := &preflightFixture{ctx: ctx, pool: pool, user: uuid.New(), org: uuid.New(), lobby: uuid.New(), annex: uuid.New(), phone: uuid.New(), playlist: uuid.New()}
	exec(`INSERT INTO organization_settings(singleton,organization_name,id,default_timezone)VALUES(TRUE,'Preflight Test',$1,'UTC')`, f.org)
	exec(`INSERT INTO users(id,name,username,password_hash,role,active)VALUES($1,'Owner','owner','unused','owner',TRUE)`, f.user)
	insertScreen := func(id uuid.UUID, name, platform string) {
		exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,$4,$5,'Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, id, f.org, uuid.NewString(), name, platform)
	}
	exec(`INSERT INTO screen_groups(id,organization_id,name,created_by)VALUES($1,$2,'Lobby wall',$3)`, f.lobby, f.org, f.user)
	for _, name := range []string{"Lobby A", "Lobby B", "Lobby C"} {
		id := uuid.New()
		insertScreen(id, name, "linux")
		exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3)`, f.lobby, id, f.user)
		f.members = append(f.members, id)
	}
	insertScreen(f.annex, "Annex", "linux")
	insertScreen(f.phone, "Hallway tablet", "android-tv")
	exec(`INSERT INTO playlists(id,organization_id,name,created_by)VALUES($1,$2,'Announcements',$3)`, f.playlist, f.org, f.user)
	f.service = NewService(pool, nil, Limits{MaxSchedules: 1000, MaxTargetsPerSchedule: 250})
	return f
}

func (f *preflightFixture) weekdayInput(name string, priority int, targets ...Target) Input {
	return Input{
		Name: name, PlaylistID: f.playlist, Type: Weekly, Timezone: "UTC", Priority: priority, Enabled: true,
		DailyStart: p("09:00"), DailyEnd: p("17:00"), DaysOfWeek: []int{1, 2, 3, 4, 5}, Targets: targets,
	}
}

func group(id uuid.UUID) Target  { return Target{Type: "group", ID: id} }
func screen(id uuid.UUID) Target { return Target{Type: "screen", ID: id} }

// A Tuesday morning before the weekday window opens.
var preflightNow = time.Date(2026, 10, 6, 6, 0, 0, 0, time.UTC)

func TestPreflightCountsEveryTargetedScreenOnce(t *testing.T) {
	f := newPreflightFixture(t)
	// A grouped screen listed beside its own group normalizes to the group,
	// so the three members are counted once. The annex is separate.
	in := f.weekdayInput("Weekdays", 0, screen(f.members[0]), group(f.lobby), screen(f.annex))
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, in)
	if err != nil {
		t.Fatal(err)
	}
	if got.TargetScreenCount != 4 || got.WinningScreenCount != 4 || got.LosingScreenCount != 0 {
		t.Fatalf("%+v", got)
	}
	if got.CheckedAt == nil || !got.CheckedAt.Equal(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("checked at %v", got.CheckedAt)
	}
}

func TestPreflightDoesNotCompeteWithTheSavedCopyOfTheSameSchedule(t *testing.T) {
	f := newPreflightFixture(t)
	saved, err := f.service.Create(f.ctx, f.user, f.weekdayInput("Weekdays", 0, group(f.lobby)))
	if err != nil {
		t.Fatal(err)
	}
	edit := f.weekdayInput("Weekdays", 0, group(f.lobby))
	edit.DailyStart = p("10:00")
	asEdit, err := f.service.preflightAt(f.ctx, preflightNow, &saved.ID, edit)
	if err != nil {
		t.Fatal(err)
	}
	if len(asEdit.Competitors) != 0 || asEdit.WinningScreenCount != 3 {
		t.Fatalf("an edit competed with itself: %+v", asEdit)
	}
	// The same input as a brand-new schedule does overlap the saved one.
	asNew, err := f.service.preflightAt(f.ctx, preflightNow, nil, f.weekdayInput("Copy", 0, group(f.lobby)))
	if err != nil {
		t.Fatal(err)
	}
	if len(asNew.Competitors) != 1 || asNew.Competitors[0].ScheduleID != saved.ID || asNew.Competitors[0].AffectedScreenCount != 3 {
		t.Fatalf("%+v", asNew.Competitors)
	}
}

func TestPreflightHigherPriorityScheduleWinsOnlyWhereItReaches(t *testing.T) {
	f := newPreflightFixture(t)
	rival, err := f.service.Create(f.ctx, f.user, f.weekdayInput("Friday Night Lights", 100, group(f.lobby)))
	if err != nil {
		t.Fatal(err)
	}
	in := f.weekdayInput("Weekdays", 0, group(f.lobby), screen(f.annex))
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, in)
	if err != nil {
		t.Fatal(err)
	}
	if got.TargetScreenCount != 4 || got.WinningScreenCount != 1 || got.LosingScreenCount != 3 {
		t.Fatalf("%+v", got)
	}
	if len(got.Competitors) != 1 || got.Competitors[0].ScheduleID != rival.ID || got.Competitors[0].OutranksDraftScreenCount != 3 || got.Competitors[0].Reason != ReasonLowerPriority {
		t.Fatalf("%+v", got.Competitors)
	}
	if len(got.Screens) != 3 || got.Screens[0].WinnerName != "Friday Night Lights" {
		t.Fatalf("%+v", got.Screens)
	}
}

func TestPreflightIgnoresDisabledAndDeletedSchedules(t *testing.T) {
	f := newPreflightFixture(t)
	disabled := f.weekdayInput("Disabled", 500, group(f.lobby))
	disabled.Enabled = false
	if _, err := f.service.Create(f.ctx, f.user, disabled); err != nil {
		t.Fatal(err)
	}
	removed, err := f.service.Create(f.ctx, f.user, f.weekdayInput("Removed", 500, group(f.lobby)))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.Delete(f.ctx, removed.ID, f.user); err != nil {
		t.Fatal(err)
	}
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, f.weekdayInput("Weekdays", 0, group(f.lobby)))
	if err != nil {
		t.Fatal(err)
	}
	if got.WinningScreenCount != 3 || len(got.Competitors) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightStoredDisabledDraftStillComparesAsEnabled(t *testing.T) {
	f := newPreflightFixture(t)
	in := f.weekdayInput("Weekdays", 0, group(f.lobby))
	in.Enabled = false
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, in)
	if err != nil {
		t.Fatal(err)
	}
	if got.DraftEnabled || got.WinningScreenCount != 3 {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightLegacyDirectTargetIsMoreSpecificThanItsGroup(t *testing.T) {
	f := newPreflightFixture(t)
	rival, err := f.service.Create(f.ctx, f.user, f.weekdayInput("Direct rival", 0, screen(f.annex)))
	if err != nil {
		t.Fatal(err)
	}
	// Older schedules can still hold a direct row for a grouped screen.
	if _, err = f.pool.Exec(f.ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_id)VALUES($1,'screen',$2)`, rival.ID, f.members[0]); err != nil {
		t.Fatal(err)
	}
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, f.weekdayInput("Group draft", 0, group(f.lobby)))
	if err != nil {
		t.Fatal(err)
	}
	if got.LosingScreenCount != 1 || got.WinningScreenCount != 2 {
		t.Fatalf("%+v", got)
	}
	if got.Screens[0].ScreenID != f.members[0] || got.Screens[0].Reason != ReasonLessSpecific {
		t.Fatalf("%+v", got.Screens)
	}
}

func TestPreflightReportsUnsupportedDisplayControlScreensWithoutFailing(t *testing.T) {
	f := newPreflightFixture(t)
	in := f.weekdayInput("Power on", 0, group(f.lobby), screen(f.phone))
	in.PlaylistID = uuid.Nil
	in.DisplayAction = &displaycontrol.Action{Type: displaycontrol.CommandPowerOn}
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, in)
	if err != nil {
		t.Fatal(err)
	}
	if got.UnsupportedScreenCount != 1 || got.WinningScreenCount != 3 || len(got.Issues) != 1 || got.Issues[0].Code != IssueDisplayControlUnsupported || got.Issues[0].Severity != SeverityBlocking {
		t.Fatalf("%+v", got)
	}
	// Saving the same schedule is still refused, so the check cannot disagree.
	if _, err = f.service.Create(f.ctx, f.user, in); err == nil {
		t.Fatal("an unsupported display-control schedule was saved")
	}
}

func TestPreflightRejectsADraftWithNoTargets(t *testing.T) {
	f := newPreflightFixture(t)
	if _, err := f.service.preflightAt(f.ctx, preflightNow, nil, f.weekdayInput("Nowhere", 0)); err == nil {
		t.Fatal("a draft with no targets was inspected")
	}
}

func TestPreflightIgnoresDeletedAndArchivedScreens(t *testing.T) {
	f := newPreflightFixture(t)
	if _, err := f.pool.Exec(f.ctx, `UPDATE screens SET deleted_at=now() WHERE id=$1`, f.members[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE screens SET archived_at=now() WHERE id=$1`, f.members[1]); err != nil {
		t.Fatal(err)
	}
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, f.weekdayInput("Weekdays", 0, group(f.lobby)))
	if err != nil {
		t.Fatal(err)
	}
	if got.TargetScreenCount != 1 || got.WinningScreenCount != 1 {
		t.Fatalf("%+v", got)
	}
}

func TestPreflightChecksADraftThatHasNoNameYet(t *testing.T) {
	f := newPreflightFixture(t)
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, f.weekdayInput("", 0, group(f.lobby)))
	if err != nil {
		t.Fatalf("an unnamed draft was refused: %v", err)
	}
	if got.WinningScreenCount != 3 {
		t.Fatalf("%+v", got)
	}
	// Saving still needs a name, so the check cannot make an unsaveable draft look fine.
	if _, err = f.service.Create(f.ctx, f.user, f.weekdayInput("", 0, group(f.lobby))); err == nil {
		t.Fatal("an unnamed schedule was saved")
	}
}

func TestPreflightUsesTheOrganizationTimezoneForADraftWithNone(t *testing.T) {
	f := newPreflightFixture(t)
	if _, err := f.pool.Exec(f.ctx, `UPDATE organization_settings SET default_timezone='Pacific/Auckland'`); err != nil {
		t.Fatal(err)
	}
	in := f.weekdayInput("Weekdays", 0, group(f.lobby))
	in.Timezone = ""
	got, err := f.service.preflightAt(f.ctx, preflightNow, nil, in)
	if err != nil {
		t.Fatal(err)
	}
	// It is already Tue 19:00 in Auckland, so the next 09:00 NZDT is Wed 7 Oct,
	// which is 20:00 UTC on Tue 6 Oct.
	want := time.Date(2026, 10, 6, 20, 0, 0, 0, time.UTC)
	if got.CheckedAt == nil || !got.CheckedAt.Equal(want) {
		t.Fatalf("checked at %v, want %v", got.CheckedAt, want)
	}
}

type readyEverything struct{ calls int }

func (r *readyEverything) ValidatePresentation(context.Context, string, uuid.UUID, time.Time) error {
	r.calls++
	return nil
}

// A display action has no presentation to validate. With readiness configured,
// as it is in production, saving or checking one used to dereference a nil
// content ID.
func TestDisplayControlScheduleSkipsPresentationReadiness(t *testing.T) {
	f := newPreflightFixture(t)
	readiness := &readyEverything{}
	f.service.SetPresentationReadiness(readiness)
	in := f.weekdayInput("Power on", 0, group(f.lobby))
	in.PlaylistID = uuid.Nil
	in.DisplayAction = &displaycontrol.Action{Type: displaycontrol.CommandPowerOn}
	if _, err := f.service.preflightAt(f.ctx, preflightNow, nil, in); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	saved, err := f.service.Create(f.ctx, f.user, in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if saved.DisplayAction == nil || readiness.calls != 0 {
		t.Fatalf("display action=%v readiness calls=%d", saved.DisplayAction, readiness.calls)
	}
	// Content schedules are still checked.
	if _, err = f.service.Create(f.ctx, f.user, f.weekdayInput("Content", 0, group(f.lobby))); err != nil || readiness.calls != 1 {
		t.Fatalf("content create err=%v readiness calls=%d", err, readiness.calls)
	}
}
