package span

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

var (
	ErrNotFound = errors.New("Span resource not found")
	ErrNotReady = errors.New("Span video panel is still preparing")
)

type Config struct {
	FFmpegPath  string
	FFprobePath string
}

type Notifier interface {
	ManifestChanged(uuid.UUID, int64)
}

type Service struct {
	db       *pgxpool.Pool
	storage  media.Storage
	cfg      Config
	notifier Notifier
}

type VideoPanel struct {
	ID              uuid.UUID
	Status          string
	Width           int
	Height          int
	DurationSeconds float64
	FrameRate       float64
	MIMEType        string
	FileSize        int64
	SHA256          string
	DownloadPath    string
}

type StatusResult struct {
	GroupID  uuid.UUID     `json:"groupId"`
	Mode     string        `json:"displayMode"`
	Geometry Geometry      `json:"geometry"`
	Panels   []Preparation `json:"preparations"`
}

func NewService(db *pgxpool.Pool, storage media.Storage, cfg Config, notifier Notifier) *Service {
	return &Service{db: db, storage: storage, cfg: cfg, notifier: notifier}
}

func (s *Service) Geometry(ctx context.Context, groupID uuid.UUID) (string, Geometry, error) {
	var mode string
	var geometry Geometry
	if err := s.db.QueryRow(ctx, `SELECT display_mode,span_canvas_width,span_canvas_height FROM screen_groups WHERE id=$1 AND deleted_at IS NULL`, groupID).Scan(&mode, &geometry.Canvas.Width, &geometry.Canvas.Height); errors.Is(err, pgx.ErrNoRows) {
		return "", Geometry{}, ErrNotFound
	} else if err != nil {
		return "", Geometry{}, err
	}
	rows, err := s.db.Query(ctx, `SELECT p.screen_id,p.panel_order,p.x,p.y,p.width,p.height,p.rotation,p.bezel_left,p.bezel_top,p.bezel_right,p.bezel_bottom,sc.name FROM screen_group_panels p JOIN screens sc ON sc.id=p.screen_id WHERE p.screen_group_id=$1 ORDER BY p.panel_order,p.screen_id`, groupID)
	if err != nil {
		return "", Geometry{}, err
	}
	defer rows.Close()
	geometry.Panels = []Panel{}
	for rows.Next() {
		var panel Panel
		if err := rows.Scan(&panel.ScreenID, &panel.PanelOrder, &panel.X, &panel.Y, &panel.Width, &panel.Height, &panel.Rotation, &panel.BezelLeft, &panel.BezelTop, &panel.BezelRight, &panel.BezelBottom, &panel.ScreenName); err != nil {
			return "", Geometry{}, err
		}
		geometry.Panels = append(geometry.Panels, panel)
	}
	if err := rows.Err(); err != nil {
		return "", Geometry{}, err
	}
	return mode, geometry, nil
}

