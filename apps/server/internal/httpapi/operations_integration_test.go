package httpapi

import (
	"context"
	"encoding/json"
	"errors"
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

func TestPlayerCommandsPostgreSQLDelivery(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}

	organizationID := uuid.New()
	screenID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'Command Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Test screen','android-tv','Test','Test','14','0.10.1',1920,1080,1,'en-US','UTC')`, screenID, organizationID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}

	s := &server{
		db:         pool,
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		operations: OperationsConfig{CommandRetentionDays: 30},
	}
	poll := func() []commandPollItem {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/v1/player/commands", nil)
		request = request.WithContext(context.WithValue(request.Context(), deviceContextKey, devices.DevicePrincipal{ScreenID: screenID, Enabled: true}))
		response := httptest.NewRecorder()
		s.playerCommands(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("poll status=%d body=%s", response.Code, response.Body.String())
		}
		var envelope struct {
			Data struct {
				Items []commandPollItem `json:"items"`
			} `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.Items == nil {
			t.Fatal("items must be an empty array, not null")
		}
		return envelope.Data.Items
	}

	if items := poll(); len(items) != 0 {
		t.Fatalf("empty poll returned %d commands", len(items))
	}

	commandID := uuid.New()
	createdAt := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Microsecond)
	if _, err = pool.Exec(ctx, `INSERT INTO player_commands(id,organization_id,screen_id,type,idempotency_key,created_at,expires_at) VALUES($1,$2,$3,'sync_now',$4,$5,$6)`, commandID, organizationID, screenID, uuid.New(), createdAt, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	items := poll()
	if len(items) != 1 || items[0].ID != commandID || items[0].State != "delivered" {
		t.Fatalf("unexpected pending delivery: %#v", items)
	}
	var deliveredAt time.Time
	var attemptCount int
	if err = pool.QueryRow(ctx, `SELECT delivered_at,attempt_count FROM player_commands WHERE id=$1`, commandID).Scan(&deliveredAt, &attemptCount); err != nil {
		t.Fatal(err)
	}
	if deliveredAt.IsZero() || attemptCount != 1 {
		t.Fatalf("delivered_at=%v attempt_count=%d", deliveredAt, attemptCount)
	}

	items = poll()
	if len(items) != 1 || items[0].ID != commandID {
		t.Fatalf("delivered command was not redelivered: %#v", items)
	}
	var redeliveredAt time.Time
	if err = pool.QueryRow(ctx, `SELECT delivered_at,attempt_count FROM player_commands WHERE id=$1`, commandID).Scan(&redeliveredAt, &attemptCount); err != nil {
		t.Fatal(err)
	}
	if !redeliveredAt.Equal(deliveredAt) || attemptCount != 2 {
		t.Fatalf("redelivery changed delivered_at or attempt count: first=%v second=%v attempts=%d", deliveredAt, redeliveredAt, attemptCount)
	}

	if _, err = pool.Exec(ctx, `DELETE FROM player_commands`); err != nil {
		t.Fatal(err)
	}
	oldestID, newestID, expiredID := uuid.New(), uuid.New(), uuid.New()
	for _, command := range []struct {
		id      uuid.UUID
		created time.Time
		expires time.Time
	}{
		{newestID, time.Now().Add(-time.Minute), time.Now().Add(time.Hour)},
		{oldestID, time.Now().Add(-3 * time.Minute), time.Now().Add(time.Hour)},
		{expiredID, time.Now().Add(-4 * time.Minute), time.Now().Add(-time.Minute)},
	} {
		if _, err = pool.Exec(ctx, `INSERT INTO player_commands(id,organization_id,screen_id,type,idempotency_key,created_at,expires_at) VALUES($1,$2,$3,'sync_now',$4,$5,$6)`, command.id, organizationID, screenID, uuid.New(), command.created, command.expires); err != nil {
			t.Fatal(err)
		}
	}
	items = poll()
	if len(items) != 2 || items[0].ID != oldestID || items[1].ID != newestID {
		t.Fatalf("commands were not returned oldest first: %#v", items)
	}
	var expiredState string
	if err = pool.QueryRow(ctx, `SELECT state FROM player_commands WHERE id=$1`, expiredID).Scan(&expiredState); err != nil || expiredState != "expired" {
		t.Fatalf("expired command state=%q err=%v", expiredState, err)
	}
}

type commandPollItem struct {
	ID    uuid.UUID `json:"id"`
	State string    `json:"state"`
}

func TestQueueCommandRefusesArchivedAndDeletedScreens(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}

	organizationID, userID, liveID, archivedID, deletedID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'Archive Command Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Operator','operator','unused','owner',TRUE)`, userID); err != nil {
		t.Fatal(err)
	}
	for _, screen := range []uuid.UUID{liveID, archivedID, deletedID} {
		if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Command screen','android-tv','Test','Test','14','0.10.1',1920,1080,1,'en-US','UTC')`, screen, organizationID, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `UPDATE screens SET archived_at=now(),archived_reason='test',enabled=FALSE WHERE id=$1`, archivedID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE screens SET deleted_at=now(),enabled=FALSE WHERE id=$1`, deletedID); err != nil {
		t.Fatal(err)
	}

	s := &server{
		db:      pool,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		devices: devices.NewService(pool, devices.NewPresenceHub(), ""),
		operations: OperationsConfig{
			CommandRetentionDays:        30,
			MaxPendingCommands:          10,
			DefaultCommandExpiryMinutes: 60,
		},
	}
	queue := func(screen uuid.UUID) error {
		_, _, err := s.queueCommand(ctx, screen, userID, "sync_now", []byte(`{}`), uuid.New())
		return err
	}
	countCommands := func(screen uuid.UUID) int {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM player_commands WHERE screen_id=$1`, screen).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	if err = queue(liveID); err != nil {
		t.Fatalf("live screen command: %v", err)
	}
	if got := countCommands(liveID); got != 1 {
		t.Fatalf("live screen commands = %d, want 1", got)
	}
	for _, screen := range []uuid.UUID{archivedID, deletedID} {
		if err = queue(screen); !errors.Is(err, errScreenNotFound) {
			t.Fatalf("screen %s command error = %v, want errScreenNotFound", screen, err)
		}
		if got := countCommands(screen); got != 0 {
			t.Fatalf("screen %s commands = %d, want 0", screen, got)
		}
	}
}
