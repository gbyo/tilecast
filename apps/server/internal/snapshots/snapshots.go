// Package snapshots keeps a bounded history of what screens actually showed.
//
// Live preview answers "what is on that screen now" and forgets. This answers
// "what was on it at 10:14", which is the question asked after somebody reports
// a wrong board, or over a break when nobody is in the building.
//
// Snapshots are captured from the Player render surface.
package snapshots

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/previews"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

// ErrNotFound is returned for an unknown snapshot.
var ErrNotFound = errors.New("not found")

// SettingsReader is the part of the settings service this package needs.
type SettingsReader interface {
	Organization(ctx context.Context) (settings.Document, error)
}

// Capturer requests a frame from a screen. It is the live preview service: one
// capture path means a manual preview and a scheduled snapshot cannot disagree
// about what the screen showed.
type Capturer interface {
	Renew(ctx context.Context, screenID uuid.UUID, forceCapture bool) (previews.Session, error)
}

// Service records, prunes, and reads snapshot history.
type Service struct {
	db       *pgxpool.Pool
	settings SettingsReader
	capturer Capturer
	logger   *slog.Logger
}

// NewService builds the snapshot service.
func NewService(db *pgxpool.Pool, reader SettingsReader, capturer Capturer, logger *slog.Logger) *Service {
	return &Service{db: db, settings: reader, capturer: capturer, logger: logger}
}

// Policy is the organization's snapshot configuration.
type Policy struct {
	Enabled         bool
	IntervalMinutes int
	RetentionDays   int
	MaxPerScreen    int
}

// Policy reads the configuration. Defaults are conservative: off, hourly, a
// week, and a couple of days' worth per screen.
func (s *Service) Policy(ctx context.Context) Policy {
	policy := Policy{IntervalMinutes: 60, RetentionDays: 7, MaxPerScreen: 48}
	document, err := s.settings.Organization(ctx)
	if err != nil {
		return policy
	}
	if v, ok := document.Values["snapshots.enabled"].(bool); ok {
		policy.Enabled = v
	}
	if v, ok := document.Values["snapshots.interval_minutes"].(float64); ok && v > 0 {
		policy.IntervalMinutes = int(v)
	}
	if v, ok := document.Values["snapshots.retention_days"].(float64); ok && v > 0 {
		policy.RetentionDays = int(v)
	}
	if v, ok := document.Values["snapshots.max_per_screen"].(float64); ok && v > 0 {
		policy.MaxPerScreen = int(v)
	}
	return policy
}

// Record stores one captured frame. It is installed on the preview service, so
// every successful capture flows through here when history is enabled.
//
// It is deliberately best-effort and never returns an error: a snapshot that
// cannot be stored must not fail the live preview the operator is watching.
func (s *Service) Record(ctx context.Context, screenID uuid.UUID, upload previews.Upload) {
	s.record(ctx, screenID, upload, "scheduled")
}

// RecordManual stores a frame produced by somebody pressing a button.
func (s *Service) RecordManual(ctx context.Context, screenID uuid.UUID, upload previews.Upload) {
	s.record(ctx, screenID, upload, "manual")
}

// RecordTriggered preserves whether the preview capture was operator-requested
// or part of ordinary scheduled/background preview activity.
func (s *Service) RecordTriggered(ctx context.Context, screenID uuid.UUID, upload previews.Upload, trigger previews.CaptureTrigger) {
	if trigger == previews.CaptureTriggerManual {
		s.RecordManual(ctx, screenID, upload)
		return
	}
	s.Record(ctx, screenID, upload)
}

