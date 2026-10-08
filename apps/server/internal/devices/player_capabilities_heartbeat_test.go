package devices

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// TestHeartbeatStoresPlayerCapabilities proves the generic capability
// report persists through the heartbeat: known entries land, unknown
// entries are dropped, nil keeps the stored report, and an explicit
// empty report clears it.
func TestHeartbeatStoresPlayerCapabilities(t *testing.T) {
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
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	orgID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id)VALUES(TRUE,'Capability Test',$1)`, orgID); err != nil {
		t.Fatal(err)
	}
	screenID, credentialID := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)VALUES($1,$2,$3,'Capability Screen','linux','Test','Test','none','1.0',1920,1080,1,'en-US','UTC')`, screenID, orgID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO device_credentials(id,screen_id,public_id,secret_hash)VALUES($1,$2,$3,$4)`, credentialID, screenID, uuid.NewString(), make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, NewPresenceHub(), "https://signage.example.org")
	principal := DevicePrincipal{CredentialID: credentialID, ScreenID: screenID, ScreenName: "Capability Screen", Enabled: true}
	stored := func() map[string]PlayerCapabilityReport {
		t.Helper()
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT COALESCE(player_capabilities,'{}'::jsonb)::text FROM screen_player_status WHERE screen_id=$1`, screenID).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var out map[string]PlayerCapabilityReport
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	beat := func(caps map[string]PlayerCapabilityReport) {
		t.Helper()
		if err := service.Heartbeat(ctx, principal, Heartbeat{
			ScreenWidth: 1920, ScreenHeight: 1080, PlayerVersion: "1.0",
			PlayerCapabilities: caps,
		}, "192.168.1.42:1234"); err != nil {
			t.Fatal(err)
		}
	}

	beat(map[string]PlayerCapabilityReport{
		"display.power":  {Version: 1, Provider: "hdmi_cec"},
		"display.eject":  {Version: 1, Provider: "network"},
		"display.volume": {Version: 2, Provider: "hdmi_cec"},
		"display.mute":   {Version: 1, Provider: "telepathy"},
	})
	got := stored()
	if len(got) != 1 || got["display.power"] != (PlayerCapabilityReport{Version: 1, Provider: "hdmi_cec"}) {
		t.Fatalf("stored = %+v, want only display.power", got)
	}

	// Nil says nothing and keeps the stored report.
	beat(nil)
	if got := stored(); len(got) != 1 {
		t.Fatalf("nil heartbeat stored = %+v", got)
	}

	// Explicit empty clears it: a disconnected provider disappears.
	beat(map[string]PlayerCapabilityReport{})
	if got := stored(); len(got) != 0 {
		t.Fatalf("empty heartbeat stored = %+v", got)
	}
}
