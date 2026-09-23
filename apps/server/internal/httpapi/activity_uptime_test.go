package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestBuildUptimeReportSeparatesHealthyImpairedAndDownTime(t *testing.T) {
	spec := uptimeWindowSpecs["24h"]
	to := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	from := to.Add(-2 * time.Hour)
	cafeteria, library := uuid.New(), uuid.New()
	rows := []uptimeRow{
		// A fully healthy screen.
		{ScreenID: cafeteria, ScreenName: "Cafeteria", BucketStart: from, BucketEnd: from.Add(time.Hour), UpSeconds: 3600},
		{ScreenID: cafeteria, ScreenName: "Cafeteria", BucketStart: from.Add(time.Hour), BucketEnd: to, UpSeconds: 3600},
		// A screen that spent the second hour half down and half impaired.
		{ScreenID: library, ScreenName: "Library", BucketStart: from, BucketEnd: from.Add(time.Hour), UpSeconds: 3600},
		{ScreenID: library, ScreenName: "Library", BucketStart: from.Add(time.Hour), BucketEnd: to, ImpairedSec: 1800, DownSeconds: 1800},
	}

	report := buildUptimeReport(rows, spec, from, to)

	if report.ScreensTracked != 2 || report.ScreensWithDowntime != 1 {
		t.Fatalf("expected two tracked screens and one with downtime, got %d and %d", report.ScreensTracked, report.ScreensWithDowntime)
	}
	if report.UpSeconds != 10800 || report.ImpairedSeconds != 1800 || report.DownSeconds != 1800 {
		t.Fatalf("unexpected totals: up=%d impaired=%d down=%d", report.UpSeconds, report.ImpairedSeconds, report.DownSeconds)
	}
	if report.UptimePercent == nil || *report.UptimePercent != 75 {
		t.Fatalf("expected 75%% healthy time, got %v", report.UptimePercent)
	}
	if len(report.Buckets) != 2 {
		t.Fatalf("expected one bucket per hour, got %d", len(report.Buckets))
	}
	if report.Buckets[0].UpPercent != 100 || report.Buckets[0].ScreensDown != 0 {
		t.Fatalf("first bucket should be fully up: %+v", report.Buckets[0])
	}
	second := report.Buckets[1]
	if second.UpPercent != 50 || second.ImpairedPercent != 25 || second.DownPercent != 25 || second.ScreensDown != 1 {
		t.Fatalf("unexpected second bucket: %+v", second)
	}
	// The worst screen is listed first so the panel reads as a work queue.
	if report.Screens[0].ScreenName != "Library" || report.Screens[0].DownSeconds != 1800 {
		t.Fatalf("expected Library ranked first: %+v", report.Screens[0])
	}
	if got := report.Screens[0].Buckets; len(got) != 2 || got[0] != "up" || got[1] != "down" {
		t.Fatalf("unexpected Library strip: %v", got)
	}
	if got := report.Screens[1].Buckets; got[0] != "up" || got[1] != "up" {
		t.Fatalf("unexpected Cafeteria strip: %v", got)
	}
}

func TestBuildUptimeReportReportsUnmeasuredTimeInsteadOfGuessing(t *testing.T) {
	spec := uptimeWindowSpecs["24h"]
	to := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	from := to.Add(-time.Hour)
	screenID := uuid.New()
	rows := []uptimeRow{{ScreenID: screenID, ScreenName: "New TV", BucketStart: from, BucketEnd: to}}

	report := buildUptimeReport(rows, spec, from, to)

	if report.UptimePercent != nil {
		t.Fatalf("a screen with no recorded state must not report a percentage, got %v", *report.UptimePercent)
	}
	if report.Buckets[0].UnknownPercent != 100 {
		t.Fatalf("expected the bucket to be entirely unmeasured: %+v", report.Buckets[0])
	}
	if report.Screens[0].Buckets[0] != "unknown" {
		t.Fatalf("expected an unknown strip cell, got %q", report.Screens[0].Buckets[0])
	}
}

func TestClampUptimeSegmentsKeepsBucketsWithinTheirSpan(t *testing.T) {
	up, impaired, down := clampUptimeSegments(3600, 1800, 1800, 3600)
	if total := up + impaired + down; total != 3600 {
		t.Fatalf("expected overlapping intervals to be scaled into the bucket, got %v", total)
	}
	if up != 1800 {
		t.Fatalf("expected proportional scaling, got up=%v", up)
	}
}

