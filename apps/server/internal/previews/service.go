package previews

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	LeaseDuration        = 60 * time.Second
	CaptureInterval      = 20 * time.Second
	CaptureFreshness     = 45 * time.Second
	CaptureRetryInterval = 30 * time.Second
	MaxImageBytes        = 500 * 1024
	MaxWidth             = 960
	MaxHeight            = 540
)

var (
	ErrNotFound      = errors.New("screen preview was not found")
	ErrLeaseExpired  = errors.New("screen preview session has expired")
	ErrInvalidUpload = errors.New("screen preview upload is invalid")
)

type Notifier interface {
	Notify(screenID uuid.UUID, message map[string]any) bool
}

type Service struct {
	db       *pgxpool.Pool
	notifier Notifier
	now      func() time.Time
	// history receives every successful capture when snapshot history is
	// enabled. Nil means this installation keeps no history, which is the
	// default.
	history func(ctx context.Context, screenID uuid.UUID, upload Upload)
}

// SetHistoryRecorder installs the snapshot history recorder.
func (s *Service) SetHistoryRecorder(record func(ctx context.Context, screenID uuid.UUID, upload Upload)) {
	s.history = record
}

func NewService(db *pgxpool.Pool, notifier Notifier) *Service {
	return &Service{db: db, notifier: notifier, now: time.Now}
}

type Session struct {
	Active                 bool       `json:"active"`
	ExpiresAt              *time.Time `json:"expiresAt,omitempty"`
	CaptureIntervalSeconds int        `json:"captureIntervalSeconds"`
	CaptureNow             bool       `json:"captureNow"`
}

type Metadata struct {
	ScreenID             uuid.UUID  `json:"screenId"`
	Status               string     `json:"status"`
	LeaseExpiresAt       *time.Time `json:"leaseExpiresAt,omitempty"`
	CapturedAt           *time.Time `json:"capturedAt,omitempty"`
	PlayerVersion        string     `json:"playerVersion,omitempty"`
	Width                int        `json:"width,omitempty"`
	Height               int        `json:"height,omitempty"`
	FileSize             int        `json:"fileSize,omitempty"`
	CaptureFailureStatus string     `json:"captureFailureStatus,omitempty"`
	ImageAvailable       bool       `json:"imageAvailable"`
	UpdatedAt            time.Time  `json:"updatedAt"`
}

type Upload struct {
	CapturedAt    time.Time
	PlayerVersion string
	Width         int
	Height        int
	ContentType   string
	Data          []byte
	FailureStatus string
}

type Image struct {
	ContentType string
	Data        []byte
	UpdatedAt   time.Time
}

func (s *Service) Renew(ctx context.Context, screenID uuid.UUID, forceCapture bool) (Session, error) {
	now := s.now().UTC()
	expiresAt := now.Add(LeaseDuration)
	var storedScreenID uuid.UUID
	var requestedAt time.Time
	err := s.db.QueryRow(ctx, `
		INSERT INTO screen_previews(screen_id,organization_id,lease_expires_at,capture_requested_at,updated_at)
		SELECT screens.id,screens.organization_id,$2,$1,$1
		FROM screens
		JOIN organization_settings ON organization_settings.singleton=TRUE AND organization_settings.id=screens.organization_id
		WHERE screens.id=$3
		ON CONFLICT(screen_id) DO UPDATE SET
			lease_expires_at=EXCLUDED.lease_expires_at,
			capture_requested_at=CASE
				WHEN $4 THEN $1
				WHEN (screen_previews.captured_at IS NULL OR screen_previews.captured_at < $1 - make_interval(secs => $5))
					AND left(COALESCE(screen_previews.failure_status, ''), 10) <> 'sensitive_'
					AND screen_previews.capture_requested_at <= $1 - make_interval(secs => $6)
					AND (screen_previews.attempted_at IS NULL OR screen_previews.attempted_at <= $1 - make_interval(secs => $6))
				THEN $1
				ELSE screen_previews.capture_requested_at
			END,
			updated_at=$1
		RETURNING screen_id, capture_requested_at`, now, expiresAt, screenID, forceCapture, int(CaptureFreshness.Seconds()), int(CaptureRetryInterval.Seconds())).Scan(&storedScreenID, &requestedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("renew screen preview session: %w", err)
	}
	// Only a new capture request needs to wake the Player. Ordinary 30-second
	// lease renewals must not cause a socket notification or a session GET.
	if s.notifier != nil && requestedAt.Equal(now) {
		s.notifier.Notify(screenID, map[string]any{"type": "preview.session_changed"})
	}
	return Session{Active: true, ExpiresAt: &expiresAt, CaptureIntervalSeconds: int(CaptureInterval.Seconds()), CaptureNow: forceCapture}, nil
}

