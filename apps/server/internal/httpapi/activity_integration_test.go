package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

type activityTestEnvironment struct {
	server   *server
	pool     *pgxpool.Pool
	screenID uuid.UUID
	owner    auth.Session
}

func withActivityDatabase(t *testing.T, run func(activityTestEnvironment)) {
	t.Helper()
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
	organizationID, screenID, ownerID := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'Activity Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Activity Owner','activity-owner','unused-test-hash','owner',TRUE)`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Cafeteria TV','android-tv','Test','TV','14','1.0',1920,1080,1,'en-US','America/New_York')`, screenID, organizationID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	// A live credential is what makes the screen part of the operational fleet;
	// uptime and fleet health both measure only enrolled, unrevoked screens.
	if _, err = pool.Exec(ctx, `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash) VALUES($1,$2,$3,'\x00'::bytea)`, uuid.New(), screenID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	deviceService := devices.NewService(pool, devices.NewPresenceHub(), "")
	s := &server{db: pool, devices: deviceService, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	run(activityTestEnvironment{server: s, pool: pool, screenID: screenID, owner: auth.Session{User: auth.User{ID: ownerID, Name: "Activity Owner", Username: "activity-owner", Role: "owner", Active: true}}})
}

func TestSocketHeartbeatRecordsLivenessAndUptimeWhenMetadataCannotDecode(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		principal := devices.DevicePrincipal{ScreenID: env.screenID, ScreenName: "Cafeteria TV", Enabled: true}
		socketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.server.playerSocket(w, r.WithContext(context.WithValue(r.Context(), deviceContextKey, principal)))
		}))
		defer socketServer.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(socketServer.URL, "http"), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.CloseNow() //nolint:errcheck

		var hello socketMessage
		if err = wsjson.Read(ctx, connection, &hello); err != nil {
			t.Fatal(err)
		}
		if hello.Type != "server.hello" {
			t.Fatalf("first socket message type = %q", hello.Type)
		}
		if err = wsjson.Write(ctx, connection, map[string]any{
			"type": "player.status",
			"payload": map[string]any{
				"screenWidth":   1920,
				"screenHeight":  1080,
				"playerVersion": "0.2.2",
				"currentItemId": "layout:item",
				"playbackState": "playing",
			},
		}); err != nil {
			t.Fatal(err)
		}

		deadline := time.Now().Add(3 * time.Second)
		for {
			var lastHeartbeat *time.Time
			var openIntervals int
			_ = env.pool.QueryRow(ctx, `SELECT last_heartbeat_at FROM screens WHERE id=$1`, env.screenID).Scan(&lastHeartbeat)
			_ = env.pool.QueryRow(ctx, `SELECT count(*) FROM screen_state_intervals WHERE screen_id=$1 AND ended_at IS NULL AND state='online'`, env.screenID).Scan(&openIntervals)
			if lastHeartbeat != nil && openIntervals == 1 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("socket contact was not recorded: lastHeartbeat=%v openIntervals=%d", lastHeartbeat, openIntervals)
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
}

func TestBackgroundLivenessDoesNotOverwriteForegroundPlaybackState(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		manifestVersion := int64(42)
		cacheLimit := int64(987654321)
		itemID, assetID := uuid.New(), uuid.New()
		if _, err := env.pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,active_manifest_version,current_item_id,current_asset_id,playback_state,cache_limit_bytes) VALUES($1,$2,$3,$4,'playing',$5)`, env.screenID, manifestVersion, itemID, assetID, cacheLimit); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET player_version='2.9.0' WHERE id=$1`, env.screenID); err != nil {
			t.Fatal(err)
		}
		principal := devices.DevicePrincipal{ScreenID: env.screenID, ScreenName: "Cafeteria TV", Enabled: true}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/player/liveness", strings.NewReader(`{}`)).WithContext(context.WithValue(context.Background(), deviceContextKey, principal))
		response := httptest.NewRecorder()

		env.server.playerLivenessWithActivity(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("liveness status=%d body=%s", response.Code, response.Body.String())
		}

		var gotManifest *int64
		var gotItem, gotAsset uuid.UUID
		var gotState, gotVersion string
		var gotCache *int64
		if err := env.pool.QueryRow(ctx, `SELECT active_manifest_version,current_item_id,current_asset_id,playback_state,cache_limit_bytes FROM screen_player_status WHERE screen_id=$1`, env.screenID).Scan(&gotManifest, &gotItem, &gotAsset, &gotState, &gotCache); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(ctx, `SELECT player_version FROM screens WHERE id=$1`, env.screenID).Scan(&gotVersion); err != nil {
			t.Fatal(err)
		}
		if gotManifest == nil || *gotManifest != manifestVersion || gotItem != itemID || gotAsset != assetID || gotState != "playing" || gotVersion != "2.9.0" || gotCache == nil || *gotCache != cacheLimit {
			t.Fatalf("background liveness changed foreground snapshot: manifest=%v item=%q asset=%q state=%q version=%q cache=%v", gotManifest, gotItem, gotAsset, gotState, gotVersion, gotCache)
		}
	})
}