// SyncMembershipGeometry keeps a Span group's panel set total after the
// existing membership transaction adds or removes a screen. Replacement does
// not call this path because it keeps the logical screen ID unchanged.
func (s *Service) SyncMembershipGeometry(ctx context.Context, groupID, user uuid.UUID) error {
	mode, geometry, err := s.Geometry(ctx, groupID)
	if err != nil || mode != ModeSpan {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT screen_id FROM screen_group_memberships WHERE screen_group_id=$1 ORDER BY screen_id`, groupID)
	if err != nil {
		return err
	}
	defer rows.Close()
	members := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return err
		}
		members = append(members, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(members) == 0 {
		return nil
	}
	if len(geometry.Panels) != len(members) {
		modeCopy := mode
		canvas := geometry.Canvas
		return s.UpdateGeometry(ctx, groupID, user, &modeCopy, &canvas, Preset(canvas, members, 0), true)
	}
	memberSet := make(map[uuid.UUID]bool, len(members))
	for _, id := range members {
		memberSet[id] = true
	}
	for _, panel := range geometry.Panels {
		if !memberSet[panel.ScreenID] {
			modeCopy := mode
			canvas := geometry.Canvas
			return s.UpdateGeometry(ctx, groupID, user, &modeCopy, &canvas, Preset(canvas, members, 0), true)
		}
	}
	return nil
}

// ViewportForScreen is nil for Mirror and for a Span member whose geometry is
// incomplete. The latter is surfaced as ErrNotReady so a player never renders
// a full wall by accident.
func (s *Service) ViewportForScreen(ctx context.Context, screenID uuid.UUID) (*Panel, *Canvas, error) {
	var groupID uuid.UUID
	var mode string
	var canvas Canvas
	if err := s.db.QueryRow(ctx, `SELECT g.id,g.display_mode,g.span_canvas_width,g.span_canvas_height FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id AND g.deleted_at IS NULL WHERE m.screen_id=$1`, screenID).Scan(&groupID, &mode, &canvas.Width, &canvas.Height); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	} else if err != nil {
		return nil, nil, err
	}
	if mode != ModeSpan {
		return nil, nil, nil
	}
	var panel Panel
	if err := s.db.QueryRow(ctx, `SELECT screen_id,panel_order,x,y,width,height,rotation,bezel_left,bezel_top,bezel_right,bezel_bottom FROM screen_group_panels WHERE screen_group_id=$1 AND screen_id=$2`, groupID, screenID).Scan(&panel.ScreenID, &panel.PanelOrder, &panel.X, &panel.Y, &panel.Width, &panel.Height, &panel.Rotation, &panel.BezelLeft, &panel.BezelTop, &panel.BezelRight, &panel.BezelBottom); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrNotReady
	} else if err != nil {
		return nil, nil, err
	}
	return &panel, &canvas, nil
}

// UpdateGeometry validates the full member set inside one transaction. A
// Span transition without explicit panels gets a deterministic compact grid.
func (s *Service) UpdateGeometry(ctx context.Context, groupID, user uuid.UUID, mode *string, canvas *Canvas, panels []Panel, panelsSet bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var currentMode string
	var currentCanvas Canvas
	if err := tx.QueryRow(ctx, `SELECT display_mode,span_canvas_width,span_canvas_height FROM screen_groups WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, groupID).Scan(&currentMode, &currentCanvas.Width, &currentCanvas.Height); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	chosenMode := currentMode
	if mode != nil {
		chosenMode = *mode
	}
	if err := ValidateMode(chosenMode); err != nil {
		return err
	}
	chosenCanvas := currentCanvas
	if canvas != nil {
		chosenCanvas = *canvas
	}
	memberRows, err := tx.Query(ctx, `SELECT screen_id FROM screen_group_memberships WHERE screen_group_id=$1 ORDER BY screen_id`, groupID)
	if err != nil {
		return err
	}
	memberIDs := []uuid.UUID{}
	for memberRows.Next() {
		var id uuid.UUID
		if err := memberRows.Scan(&id); err != nil {
			memberRows.Close()
			return err
		}
		memberIDs = append(memberIDs, id)
	}
	memberRows.Close()
	if chosenMode == ModeSpan && len(memberIDs) == 0 {
		return errors.New("a Span group must contain at least one screen")
	}
	if panelsSet {
		if len(panels) == 0 && chosenMode == ModeSpan {
			panels = Preset(chosenCanvas, memberIDs, 0)
		}
	} else if chosenMode == ModeSpan {
		rows, queryErr := tx.Query(ctx, `SELECT screen_id,panel_order,x,y,width,height,rotation,bezel_left,bezel_top,bezel_right,bezel_bottom FROM screen_group_panels WHERE screen_group_id=$1 ORDER BY panel_order,screen_id`, groupID)
		if queryErr != nil {
			return queryErr
		}
		for rows.Next() {
			var panel Panel
			if queryErr = rows.Scan(&panel.ScreenID, &panel.PanelOrder, &panel.X, &panel.Y, &panel.Width, &panel.Height, &panel.Rotation, &panel.BezelLeft, &panel.BezelTop, &panel.BezelRight, &panel.BezelBottom); queryErr != nil {
				rows.Close()
				return queryErr
			}
			panels = append(panels, panel)
		}
		rows.Close()
		if len(panels) == 0 {
			panels = Preset(chosenCanvas, memberIDs, 0)
		}
	}
	if chosenMode == ModeSpan {
		if len(panels) != len(memberIDs) {
			return errors.New("Span geometry must define one panel for every member screen")
		}
		members := make(map[uuid.UUID]bool, len(memberIDs))
		for _, id := range memberIDs {
			members[id] = true
		}
		for _, panel := range panels {
			if !members[panel.ScreenID] {
				return errors.New("Span geometry contains a screen that is not a group member")
			}
		}
		if err := ValidateGeometry(chosenCanvas, panels); err != nil {
			return err
		}
	} else if len(panels) > 0 {
		if err := ValidateGeometry(chosenCanvas, panels); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE screen_groups SET display_mode=$2,span_canvas_width=$3,span_canvas_height=$4,span_geometry_revision=span_geometry_revision+1,updated_at=now() WHERE id=$1`, groupID, chosenMode, chosenCanvas.Width, chosenCanvas.Height); err != nil {
		return err
	}
	if panelsSet || chosenMode == ModeSpan {
		if _, err := tx.Exec(ctx, `DELETE FROM screen_group_panels WHERE screen_group_id=$1`, groupID); err != nil {
			return err
		}
		for _, panel := range panels {
			if _, err := tx.Exec(ctx, `INSERT INTO screen_group_panels(screen_group_id,screen_id,panel_order,x,y,width,height,rotation,bezel_left,bezel_top,bezel_right,bezel_bottom) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, groupID, panel.ScreenID, panel.PanelOrder, panel.X, panel.Y, panel.Width, panel.Height, panel.Rotation, panel.BezelLeft, panel.BezelTop, panel.BezelRight, panel.BezelBottom); err != nil {
				return err
			}
		}
	}
	ids, err := bumpScreens(ctx, tx, memberIDs, "screen_group.geometry_changed")
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, item := range ids {
		if s.notifier != nil {
			s.notifier.ManifestChanged(item.id, item.version)
		}
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'screen_group.geometry_updated','screen_group',$3)`, uuid.New(), user, groupID.String())
	return nil
}

func (s *Service) Status(ctx context.Context, groupID uuid.UUID) (StatusResult, error) {
	mode, geometry, err := s.Geometry(ctx, groupID)
	if err != nil {
		return StatusResult{}, err
	}
	result := StatusResult{GroupID: groupID, Mode: mode, Geometry: geometry, Panels: []Preparation{}}
	rows, err := s.db.Query(ctx, `SELECT id,screen_id,source_asset_id,source_variant_id,status,progress,width,height,duration_seconds,frame_rate,error_code,error_message,updated_at FROM span_video_panels WHERE screen_group_id=$1 ORDER BY updated_at DESC,id`, groupID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item Preparation
		var progress *float32
		var updated time.Time
		if err := rows.Scan(&item.ID, &item.ScreenID, &item.SourceAssetID, &item.SourceVariantID, &item.Status, &progress, &item.Width, &item.Height, &item.DurationSeconds, &item.FrameRate, &item.ErrorCode, &item.ErrorMessage, &updated); err != nil {
			return result, err
		}
		if progress != nil {
			value := float64(*progress)
			item.Progress = &value
		}
		item.UpdatedAt = updated.UTC().Format(time.RFC3339)
		result.Panels = append(result.Panels, item)
	}
	return result, rows.Err()
}

func (s *Service) PrepareVideo(ctx context.Context, screenID, assetID, variantID uuid.UUID) (VideoPanel, error) {
	var groupID uuid.UUID
	var mode string
	var canvas Canvas
	if err := s.db.QueryRow(ctx, `SELECT g.id,g.display_mode,g.span_canvas_width,g.span_canvas_height FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id AND g.deleted_at IS NULL WHERE m.screen_id=$1`, screenID).Scan(&groupID, &mode, &canvas.Width, &canvas.Height); errors.Is(err, pgx.ErrNoRows) {
		return VideoPanel{}, ErrNotFound
	} else if err != nil {
		return VideoPanel{}, err
	}
	if mode != ModeSpan {
		return VideoPanel{}, ErrNotFound
	}
	var panel Panel
	var geometryRevision int64
	if err := s.db.QueryRow(ctx, `SELECT p.screen_id,p.panel_order,p.x,p.y,p.width,p.height,p.rotation,p.bezel_left,p.bezel_top,p.bezel_right,p.bezel_bottom,g.span_geometry_revision FROM screen_group_panels p JOIN screen_groups g ON g.id=p.screen_group_id WHERE p.screen_group_id=$1 AND p.screen_id=$2`, groupID, screenID).Scan(&panel.ScreenID, &panel.PanelOrder, &panel.X, &panel.Y, &panel.Width, &panel.Height, &panel.Rotation, &panel.BezelLeft, &panel.BezelTop, &panel.BezelRight, &panel.BezelBottom, &geometryRevision); errors.Is(err, pgx.ErrNoRows) {
		return VideoPanel{}, ErrNotReady
	} else if err != nil {
		return VideoPanel{}, err
	}
	geometryHash := GeometryHash(canvas, panel)
	var organization uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT a.organization_id FROM assets a JOIN asset_variants v ON v.id=$2 AND v.asset_id=a.id AND v.deleted_at IS NULL AND v.player_compatible=TRUE WHERE a.id=$1 AND a.type='video' AND a.processing_status='ready' AND a.deleted_at IS NULL`, assetID, variantID).Scan(&organization); err != nil {
		return VideoPanel{}, fmt.Errorf("Span source video is unavailable: %w", err)
	}
	panelID, status, width, height, duration, frameRate, size, hash, err := s.ensureVideoPanel(ctx, organization, groupID, screenID, assetID, variantID, geometryRevision, geometryHash)
	if err != nil {
		return VideoPanel{}, err
	}
	result := VideoPanel{ID: panelID, Status: status}
	if status != "ready" {
		return result, nil
	}
	result.Width, result.Height, result.DurationSeconds, result.FrameRate, result.FileSize = valueOrZero(width), valueOrZero(height), valueOrZero(duration), valueOrZero(frameRate), valueOrZero(size)
	result.MIMEType = "video/mp4"
	if len(hash) > 0 {
		result.SHA256 = hex.EncodeToString(hash)
	}
	result.DownloadPath = "/api/v1/player/span-panels/" + panelID.String()
	return result, nil
}