func (s *Service) PlayerSession(ctx context.Context, screenID uuid.UUID) (Session, error) {
	var expiresAt time.Time
	var captureNow bool
	err := s.db.QueryRow(ctx, `
		SELECT preview.lease_expires_at,
			preview.capture_requested_at>COALESCE(preview.attempted_at,'epoch'::timestamptz)
		FROM screen_previews preview
		JOIN screens ON screens.id=preview.screen_id
		JOIN organization_settings ON organization_settings.singleton=TRUE AND organization_settings.id=screens.organization_id
		WHERE preview.screen_id=$1`, screenID).Scan(&expiresAt, &captureNow)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{CaptureIntervalSeconds: int(CaptureInterval.Seconds())}, nil
	}
	if err != nil {
		return Session{}, fmt.Errorf("read player preview session: %w", err)
	}
	active := expiresAt.After(s.now())
	if !active {
		captureNow = false
	}
	return Session{Active: active, ExpiresAt: &expiresAt, CaptureIntervalSeconds: int(CaptureInterval.Seconds()), CaptureNow: captureNow}, nil
}

// previewImageVisible fails closed for old/unknown failure statuses. Older Players
// send 'unavailable' for both a capture error and a protected UI, so their
// cached image must remain inaccessible until a new successful capture.
func previewImageVisible(failure string) bool {
	switch failure {
	case "", "renderer_timeout", "renderer_disconnected", "capture_invalid", "capture_out_of_bounds", "pixel_copy_failed":
		return true
	default:
		return false
	}
}

func (s *Service) RecordUpload(ctx context.Context, screenID uuid.UUID, upload Upload) error {
	if err := validateUpload(upload); err != nil {
		return err
	}
	now := s.now().UTC()
	failureStatus := strings.TrimSpace(upload.FailureStatus)
	// Failure updates only the attempt and failure status, not the last image.
	// Unknown or protected failure statuses are hidden by the image endpoint.
	commandTag, err := s.db.Exec(ctx, `
		UPDATE screen_previews preview SET
			attempted_at=$2,
			captured_at=CASE WHEN $3='' THEN $2 ELSE preview.captured_at END,
			player_version=$4,
			width=CASE WHEN $3='' THEN $5 ELSE preview.width END,
			height=CASE WHEN $3='' THEN $6 ELSE preview.height END,
			file_size=CASE WHEN $3='' THEN $7 ELSE preview.file_size END,
			content_type=CASE WHEN $3='' THEN $8 ELSE preview.content_type END,
			image_data=CASE WHEN $3='' THEN $9 ELSE preview.image_data END,
			failure_status=$3,
			updated_at=$2
		FROM screens
		JOIN organization_settings ON organization_settings.singleton=TRUE AND organization_settings.id=screens.organization_id
		WHERE preview.screen_id=$1 AND screens.id=preview.screen_id AND preview.lease_expires_at>$2`,
		screenID, now, failureStatus, strings.TrimSpace(upload.PlayerVersion), upload.Width, upload.Height, len(upload.Data), upload.ContentType, upload.Data)
	if err != nil {
		return fmt.Errorf("store player preview: %w", err)
	}
	if commandTag.RowsAffected() == 0 {
		return ErrLeaseExpired
	}
	// Snapshot history, when it is enabled, records the frames that arrive here
	// rather than capturing separately. One capture path means a manual preview
	// and a scheduled snapshot cannot disagree about what the screen showed.
	if s.history != nil && failureStatus == "" && len(upload.Data) > 0 {
		s.history(ctx, screenID, upload)
	}
	return nil
}