func TestConcurrentHTTPAndWebSocketHeartbeatTransitionsStayAtomic(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		principal := devices.DevicePrincipal{ScreenID: env.screenID, ScreenName: "Cafeteria TV", Enabled: true}
		start := make(chan struct{})
		var group sync.WaitGroup
		group.Add(2)

		go func() {
			defer group.Done()
			<-start
			request := httptest.NewRequest(http.MethodPost, "/api/v1/player/heartbeat", strings.NewReader(`{"screenWidth":1920,"screenHeight":1080,"playerVersion":"0.2.2","playbackState":"playing"}`))
			request = request.WithContext(context.WithValue(request.Context(), deviceContextKey, principal))
			env.server.playerHeartbeatWithActivity(httptest.NewRecorder(), request)
		}()
		go func() {
			defer group.Done()
			<-start
			request := httptest.NewRequest(http.MethodGet, "/api/v1/player/socket", nil)
			env.server.handleSocketStatus(request, context.Background(), principal, json.RawMessage(`{"screenWidth":1920,"screenHeight":1080,"playerVersion":"0.2.2","playbackState":"playing"}`))
		}()
		close(start)
		group.Wait()

		var connected, openIntervals, allOpen int
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_activity_events WHERE screen_id=$1 AND event_type='player.connected'`, env.screenID).Scan(&connected); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM screen_state_intervals WHERE screen_id=$1 AND ended_at IS NULL AND state IN('online','healthy')`, env.screenID).Scan(&openIntervals); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM screen_state_intervals WHERE screen_id=$1 AND ended_at IS NULL`, env.screenID).Scan(&allOpen); err != nil {
			t.Fatal(err)
		}
		if connected != 1 || openIntervals != 1 || allOpen != 1 {
			t.Fatalf("connected=%d openUp=%d allOpen=%d", connected, openIntervals, allOpen)
		}
	})
}

func TestReplacedSocketCannotMarkActiveReplacementDisconnected(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		principal := devices.DevicePrincipal{ScreenID: env.screenID, ScreenName: "Cafeteria TV", Enabled: true}
		socketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.server.playerSocket(w, r.WithContext(context.WithValue(r.Context(), deviceContextKey, principal)))
		}))
		defer socketServer.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		socketURL := "ws" + strings.TrimPrefix(socketServer.URL, "http")
		first, _, err := websocket.Dial(ctx, socketURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer first.CloseNow() //nolint:errcheck
		var hello socketMessage
		if err = wsjson.Read(ctx, first, &hello); err != nil {
			t.Fatal(err)
		}
		first.CloseRead(ctx)

		second, _, err := websocket.Dial(ctx, socketURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer second.CloseNow() //nolint:errcheck
		if err = wsjson.Read(ctx, second, &hello); err != nil {
			t.Fatal(err)
		}

		// Give the replaced handler enough time to run all of its defers. Its
		// token no longer owns presence, so it must not write a disconnect.
		time.Sleep(100 * time.Millisecond)
		var disconnectedAt *time.Time
		if err = env.pool.QueryRow(ctx, `SELECT last_disconnected_at FROM screens WHERE id=$1`, env.screenID).Scan(&disconnectedAt); err != nil {
			t.Fatal(err)
		}
		if disconnectedAt != nil {
			t.Fatalf("replaced socket marked the active replacement disconnected at %v", disconnectedAt)
		}

		_ = second.Close(websocket.StatusNormalClosure, "test complete")
		deadline := time.Now().Add(3 * time.Second)
		for {
			_ = env.pool.QueryRow(ctx, `SELECT last_disconnected_at FROM screens WHERE id=$1`, env.screenID).Scan(&disconnectedAt)
			if disconnectedAt != nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("active socket cleanup did not record a disconnect")
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
}

func TestPlayerActivityDeduplicatesOrdersAndDerivesSessions(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		startID, endID := uuid.New(), uuid.New()
		started := time.Now().UTC().Add(-30 * time.Second).Truncate(time.Microsecond)
		batch := playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: startID, Sequence: 1, EventType: "playlist_item.started", OccurredAt: started, PlayerTimezone: "America/New_York", ManifestVersion: int64Pointer(42), PresentationType: "playlist", PresentationID: "morning", PresentationRev: "3", ContentType: "media", ContentID: "welcome-video", PlaylistItemID: "item-1", ActivitySessionID: "session-1", Result: "playing", ExpectedDurationMS: int64Pointer(30_000), TriggerContext: "schedule", ScheduleID: "schedule-1"},
			{ID: endID, Sequence: 2, EventType: "playlist_item.completed", OccurredAt: started.Add(30 * time.Second), PlayerTimezone: "America/New_York", ManifestVersion: int64Pointer(42), PresentationType: "playlist", PresentationID: "morning", ContentType: "media", ContentID: "welcome-video", PlaylistItemID: "item-1", ActivitySessionID: "session-1", Result: "completed", DurationMS: int64Pointer(30_000)},
		}}
		postActivityBatch(t, env, batch, http.StatusAccepted)
		postActivityBatch(t, env, batch, http.StatusAccepted)
		var count int
		if err := env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_activity_events WHERE screen_id=$1`, env.screenID).Scan(&count); err != nil || count != 2 {
			t.Fatalf("event count=%d err=%v", count, err)
		}
		var result string
		var duration int64
		if err := env.pool.QueryRow(context.Background(), `SELECT result,actual_duration_ms FROM playback_sessions WHERE screen_id=$1 AND activity_session_id='session-1'`, env.screenID).Scan(&result, &duration); err != nil {
			t.Fatal(err)
		}
		if result != "completed" || duration != 30_000 {
			t.Fatalf("session result=%s duration=%d", result, duration)
		}
		rows, err := env.pool.Query(context.Background(), `SELECT sequence FROM player_activity_events WHERE screen_id=$1 ORDER BY sequence`, env.screenID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var sequences []int64
		for rows.Next() {
			var sequence int64
			_ = rows.Scan(&sequence)
			sequences = append(sequences, sequence)
		}
		if len(sequences) != 2 || sequences[0] != 1 || sequences[1] != 2 {
			t.Fatalf("sequences=%v", sequences)
		}
	})
}

