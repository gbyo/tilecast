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
)

// Noise Meter was removed, but Linux and Edge Players released with it still
// send its heartbeat section. Strict decoding must not refuse their whole
// heartbeat for it: the section is accepted and ignored, nothing is stored,
// and nothing is acknowledged.
func TestHeartbeatAcceptsTheRetiredNoiseMeterSection(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Retired Heartbeat Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','retired-heartbeat','unused','owner',TRUE)`, userID); err != nil {
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
	s := &server{
		db:      pool,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		devices: devices.NewService(pool, devices.NewPresenceHub(), "http://localhost"),
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
	legacy := `{"screenWidth":1920,"screenHeight":1080,"playerVersion":"0.16.0","playbackState":"playing",` +
		`"noiseMeter":{"status":"loud","currentLevel":88.4,"pendingHistory":[{"startedAt":"` +
		base.Format(time.RFC3339) + `","averageLevel":42.5,"peakLevel":71,"monitoredMs":10000,"warningMs":2000,` +
		`"loudMs":0,"triggerCount":0}]}}`
	for _, body := range []string{legacy, `{"playbackState":"playing","noiseMeter":{"status":"inactive"}}`} {
		status, data := post(body)
		if status != http.StatusOK || data["accepted"] != true {
			t.Fatalf("heartbeat with the retired section = %d %#v", status, data)
		}
		if _, acknowledged := data["noiseHistory"]; acknowledged {
			t.Fatalf("retired history was acknowledged: %#v", data)
		}
		if _, ignored := data["ignoredFields"]; ignored {
			t.Fatalf("retired section reported as dropped: %#v", data)
		}
	}
	var rows int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM noise_meter_history WHERE screen_id=$1`, screenID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("retired history stored %d rows (%v)", rows, err)
	}
	var reported *string
	if err = pool.QueryRow(ctx, `SELECT noise_meter_status FROM screen_player_status WHERE screen_id=$1`, screenID).Scan(&reported); err != nil || reported != nil {
		t.Fatalf("retired live status stored %v (%v)", reported, err)
	}
}