func (s *Service) record(ctx context.Context, screenID uuid.UUID, upload previews.Upload, trigger string) {
	policy := s.Policy(ctx)
	if !policy.Enabled {
		return
	}
	if _, err := s.db.Exec(ctx, `
		INSERT INTO screen_snapshots(
			id,screen_id,captured_at,width,height,file_size,content_type,
			image_data,player_version,trigger)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		uuid.New(), screenID, upload.CapturedAt.UTC(), upload.Width, upload.Height,
		len(upload.Data), upload.ContentType, upload.Data, upload.PlayerVersion, trigger); err != nil {
		s.logger.Error("storing screen snapshot failed", "error", err)
		return
	}
	// The per-screen cap is applied on write rather than only on the retention
	// sweep, so a misconfigured interval cannot outrun the sweep and fill the
	// database between two ticks.
	if _, err := s.db.Exec(ctx, `
		DELETE FROM screen_snapshots WHERE id IN (
			SELECT id FROM screen_snapshots WHERE screen_id=$1
			ORDER BY captured_at DESC, id DESC OFFSET $2)`,
		screenID, policy.MaxPerScreen); err != nil {
		s.logger.Error("applying the snapshot cap failed", "error", err)
	}
}

// Sweep requests captures that are due and applies retention. It is called on a
// timer by the worker.
func (s *Service) Sweep(ctx context.Context) error {
	policy := s.Policy(ctx)
	if !policy.Enabled {
		// Turning the feature off stops new captures and lets retention clear
		// what is there, rather than stranding images nobody can reach.
		return s.prune(ctx, policy)
	}
	due, err := s.dueScreens(ctx, policy)
	if err != nil {
		return err
	}
	for _, screen := range due {
		// Renew asks the Player for a frame through the ordinary live preview
		// lease. A screen that is offline simply does not answer, and the next
		// sweep asks again.
		if _, err := s.capturer.Renew(ctx, screen, true); err != nil {
			s.logger.Warn("requesting a scheduled snapshot failed", "error", err)
		}
	}
	return s.prune(ctx, policy)
}

func (s *Service) dueScreens(ctx context.Context, policy Policy) ([]uuid.UUID, error) {
	interval := time.Duration(policy.IntervalMinutes) * time.Minute
	// Only screens that are actually reporting. That also covers active hours
	// without a separate setting: a screen asleep outside its active hours is
	// not heartbeating, so it is not asked for a frame. Asking a screen that has
	// been dark for a week every hour would be pure noise.
	query := `
		SELECT sc.id FROM screens sc
		WHERE sc.deleted_at IS NULL AND sc.archived_at IS NULL AND sc.enabled=TRUE
		  AND sc.last_heartbeat_at IS NOT NULL AND sc.last_heartbeat_at > now()-interval '15 minutes'
		  AND EXISTS(SELECT 1 FROM device_credentials c
		             WHERE c.screen_id=sc.id AND c.revoked_at IS NULL)
		  AND NOT EXISTS(
		      SELECT 1 FROM screen_snapshots snap
		      WHERE snap.screen_id=sc.id AND snap.captured_at > now()-$1::interval)
		ORDER BY sc.id
		LIMIT 200`
	rows, err := s.db.Query(ctx, query, interval)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Service) prune(ctx context.Context, policy Policy) error {
	_, err := s.db.Exec(ctx, `
		DELETE FROM screen_snapshots
		WHERE captured_at < now() - make_interval(days => $1)`, policy.RetentionDays)
	return err
}

// Snapshot is the metadata for one stored frame. The image itself is fetched
// separately so a list does not carry megabytes of pixels.
type Snapshot struct {
	ID            uuid.UUID `json:"id"`
	ScreenID      uuid.UUID `json:"screenId"`
	CapturedAt    time.Time `json:"capturedAt"`
	Width         int       `json:"width"`
	Height        int       `json:"height"`
	FileSize      int       `json:"fileSize"`
	PlayerVersion string    `json:"playerVersion,omitempty"`
	Trigger       string    `json:"trigger"`
}

// List returns a screen's snapshot history, newest first.
func (s *Service) List(ctx context.Context, screenID uuid.UUID, limit int) ([]Snapshot, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.Query(ctx, `
		SELECT id,screen_id,captured_at,width,height,file_size,player_version,trigger
		FROM screen_snapshots WHERE screen_id=$1
		ORDER BY captured_at DESC, id DESC LIMIT $2`, screenID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Snapshot{}
	for rows.Next() {
		var item Snapshot
		if err := rows.Scan(&item.ID, &item.ScreenID, &item.CapturedAt, &item.Width,
			&item.Height, &item.FileSize, &item.PlayerVersion, &item.Trigger); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// Image is one stored frame.
type Image struct {
	ContentType string
	Data        []byte
	CapturedAt  time.Time
}

// GetImage reads one frame. The screen id is part of the lookup so a snapshot
// cannot be fetched through a screen the caller is not authorized for.
func (s *Service) GetImage(ctx context.Context, screenID, id uuid.UUID) (Image, error) {
	var image Image
	err := s.db.QueryRow(ctx, `
		SELECT content_type,image_data,captured_at FROM screen_snapshots
		WHERE id=$1 AND screen_id=$2`, id, screenID).
		Scan(&image.ContentType, &image.Data, &image.CapturedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Image{}, ErrNotFound
	}
	return image, err
}

// Usage reports how much space the history occupies, so an operator can see the
// cost of the setting they turned on rather than discovering it in a backup.
func (s *Service) Usage(ctx context.Context) (int64, int, error) {
	var bytes *int64
	var count int
	err := s.db.QueryRow(ctx,
		`SELECT sum(file_size), count(*) FROM screen_snapshots`).Scan(&bytes, &count)
	if err != nil {
		return 0, 0, err
	}
	if bytes == nil {
		return 0, count, nil
	}
	return *bytes, count, nil
}