func TestPlayerActivityMissingStopsBecomePartialOrUnknown(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC().Truncate(time.Microsecond)
		batch := playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: uuid.New(), Sequence: 1, EventType: "presentation.started", OccurredAt: now.Add(-20 * time.Minute), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "lunch", ActivitySessionID: "old-root", Result: "playing"},
			{ID: uuid.New(), Sequence: 2, EventType: "presentation.started", OccurredAt: now.Add(-10 * time.Minute), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "afternoon", ActivitySessionID: "new-root", Result: "playing"},
			{ID: uuid.New(), Sequence: 3, EventType: "widget.started", OccurredAt: now.Add(-7 * time.Hour), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "afternoon", ContentType: "widget", ContentID: "weather", ActivitySessionID: "stale-widget", Result: "playing"},
		}}
		postActivityBatch(t, env, batch, http.StatusAccepted)
		var oldResult, staleResult string
		if err := env.pool.QueryRow(context.Background(), `SELECT result FROM playback_sessions WHERE activity_session_id='old-root'`).Scan(&oldResult); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(context.Background(), `SELECT result FROM playback_sessions WHERE activity_session_id='stale-widget'`).Scan(&staleResult); err != nil {
			t.Fatal(err)
		}
		if oldResult != "partial" || staleResult != "unknown" {
			t.Fatalf("old=%s stale=%s", oldResult, staleResult)
		}
	})
}

func TestLayoutPlaylistZoneAndFailedWidgetPreserveRootSession(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
		parent := "layout-root"
		batch := playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: uuid.New(), Sequence: 1, EventType: "presentation.started", OccurredAt: now, PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria-layout", PresentationRev: "4", ActivitySessionID: parent, Result: "playing"},
			{ID: uuid.New(), Sequence: 2, EventType: "playlist_item.started", OccurredAt: now.Add(time.Second), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria-layout", ContentType: "media", ContentID: "lunch-video", PlaylistItemID: "zone-item", LayoutPlacementID: "playlist-zone-a", ActivitySessionID: "zone-play", Result: "playing", Metadata: map[string]any{"parentActivitySessionId": parent}},
			{ID: uuid.New(), Sequence: 3, EventType: "playlist_item.completed", OccurredAt: now.Add(31 * time.Second), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria-layout", ContentType: "media", ContentID: "lunch-video", PlaylistItemID: "zone-item", LayoutPlacementID: "playlist-zone-a", ActivitySessionID: "zone-play", Result: "completed", DurationMS: int64Pointer(30_000)},
			{ID: uuid.New(), Sequence: 4, EventType: "widget.started", OccurredAt: now.Add(2 * time.Second), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria-layout", ContentType: "widget", ContentID: "weather-widget", LayoutPlacementID: "weather-placement", ActivitySessionID: "widget-play", Result: "playing", Metadata: map[string]any{"parentActivitySessionId": parent}},
			{ID: uuid.New(), Sequence: 5, EventType: "widget.failed", OccurredAt: now.Add(4 * time.Second), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria-layout", ContentType: "widget", ContentID: "weather-widget", LayoutPlacementID: "weather-placement", ActivitySessionID: "widget-play", Result: "failed", DurationMS: int64Pointer(2_000), FailureCode: "renderer_failure"},
		}}
		postActivityBatch(t, env, batch, http.StatusAccepted)
		var rootEnded *time.Time
		var zoneResult, widgetResult, zonePlacement string
		if err := env.pool.QueryRow(context.Background(), `SELECT ended_at FROM playback_sessions WHERE activity_session_id=$1`, parent).Scan(&rootEnded); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(context.Background(), `SELECT result,layout_placement_id FROM playback_sessions WHERE activity_session_id='zone-play'`).Scan(&zoneResult, &zonePlacement); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(context.Background(), `SELECT result FROM playback_sessions WHERE activity_session_id='widget-play'`).Scan(&widgetResult); err != nil {
			t.Fatal(err)
		}
		if rootEnded != nil || zoneResult != "completed" || zonePlacement != "playlist-zone-a" || widgetResult != "failed" {
			t.Fatalf("rootEnded=%v zone=%s placement=%s widget=%s", rootEnded, zoneResult, zonePlacement, widgetResult)
		}
	})
}