// spanPanelRetryAfter is how long a failed panel stays failed before a manifest
// build queues it again. A transient failure (storage, a restart during FFmpeg)
// recovers on its own; a source that always fails costs one retry run per
// interval instead of one per manifest request.
const spanPanelRetryAfter = 15 * time.Minute

// ensureVideoPanel finds or creates the panel row and guarantees that a panel
// which is not ready has a job that will make it ready. Row and job are
// written in one transaction under the row lock, so concurrent manifest builds
// for the same screen agree on one row, and a crash cannot leave a queued row
// without a job. A panel stranded without a job, or failed longer than
// spanPanelRetryAfter, is queued again.
func (s *Service) ensureVideoPanel(ctx context.Context, organization, groupID, screenID, assetID, variantID uuid.UUID, geometryRevision int64, geometryHash string) (panelID uuid.UUID, status string, width, height *int, duration, frameRate *float64, size *int64, hash []byte, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err = tx.Exec(ctx, `INSERT INTO span_video_panels(id,organization_id,screen_group_id,screen_id,source_asset_id,source_variant_id,geometry_revision,geometry_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(screen_group_id,screen_id,source_asset_id,source_variant_id,geometry_hash) DO NOTHING`, uuid.New(), organization, groupID, screenID, assetID, variantID, geometryRevision, geometryHash); err != nil {
		return
	}
	var retryDue bool
	if err = tx.QueryRow(ctx, `SELECT id,status,width,height,duration_seconds,frame_rate,file_size,sha256,updated_at<now()-make_interval(secs=>$6) FROM span_video_panels WHERE screen_group_id=$1 AND screen_id=$2 AND source_asset_id=$3 AND source_variant_id=$4 AND geometry_hash=$5 FOR UPDATE`, groupID, screenID, assetID, variantID, geometryHash, spanPanelRetryAfter.Seconds()).Scan(&panelID, &status, &width, &height, &duration, &frameRate, &size, &hash, &retryDue); err != nil {
		return
	}
	if status != "ready" {
		var active bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_jobs WHERE kind='generate_span_video_panel' AND status IN('queued','running') AND payload->>'panelId'=$1)`, panelID.String()).Scan(&active); err != nil {
			return
		}
		if !active && (status != "failed" || retryDue) {
			var queued []byte
			if queued, err = json.Marshal(map[string]string{"panelId": panelID.String()}); err != nil {
				return
			}
			if _, err = tx.Exec(ctx, `INSERT INTO media_jobs(id,kind,status,payload) VALUES($1,'generate_span_video_panel','queued',$2::jsonb)`, uuid.New(), queued); err != nil {
				return
			}
			if _, err = tx.Exec(ctx, `UPDATE span_video_panels SET status='queued',progress=NULL,updated_at=now() WHERE id=$1`, panelID); err != nil {
				return
			}
			status = "queued"
		}
	}
	err = tx.Commit(ctx)
	return
}

func valueOrZero[T any](value *T) T {
	if value == nil {
		var zero T
		return zero
	}
	return *value
}

func (s *Service) Delivery(ctx context.Context, panelID uuid.UUID) (media.Delivery, error) {
	var key, mime string
	var size int64
	var hash []byte
	if err := s.db.QueryRow(ctx, `SELECT storage_key,mime_type,file_size,sha256 FROM span_video_panels WHERE id=$1 AND status='ready'`, panelID).Scan(&key, &mime, &size, &hash); errors.Is(err, pgx.ErrNoRows) {
		return media.Delivery{}, ErrNotFound
	} else if err != nil {
		return media.Delivery{}, err
	}
	path, err := s.storage.Path(key)
	if err != nil {
		return media.Delivery{}, err
	}
	return media.Delivery{VariantID: panelID, Path: path, MIMEType: mime, Size: size, HashHex: hex.EncodeToString(hash)}, nil
}

func (s *Service) ProcessJob(ctx context.Context, _ string, _ *uuid.UUID, payload []byte) (err error) {
	var request struct {
		PanelID uuid.UUID `json:"panelId"`
	}
	if err = json.Unmarshal(payload, &request); err != nil || request.PanelID == uuid.Nil {
		return errors.New("Span panel job payload is invalid")
	}
	defer func() {
		if err != nil {
			_, _ = s.db.Exec(ctx, `UPDATE span_video_panels SET status='failed',error_code='span_panel_failed',error_message='Tilecast could not prepare this wall panel.',updated_at=now() WHERE id=$1`, request.PanelID)
		}
	}()
	var groupID, screenID uuid.UUID
	var geometryHash string
	var canvas Canvas
	var panel Panel
	var sourceKey string
	if err = s.db.QueryRow(ctx, `SELECT p.screen_group_id,p.screen_id,p.geometry_hash,g.span_canvas_width,g.span_canvas_height,p.x,p.y,p.width,p.height,p.rotation,p.bezel_left,p.bezel_top,p.bezel_right,p.bezel_bottom,v.storage_key FROM span_video_panels p JOIN screen_groups g ON g.id=p.screen_group_id JOIN asset_variants v ON v.id=p.source_variant_id AND v.deleted_at IS NULL WHERE p.id=$1`, request.PanelID).Scan(&groupID, &screenID, &geometryHash, &canvas.Width, &canvas.Height, &panel.X, &panel.Y, &panel.Width, &panel.Height, &panel.Rotation, &panel.BezelLeft, &panel.BezelTop, &panel.BezelRight, &panel.BezelBottom, &sourceKey); err != nil {
		return err
	}
	panel.ScreenID = screenID
	if GeometryHash(canvas, panel) != geometryHash {
		return errors.New("Span panel geometry changed while it was queued")
	}
	source, pathErr := s.storage.Path(sourceKey)
	if pathErr != nil {
		return pathErr
	}
	if _, err = s.db.Exec(ctx, `UPDATE span_video_panels SET status='processing',progress=0,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1`, request.PanelID); err != nil {
		return err
	}
	outputKey := filepath.ToSlash(filepath.Join("variants", "span-panels", request.PanelID.String()+".mp4"))
	output, pathErr := s.storage.Path(outputKey)
	if pathErr != nil {
		return pathErr
	}
	if err = os.MkdirAll(filepath.Dir(output), 0o750); err != nil {
		return err
	}
	tmp, createErr := os.CreateTemp(filepath.Dir(output), ".span-panel-*.mp4")
	if createErr != nil {
		return createErr
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)
	args, argErr := PanelFFmpegArgs(source, tmpPath, canvas, panel)
	if argErr != nil {
		return argErr
	}
	commandCtx, cancel := context.WithTimeout(ctx, 6*time.Hour)
	defer cancel()
	if output, commandErr := exec.CommandContext(commandCtx, s.cfg.FFmpegPath, args...).CombinedOutput(); commandErr != nil {
		_ = output
		return fmt.Errorf("Span video panel generation failed: %w", commandErr)
	}
	if err = os.Rename(tmpPath, output); err != nil {
		return err
	}
	info, probeErr := media.ProbeVideo(ctx, s.cfg.FFprobePath, output)
	if probeErr != nil {
		return probeErr
	}
	if info.Width != panel.Width || info.Height != panel.Height || info.Duration <= 0 || info.FrameRate <= 0 {
		return errors.New("Span panel output did not meet the requested geometry")
	}
	file, openErr := os.Open(output)
	if openErr != nil {
		return openErr
	}
	size, hash, hashErr := hashFile(file)
	_ = file.Close()
	if hashErr != nil {
		return hashErr
	}
	if _, err = s.db.Exec(ctx, `UPDATE span_video_panels SET storage_key=$2,status='ready',progress=1,file_size=$3,sha256=$4,width=$5,height=$6,duration_seconds=$7,frame_rate=$8,updated_at=now() WHERE id=$1`, request.PanelID, outputKey, size, hash, info.Width, info.Height, info.Duration, info.FrameRate); err != nil {
		return err
	}
	if err = s.bumpScreen(ctx, screenID, "span_video_panel.ready"); err != nil {
		return err
	}
	_ = groupID
	return nil
}

func (s *Service) bumpScreen(ctx context.Context, screenID uuid.UUID, reason string) error {
	var version int64
	if err := s.db.QueryRow(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason) VALUES($1,1,$2) ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2 RETURNING manifest_version`, screenID, reason).Scan(&version); err != nil {
		return err
	}
	if s.notifier != nil {
		s.notifier.ManifestChanged(screenID, version)
	}
	return nil
}

