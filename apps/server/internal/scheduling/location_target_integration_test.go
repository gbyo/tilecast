package scheduling_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/displaycontrol"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

func TestScheduleLocationTargets(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lockPool.Close)
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lock.Release)
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) })
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Location Targets", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	user := owner.User.ID

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	library, annex := uuid.New(), uuid.New()
	exec(`INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Library'),($3,$2,'Annex')`, library, org, annex)
	newScreen := func(name string, location uuid.UUID, platform string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone,location_id,enabled) VALUES($1,$2,$3,$4,$5,'Test','TV','14','1.0',1920,1080,1,'en-US','UTC',$6,TRUE)`, id, org, uuid.NewString(), name, platform, location)
		return id
	}
	desk, lobby := newScreen("Desk", library, "linux"), newScreen("Lobby", library, "linux")
	annexWall := newScreen("Annex wall", annex, "linux")
	playlist := uuid.New()
	exec(`INSERT INTO playlists(id,organization_id,name,description,source_type,created_by)VALUES($1,$2,'Announcements','','static',$3)`, playlist, org, user)

	service := scheduling.NewService(pool, nil, scheduling.Limits{MaxSchedules: 10, MaxTargetsPerSchedule: 10, MaxGroupsPerScreen: 10, PrefetchDays: 1})
	deviceService := devices.NewService(pool, devices.NewPresenceHub(), "")
	input := func(targets ...scheduling.Target) scheduling.Input {
		start, end := "07:00", "08:00"
		return scheduling.Input{Name: "Morning", PlaylistID: playlist, Type: scheduling.Weekly, Timezone: "UTC", Enabled: true,
			DailyStart: &start, DailyEnd: &end, DaysOfWeek: []int{1}, Targets: targets}
	}
	relevant := func(screen uuid.UUID) int {
		t.Helper()
		records, err := service.Relevant(ctx, screen)
		if err != nil {
			t.Fatal(err)
		}
		return len(records)
	}
	manifestVersion := func(screen uuid.UUID) int64 {
		t.Helper()
		var version int64
		_ = pool.QueryRow(ctx, `SELECT COALESCE((SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1),0)`, screen).Scan(&version)
		return version
	}

	record, err := service.Create(ctx, user, input(scheduling.Target{Type: "location", ID: library}))
	if err != nil {
		t.Fatalf("create location schedule: %v", err)
	}
	if len(record.Targets) != 1 || record.Targets[0].Type != "location" || record.Targets[0].ID != library || record.Targets[0].Name != "Library" {
		t.Fatalf("targets = %+v, want the Library location by name", record.Targets)
	}
	if relevant(desk) != 1 || relevant(lobby) != 1 {
		t.Fatal("schedule did not reach the screens at its location")
	}
	if relevant(annexWall) != 0 {
		t.Fatal("schedule reached a screen at another location")
	}
	reached, err := service.Relevant(ctx, desk)
	if err != nil {
		t.Fatal(err)
	}
	if reached[0].Specificity != 0 {
		t.Fatalf("location target specificity = %d, want 0", reached[0].Specificity)
	}

	// A Display Group plays one schedule on all members, so a grouped screen at
	// the location brings its peers elsewhere with it.
	group, err := service.CreateGroup(ctx, user, "Entrance", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = service.AddScreen(ctx, group.ID, desk, user); err != nil {
		t.Fatal(err)
	}
	if err = service.AddScreen(ctx, group.ID, annexWall, user); err != nil {
		t.Fatal(err)
	}
	if relevant(annexWall) != 1 {
		t.Fatal("a group peer of a screen at the location did not receive the schedule")
	}
	before := manifestVersion(annexWall)
	if err = service.RemoveScreen(ctx, group.ID, desk, user); err != nil {
		t.Fatal(err)
	}
	if relevant(annexWall) != 0 {
		t.Fatal("a group peer kept the schedule after the screen at the location left the group")
	}
	if manifestVersion(annexWall) <= before {
		t.Fatal("removing a screen from a location schedule's group did not change the peer's manifest")
	}

	// Moving a screen into the location changes what it plays.
	before = manifestVersion(annexWall)
	if _, err = deviceService.UpdateScreen(ctx, annexWall, user, "Annex wall", &library, "", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}
	if relevant(annexWall) != 1 || manifestVersion(annexWall) <= before {
		t.Fatal("moving a screen to the location did not give it the schedule and a new manifest")
	}

	// Preflight counts location screens.
	preflight, err := service.Preflight(ctx, nil, input(scheduling.Target{Type: "location", ID: library}))
	if err != nil {
		t.Fatal(err)
	}
	if preflight.TargetScreenCount != 3 {
		t.Fatalf("preflight target screens = %d, want 3", preflight.TargetScreenCount)
	}

	// Rejected shapes.
	if _, err = service.Create(ctx, user, input(scheduling.Target{Type: "location", ID: uuid.New()})); err == nil || !strings.Contains(err.Error(), "schedule target is invalid") {
		t.Fatalf("unknown location error = %v", err)
	}
	displayInput := input(scheduling.Target{Type: "location", ID: library})
	displayInput.PlaylistID = uuid.Nil
	displayInput.DisplayAction = &displaycontrol.Action{Type: displaycontrol.CommandPowerOn}
	if _, err = service.Create(ctx, user, displayInput); err == nil || !strings.Contains(err.Error(), "not locations") {
		t.Fatalf("display-control location error = %v", err)
	}

	// Deleting a location that no screen uses disables its schedules.
	empty := uuid.New()
	exec(`INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Storage')`, empty, org)
	emptyRecord, err := service.Create(ctx, user, input(scheduling.Target{Type: "location", ID: empty}))
	if err != nil {
		t.Fatal(err)
	}
	if err = deviceService.DeleteLocation(ctx, empty, user); err != nil {
		t.Fatal(err)
	}
	var enabled bool
	if err = pool.QueryRow(ctx, `SELECT enabled FROM schedules WHERE id=$1`, emptyRecord.ID).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("schedule for a deleted location is still enabled")
	}
}