func TestPlaybackGapAppearsInOverviewAndClosesProofUnknown(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC().Truncate(time.Microsecond)
		lastContact := now.Add(-5 * time.Minute)
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: uuid.New(), Sequence: 1, EventType: "presentation.started", OccurredAt: now.Add(-10 * time.Minute), PlayerTimezone: "UTC", PresentationType: "playlist", PresentationID: "morning-announcements", ActivitySessionID: "gap-root", Result: "playing"},
		}}, http.StatusAccepted)
		if _, err := env.pool.Exec(context.Background(), `UPDATE screens SET last_heartbeat_at=$2 WHERE id=$1`, env.screenID, lastContact); err != nil {
			t.Fatal(err)
		}
		principal := devices.DevicePrincipal{ScreenID: env.screenID, ScreenName: "Cafeteria TV", Enabled: true}
		heartbeatRequest := httptest.NewRequest(http.MethodPost, "/api/v1/player/heartbeat", strings.NewReader(`{"screenWidth":1920,"screenHeight":1080,"playerVersion":"1.0","playbackState":"playing"}`))
		heartbeatRequest = heartbeatRequest.WithContext(context.WithValue(heartbeatRequest.Context(), deviceContextKey, principal))
		heartbeatResponse := httptest.NewRecorder()
		env.server.playerHeartbeatWithActivity(heartbeatResponse, heartbeatRequest)
		if heartbeatResponse.Code != http.StatusOK {
			t.Fatalf("heartbeat status=%d body=%s", heartbeatResponse.Code, heartbeatResponse.Body.String())
		}

		var result string
		var endedAt time.Time
		if err := env.pool.QueryRow(context.Background(), `SELECT result,ended_at FROM playback_sessions WHERE activity_session_id='gap-root'`).Scan(&result, &endedAt); err != nil {
			t.Fatal(err)
		}
		if result != "unknown" || !endedAt.Equal(lastContact) {
			t.Fatalf("gap session result=%q endedAt=%v", result, endedAt)
		}

		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/overview?range=24h", nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.activityOverview(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("overview status=%d body=%s", response.Code, response.Body.String())
		}
		var envelope struct {
			Data activityOverviewData `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.Cards.ScreensWithReportingGaps != 1 {
			t.Fatalf("reporting gaps=%d overview=%s", envelope.Data.Cards.ScreensWithReportingGaps, response.Body.String())
		}
		// Fleet health must count the operational population, not repeat the
		// heartbeat check the old "reporting normally" card made.
		if envelope.Data.Fleet.Measured != 1 {
			t.Fatalf("fleet measured=%d overview=%s", envelope.Data.Fleet.Measured, response.Body.String())
		}
		if total := envelope.Data.Fleet.Healthy + envelope.Data.Fleet.Impaired + envelope.Data.Fleet.Offline + envelope.Data.Fleet.Unmeasured; total != envelope.Data.Fleet.Measured {
			t.Fatalf("fleet states sum to %d, measured %d: %s", total, envelope.Data.Fleet.Measured, response.Body.String())
		}
		// The dashboard indexes into these collections directly; empty lists
		// must marshal as [] rather than null.
		var shape struct {
			Data map[string]json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &shape); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"timeline"} {
			if string(shape.Data[field]) == "null" {
				t.Fatalf("overview %s marshaled as null: %s", field, response.Body.String())
			}
		}
	})
}

func TestActivityOverviewReturnsServerErrorWhenRequiredQueryFails(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		if _, err := env.pool.Exec(context.Background(), `ALTER TABLE audit_logs RENAME TO audit_logs_unavailable_for_activity_test`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := env.pool.Exec(context.Background(), `ALTER TABLE audit_logs_unavailable_for_activity_test RENAME TO audit_logs`); err != nil {
				t.Errorf("restore audit_logs table: %v", err)
			}
		}()

		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/overview?range=24h", nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.activityOverview(response, request)
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("overview status=%d body=%s, want 500", response.Code, response.Body.String())
		}
		if !strings.Contains(response.Body.String(), `"code":"internal_error"`) {
			t.Fatalf("overview error=%s, want internal_error", response.Body.String())
		}
	})
}

func TestScreenActivityReturnsServerErrorWhenRequiredQueryFails(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		if _, err := env.pool.Exec(context.Background(), `ALTER TABLE player_activity_events RENAME TO player_activity_events_unavailable_for_activity_test`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := env.pool.Exec(context.Background(), `ALTER TABLE player_activity_events_unavailable_for_activity_test RENAME TO player_activity_events`); err != nil {
				t.Errorf("restore player_activity_events table: %v", err)
			}
		}()

		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/screens/"+env.screenID.String(), nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.screenActivity(response, request)
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("screen activity status=%d body=%s, want 500", response.Code, response.Body.String())
		}
		if !strings.Contains(response.Body.String(), `"code":"internal_error"`) {
			t.Fatalf("screen activity error=%s, want internal_error", response.Body.String())
		}
	})
}

func TestScreenActivityAllowsNoCurrentPresentation(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/screens/"+env.screenID.String(), nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.screenActivity(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("screen activity status=%d body=%s, want 200", response.Code, response.Body.String())
		}
		var envelope struct {
			Data screenActivityData `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.CurrentPresentation != nil || envelope.Data.RecentProof == nil || envelope.Data.RecentEvents == nil {
			t.Fatalf("screen activity returned invalid empty state: %s", response.Body.String())
		}
	})
}

