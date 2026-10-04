package playbackplan

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestRecordedAtRejectsMissingIdentityOrInstant(t *testing.T) {
	for _, input := range []struct {
		screen uuid.UUID
		at     time.Time
	}{
		{uuid.Nil, time.Now()}, {uuid.New(), time.Time{}},
	} {
		_, err := NewHistory(nil).RecordedAt(context.Background(), input.screen, input.at)
		if !errors.Is(err, ErrInvalidInspection) {
			t.Fatalf("error=%v", err)
		}
	}
}

func TestRecordedPlaybackPlanPostgreSQL(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`)
	if err := database.Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	org, screen := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Playback Plan Test',$1)`, org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Historical screen','linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, screen, org, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	first, second := uuid.New(), uuid.New()
	// These content and schedule identities need not exist anymore.
	if _, err := pool.Exec(ctx, `INSERT INTO expected_playback_windows(id,screen_id,presentation_type,presentation_id,presentation_revision,manifest_version,schedule_id,trigger_source,timezone,expected_start,expected_end,superseded_at,superseded_reason,expected_content_type,expected_content_id)
		VALUES($1,$2,'layout','removed-layout','14',7,'removed-schedule','schedule','America/New_York',$3,$4,$4,'schedule_ended','widget','removed-widget')`, first, screen, start, end); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO expected_playback_windows(id,screen_id,presentation_type,presentation_id,presentation_revision,trigger_source,expected_start) VALUES($1,$2,'playlist','new-assignment','2','direct',$3)`, second, screen, end); err != nil {
		t.Fatal(err)
	}
	history := NewHistory(pool)
	owner, currentPlaylist := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','history-owner','unused','owner',TRUE)`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,revision,created_by) VALUES($1,$2,'Current rotation',88,$3)`, currentPlaylist, org, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO screen_playlist_assignments(id,screen_id,playlist_id,assigned_by) VALUES($1,$2,$3,$4)`, uuid.New(), screen, currentPlaylist, owner); err != nil {
		t.Fatal(err)
	}
	plan, err := history.RecordedAt(ctx, screen, start)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Basis != BasisRecorded || plan.Expectation == nil {
		t.Fatalf("plan=%+v", plan)
	}
	record := plan.Expectation
	if record.WindowID != first || record.PresentationID != "removed-layout" || record.PresentationRevision != "14" || record.ManifestVersion == nil || *record.ManifestVersion != 7 || record.ScheduleID != "removed-schedule" || record.Timezone != "America/New_York" || record.ContentID != "removed-widget" {
		t.Fatalf("record=%+v", record)
	}
	// Changes to current assignments and metadata must not rewrite history.
	if _, err := pool.Exec(ctx, `UPDATE playlists SET revision=99,name='Changed current rotation' WHERE id=$1`, currentPlaylist); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM screen_playlist_assignments WHERE screen_id=$1`, screen); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE screens SET name='Renamed screen',timezone='Asia/Tokyo' WHERE id=$1`, screen); err != nil {
		t.Fatal(err)
	}
	unchanged, err := history.RecordedAt(ctx, screen, start)
	if err != nil || !reflect.DeepEqual(plan, unchanged) {
		t.Fatalf("historical plan changed: %+v error=%v", unchanged, err)
	}
	boundary, err := history.RecordedAt(ctx, screen, end)
	if err != nil || boundary.Expectation == nil || boundary.Expectation.WindowID != second {
		t.Fatalf("half-open boundary=%+v error=%v", boundary, err)
	}
	missing, err := history.RecordedAt(ctx, screen, start.Add(-time.Microsecond))
	if err != nil || missing.Basis != BasisUnavailable || missing.Expectation != nil {
		t.Fatalf("missing=%+v error=%v", missing, err)
	}
	if _, err := history.RecordedAt(ctx, uuid.New(), start); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing screen error=%v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO expected_playback_windows(id,screen_id,expected_start,expected_end) VALUES($1,$2,$3,$4)`, uuid.New(), screen, start, end); err != nil {
		t.Fatal(err)
	}
	if _, err := history.RecordedAt(ctx, screen, start); !errors.Is(err, ErrAmbiguousExpectation) {
		t.Fatalf("overlap error=%v", err)
	}
	pool.Close()
	if _, err := history.RecordedAt(ctx, screen, start); err == nil {
		t.Fatal("database failure became a successful missing expectation")
	}
}
