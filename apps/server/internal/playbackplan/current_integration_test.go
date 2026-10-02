package playbackplan

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	inspector := NewInspector(service, NewHistory(pool))
	inspector.now = func() time.Time { return at }
	historicalStart, historicalEnd := at.Add(-2*time.Hour), at.Add(-time.Hour)
	exec(`INSERT INTO expected_playback_windows(id,screen_id,presentation_type,presentation_id,presentation_revision,trigger_source,expected_start,expected_end) VALUES($1,$2,'layout','removed-layout','3','schedule',$3,$4)`, uuid.New(), screen, historicalStart, historicalEnd)
	historical, err := inspector.Inspect(ctx, screen, &historicalStart)
	if err != nil || historical.Basis != BasisRecorded || historical.Current != nil || historical.Historical == nil || historical.Historical.Expectation == nil || historical.Historical.Expectation.PresentationID != "removed-layout" {
		t.Fatalf("historical inspection=%#v err=%v", historical, err)
	}
	gap := at.Add(-30 * time.Minute)
	unavailable, err := inspector.Inspect(ctx, screen, &gap)
	if err != nil || unavailable.Basis != BasisUnavailable || unavailable.Current != nil || unavailable.Historical == nil || unavailable.Historical.Expectation != nil {
		t.Fatalf("historical gap used current content: inspection=%#v err=%v", unavailable, err)
	}
	current, err := inspector.Inspect(ctx, screen, nil)
	if err != nil || current.Basis != BasisCurrent || current.Historical != nil || current.Current == nil || current.Current.Selected == nil || current.Current.Selected.ContentID != takeover {
		t.Fatalf("current inspection=%#v err=%v", current, err)
	}
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
	t.Run("snapshot_survives_concurrent_configuration_change", func(t *testing.T) {
		exec(`INSERT INTO screen_player_status(screen_id,active_manifest_version,pending_manifest_version) VALUES($1,6,7)`, screen)
		exec := func(sql string, args ...any) {
			t.Helper()
			if _, err := pool.Exec(ctx, sql, args...); err != nil {
				t.Fatal(err)
			}
		}
		inspectionAt := at.Add(20 * time.Minute)
		newTakeover := uuid.New()
		writer := afterAssignmentRead{TransactionalAssignments: assignments, after: func(ctx context.Context, tx pgx.Tx) {
			var readOnly, isolation string
			if err := tx.QueryRow(ctx, `SELECT current_setting('transaction_read_only'),current_setting('transaction_isolation')`).Scan(&readOnly, &isolation); err != nil || readOnly != "on" || isolation != "repeatable read" {
				t.Fatalf("snapshot options: readOnly=%s isolation=%s err=%v", readOnly, isolation, err)
			}
			// These writes use another connection, after the inspector's first read.
			exec(`UPDATE screen_playlist_assignments SET playlist_id=$2 WHERE screen_id=$1`, screen, override)
			exec(`UPDATE schedules SET enabled=FALSE WHERE id=$1`, scheduleID)
			exec(`UPDATE screen_player_status SET active_manifest_version=99,pending_manifest_version=NULL,presentation_schema_versions='{1}',native_presentation_capabilities='{}' WHERE screen_id=$1`, screen)
			exec(`INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_at,expires_at,created_at) VALUES($1,$2,'Concurrent Takeover',$3,'active',$4,$5,$4)`, newTakeover, org, takeover, inspectionAt, end)
			exec(`INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state) VALUES($1,$2,7,'pending')`, newTakeover, screen)
		}}
		got, err := NewSnapshotCurrent(pool, writer, schedules, quick).At(ctx, screen, inspectionAt)
		if err != nil || got.Selected == nil || got.Selected.Source != "schedule" || got.Selected.ContentID != scheduled {
			t.Fatalf("mixed configuration snapshot: selected=%#v err=%v", got.Selected, err)
		}
		if got.ScheduleExplanation.Resolution.Winner.Schedule.Specificity != 1 {
			t.Fatal("transactional reader lost direct target specificity")
		}
		if got.Synchronization.Status != "preparing" || got.Capabilities.Evidence.Reported {
			t.Fatalf("mixed reported state snapshot: synchronization=%#v capabilities=%#v", got.Synchronization, got.Capabilities)
		}
		snapshot := NewSnapshotCurrent(pool, assignments, schedules, quick)
		fresh, err := snapshot.At(ctx, screen, inspectionAt)
		if err != nil || fresh.Selected == nil || fresh.Selected.Source != "takeover" || *fresh.Selected.SelectionID != newTakeover {
			t.Fatalf("fresh snapshot missed committed change: selected=%#v err=%v", fresh.Selected, err)
		}
		if fresh.Synchronization.Status != "out_of_date" || !fresh.Capabilities.Evidence.Reported || len(fresh.Capabilities.Evidence.SchemaVersions) != 1 {
			t.Fatalf("fresh snapshot missed reported state: synchronization=%#v capabilities=%#v", fresh.Synchronization, fresh.Capabilities)
		}
		exec(`UPDATE takeovers SET status='cancelled' WHERE id=$1`, newTakeover)
		fallbackPlan, err := snapshot.At(ctx, screen, inspectionAt)
		if err != nil || fallbackPlan.Selected == nil || fallbackPlan.Selected.ContentID != override || fallbackPlan.Selected.Source != "assignment" {
			t.Fatalf("fresh fallback=%#v err=%v", fallbackPlan.Selected, err)
		}
		if len(fallbackPlan.ScheduleExplanation.Candidates) != 1 || fallbackPlan.ScheduleExplanation.Candidates[0].Reason != scheduling.ReasonDisabled || fallbackPlan.ScheduleExplanation.Candidates[0].Status != scheduling.CandidateInactive || fallbackPlan.NextEvaluationAt != nil {
			t.Fatalf("disabled alternative trace=%#v", fallbackPlan)
		}
		manifestSchedules, err := schedules.Relevant(ctx, screen)
		if err != nil || len(manifestSchedules) != 0 {
			t.Fatalf("manifest reader included disabled schedule: records=%#v err=%v", manifestSchedules, err)
		}
		if _, err := snapshot.At(ctx, uuid.New(), inspectionAt); !errors.Is(err, ErrNotFound) {
			t.Fatalf("missing Screen error=%v", err)
		}
	})
	t.Run("selected_content_limits_do_not_replace_selection", func(t *testing.T) {
		exec := func(sql string, args ...any) {
			t.Helper()
			if _, err := pool.Exec(ctx, sql, args...); err != nil {
				t.Fatal(err)
			}
		}
		snapshot := NewSnapshotCurrent(pool, assignments, schedules, quick)
		exec(`UPDATE playlists SET deleted_at=now() WHERE id=$1`, override)
		missing, err := snapshot.At(ctx, screen, end)
		if err != nil || missing.Selected == nil || missing.Selected.ContentID != override || missing.Capabilities.Status != "unavailable" || missing.Capabilities.Reason != "selected_content_not_found" {
			t.Fatalf("missing selected root: plan=%#v err=%v", missing, err)
		}
		layout := uuid.New()
		exec(`INSERT INTO layouts(id,organization_id,name,orientation,canvas_width,canvas_height,draft_document,created_by) VALUES($1,$2,'Unpublished plan layout','landscape',1920,1080,'{}'::jsonb,$3)`, layout, org, owner.User.ID)
		exec(`UPDATE screen_playlist_assignments SET playlist_id=NULL,layout_id=$2 WHERE screen_id=$1`, screen, layout)
		unpublished, err := snapshot.At(ctx, screen, end)
		if err != nil || unpublished.Selected == nil || unpublished.Selected.ContentID != layout || unpublished.Capabilities.Reason != "selected_content_not_published" {
			t.Fatalf("unpublished root: plan=%#v err=%v", unpublished, err)
		}
		exec(`DELETE FROM screen_playlist_assignments WHERE screen_id=$1`, screen)
		empty, err := snapshot.At(ctx, screen, end)
		if err != nil || empty.Selected != nil || empty.Capabilities.Status != "not_applicable" || empty.Capabilities.Reason != "no_selected_content" {
			t.Fatalf("empty assignment: plan=%#v err=%v", empty, err)
		}
	})
}