func TestAuditFilteringRedactionAndCSV(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		auditID := uuid.New()
		_, err := env.pool.Exec(context.Background(), `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,result,ip_address,request_id,summary,metadata,metadata_sensitive,created_at) VALUES($1,$2,'layouts.published','layout',$3,'Morning Layout','success','192.0.2.10','request-1','Activity Owner published Morning Layout','{"revision":4,"diagnosticPayload":"private"}'::jsonb,TRUE,now()-interval '1 second')`, auditID, env.owner.User.ID, uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		editor := auth.Session{User: auth.User{ID: uuid.New(), Role: "editor", Active: true}}
		request := httptest.NewRequest(http.MethodGet, "/api/v1/activity/audit?resourceType=layout&search=Morning", nil)
		request = requestWithTestPrincipal(request, editor)
		response := httptest.NewRecorder()
		env.server.listAuditActivity(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("audit status=%d body=%s", response.Code, response.Body.String())
		}
		var envelope struct {
			Data auditActivityPage `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || len(envelope.Data.Items) != 1 {
			t.Fatalf("audit response=%s err=%v", response.Body.String(), err)
		}
		item := envelope.Data.Items[0]
		if item.IPAddress != "" || item.RequestID != "" || item.Metadata["redacted"] != true {
			t.Fatalf("editor saw sensitive audit data: %#v", item)
		}

		exportRequest := httptest.NewRequest(http.MethodGet, "/api/v1/activity/audit/export.csv?resourceType=layout", nil)
		exportRequest = requestWithTestPrincipal(exportRequest, env.owner)
		exportResponse := httptest.NewRecorder()
		env.server.exportAuditActivity(exportResponse, exportRequest)
		if exportResponse.Code != http.StatusOK || !strings.Contains(exportResponse.Body.String(), "Morning Layout") || !strings.Contains(exportResponse.Body.String(), "Timestamp,Actor") {
			t.Fatalf("audit CSV=%d %s", exportResponse.Code, exportResponse.Body.String())
		}
	})
}

func TestDateAwareProofAttributionAndAuditRedaction(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		event := playerActivityEventInput{ID: uuid.New(), Sequence: 1, EventType: "data_widget.activated", OccurredAt: time.Now().UTC(), PlayerTimezone: "UTC", PresentationType: "layout", PresentationID: "cafeteria", ContentType: "widget", ContentID: "menu-widget", LayoutPlacementID: "menu-placement", ActivitySessionID: "menu-session", Result: "playing", SourceID: "lunch-menu", SelectedRecordID: "2026-07-15-lunch", SelectionDate: "2026-07-15", SourceCachedAt: timePointer(time.Now().UTC().Add(-time.Minute)), SourceRevision: "rev-8", SnapshotHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{event}}, http.StatusAccepted)
		var recordID, sourceID, snapshot string
		if err := env.pool.QueryRow(context.Background(), `SELECT selected_record_id,source_id,snapshot_hash FROM playback_sessions WHERE activity_session_id='menu-session'`).Scan(&recordID, &sourceID, &snapshot); err != nil {
			t.Fatal(err)
		}
		if recordID != "2026-07-15-lunch" || sourceID != "lunch-menu" || len(snapshot) != 64 {
			t.Fatalf("attribution=%s %s %s", recordID, sourceID, snapshot)
		}
		clean := sanitizeActivityMap(map[string]any{"password": "never", "safe": "shown", "nested": map[string]any{"sessionToken": "never", "field": "value"}}, false)
		if _, ok := clean["password"]; ok || clean["safe"] != "shown" {
			t.Fatalf("unsafe metadata=%#v", clean)
		}
		nested := clean["nested"].(map[string]any)
		if _, ok := nested["sessionToken"]; ok || nested["field"] != "value" {
			t.Fatalf("unsafe nested metadata=%#v", nested)
		}
	})
}

func TestActivityExportsAndRetentionRespectPermissions(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		viewerRequest := httptest.NewRequest(http.MethodGet, "/api/v1/activity/proof-of-play/export.csv", nil)
		viewerRequest = requestWithTestPrincipal(viewerRequest, auth.Session{User: auth.User{ID: uuid.New(), Role: "viewer"}})
		viewerResponse := httptest.NewRecorder()
		env.server.exportProofOfPlay(viewerResponse, viewerRequest)
		if viewerResponse.Code != http.StatusForbidden {
			t.Fatalf("viewer export status=%d", viewerResponse.Code)
		}

		old := time.Now().UTC().Add(-400 * 24 * time.Hour)
		_, _ = env.pool.Exec(context.Background(), `INSERT INTO player_activity_events(id,screen_id,sequence,event_type,category,severity,occurred_at,player_timezone,result) VALUES($1,$2,1,'player.connected','connectivity','info',$3,'UTC','success')`, uuid.New(), env.screenID, old)
		_, _ = env.pool.Exec(context.Background(), `UPDATE activity_retention_settings SET raw_event_days=60`)
		env.server.cleanupActivityBounded(context.Background(), 500)
		var count int
		_ = env.pool.QueryRow(context.Background(), `SELECT count(*) FROM player_activity_events WHERE screen_id=$1 AND occurred_at=$2`, env.screenID, old).Scan(&count)
		if count != 0 {
			t.Fatalf("old activity events were not cleaned up")
		}
	})
}

func TestOverlappingZonesDoNotInflateScreenPlaybackTime(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
		insertSession := func(sessionType, key string, offset, length time.Duration, parent string) {
			t.Helper()
			var parentID *uuid.UUID
			if parent != "" {
				var found uuid.UUID
				if err := env.pool.QueryRow(ctx, `SELECT id FROM playback_sessions WHERE screen_id=$1 AND activity_session_id=$2`, env.screenID, parent).Scan(&found); err != nil {
					t.Fatal(err)
				}
				parentID = &found
			}
			if _, err := env.pool.Exec(ctx, `
				INSERT INTO playback_sessions(id,screen_id,parent_session_id,activity_session_id,started_at,ended_at,actual_duration_ms,result,session_type,terminal_reason)
				VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,'completed_duration')`,
				uuid.New(), env.screenID, parentID, key, start.Add(offset), start.Add(offset+length), length.Milliseconds(), sessionType); err != nil {
				t.Fatal(err)
			}
		}

		// One ten-minute root presentation with two layout zones playing for its
		// whole length. Real screen time is ten minutes; exposure is twenty.
		insertSession("presentation", "root-a", 0, 10*time.Minute, "")
		insertSession("layout_placement", "zone-1", 0, 10*time.Minute, "root-a")
		insertSession("layout_placement", "zone-2", 0, 10*time.Minute, "root-a")
		// A second root that overlaps the first by five minutes, as happens when
		// a replacement starts before the outgoing session is closed.
		insertSession("presentation", "root-b", 5*time.Minute, 10*time.Minute, "")

		durations, err := env.server.playbackDurations(ctx, start.Add(-time.Minute), start.Add(time.Hour), uuid.Nil, false)
		if err != nil {
			t.Fatal(err)
		}
		if got := durations.ConfirmedScreenMS; got != (15 * time.Minute).Milliseconds() {
			t.Fatalf("confirmed screen playback = %dms, want the 15-minute union of both roots", got)
		}
		if got := durations.ContentExposureMS; got != (20 * time.Minute).Milliseconds() {
			t.Fatalf("content exposure = %dms, want 20 minutes across both zones", got)
		}

		// Clipping: a window covering only the first five minutes sees only that.
		clipped, err := env.server.playbackDurations(ctx, start, start.Add(5*time.Minute), uuid.Nil, false)
		if err != nil {
			t.Fatal(err)
		}
		if got := clipped.ConfirmedScreenMS; got != (5 * time.Minute).Milliseconds() {
			t.Fatalf("clipped screen playback = %dms, want 5 minutes", got)
		}

		// This root begins before the summary range and contributes only its
		// final minute. Interval metrics must clip it rather than omit it.
		insertSession("presentation", "root-before-range", -6*time.Minute, 6*time.Minute, "")

		// The Proof-of-Play summary promises the same wall-clock semantics as
		// the Overview. It used to sum actual_duration_ms here, turning the two
		// overlapping roots into twenty minutes while labelling the result
		// "overlaps merged".
		request := httptest.NewRequest(
			http.MethodGet,
			"/api/v1/activity/proof-of-play/summary?dimension=screen&from="+
				start.Add(-time.Minute).Format(time.RFC3339)+"&to="+
				start.Add(time.Hour).Format(time.RFC3339),
			nil,
		)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.proofOfPlaySummary(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("proof summary status=%d body=%s", response.Code, response.Body.String())
		}
		var envelope struct {
			Data struct {
				Items []proofSummaryItem `json:"items"`
			} `json:"data"`
		}
		if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
			t.Fatal(err)
		}
		if len(envelope.Data.Items) != 1 {
			t.Fatalf("proof summary items=%d body=%s", len(envelope.Data.Items), response.Body.String())
		}
		item := envelope.Data.Items[0]
		if item.ConfirmedScreenPlaybackMS != (16 * time.Minute).Milliseconds() {
			t.Fatalf("proof summary screen playback=%dms, want clipped 16-minute union", item.ConfirmedScreenPlaybackMS)
		}
		if item.ContentExposureMS != (20 * time.Minute).Milliseconds() {
			t.Fatalf("proof summary exposure=%dms, want 20 minutes", item.ContentExposureMS)
		}
	})
}

func TestInterruptedPlaysCountOnlyUnexpectedEndings(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		start := time.Now().UTC().Add(-time.Hour)
		for index, reason := range []string{
			// Expected endings: an operator asked for these, or they are simply
			// how playback works.
			"schedule_transition", "expected_item_boundary", "takeover", "manual_skip",
			// Unknown is not evidence of an interruption either.
			"unknown",
			// Genuine interruptions.
			"renderer_failure", "heartbeat_gap",
		} {
			if _, err := env.pool.Exec(ctx, `
				INSERT INTO playback_sessions(id,screen_id,activity_session_id,started_at,ended_at,actual_duration_ms,result,session_type,terminal_reason)
				VALUES($1,$2,$3,$4,$5,1000,'partial','presentation',$6)`,
				uuid.New(), env.screenID, "session-"+reason, start.Add(time.Duration(index)*time.Minute), start.Add(time.Duration(index)*time.Minute+time.Second), reason); err != nil {
				t.Fatal(err)
			}
		}

		var interrupted int64
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE screen_id=$1 AND terminal_reason = ANY($2)`, env.screenID, interruptedTerminalReasons()).Scan(&interrupted); err != nil {
			t.Fatal(err)
		}
		if interrupted != 2 {
			t.Fatalf("interrupted plays = %d, want only the renderer failure and the heartbeat gap", interrupted)
		}
	})
}