func (s *Service) GetMetadata(ctx context.Context, screenID uuid.UUID) (Metadata, error) {
	var result Metadata
	var leaseExpiresAt time.Time
	var capturedAt *time.Time
	var imageAvailable bool
	err := s.db.QueryRow(ctx, `
		SELECT preview.screen_id,preview.lease_expires_at,preview.captured_at,preview.player_version,
			preview.width,preview.height,preview.file_size,preview.failure_status,(preview.image_data IS NOT NULL),preview.updated_at
		FROM screen_previews preview
		JOIN screens ON screens.id=preview.screen_id
		JOIN organization_settings ON organization_settings.singleton=TRUE AND organization_settings.id=screens.organization_id
		WHERE preview.screen_id=$1`, screenID).Scan(
		&result.ScreenID, &leaseExpiresAt, &capturedAt, &result.PlayerVersion,
		&result.Width, &result.Height, &result.FileSize, &result.CaptureFailureStatus, &imageAvailable, &result.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if scanErr := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens JOIN organization_settings ON organization_settings.singleton=TRUE AND organization_settings.id=screens.organization_id WHERE screens.id=$1)`, screenID).Scan(&exists); scanErr != nil {
			return Metadata{}, fmt.Errorf("check preview screen: %w", scanErr)
		}
		if !exists {
			return Metadata{}, ErrNotFound
		}
		return Metadata{ScreenID: screenID, Status: "unavailable", ImageAvailable: false, UpdatedAt: s.now().UTC()}, nil
	}
	if err != nil {
		return Metadata{}, fmt.Errorf("read screen preview metadata: %w", err)
	}
	result.LeaseExpiresAt = &leaseExpiresAt
	result.CapturedAt = capturedAt
	result.ImageAvailable = imageAvailable && previewImageVisible(result.CaptureFailureStatus)
	switch {
	case result.CaptureFailureStatus != "" && strings.HasPrefix(result.CaptureFailureStatus, "sensitive_"):
		result.Status = "unavailable"
	case result.CaptureFailureStatus != "":
		result.Status = "capture_error"
	case result.ImageAvailable:
		result.Status = "available"
	case leaseExpiresAt.After(s.now()):
		result.Status = "loading"
	default:
		result.Status = "unavailable"
	}
	return result, nil
}

func (s *Service) GetImage(ctx context.Context, screenID uuid.UUID) (Image, error) {
	var image Image
	err := s.db.QueryRow(ctx, `
		SELECT preview.content_type,preview.image_data,preview.updated_at
		FROM screen_previews preview
		JOIN screens ON screens.id=preview.screen_id
		JOIN organization_settings ON organization_settings.singleton=TRUE AND organization_settings.id=screens.organization_id
		WHERE preview.screen_id=$1 AND preview.image_data IS NOT NULL
		  AND preview.failure_status IN ('', 'renderer_timeout', 'renderer_disconnected', 'capture_invalid', 'capture_out_of_bounds', 'pixel_copy_failed')`, screenID).Scan(&image.ContentType, &image.Data, &image.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Image{}, ErrNotFound
	}
	if err != nil {
		return Image{}, fmt.Errorf("read screen preview image: %w", err)
	}
	return image, nil
}

func validateUpload(upload Upload) error {
	failureStatus := strings.TrimSpace(upload.FailureStatus)
	if len(strings.TrimSpace(upload.PlayerVersion)) == 0 || len(upload.PlayerVersion) > 120 {
		return fmt.Errorf("%w: player version is required", ErrInvalidUpload)
	}
	if len(failureStatus) > 120 {
		return fmt.Errorf("%w: failure status is too long", ErrInvalidUpload)
	}
	if failureStatus != "" {
		if len(upload.Data) != 0 {
			return fmt.Errorf("%w: failed captures must not include image data", ErrInvalidUpload)
		}
		return nil
	}
	if upload.CapturedAt.IsZero() {
		return fmt.Errorf("%w: capture time is required", ErrInvalidUpload)
	}
	if upload.Width < 1 || upload.Width > MaxWidth || upload.Height < 1 || upload.Height > MaxHeight {
		return fmt.Errorf("%w: preview dimensions exceed %dx%d", ErrInvalidUpload, MaxWidth, MaxHeight)
	}
	if len(upload.Data) < 1 || len(upload.Data) > MaxImageBytes {
		return fmt.Errorf("%w: preview image must be between 1 and %d bytes", ErrInvalidUpload, MaxImageBytes)
	}
	if upload.ContentType != "image/jpeg" && upload.ContentType != "image/webp" {
		return fmt.Errorf("%w: preview must be JPEG or WebP", ErrInvalidUpload)
	}
	return nil
}
