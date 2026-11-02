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
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

func TestScheduleRejectsArchivedScreenTarget(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE schedule_targets,schedules,playlist_items,playlists,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Archived Target Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	playlist, screen := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,source_type,created_by)VALUES($1,$2,'Announcements','','static',$3)`, playlist, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone,archived_at,archived_reason,enabled) VALUES($1,$2,$3,'Archived TV','android-tv','Test','TV','14','1.0',1920,1080,1,'en-US','UTC',now(),'test',FALSE)`, screen, org, uuid.NewString()); err != nil {
		t.Fatal(err)
	}

	service := scheduling.NewService(pool, nil, scheduling.Limits{MaxSchedules: 10, MaxTargetsPerSchedule: 10, MaxGroupsPerScreen: 10, PrefetchDays: 1})
	_, err = service.Create(ctx, owner.User.ID, scheduling.Input{
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
	// The archive trigger also refuses this insert, but only after the target
	// check has passed. The clean validation error is the contract.
	if err == nil || !strings.Contains(err.Error(), "schedule target is invalid") {
		t.Fatalf("archived screen schedule error = %v, want the target validation error", err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schedule_targets WHERE screen_id=$1`, screen).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("archived screen targets = %d, want 0", count)
	}
}

func ptrString(value string) *string { return &value }