func TestFleetHealthMeasuresOnlyTheOperationalFleet(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		now := time.Now().UTC()

		// The fixture screen: reporting and confirmed playing.
		if _, err := env.pool.Exec(ctx, `UPDATE screens SET last_heartbeat_at=$2 WHERE id=$1`, env.screenID, now.Add(-time.Minute)); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id,playback_state,active_manifest_version,foreground_state) VALUES($1,'playing',3,'foreground')`, env.screenID); err != nil {
			t.Fatal(err)
		}

		var organizationID uuid.UUID
		if err := env.pool.QueryRow(ctx, `SELECT organization_id FROM screens WHERE id=$1`, env.screenID).Scan(&organizationID); err != nil {
			t.Fatal(err)
		}
		// Each of these is out of service for an administrative reason, so none
		// of them may appear in an operational count.
		excluded := []struct {
			name  string
			apply string
		}{
			{"disabled", `UPDATE screens SET enabled=FALSE WHERE id=$1`},
			{"archived", `UPDATE screens SET archived_at=now() WHERE id=$1`},
			{"deleted", `UPDATE screens SET deleted_at=now() WHERE id=$1`},
			{"revoked", `UPDATE device_credentials SET revoked_at=now() WHERE screen_id=$1`},
		}
		for _, item := range excluded {
			id := uuid.New()
			if _, err := env.pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone,last_heartbeat_at) VALUES($1,$2,$3,$4,'android-tv','Test','TV','14','1.0',1920,1080,1,'en-US','America/New_York',now())`, id, organizationID, uuid.NewString(), item.name); err != nil {
				t.Fatal(err)
			}
			if _, err := env.pool.Exec(ctx, `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash) VALUES($1,$2,$3,'\x00'::bytea)`, uuid.New(), id, uuid.NewString()); err != nil {
				t.Fatal(err)
			}
			if _, err := env.pool.Exec(ctx, item.apply, id); err != nil {
				t.Fatalf("%s: %v", item.name, err)
			}
		}

		health, err := env.server.fleetHealth(ctx, now, uuid.Nil, false)
		if err != nil {
			t.Fatal(err)
		}
		if health.Measured != 1 || health.Healthy != 1 || health.Online != 1 {
			t.Fatalf("fleet health = %+v, want one healthy online screen", health)
		}
		if health.Impaired != 0 || health.Offline != 0 || health.Unmeasured != 0 {
			t.Fatalf("out-of-service screens leaked into fleet health: %+v", health)
		}

		// The same screen in safe mode is impaired, not healthy, even though its
		// heartbeat has not changed.
		if _, err := env.pool.Exec(ctx, `UPDATE screen_player_status SET safe_mode=TRUE WHERE screen_id=$1`, env.screenID); err != nil {
			t.Fatal(err)
		}
		health, err = env.server.fleetHealth(ctx, now, uuid.Nil, false)
		if err != nil {
			t.Fatal(err)
		}
		if health.Healthy != 0 || health.Impaired != 1 || health.Online != 1 {
			t.Fatalf("safe mode should be impaired but online: %+v", health)
		}
	})
}

