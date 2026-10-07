package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

// A Browser Player runs only the command types its capability matrix lists.
// The single queueing path refuses the rest, so a bulk operation, a single
// request and any later caller get the same answer.
func TestBrowserScreensAcceptOnlyTheirMatrixCommands(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	organizationID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'Command Matrix',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	screen := func(platform string) uuid.UUID {
		id := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,$4,$4,'Test','Test','14','0.1.0',1920,1080,1,'en-US','UTC')`, id, organizationID, uuid.NewString(), platform); err != nil {
			t.Fatal(err)
		}
		return id
	}
	browser, linux := screen("browser"), screen("linux")
	s := &server{
		db:         pool,
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		operations: OperationsConfig{CommandRetentionDays: 30, MaxPendingCommands: 50, DefaultCommandExpiryMinutes: 60},
		devices:    devices.NewService(pool, devices.NewPresenceHub(), "https://signage.example.org"),
	}
	user := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Owner','matrix-owner','x','owner')`, user); err != nil {
		t.Fatal(err)
	}
	for _, supported := range devices.BrowserSupportedCommands() {
		if _, _, err := s.queueCommand(ctx, browser, user, supported, []byte(`{}`), uuid.New()); err != nil {
			t.Fatalf("%s was refused for a Browser Player: %v", supported, err)
		}
	}
	for _, refused := range []string{"display_power_off", "clear_media_cache", "clear_website_data", "install_player_update", "restart_player_process", "run_player_self_test", "install_autostart"} {
		if _, _, err := s.queueCommand(ctx, browser, user, refused, []byte(`{}`), uuid.New()); !errors.Is(err, errCommandUnsupported) {
			t.Fatalf("%s was queued for a Browser Player: %v", refused, err)
		}
		if _, _, err := s.queueCommand(ctx, linux, user, refused, []byte(`{}`), uuid.New()); err != nil {
			t.Fatalf("%s was refused for a native player: %v", refused, err)
		}
	}
	var queued int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM player_commands WHERE screen_id=$1`, browser).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != len(devices.BrowserSupportedCommands()) {
		t.Fatalf("a refused command left %d rows for the Browser Screen", queued)
	}
}
