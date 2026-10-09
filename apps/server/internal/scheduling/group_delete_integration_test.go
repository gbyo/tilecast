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

func TestDeletingGroupDisablesItsSchedulesAndStopsItsPresentations(t *testing.T) {
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
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Group Delete", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	service := scheduling.NewService(pool, nil, scheduling.Limits{MaxSchedules: 10, MaxTargetsPerSchedule: 10, MaxGroupsPerScreen: 10, PrefetchDays: 1})
	group, err := service.CreateGroup(ctx, owner.User.ID, "Cafeteria", "")
	if err != nil {
		t.Fatal(err)
	}
	playlist := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,source_type,created_by)VALUES($1,$2,'Announcements','','static',$3)`, playlist, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	schedule := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,playlist_id,type,timezone,priority,enabled,daily_start,daily_end,days_of_week,created_by)VALUES($1,$2,'Lunch',$3,'weekly','UTC',0,TRUE,'07:00','08:00','{1}',$4)`, schedule, org, playlist, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO schedule_targets(schedule_id,target_type,screen_group_id)VALUES($1,'group',$2)`, schedule, group.ID); err != nil {
		t.Fatal(err)
	}
	override := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO presentation_overrides(id,organization_id,target_type,target_id,content_type,content_id,duration_seconds,started_at,expires_at,after_action,wake_display,created_by)VALUES($1,$2,'group',$3,'playlist',$4,0,now(),NULL,'resume',FALSE,$5)`, override, org, group.ID, playlist, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	if err = service.DeleteGroup(ctx, group.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	var enabled bool
	if err = pool.QueryRow(ctx, `SELECT enabled FROM schedules WHERE id=$1`, schedule).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("schedule for a deleted Display Group is still enabled")
	}
	var stopped bool
	if err = pool.QueryRow(ctx, `SELECT stopped_at IS NOT NULL FROM presentation_overrides WHERE id=$1`, override).Scan(&stopped); err != nil {
		t.Fatal(err)
	}
	if !stopped {
		t.Fatal("Quick Present for a deleted Display Group is still active")
	}
}