func TestArchivedScreensAreExcludedFromActivityEventsAndTimeline(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC()
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			{ID: uuid.New(), Sequence: 1, EventType: "presentation.started", OccurredAt: now, PlayerTimezone: "UTC", Result: "playing"},
		}}, http.StatusAccepted)
		if _, err := env.pool.Exec(context.Background(), `UPDATE screens SET archived_at=now() WHERE id=$1`, env.screenID); err != nil {
			t.Fatal(err)
		}

		eventsRequest := httptest.NewRequest(http.MethodGet, "/api/v1/activity/events?range=24h&screen="+env.screenID.String(), nil)
		eventsRequest = requestWithTestPrincipal(eventsRequest, env.owner)
		eventsResponse := httptest.NewRecorder()
		env.server.listScreenEvents(eventsResponse, eventsRequest)
		if eventsResponse.Code != http.StatusOK {
			t.Fatalf("events status=%d body=%s", eventsResponse.Code, eventsResponse.Body.String())
		}
		var eventsEnvelope struct {
			Data screenEventPage `json:"data"`
		}
		if err := json.Unmarshal(eventsResponse.Body.Bytes(), &eventsEnvelope); err != nil {
			t.Fatal(err)
		}
		if len(eventsEnvelope.Data.Items) != 0 {
			t.Fatalf("archived screen leaked %d activity events", len(eventsEnvelope.Data.Items))
		}

		timelineRequest := httptest.NewRequest(http.MethodGet, "/api/v1/activity/screens/"+env.screenID.String()+"/timeline?range=24h", nil)
		timelineRequest = requestWithTestPrincipal(timelineRequest, env.owner)
		timelineResponse := httptest.NewRecorder()
		env.server.screenTimeline(timelineResponse, timelineRequest)
		if timelineResponse.Code != http.StatusNotFound {
			t.Fatalf("archived screen timeline status=%d body=%s, want 404", timelineResponse.Code, timelineResponse.Body.String())
		}

		screenRequest := httptest.NewRequest(http.MethodGet, "/api/v1/activity/screens/"+env.screenID.String(), nil)
		screenRequest = requestWithTestPrincipal(screenRequest, env.owner)
		screenResponse := httptest.NewRecorder()
		env.server.screenActivity(screenResponse, screenRequest)
		if screenResponse.Code != http.StatusNotFound {
			t.Fatalf("archived screen activity status=%d body=%s, want 404", screenResponse.Code, screenResponse.Body.String())
		}
	})
}

func postActivityBatch(t *testing.T, env activityTestEnvironment, input playerActivityBatchInput, expected int) {
	t.Helper()
	_ = postActivityBatchResult(t, env, input, expected)
}

func postActivityBatchResult(t *testing.T, env activityTestEnvironment, input playerActivityBatchInput, expected int) playerActivityBatchResult {
	t.Helper()
	body, _ := json.Marshal(input)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/player/activity-events", bytes.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), deviceContextKey, devices.DevicePrincipal{ScreenID: env.screenID, Enabled: true}))
	response := httptest.NewRecorder()
	env.server.ingestPlayerActivity(response, request)
	if response.Code != expected {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if expected != http.StatusAccepted {
		return playerActivityBatchResult{}
	}
	var envelope struct {
		Data playerActivityBatchResult `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode activity response: %v", err)
	}
	return envelope.Data
}

func TestActivitySequenceResetPreservesNewEvent(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		now := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
		originalID := uuid.New()
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{{
			ID: originalID, Sequence: 1, EventType: "player.connected",
			OccurredAt: now, PlayerTimezone: "UTC", Result: "success",
		}}}, http.StatusAccepted)

		// Simulate a Player whose local sequence file was lost/corrupted. The UUID
		// proves this is a new event even though the reported sequence restarted.
		resetID := uuid.New()
		body, _ := json.Marshal(playerActivityBatchInput{Events: []playerActivityEventInput{{
			ID: resetID, Sequence: 1, EventType: "connection.restored",
			OccurredAt: now.Add(time.Second), PlayerTimezone: "UTC", Result: "recovered",
		}}})
		request := httptest.NewRequest(http.MethodPost, "/api/v1/player/activity-events", bytes.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), deviceContextKey, devices.DevicePrincipal{ScreenID: env.screenID, Enabled: true}))
		response := httptest.NewRecorder()
		env.server.ingestPlayerActivity(response, request)
		if response.Code != http.StatusAccepted {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var envelope struct {
			Data playerActivityBatchResult `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.Accepted != 1 || envelope.Data.Duplicates != 0 ||
			len(envelope.Data.AcknowledgedEventIDs) != 1 || envelope.Data.AcknowledgedEventIDs[0] != resetID.String() {
			t.Fatalf("sequence-reset response = %+v", envelope.Data)
		}

		var sequence *int64
		var metadata map[string]any
		var raw []byte
		if err := env.pool.QueryRow(context.Background(),
			`SELECT sequence,metadata FROM player_activity_events WHERE id=$1`, resetID).
			Scan(&sequence, &raw); err != nil {
			t.Fatal(err)
		}
		if sequence != nil {
			t.Fatalf("recovered event sequence=%d, want NULL", *sequence)
		}
		if err := json.Unmarshal(raw, &metadata); err != nil {
			t.Fatal(err)
		}
		if metadata["sequenceCollision"] != true || metadata["reportedSequence"] != float64(1) {
			t.Fatalf("recovery metadata = %#v", metadata)
		}

		var count int
		if err := env.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM player_activity_events WHERE id=ANY($1)`, []uuid.UUID{originalID, resetID}).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 2 {
			t.Fatalf("stored reset events=%d, want 2", count)
		}

		// A true retry still deduplicates by UUID and does not create a third row.
		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{{
			ID: resetID, Sequence: 1, EventType: "connection.restored",
			OccurredAt: now.Add(time.Second), PlayerTimezone: "UTC", Result: "recovered",
		}}}, http.StatusAccepted)
		if err := env.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM player_activity_events WHERE id=ANY($1)`, []uuid.UUID{originalID, resetID}).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 2 {
			t.Fatalf("retry created extra activity row: %d", count)
		}
	})
}

