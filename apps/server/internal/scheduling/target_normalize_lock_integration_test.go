package scheduling_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

// A screen target is stored as its Display Group when the screen is a member.
// Create must not decide that from a read taken before an open membership
// change commits; it waits for the change, then stores the group.
func TestScheduleCreateNormalizesUnderScreenLock(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Target Lock", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	screen, group, playlist := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Lobby TV','linux','Test','TV','none','1.0',1920,1080,1,'en-US','UTC')`, screen, org, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Lobby',$3)`, group, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,source_type,created_by)VALUES($1,$2,'Announcements','','static',$3)`, playlist, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	change, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = change.Exec(ctx, `INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by) VALUES($1,$2,$3)`, group, screen, owner.User.ID); err != nil {
		_ = change.Rollback(ctx)
		t.Fatal(err)
	}

	service := scheduling.NewService(pool, nil, scheduling.Limits{MaxSchedules: 10, MaxTargetsPerSchedule: 10, MaxGroupsPerScreen: 10, PrefetchDays: 1})
	done := make(chan error, 1)
	go func() {
		_, err := service.Create(ctx, owner.User.ID, scheduling.Input{
			Name:       "Lunch",
			PlaylistID: playlist,
			Type:       scheduling.Weekly,
			Timezone:   "UTC",
			Enabled:    true,
			DailyStart: ptrString("07:00"),
			DailyEnd:   ptrString("08:00"),
			DaysOfWeek: []int{1},
			Targets:    []scheduling.Target{{Type: "screen", ID: screen}},
		})
		done <- err
	}()
	select {
	case <-done:
		_ = change.Rollback(ctx)
		t.Fatal("schedule was written while the screen's membership change was open")
	case <-time.After(300 * time.Millisecond):
	}
	if err = change.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("create after the membership change: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("create did not resume after the membership change committed")
	}
	var screenTargets, groupTargets int
	if err = pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE screen_id IS NOT NULL), count(*) FILTER (WHERE screen_group_id IS NOT NULL) FROM schedule_targets`).Scan(&screenTargets, &groupTargets); err != nil {
		t.Fatal(err)
	}
	if screenTargets != 0 || groupTargets != 1 {
		t.Fatalf("stored targets: screen=%d group=%d, want screen=0 group=1", screenTargets, groupTargets)
	}
}
