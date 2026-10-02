package playbackplan

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/presentations"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

func TestCurrentComposesStoredSelectionWithoutWrites(t *testing.T) {
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
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`)
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`TRUNCATE organization_settings,users CASCADE`)
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Plan Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	screen, fallback, scheduled, override, takeover := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Plan screen','android-tv','Google','ADT-3','14','0.4.0',1920,1080,2,'en-US','UTC')`, screen, org, uuid.NewString())
	for _, id := range []uuid.UUID{fallback, scheduled, override, takeover} {
		exec(`INSERT INTO playlists(id,organization_id,name,revision) VALUES($1,$2,'Plan content',14)`, id, org)
	}
	exec(`INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id) VALUES($1,$2,$3)`, uuid.New(), screen, fallback)
	exec(`INSERT INTO screen_manifest_state(screen_id,manifest_version) VALUES($1,7)`, screen)
	at := time.Date(2026, 10, 2, 16, 0, 0, 0, time.UTC)
	start, end, quickEnd, takeoverEnd := at.Add(-time.Hour), at.Add(time.Hour), at.Add(10*time.Minute), at.Add(5*time.Minute)
	scheduleID, quickID, takeoverID := uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO schedules(id,organization_id,name,playlist_id,type,timezone,one_time_start,one_time_end) VALUES($1,$2,'Plan schedule',$3,'one_time','UTC',$4,$5)`, scheduleID, org, scheduled, start, end)
	exec(`INSERT INTO schedule_targets(schedule_id,target_type,screen_id) VALUES($1,'screen',$2)`, scheduleID, screen)
	exec(`INSERT INTO presentation_overrides(id,organization_id,target_type,target_id,content_type,content_id,duration_seconds,started_at,expires_at) VALUES($1,$2,'screen',$3,'playlist',$4,600,$5,$6)`, quickID, org, screen, override, at, quickEnd)
	exec(`INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_at,expires_at,activated_by,created_at) VALUES($1,$2,'Plan Takeover',$3,'active',$4,$5,$6,$4)`, takeoverID, org, takeover, at, takeoverEnd, owner.User.ID)
	exec(`INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state) VALUES($1,$2,7,'pending')`, takeoverID, screen)
	assignments := playlists.NewService(pool, nil)
	schedules := scheduling.NewService(pool, nil, scheduling.Limits{})
	quick := presentations.NewService(pool, nil)
	service := NewCurrent(assignments, schedules, quick)
	for _, test := range []struct {
		at     time.Time
		source string
		id     uuid.UUID
		next   *time.Time
	}{
		{at, "takeover", takeover, &takeoverEnd},
		{takeoverEnd, "quick_present", override, &quickEnd},
		{quickEnd, "schedule", scheduled, &end},
		{end, "assignment", fallback, nil},
	} {
		got, err := service.At(ctx, screen, test.at)
		if err != nil {
			t.Fatal(err)
		}
		if got.Selected == nil || got.Selected.Source != test.source || got.Selected.ContentID != test.id {
			t.Fatalf("at %s: selected=%#v", test.at, got.Selected)
		}
		if (got.NextEvaluationAt == nil) != (test.next == nil) || (test.next != nil && !got.NextEvaluationAt.Equal(*test.next)) {
			t.Fatalf("at %s: next=%v want=%v", test.at, got.NextEvaluationAt, test.next)
		}
	}
	var version int64
	var status string
	var stopped *time.Time
	if err = pool.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screen).Scan(&version); err != nil || version != 7 {
		t.Fatalf("manifest changed: version=%d err=%v", version, err)
	}
	if err = pool.QueryRow(ctx, `SELECT status FROM takeovers WHERE id=$1`, takeoverID).Scan(&status); err != nil || status != "active" {
		t.Fatalf("Takeover changed: status=%s err=%v", status, err)
	}
	if err = pool.QueryRow(ctx, `SELECT stopped_at FROM presentation_overrides WHERE id=$1`, quickID).Scan(&stopped); err != nil || stopped != nil {
		t.Fatalf("Quick Present changed: stopped=%v err=%v", stopped, err)
	}
}
