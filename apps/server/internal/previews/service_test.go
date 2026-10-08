package previews

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

type recordingNotifier struct {
	screenID uuid.UUID
	message  map[string]any
}

func (n *recordingNotifier) Notify(screenID uuid.UUID, message map[string]any) bool {
	n.screenID = screenID
	n.message = message
	return true
}

func TestValidateUploadBounds(t *testing.T) {
	valid := Upload{
		CapturedAt:    time.Now(),
		PlayerVersion: "0.10.1",
		Width:         MaxWidth,
		Height:        MaxHeight,
		ContentType:   "image/jpeg",
		Data:          []byte{1},
	}
	if err := validateUpload(valid); err != nil {
		t.Fatalf("valid preview rejected: %v", err)
	}
	valid.Width = MaxWidth + 1
	if err := validateUpload(valid); !errors.Is(err, ErrInvalidUpload) {
		t.Fatalf("oversize dimensions error = %v", err)
	}
	valid.Width = MaxWidth
	valid.Data = make([]byte, MaxImageBytes+1)
	if err := validateUpload(valid); !errors.Is(err, ErrInvalidUpload) {
		t.Fatalf("oversize image error = %v", err)
	}
	failure := Upload{PlayerVersion: "0.10.1", FailureStatus: "sensitive_admin"}
	if err := validateUpload(failure); err != nil {
		t.Fatalf("failure report rejected: %v", err)
	}
}

func TestPreviewLifecyclePostgreSQL(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(true,'Preview Test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone) VALUES($1,$2,$3,'Preview screen','android-tv','Test','Test','14','0.10.1',1920,1080,1,'en-US','UTC')`, screenID, organizationID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC().Truncate(time.Microsecond)
	notifier := &recordingNotifier{}
	service := NewService(pool, notifier)
	service.now = func() time.Time { return now }

	session, err := service.Renew(ctx, screenID, true)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if !session.Active || !session.CaptureNow || session.ExpiresAt == nil || !session.ExpiresAt.Equal(now.Add(LeaseDuration)) {
		t.Fatalf("unexpected session: %#v", session)
	}
	if notifier.screenID != screenID || notifier.message["type"] != "preview.session_changed" {
		t.Fatalf("preview notification was not sent: %#v", notifier)
	}
	playerSession, err := service.PlayerSession(ctx, screenID)
	if err != nil || !playerSession.Active || !playerSession.CaptureNow {
		t.Fatalf("player session = %#v, %v", playerSession, err)
	}

	image := []byte("bounded-preview-image")
	if err = service.RecordUpload(ctx, screenID, Upload{
		CapturedAt:    now,
		PlayerVersion: "0.10.1",
		Width:         960,
		Height:        540,
		ContentType:   "image/jpeg",
		Data:          image,
	}); err != nil {
		t.Fatalf("upload: %v", err)
	}
	metadata, err := service.GetMetadata(ctx, screenID)
	if err != nil {
		t.Fatalf("metadata: %v", err)
	}
	if metadata.Status != "available" || !metadata.ImageAvailable || metadata.FileSize != len(image) || metadata.CapturedAt == nil {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}
	stored, err := service.GetImage(ctx, screenID)
	if err != nil || !bytes.Equal(stored.Data, image) || stored.ContentType != "image/jpeg" {
		t.Fatalf("stored image = %#v, %v", stored, err)
	}


	// A healthy lease renewal does not force another capture.
	now = now.Add(10 * time.Second)
	if _, err = service.Renew(ctx, screenID, false); err != nil {
		t.Fatalf("healthy renewal: %v", err)
	}
	playerSession, err = service.PlayerSession(ctx, screenID)
	if err != nil || playerSession.CaptureNow {
		t.Fatalf("healthy renewal unexpectedly requested capture: %#v %v", playerSession, err)
	}

	// An overdue image is automatically re-requested. Repeated renewals do
	// not reset the request timestamp or storm a player that hasn't answered.
	now = now.Add(CaptureFreshness)
	if _, err = service.Renew(ctx, screenID, false); err != nil {
		t.Fatalf("overdue renewal: %v", err)
	}
	playerSession, err = service.PlayerSession(ctx, screenID)
	if err != nil || !playerSession.CaptureNow {
		t.Fatalf("overdue image was not re-requested: %#v %v", playerSession, err)
	}
	var requestedAt time.Time
	if err = pool.QueryRow(ctx, `SELECT capture_requested_at FROM screen_previews WHERE screen_id=$1`, screenID).Scan(&requestedAt); err != nil {
		t.Fatal(err)
	}
	now = now.Add(5 * time.Second)
	if _, err = service.Renew(ctx, screenID, false); err != nil {
		t.Fatalf("duplicate renewal: %v", err)
	}
	var duplicateRequestedAt time.Time
	if err = pool.QueryRow(ctx, `SELECT capture_requested_at FROM screen_previews WHERE screen_id=$1`, screenID).Scan(&duplicateRequestedAt); err != nil {
		t.Fatal(err)
	}
	if !requestedAt.Equal(duplicateRequestedAt) {
		t.Fatalf("duplicate renewals reset capture request: %s -> %s", requestedAt, duplicateRequestedAt)
	}

	now = now.Add(CaptureRetryInterval)
	if _, err = service.Renew(ctx, screenID, false); err != nil {
		t.Fatalf("retry renewal: %v", err)
	}
	var retriedAt time.Time
	if err = pool.QueryRow(ctx, `SELECT capture_requested_at FROM screen_previews WHERE screen_id=$1`, screenID).Scan(&retriedAt); err != nil {
		t.Fatal(err)
	}
	if !retriedAt.After(requestedAt) {
		t.Fatalf("overdue pending request not retried: %s", retriedAt)
	}

	// Simulate the player responding to the retried request.
	if err = service.RecordUpload(ctx, screenID, Upload{
		CapturedAt:    now,
		PlayerVersion: "0.10.1",
		Width:         960,
		Height:        540,
		ContentType:   "image/jpeg",
		Data:          image,
	}); err != nil {
		t.Fatalf("recovery upload: %v", err)
	}
	if _, err = service.Renew(ctx, screenID, false); err != nil {
		t.Fatalf("post-recovery renewal: %v", err)
	}
	playerSession, err = service.PlayerSession(ctx, screenID)
	if err != nil || playerSession.CaptureNow {
		t.Fatalf("successful upload did not clear requested state: %#v %v", playerSession, err)
	}

	now = now.Add(CaptureInterval)
	if err = service.RecordUpload(ctx, screenID, Upload{PlayerVersion: "0.10.1", FailureStatus: "pixel_copy_failed"}); err != nil {
		t.Fatalf("failure upload: %v", err)
	}
	metadata, err = service.GetMetadata(ctx, screenID)
	if err != nil || metadata.Status != "capture_error" || metadata.ImageAvailable || metadata.CaptureFailureStatus != "pixel_copy_failed" {
		t.Fatalf("failure metadata = %#v, %v", metadata, err)
	}
	if _, err = service.GetImage(ctx, screenID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed capture should clear the previous image, got %v", err)
	}

	var rows int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM screen_previews WHERE screen_id=$1`, screenID).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("preview row count=%d err=%v", rows, err)
	}
	if _, err = service.Renew(ctx, uuid.New(), true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown screen renew error = %v", err)
	}
}