// Uptime measures actively paired screens, so a test screen needs the device
// credential that pairing would have created.
func pairUptimeScreen(t *testing.T, pool *pgxpool.Pool, screenID uuid.UUID, revoked bool) {
	t.Helper()
	revokedAt := "NULL"
	if revoked {
		revokedAt = "now()"
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash,revoked_at) VALUES($1,$2,$3,'\x00'::bytea,`+revokedAt+`)`, uuid.New(), screenID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
}

func TestUptimeCountsSilentPlayerAsDownRatherThanStillHealthy(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		now := time.Now().UTC()
		pairUptimeScreen(t, env.pool, env.screenID, false)
		// The player reported healthy six hours ago and stopped heartbeating two
		// hours ago without ever sending a disconnect event.
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET last_heartbeat_at=$2 WHERE id=$1`, env.screenID, now.Add(-2*time.Hour)); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO screen_state_intervals(id,screen_id,state,started_at) VALUES($1,$2,'healthy',$3)`, uuid.New(), env.screenID, now.Add(-6*time.Hour)); err != nil {
			t.Fatal(err)
		}

		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/uptime?window=24h", nil)
		request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, env.owner))
		response := httptest.NewRecorder()
		env.server.activityUptime(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("unexpected status %d: %s", response.Code, response.Body.String())
		}
		var payload struct {
			Data uptimeReport `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		report := payload.Data
		if report.Window != "24h" || len(report.Buckets) != 24 {
			t.Fatalf("expected twenty-four hourly buckets, got window %q with %d", report.Window, len(report.Buckets))
		}
		// Downtime starts one gap grace period after the last heartbeat.
		expectedDown := int64((2*time.Hour - uptimeHeartbeatGrace).Seconds())
		if difference := report.DownSeconds - expectedDown; difference < -60 || difference > 60 {
			t.Fatalf("expected about %d seconds of downtime, got %d", expectedDown, report.DownSeconds)
		}
		if report.UpSeconds < int64((3 * time.Hour).Seconds()) {
			t.Fatalf("expected the healthy stretch to be counted, got %d seconds", report.UpSeconds)
		}
		// Time before the first recorded interval stays unmeasured rather than
		// counting against uptime.
		if report.TrackedSeconds-report.UpSeconds-report.DownSeconds-report.ImpairedSeconds < int64((17 * time.Hour).Seconds()) {
			t.Fatalf("expected the untracked remainder of the window to be excluded: %+v", report)
		}
		if report.UptimePercent == nil || *report.UptimePercent > 70 || *report.UptimePercent < 60 {
			t.Fatalf("expected roughly two thirds healthy time, got %v", report.UptimePercent)
		}
		if len(report.Screens) != 1 || report.Screens[0].DownSeconds == 0 {
			t.Fatalf("expected the screen row to carry its downtime: %+v", report.Screens)
		}
		if state := report.Screens[0].Buckets[len(report.Screens[0].Buckets)-1]; state != "down" {
			t.Fatalf("expected the newest strip cell to be down, got %q", state)
		}
	})
}

func TestUptimeSeparatesHeartbeatGapsFromContentFailures(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		now := time.Now().UTC()
		pairUptimeScreen(t, env.pool, env.screenID, false)
		insert := func(state, reason string, start, end time.Time) {
			if _, err := env.pool.Exec(ctx, `INSERT INTO screen_state_intervals(id,screen_id,state,started_at,ended_at,reason_code) VALUES($1,$2,$3,$4,$5,NULLIF($6,''))`, uuid.New(), env.screenID, state, start, end, reason); err != nil {
				t.Fatal(err)
			}
		}
		// Four closed hours: healthy, a detected heartbeat gap, a renderer failure,
		// and an explicit disconnect.
		insert("healthy", "", now.Add(-4*time.Hour), now.Add(-3*time.Hour))
		insert("degraded", "heartbeat_gap", now.Add(-3*time.Hour), now.Add(-2*time.Hour))
		insert("degraded", "playback_error", now.Add(-2*time.Hour), now.Add(-time.Hour))
		insert("offline", "", now.Add(-time.Hour), now)
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET last_heartbeat_at=$2 WHERE id=$1`, env.screenID, now); err != nil {
			t.Fatal(err)
		}

		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/uptime?window=7d", nil)
		request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, env.owner))
		response := httptest.NewRecorder()
		env.server.activityUptime(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("unexpected status %d: %s", response.Code, response.Body.String())
		}
		var payload struct {
			Data uptimeReport `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		report := payload.Data
		if len(report.Buckets) != 28 {
			t.Fatalf("expected twenty-eight six-hour buckets, got %d", len(report.Buckets))
		}
		hour := int64(time.Hour.Seconds())
		if near := func(got, want int64) bool { return got-want > -60 && got-want < 60 }; !near(report.UpSeconds, hour) ||
			!near(report.ImpairedSeconds, hour) || !near(report.DownSeconds, 2*hour) {
			t.Fatalf("expected one healthy hour, one impaired hour, and two down hours: up=%d impaired=%d down=%d", report.UpSeconds, report.ImpairedSeconds, report.DownSeconds)
		}
		if report.UptimePercent == nil || *report.UptimePercent > 26 || *report.UptimePercent < 24 {
			t.Fatalf("expected a quarter of measured time healthy, got %v", report.UptimePercent)
		}
	})
}