type note struct {
	id      uuid.UUID
	version int64
}

func bumpScreens(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, reason string) ([]note, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason) SELECT unnest($1::uuid[]),1,$2 ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2 RETURNING screen_id,manifest_version`, ids, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []note{}
	for rows.Next() {
		var item note
		if err := rows.Scan(&item.id, &item.version); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func hashFile(file *os.File) (int64, []byte, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return 0, nil, err
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return 0, nil, err
	}
	return size, hash.Sum(nil), nil
}

// PanelFFmpegArgs is pure and contains only generated paths and bounded
// numeric geometry. It is shared by the worker and unit tests.
func PanelFFmpegArgs(source, output string, canvas Canvas, panel Panel) ([]string, error) {
	if err := ValidateGeometry(canvas, []Panel{panel}); err != nil {
		return nil, err
	}
	cropWidth := panel.Width - panel.BezelLeft - panel.BezelRight
	cropHeight := panel.Height - panel.BezelTop - panel.BezelBottom
	if cropWidth < 1 || cropHeight < 1 {
		return nil, errors.New("Span bezel compensation removes the panel")
	}
	filter := fmt.Sprintf("scale=w=%d:h=%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,crop=%d:%d:%d:%d", canvas.Width, canvas.Height, canvas.Width, canvas.Height, cropWidth, cropHeight, panel.X+panel.BezelLeft, panel.Y+panel.BezelTop)
	switch panel.Rotation {
	case 90:
		filter += ",transpose=1"
	case 180:
		filter += ",hflip,vflip"
	case 270:
		filter += ",transpose=2"
	}
	filter += fmt.Sprintf(",scale=%d:%d:flags=lanczos,format=yuv420p", panel.Width, panel.Height)
	args := []string{"-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", source, "-map", "0:v:0", "-an", "-vf", filter, "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-force_key_frames", "expr:gte(t,n_forced*2)", "-threads", "2", "-movflags", "+faststart", "-map_metadata", "-1", "-y", output}
	return args, nil
}