func int64Pointer(value int64) *int64        { return &value }
func timePointer(value time.Time) *time.Time { return &value }

// The per-screen timeline exists so one screen's history is a single ordered
// stream. Before it, answering "what happened at 09:14" meant reading four
// lists and lining them up by eye.
func TestScreenTimelineMergesEverySource(t *testing.T) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := context.Background()
		now := time.Now().UTC()

		postActivityBatch(t, env, playerActivityBatchInput{Events: []playerActivityEventInput{
			{
				ID: uuid.New(), Sequence: 1, EventType: "presentation.started",
				OccurredAt: now.Add(-30 * time.Minute), PlayerTimezone: "UTC",
				ActivitySessionID: "root-timeline", PresentationType: "playlist",
				PresentationID: "playlist-a", Result: "playing",
			},
			{
				ID: uuid.New(), Sequence: 2, EventType: "renderer.failure",
				OccurredAt: now.Add(-20 * time.Minute), PlayerTimezone: "UTC",
				Result: "failed", FailureCode: "renderer_failure",
			},
		}}, http.StatusAccepted)
		if _, err := env.pool.Exec(ctx, `
			INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,summary,created_at)
			VALUES($1,$2,'screen.updated','screen',$3,'success','Renamed the screen',now()-interval '1 second')`,
			uuid.New(), env.owner.User.ID, env.screenID.String()); err != nil {
			t.Fatal(err)
		}

		request := httptest.NewRequest(http.MethodGet,
			"/api/v1/activity/screens/"+env.screenID.String()+"/timeline?range=24h", nil)
		request = requestWithTestPrincipal(request, env.owner)
		response := httptest.NewRecorder()
		env.server.screenTimeline(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("timeline status=%d body=%s", response.Code, response.Body.String())
		}
		var envelope struct {
			Data screenTimelineResponse `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}

		domains := map[string]bool{}
		for _, entry := range envelope.Data.Entries {
			domains[entry.Domain] = true
		}
		// Events, derived state intervals, playback sessions, incidents and
		// administrative changes all reach the same stream.
		for _, domain := range []string{"playback", "state", "incidents", "audit"} {
			if !domains[domain] {
				t.Errorf("timeline is missing the %s domain: %+v", domain, domains)
			}
		}
		// Newest first, with no exceptions.
		for index := 1; index < len(envelope.Data.Entries); index++ {
			if envelope.Data.Entries[index].Timestamp.After(envelope.Data.Entries[index-1].Timestamp) {
				t.Fatalf("timeline is out of order at %d", index)
			}
		}
		// The health classification comes from the same classifier the fleet
		// section uses, so the two pages cannot disagree.
		if envelope.Data.Status.Health == "" || envelope.Data.Status.HealthReason == "" {
			t.Fatalf("current status is missing its health classification: %+v", envelope.Data.Status)
		}
		if envelope.Data.Status.CurrentIncident == "" {
			t.Fatal("a renderer failure should leave an open incident on the status header")
		}

		filtered := httptest.NewRequest(http.MethodGet,
			"/api/v1/activity/screens/"+env.screenID.String()+"/timeline?range=24h&domain=audit", nil)
		filtered = requestWithTestPrincipal(filtered, env.owner)
		filteredResponse := httptest.NewRecorder()
		env.server.screenTimeline(filteredResponse, filtered)
		var filteredEnvelope struct {
			Data screenTimelineResponse `json:"data"`
		}
		if err := json.Unmarshal(filteredResponse.Body.Bytes(), &filteredEnvelope); err != nil {
			t.Fatal(err)
		}
		if len(filteredEnvelope.Data.Entries) == 0 {
			t.Fatal("filtering to audit returned nothing")
		}
		for _, entry := range filteredEnvelope.Data.Entries {
			if entry.Domain != "audit" {
				t.Fatalf("domain filter leaked a %s entry", entry.Domain)
			}
		}
	})
}
