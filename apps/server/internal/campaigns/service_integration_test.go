package campaigns

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, database.Migrate)) }

func TestPublishRetainedTimingAndReadRelease(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	// Match the Server's typed JSON parameter encoding even when migrations
	// use simple protocol to reduce network round trips to the test database.
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	org, owner, playlist, group := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	execSQL := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	execSQL(`TRUNCATE organization_settings,users CASCADE`)
	execSQL(`INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Campaign Test',$1)`, org)
	execSQL(`INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','owner','unused','owner',TRUE)`, owner)
	execSQL(`INSERT INTO playlists(id,organization_id,name,created_by) VALUES($1,$2,'Flag',$3)`, playlist, org, owner)
	execSQL(`INSERT INTO publication_history(id,content_type,content_id,content_revision,method) VALUES($1,'playlist',$2,1,'manual')`, uuid.New(), playlist)
	execSQL(`INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'Displays',$3)`, group, org, owner)
	service := NewService(pool, nil)
	for _, kind := range []string{"weekly", "one_time"} {
		t.Run(kind, func(t *testing.T) {
			campaign, err := service.Create(ctx, owner, "Flag", "", "Asia/Vladivostok")
			if err != nil {
				t.Fatal(err)
			}
			start := time.Date(2026, 11, 9, 8, 0, 0, 0, mustLocation(t, "Asia/Vladivostok"))
			end := start.Add(4 * time.Minute)
			dailyStart, dailyEnd := "08:00", "08:04"
			draft := campaign.Draft
			draft.Destinations = []Destination{{Type: "group", ID: group}}
			draft.Blocks = []Block{{ID: uuid.New(), Name: "Flag", ContentType: "playlist", ContentID: playlist, ContentRevision: 1,
				Type: kind, Timezone: draft.Timezone, Enabled: true, OneTimeStart: &start, OneTimeEnd: &end,
				DailyStart: &dailyStart, DailyEnd: &dailyEnd, DaysOfWeek: []int{1}}}
			// Simulate an immutable submission created before timing normalization.
			raw, err := json.Marshal(draft)
			if err != nil {
				t.Fatal(err)
			}
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			_, err = tx.Exec(ctx, `INSERT INTO content_submissions(id,content_type,content_id,working_revision,snapshot,snapshot_sha256,submitted_by,status,review_required,allow_self_approval) VALUES($1,'campaign',$2,1,$3::jsonb,$4,$5,'approved',FALSE,TRUE)`, uuid.New(), campaign.ID, string(raw), snapshotDigest(draft), owner)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = service.PublishSnapshotTx(ctx, tx, campaign.ID, raw, 1, owner); err != nil {
				t.Fatalf("publish %s with hidden timing fields: %v", kind, err)
			}
			var valid bool
			if err = tx.QueryRow(ctx, `SELECT CASE WHEN type='weekly' THEN one_time_start IS NULL AND one_time_end IS NULL AND daily_start='08:00'::time AND daily_end='08:04'::time AND days_of_week=ARRAY[1]::smallint[] ELSE daily_start IS NULL AND daily_end IS NULL AND cardinality(days_of_week)=0 AND one_time_end-one_time_start=interval '4 minutes' END FROM schedules WHERE campaign_id=$1 AND deleted_at IS NULL`, campaign.ID).Scan(&valid); err != nil || !valid {
				t.Fatalf("stored timing valid=%v err=%v", valid, err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			releases, err := service.Releases(ctx, campaign.ID)
			if err != nil || len(releases) != 1 {
				t.Fatalf("read successful release: count=%d err=%v", len(releases), err)
			}
			if releases[0].FailureReason != "" || releases[0].Status != "published" {
				t.Fatalf("release = %#v", releases[0])
			}
		})
	}
}
