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
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// The Noise Meter's history arrives on the ordinary heartbeat and is
// acknowledged in its response. This covers the three things a Player depends
// on: the count comes back, a repeat is harmless, and a Player that has never
// heard of the feature keeps heartbeating exactly as before.
func TestHeartbeatCarriesNoiseMeterHistory(t *testing.T) {
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
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421977)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421977)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	organizationID, userID, screenID := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Heartbeat Noise Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO plugin_installations(organization_id,plugin_id) VALUES($1,'noise_meter')`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','noise-heartbeat','unused','owner',TRUE)`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,
		device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
		VALUES($1,$2,$3,'Cafeteria','linux','Test','Display','Linux','1',1920,1080,1,'en-US','UTC')`,
		screenID, organizationID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_manifest_state(screen_id) VALUES($1)`, screenID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screen_player_status(screen_id) VALUES($1)`, screenID); err != nil {
		t.Fatal(err)
	}
	pluginService := plugins.NewService(pool, nil)
	if _, err = pluginService.CreateNoiseMeter(ctx, userID, plugins.NoiseMeterInput{
		Name: "Cafeteria noise", WarningLevel: 60, LoudLevel: 80, Sensitivity: 100,
		TriggerHoldMS: 1000, ClearHoldMS: 3000, DisplayMode: "overlay", HeightPX: 96,
		HistoryEnabled: true, HistoryRetentionDays: 7, HistoryActiveHoursOnly: true,
		Enabled: true, TargetScope: "all", TargetIDs: []uuid.UUID{},
	}); err != nil {
		t.Fatal(err)
	}

	s := &server{
		db:      pool,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		devices: devices.NewService(pool, devices.NewPresenceHub(), "http://localhost"),
		plugins: pluginService,
	}
	post := func(body string) (int, map[string]any) {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/player/heartbeat", bytes.NewReader([]byte(body)))
		request = request.WithContext(context.WithValue(request.Context(), deviceContextKey,
			devices.DevicePrincipal{ScreenID: screenID, Enabled: true}))
		recorder := httptest.NewRecorder()
		s.playerHeartbeat(recorder, request)
		var envelope struct {
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &envelope)
		return recorder.Code, envelope.Data
	}

	base := time.Now().UTC().Add(-10 * time.Minute).Truncate(10 * time.Second)
	history := `{"startedAt":"` + base.Format(time.RFC3339) + `","averageLevel":42.5,"peakLevel":71,` +
		`"monitoredMs":10000,"warningMs":2000,"loudMs":0,"triggerCount":0},` +
		`{"startedAt":"` + base.Add(10*time.Second).Format(time.RFC3339) + `","averageLevel":88,"peakLevel":95,` +
		`"monitoredMs":10000,"warningMs":1000,"loudMs":9000,"triggerCount":1}`
	withHistory := `{"screenWidth":1920,"screenHeight":1080,"playerVersion":"0.16.0","playbackState":"playing",` +
		`"noiseMeter":{"status":"loud","currentLevel":88.4,"pendingHistory":[` + history + `]}}`

	status, data := post(withHistory)
	if status != http.StatusOK {
		t.Fatalf("heartbeat status=%d", status)
	}
	acknowledgement, ok := data["noiseHistory"].(map[string]any)
	if !ok || acknowledgement["accepted"] != float64(2) {
		t.Fatalf("heartbeat did not acknowledge the history: %#v", data)
	}
	var rows int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE screen_id=$1`, screenID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("expected two stored buckets, got %d", rows)
	}
	// The live state rides along for player health, as a single current value.
	var reportedStatus string
	var level float64
	if err = pool.QueryRow(ctx, `SELECT noise_meter_status,noise_meter_level FROM screen_player_status WHERE screen_id=$1`, screenID).Scan(&reportedStatus, &level); err != nil {
		t.Fatal(err)
	}
	if reportedStatus != "loud" || level < 88 || level > 89 {
		t.Fatalf("live meter state: %q %v", reportedStatus, level)
	}

	// The Player never saw the response and sends the same batch again.
	if status, data = post(withHistory); status != http.StatusOK {
		t.Fatalf("retry status=%d", status)
	}
	if acknowledgement, ok = data["noiseHistory"].(map[string]any); !ok || acknowledgement["accepted"] != float64(2) {
		t.Fatalf("retry was not acknowledged: %#v", data)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE screen_id=$1`, screenID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("a retried heartbeat duplicated history: %d rows", rows)
	}

	// A Player that predates the feature omits the section entirely. Its
	// heartbeat is an ordinary heartbeat, with nothing to acknowledge.
	status, data = post(`{"screenWidth":1920,"screenHeight":1080,"playerVersion":"0.14.0","playbackState":"playing"}`)
	if status != http.StatusOK || data["accepted"] != true {
		t.Fatalf("legacy heartbeat status=%d data=%#v", status, data)
	}
	if _, present := data["noiseHistory"]; present {
		t.Fatalf("nothing was submitted, so nothing should be acknowledged: %#v", data)
	}
	var lastHeartbeat *time.Time
	if err = pool.QueryRow(ctx, `SELECT last_heartbeat_at FROM screens WHERE id=$1`, screenID).Scan(&lastHeartbeat); err != nil {
		t.Fatal(err)
	}
	if lastHeartbeat == nil {
		t.Fatal("a heartbeat without noise data must still record liveness")
	}

	// A malformed optional section must not cost the lifecycle fields around it.
	status, data = post(`{"screenWidth":1920,"screenHeight":1080,"playerVersion":"0.16.0","playbackState":"playing",` +
		`"noiseMeter":{"status":"loud","pendingHistory":[{"startedAt":"not-a-time","averageLevel":50,"peakLevel":60,` +
		`"monitoredMs":10000,"warningMs":0,"loudMs":0,"triggerCount":0}]}}`)
	if status != http.StatusOK || data["accepted"] != true {
		t.Fatalf("malformed history broke the heartbeat: status=%d data=%#v", status, data)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE screen_id=$1`, screenID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("an unusable record was stored: %d rows", rows)
	}
}
