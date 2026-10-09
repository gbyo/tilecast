package httpapi

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

// With one pool connection, enqueueing a command must not wait for a second
// connection while its own transaction holds the first.
func TestQueueCommandNeedsOneConnection(t *testing.T) {
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
	setup, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Close()
	if _, err = setup.Exec(ctx, `TRUNCATE organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(setup, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Pool", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = setup.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	screen := uuid.New()
	if _, err = setup.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Lobby TV','android-tv','Test','TV','14','1.0',1920,1080,1,'en-US','UTC')`, screen, org, uuid.NewString()); err != nil {
		t.Fatal(err)
	}

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	s := &server{
		db:         pool,
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		devices:    devices.NewService(pool, devices.NewPresenceHub(), ""),
		settings:   settings.NewService(pool, nil, settings.HardLimits{}),
		operations: OperationsConfig{CommandRetentionDays: 30, MaxPendingCommands: 10, DefaultCommandExpiryMinutes: 60},
	}
	done := make(chan error, 1)
	go func() {
		_, _, err := s.queueCommand(ctx, screen, owner.User.ID, "sync_now", []byte(`{}`), uuid.New())
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("queue command: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queueCommand waited for a second pool connection while its transaction held the only one")
	}
}