func TestHeartbeatConfirmsHealthyOnlyWithCleanPlayback(t *testing.T) {
	playing := heartbeatActivityState{PlaybackState: "playing"}
	if !heartbeatConfirmsHealthy(playing) {
		t.Fatal("a clean playing heartbeat should confirm health")
	}
	limit, used := int64(100), int64(95)
	for name, status := range map[string]heartbeatActivityState{
		"not playing":     {PlaybackState: "idle"},
		"playback error":  {PlaybackState: "playing", PlaybackError: "decoder gave up"},
		"safe mode":       {PlaybackState: "playing", SafeMode: true},
		"lost foreground": {PlaybackState: "playing", ForegroundState: "background"},
		"cache pressure":  {PlaybackState: "playing", CacheLimitBytes: &limit, CacheUsedBytes: &used},
	} {
		if heartbeatConfirmsHealthy(status) {
			t.Fatalf("%s must not confirm health", name)
		}
	}
}

func TestHeartbeatAnchorsAnUpIntervalAndClearsStaleImpairment(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/player/heartbeat", nil)
		healthy := heartbeatActivityState{PlaybackState: "playing"}
		anchor := func(status heartbeatActivityState, when time.Time) {
			tx, err := env.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			env.server.anchorHeartbeatStateInterval(request, tx, env.screenID, status, when)
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
		}
		openInterval := func() (string, int) {
			var state string
			var total int
			if err := env.pool.QueryRow(ctx, `SELECT COALESCE(max(state) FILTER (WHERE ended_at IS NULL),''),count(*) FROM screen_state_intervals WHERE screen_id=$1`, env.screenID).Scan(&state, &total); err != nil {
				t.Fatal(err)
			}
			return state, total
		}

		// A player that has never emitted a recognised activity event still gets
		// measured from its heartbeats.
		now := time.Now().UTC()
		anchor(healthy, now.Add(-time.Hour))
		if state, total := openInterval(); state != "healthy" || total != 1 {
			t.Fatalf("expected one open healthy interval, got %q and %d rows", state, total)
		}

		// Later heartbeats extend that interval rather than adding rows.
		anchor(healthy, now.Add(-30*time.Minute))
		if _, total := openInterval(); total != 1 {
			t.Fatalf("expected heartbeats to extend the open interval, got %d rows", total)
		}

		// A heartbeat that cannot confirm health leaves the timeline alone.
		anchor(heartbeatActivityState{PlaybackState: "starting"}, now.Add(-20*time.Minute))
		if state, total := openInterval(); state != "healthy" || total != 1 {
			t.Fatalf("expected the open interval untouched, got %q and %d rows", state, total)
		}

		// A renderer failure leaves an impaired interval that the Linux player
		// never clears with an event; the next clean heartbeat replaces it.
		if _, err := env.pool.Exec(ctx, `UPDATE screen_state_intervals SET ended_at=$2 WHERE screen_id=$1 AND ended_at IS NULL`, env.screenID, now.Add(-15*time.Minute)); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO screen_state_intervals(id,screen_id,state,started_at,reason_code) VALUES($1,$2,'degraded',$3,'playback_error')`, uuid.New(), env.screenID, now.Add(-15*time.Minute)); err != nil {
			t.Fatal(err)
		}
		anchor(healthy, now.Add(-5*time.Minute))
		state, total := openInterval()
		if state != "healthy" || total != 3 {
			t.Fatalf("expected a fresh healthy interval after the impaired one, got %q and %d rows", state, total)
		}
		var impairedEnd *time.Time
		if err := env.pool.QueryRow(ctx, `SELECT ended_at FROM screen_state_intervals WHERE screen_id=$1 AND state='degraded'`, env.screenID).Scan(&impairedEnd); err != nil {
			t.Fatal(err)
		}
		if impairedEnd == nil {
			t.Fatal("expected the impaired interval to be closed")
		}
	})
}

func TestUptimeExcludesDisabledRevokedAndRemovedScreens(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		now := time.Now().UTC()
		var organizationID uuid.UUID
		if err := env.pool.QueryRow(ctx, `SELECT organization_id FROM screens WHERE id=$1`, env.screenID).Scan(&organizationID); err != nil {
			t.Fatal(err)
		}
		add := func(name string) uuid.UUID {
			id := uuid.New()
			if _, err := env.pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone,last_heartbeat_at) VALUES($1,$2,$3,$4,'linux','Test','PC','n/a','1.0',1920,1080,1,'en-US','America/New_York',$5)`, id, organizationID, uuid.NewString(), name, now); err != nil {
				t.Fatal(err)
			}
			if _, err := env.pool.Exec(ctx, `INSERT INTO screen_state_intervals(id,screen_id,state,started_at) VALUES($1,$2,'healthy',$3)`, uuid.New(), id, now.Add(-2*time.Hour)); err != nil {
				t.Fatal(err)
			}
			return id
		}
		credential := func(screenID uuid.UUID, revoked bool) {
			pairUptimeScreen(t, env.pool, screenID, revoked)
		}
		// The paired screen from the fixture plus one of each excluded state.
		credential(env.screenID, false)
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET last_heartbeat_at=$2 WHERE id=$1`, env.screenID, now); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO screen_state_intervals(id,screen_id,state,started_at) VALUES($1,$2,'healthy',$3)`, uuid.New(), env.screenID, now.Add(-2*time.Hour)); err != nil {
			t.Fatal(err)
		}
		credential(add("Revoked Player"), true)
		disabled := add("Disabled Player")
		credential(disabled, false)
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET enabled=FALSE WHERE id=$1`, disabled); err != nil {
			t.Fatal(err)
		}
		removed := add("Removed Player")
		credential(removed, false)
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET deleted_at=now() WHERE id=$1`, removed); err != nil {
			t.Fatal(err)
		}

		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/uptime?window=24h", nil)
		request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, env.owner))
		response := httptest.NewRecorder()
		env.server.activityUptime(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("unexpected status %d: %s", response.Code, response.Body.String())
		}
		var payload struct {
			Data uptimeReport `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Data.ScreensTracked != 1 {
			t.Fatalf("expected only the actively paired screen, got %d", payload.Data.ScreensTracked)
		}
		if len(payload.Data.Screens) != 1 || payload.Data.Screens[0].ScreenID != env.screenID {
			t.Fatalf("unexpected screen rows: %+v", payload.Data.Screens)
		}
	})
}

func TestUptimeUsesThirtyDailyBuckets(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		now := time.Now().UTC()
		pairUptimeScreen(t, env.pool, env.screenID, false)
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET last_heartbeat_at=$2 WHERE id=$1`, env.screenID, now); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO screen_state_intervals(id,screen_id,state,started_at) VALUES($1,$2,'healthy',$3)`, uuid.New(), env.screenID, now.Add(-31*24*time.Hour)); err != nil {
			t.Fatal(err)
		}

		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/uptime?window=30d", nil)
		request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, env.owner))
		response := httptest.NewRecorder()
		env.server.activityUptime(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("unexpected status %d: %s", response.Code, response.Body.String())
		}
		var payload struct {
			Data uptimeReport `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Data.Window != "30d" || len(payload.Data.Buckets) != 30 {
			t.Fatalf("expected thirty daily buckets, got window %q with %d", payload.Data.Window, len(payload.Data.Buckets))
		}
	})
}

func TestUptimeRejectsUnsupportedWindow(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/uptime?window=90d", nil)
	response := httptest.NewRecorder()
	(&server{}).activityUptime(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for an unsupported window, got %d", response.Code)
	}
}
