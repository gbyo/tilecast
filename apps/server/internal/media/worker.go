package media

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type WorkerPool struct {
	service        *Service
	logger         *slog.Logger
	id             string
	wg             sync.WaitGroup
	cancel         context.CancelFunc
	gate           func() bool
	extraProcessor func(context.Context, string, *uuid.UUID, []byte) error
}

// SetGate installs a check consulted before claiming work. Backup snapshots
// pause media processing so files cannot mutate while they are archived.
func (p *WorkerPool) SetGate(gate func() bool) { p.gate = gate }

// SetExtraProcessor lets a feature-owned media job reuse the durable worker
// lifecycle without adding feature-specific SQL or a second scheduler.
func (p *WorkerPool) SetExtraProcessor(processor func(context.Context, string, *uuid.UUID, []byte) error) {
	p.extraProcessor = processor
}

type job struct {
	ID                    uuid.UUID
	AssetID               *uuid.UUID
	Kind                  string
	Payload               []byte
	Attempts, MaxAttempts int
}

func NewWorkerPool(service *Service, logger *slog.Logger) *WorkerPool {
	return &WorkerPool{service: service, logger: logger, id: uuid.NewString()}
}
func (p *WorkerPool) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	p.cancel = cancel
	for i := 0; i < p.service.cfg.Workers; i++ {
		p.wg.Add(1)
		go p.run(ctx)
	}
}
func (p *WorkerPool) Stop() {
	if p.cancel != nil {
		p.cancel()
	}
	p.wg.Wait()
}
func (p *WorkerPool) run(ctx context.Context) {
	defer p.wg.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for {
				if p.gate != nil && !p.gate() {
					break
				}
				j, err := p.claim(ctx)
				if err != nil {
					p.logger.Error("claim media job", "error", err)
					break
				}
				if j == nil {
					break
				}
				stopLease := p.keepLease(ctx, *j)
				processErr := p.process(ctx, *j)
				stopLease()
				if processErr != nil {
					p.fail(ctx, *j, processErr)
				} else {
					p.complete(ctx, *j)
				}
			}
		}
	}
}
func (p *WorkerPool) claim(ctx context.Context) (*job, error) {
	tx, err := p.service.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var j job
	err = tx.QueryRow(ctx, `SELECT id,asset_id,kind,payload,attempts,max_attempts FROM media_jobs WHERE (status='queued' AND run_after<=now()) OR (status='running' AND locked_at<now()-interval '10 minutes') ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&j.ID, &j.AssetID, &j.Kind, &j.Payload, &j.Attempts, &j.MaxAttempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	j.Attempts++
	_, err = tx.Exec(ctx, `UPDATE media_jobs SET status='running',attempts=$2,locked_at=now(),locked_by=$3,updated_at=now() WHERE id=$1`, j.ID, j.Attempts, p.id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &j, nil
}

// mediaLeaseHeartbeat is how often a running job refreshes its lease. It is well
// inside the 10-minute reclaim window, so a slow but live FFmpeg run keeps its job.
const mediaLeaseHeartbeat = time.Minute

// keepLease refreshes this worker's lease on the job until the returned stop
// function is called. The refresh is fenced like completion, so a worker that
// has lost the job cannot extend another worker's lease.
func (p *WorkerPool) keepLease(ctx context.Context, j job) (stop func()) {
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(mediaLeaseHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, _ = p.service.db.Exec(ctx, `UPDATE media_jobs SET locked_at=now() WHERE id=$1 AND status='running' AND locked_by=$2 AND attempts=$3`, j.ID, p.id, j.Attempts)
			}
		}
	}()
	return func() {
		close(done)
		<-finished
	}
}

// complete marks a job succeeded only if this worker still holds its current
// attempt. A reclaimed job's original worker must not overwrite its replacement.
func (p *WorkerPool) complete(ctx context.Context, j job) {
	tag, err := p.service.db.Exec(ctx, `UPDATE media_jobs SET status='succeeded',progress=1,completed_at=now(),updated_at=now(),locked_at=NULL,locked_by=NULL WHERE id=$1 AND status='running' AND locked_by=$2 AND attempts=$3`, j.ID, p.id, j.Attempts)
	if err != nil {
		p.logger.Error("complete media job", "error", err, "job_id", j.ID)
		return
	}
	if tag.RowsAffected() == 0 {
		p.logger.Warn("media job completed by a superseded worker; result ignored", "job_id", j.ID)
	}
}
func (p *WorkerPool) fail(ctx context.Context, j job, cause error) {
	code := "media_processing_failed"
	if errors.Is(cause, ErrInspectionFailed) {
		code = "media_inspection_failed"
	}
	safe := "Tilecast could not process this media file."
	status := "queued"
	runAfter := time.Now().Add(time.Duration(j.Attempts*j.Attempts) * 5 * time.Second)
	if j.Attempts >= j.MaxAttempts {
		status = "failed"
	}
	tag, err := p.service.db.Exec(ctx, `UPDATE media_jobs SET status=$2,run_after=$3,error_code=$4,error_message=$5,updated_at=now(),locked_at=NULL,locked_by=NULL WHERE id=$1 AND status='running' AND locked_by=$6 AND attempts=$7`, j.ID, status, runAfter, code, safe, p.id, j.Attempts)
	if err == nil && tag.RowsAffected() == 0 {
		p.logger.Warn("media job failed under a superseded worker; result ignored", "job_id", j.ID)
		return
	}
	if err == nil && status == "failed" && j.AssetID != nil {
		_, err = p.service.db.Exec(ctx, `UPDATE assets SET processing_status='failed',processing_progress=NULL,error_code=$2,error_message=$3,updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, *j.AssetID, code, safe)
	}
	p.logger.Error("media job failed", "error", cause, "job_id", j.ID, "kind", j.Kind, "will_retry", status == "queued")
}

func (p *WorkerPool) process(ctx context.Context, j job) error {
	switch j.Kind {
	case "inspect_asset":
		return p.inspect(ctx, *j.AssetID)
	case "generate_image_thumbnail":
		return p.preview(ctx, *j.AssetID, false)
	case "generate_video_poster":
		return p.preview(ctx, *j.AssetID, true)
	case "optimize_video":
		return p.optimize(ctx, *j.AssetID)
	case "delete_asset_files":
		return p.deleteFiles(ctx, *j.AssetID)
	case "clean_expired_uploads":
		return p.cleanExpired(ctx)
	default:
		if p.extraProcessor != nil {
			return p.extraProcessor(ctx, j.Kind, j.AssetID, j.Payload)
		}
		return fmt.Errorf("unknown media job %s", j.Kind)
	}
}

func (p *WorkerPool) source(ctx context.Context, assetID uuid.UUID) (assetType, key string, err error) {
	err = p.service.db.QueryRow(ctx, `SELECT a.type,v.storage_key FROM assets a JOIN asset_variants v ON v.asset_id=a.id AND v.kind='original' AND v.deleted_at IS NULL WHERE a.id=$1`, assetID).Scan(&assetType, &key)
	return
}
func (p *WorkerPool) inspect(ctx context.Context, assetID uuid.UUID) error {
	assetType, key, err := p.source(ctx, assetID)
	if err != nil {
		return err
	}
	path, err := p.service.storage.Path(key)
	if err != nil {
		return err
	}
	if _, err := p.service.db.Exec(ctx, `UPDATE assets SET processing_status='inspecting',processing_progress=NULL,updated_at=now() WHERE id=$1`, assetID); err != nil {
		return err
	}
	if assetType == "image" {
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		info, err := InspectImage(f)
		_ = f.Close()
		if err != nil {
			return ErrInspectionFailed
		}
		metadata := fmt.Sprintf(`{"animated":%t,"frameCount":%d}`, info.Animated, info.FrameCount)
		tx, err := p.service.db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		_, err = tx.Exec(ctx, `UPDATE assets SET width=$2,height=$3,metadata=$4::jsonb,processing_status='processing',updated_at=now() WHERE id=$1`, assetID, info.Width, info.Height, metadata)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE asset_variants SET width=$2,height=$3,player_compatible=TRUE WHERE asset_id=$1 AND kind='original'`, assetID, info.Width, info.Height)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO media_jobs(id,asset_id,kind,status)VALUES($1,$2,'generate_image_thumbnail','queued') ON CONFLICT DO NOTHING`, uuid.New(), assetID)
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	info, err := ProbeVideo(ctx, p.service.cfg.FFprobePath, path)
	if err != nil {
		return err
	}
	decision := DecideVideo(info, p.service.cfg.Profile)
	metadata := fmt.Sprintf(`{"container":%q,"pixelFormat":%q,"rotation":%d,"displayAspectRatio":%q,"pixelAspectRatio":%q,"bitRate":%d,"audioSampleRate":%d,"compatibilityAction":%q}`, info.Container, info.PixelFormat, info.Rotation, info.DisplayAspectRatio, info.PixelAspectRatio, info.BitRate, info.AudioSampleRate, decision.Action)
	tx, err := p.service.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `UPDATE assets SET width=$2,height=$3,duration_seconds=$4,frame_rate=$5,video_codec=$6,audio_codec=NULLIF($7,''),audio_channels=NULLIF($8,0),metadata=$9::jsonb,processing_status='processing',updated_at=now() WHERE id=$1`, assetID, info.Width, info.Height, info.Duration, info.FrameRate, info.VideoCodec, info.AudioCodec, info.AudioChannels, metadata)
	if err != nil {
		return err
	}
	if decision.Action == UseOriginal {
		_, err = tx.Exec(ctx, `UPDATE asset_variants SET width=$2,height=$3,duration_seconds=$4,frame_rate=$5,video_codec=$6,audio_codec=NULLIF($7,''),player_compatible=TRUE WHERE asset_id=$1 AND kind='original'`, assetID, info.Width, info.Height, info.Duration, info.FrameRate, info.VideoCodec, info.AudioCodec)
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO media_jobs(id,asset_id,kind,status)VALUES($1,$2,'generate_video_poster','queued') ON CONFLICT DO NOTHING`, uuid.New(), assetID)
	if err != nil {
		return err
	}
	if decision.Action != UseOriginal {
		_, err = tx.Exec(ctx, `INSERT INTO media_jobs(id,asset_id,kind,status)VALUES($1,$2,'optimize_video','queued') ON CONFLICT DO NOTHING`, uuid.New(), assetID)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *WorkerPool) preview(ctx context.Context, assetID uuid.UUID, poster bool) error {
	_, sourceKey, err := p.source(ctx, assetID)
	if err != nil {
		return err
	}
	sourcePath, err := p.service.storage.Path(sourceKey)
	if err != nil {
		return err
	}
	variantID := uuid.New()
	key := PreviewKey(assetID, variantID, poster)
	final, err := p.service.storage.Path(key)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(final), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(final), ".preview-*.jpg")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)
	committed := false
	defer func() {
		if !committed {
			_ = p.service.storage.Delete(key)
		}
	}()
	filter := "scale=480:270:force_original_aspect_ratio=decrease:force_divisible_by=2"
	args := []string{"-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", sourcePath}
	if poster {
		args = append(args, "-ss", "1")
	}
	args = append(args, "-frames:v", "1", "-vf", filter, "-map_metadata", "-1", "-q:v", "3", "-y", tmpPath)
	cmdCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if output, err := exec.CommandContext(cmdCtx, p.service.cfg.FFmpegPath, args...).CombinedOutput(); err != nil {
		_ = output
		return fmt.Errorf("generate preview: %w", err)
	}
	if err = os.Rename(tmpPath, final); err != nil {
		return err
	}
	size, sum, err := fileHash(final)
	if err != nil {
		return err
	}
	kind := "thumbnail"
	if poster {
		kind = "poster"
	}
	var oldKey string
	_ = p.service.db.QueryRow(ctx, `SELECT storage_key FROM asset_variants WHERE asset_id=$1 AND kind=$2`, assetID, kind).Scan(&oldKey)
	_, err = p.service.db.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,created_at)VALUES($1,$2,$3,'local',$4,'image/jpeg',$5,$6,now()) ON CONFLICT(asset_id,kind) DO UPDATE SET storage_key=EXCLUDED.storage_key,file_size=EXCLUDED.file_size,sha256=EXCLUDED.sha256,deleted_at=NULL,created_at=now()`, variantID, assetID, kind, key, size, sum)
	if err != nil {
		return err
	}
	committed = true
	if oldKey != "" && oldKey != key {
		_ = p.service.storage.Delete(oldKey)
	}
	return p.markReadyIfComplete(ctx, assetID)
}

func (p *WorkerPool) optimize(ctx context.Context, assetID uuid.UUID) error {
	_, sourceKey, err := p.source(ctx, assetID)
	if err != nil {
		return err
	}
	source, err := p.service.storage.Path(sourceKey)
	if err != nil {
		return err
	}
	info, err := ProbeVideo(ctx, p.service.cfg.FFprobePath, source)
	if err != nil {
		return err
	}
	decision := DecideVideo(info, p.service.cfg.Profile)
	variantID := uuid.New()
	key := VariantKey(assetID, variantID, ".mp4")
	final, err := p.service.storage.Path(key)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(final), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(final), ".video-*.mp4")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)
	committed := false
	defer func() {
		if !committed {
			_ = p.service.storage.Delete(key)
		}
	}()
	args := []string{"-nostdin", "-v", "error", "-progress", "pipe:1", "-protocol_whitelist", "file,pipe", "-i", source, "-map", "0:v:0", "-map", "0:a?"}
	if decision.Action == Remux {
		args = append(args, "-c", "copy")
	} else {
		scale := fmt.Sprintf("scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", p.service.cfg.Profile.MaxWidth, p.service.cfg.Profile.MaxHeight)
		args = append(args, "-vf", scale, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "21", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "192k")
		if info.FrameRate > p.service.cfg.Profile.MaxFrameRate {
			args = append(args, "-r", fmt.Sprintf("%g", p.service.cfg.Profile.MaxFrameRate))
		}
	}
	args = append(args, "-movflags", "+faststart", "-map_metadata", "-1", "-y", tmpPath)
	cmdCtx, cancel := context.WithTimeout(ctx, 6*time.Hour)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, p.service.cfg.FFmpegPath, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		_ = output
		return fmt.Errorf("optimize video: %w", err)
	}
	if err = os.Rename(tmpPath, final); err != nil {
		return err
	}
	processed, err := ProbeVideo(ctx, p.service.cfg.FFprobePath, final)
	if err != nil {
		return err
	}
	size, sum, err := fileHash(final)
	if err != nil {
		return err
	}
	var oldKey string
	_ = p.service.db.QueryRow(ctx, `SELECT storage_key FROM asset_variants WHERE asset_id=$1 AND kind='playback'`, assetID).Scan(&oldKey)
	_, err = p.service.db.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,width,height,duration_seconds,frame_rate,video_codec,audio_codec,player_compatible)VALUES($1,$2,'playback','local',$3,'video/mp4',$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),TRUE) ON CONFLICT(asset_id,kind)DO UPDATE SET storage_key=EXCLUDED.storage_key,file_size=EXCLUDED.file_size,sha256=EXCLUDED.sha256,width=EXCLUDED.width,height=EXCLUDED.height,duration_seconds=EXCLUDED.duration_seconds,frame_rate=EXCLUDED.frame_rate,video_codec=EXCLUDED.video_codec,audio_codec=EXCLUDED.audio_codec,player_compatible=TRUE,deleted_at=NULL`, variantID, assetID, key, size, sum, processed.Width, processed.Height, processed.Duration, processed.FrameRate, processed.VideoCodec, processed.AudioCodec)
	if err != nil {
		return err
	}
	committed = true
	if oldKey != "" && oldKey != key {
		_ = p.service.storage.Delete(oldKey)
	}
	if !p.service.cfg.KeepOriginals {
		_ = p.service.storage.Delete(sourceKey)
		_, _ = p.service.db.Exec(ctx, `UPDATE asset_variants SET deleted_at=now(),player_compatible=FALSE WHERE asset_id=$1 AND kind='original'`, assetID)
	}
	return p.markReadyIfComplete(ctx, assetID)
}

func (p *WorkerPool) markReadyIfComplete(ctx context.Context, assetID uuid.UUID) error {
	var assetType string
	var preview, compatible bool
	err := p.service.db.QueryRow(ctx, `SELECT a.type,EXISTS(SELECT 1 FROM asset_variants v WHERE v.asset_id=a.id AND v.deleted_at IS NULL AND v.kind=CASE WHEN a.type='image' THEN 'thumbnail' ELSE 'poster' END),EXISTS(SELECT 1 FROM asset_variants v WHERE v.asset_id=a.id AND v.deleted_at IS NULL AND v.player_compatible=TRUE) FROM assets a WHERE a.id=$1`, assetID).Scan(&assetType, &preview, &compatible)
	_ = assetType
	if err != nil {
		return err
	}
	if preview && compatible {
		_, err = p.service.db.Exec(ctx, `UPDATE assets SET processing_status='ready',processing_progress=1,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, assetID)
	}
	return err
}

func (p *WorkerPool) deleteFiles(ctx context.Context, assetID uuid.UUID) error {
	rows, err := p.service.db.Query(ctx, `SELECT storage_key FROM asset_variants WHERE asset_id=$1 AND deleted_at IS NULL`, assetID)
	if err != nil {
		return err
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	rows.Close()
	for _, key := range keys {
		if err := p.service.storage.Delete(key); err != nil {
			return err
		}
	}
	tx, err := p.service.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE asset_variants SET deleted_at=COALESCE(deleted_at,now()) WHERE asset_id=$1`, assetID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE assets SET processing_status='deleted',updated_at=now() WHERE id=$1`, assetID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (p *WorkerPool) cleanExpired(ctx context.Context) error {
	rows, err := p.service.db.Query(ctx, `UPDATE upload_sessions SET status='expired',failure_code='upload_expired_cleanup_pending' WHERE expires_at<now() AND (status IN('pending','uploading') OR (status='expired' AND failure_code='upload_expired_cleanup_pending')) RETURNING id,temporary_storage_key`)
	if err != nil {
		return err
	}
	defer rows.Close()
	cleaned := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		var key string
		if err := rows.Scan(&id, &key); err != nil {
			return err
		}
		if err := p.service.storage.Delete(key); err != nil {
			return err
		}
		cleaned = append(cleaned, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if err := p.service.retryCancelledCleanup(ctx); err != nil {
		return err
	}
	for _, id := range cleaned {
		if _, err := p.service.db.Exec(ctx, `UPDATE upload_sessions SET failure_code='upload_expired' WHERE id=$1 AND status='expired' AND failure_code='upload_expired_cleanup_pending'`, id); err != nil {
			return err
		}
	}
	// Finalization is intentionally reconciled separately from expiry. A process
	// or database failure can leave the object moved while the upload row is
	// still finalizing; retrying the normal idempotent finalizer registers that
	// object instead of treating it as an orphan.
	rows, err = p.service.db.Query(ctx, `SELECT id,created_by,temporary_storage_key,final_storage_key,created_at FROM upload_sessions WHERE status='finalizing' ORDER BY created_at LIMIT 32`)
	if err != nil {
		return err
	}
	type pendingFinalization struct {
		id, user  uuid.UUID
		temporary string
		final     *string
		createdAt time.Time
	}
	pending := []pendingFinalization{}
	for rows.Next() {
		var item pendingFinalization
		if err := rows.Scan(&item.id, &item.user, &item.temporary, &item.final, &item.createdAt); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, item)
	}
	rows.Close()
	for _, item := range pending {
		temporaryExists := false
		if _, statErr := p.service.storage.Stat(item.temporary); statErr == nil {
			temporaryExists = true
		}
		finalExists := false
		if item.final != nil {
			if _, statErr := p.service.storage.Stat(*item.final); statErr == nil {
				finalExists = true
			}
		}
		if !temporaryExists && !finalExists && time.Since(item.createdAt) > 24*time.Hour {
			if _, updateErr := p.service.db.Exec(ctx, `UPDATE upload_sessions SET status='failed',failure_code='media_finalization_source_missing' WHERE id=$1 AND status='finalizing'`, item.id); updateErr != nil {
				return updateErr
			}
			continue
		}
		if _, err := p.service.FinalizeUpload(ctx, item.id, item.user); err == nil {
			continue
		} else {
			if p.logger != nil {
				p.logger.Warn("upload finalization reconciliation deferred", "upload_id", item.id, "error", err)
			}
		}
	}
	// Failed finalizations can still own a temporary or moved final object.
	// Cleanup is a separate retryable pass so a transient storage failure never
	// leaves an orphan behind or keeps the upload in finalizing forever.
	rows, err = p.service.db.Query(ctx, `SELECT id,temporary_storage_key,final_storage_key FROM upload_sessions WHERE status='failed' AND finalization_cleanup_pending=TRUE ORDER BY created_at LIMIT 32`)
	if err != nil {
		return err
	}
	type pendingCleanup struct {
		id        uuid.UUID
		temporary string
		final     *string
	}
	cleanupItems := []pendingCleanup{}
	for rows.Next() {
		var item pendingCleanup
		if err := rows.Scan(&item.id, &item.temporary, &item.final); err != nil {
			rows.Close()
			return err
		}
		cleanupItems = append(cleanupItems, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, item := range cleanupItems {
		cleanupErr := p.service.storage.Delete(item.temporary)
		if item.final != nil && *item.final != "" && *item.final != item.temporary {
			if err := p.service.storage.Delete(*item.final); cleanupErr == nil {
				cleanupErr = err
			}
		}
		if cleanupErr != nil {
			if p.logger != nil {
				p.logger.Warn("upload finalization cleanup deferred", "upload_id", item.id, "error", cleanupErr)
			}
			continue
		}
		if _, err := p.service.db.Exec(ctx, `UPDATE upload_sessions SET finalization_cleanup_pending=FALSE WHERE id=$1 AND status='failed'`, item.id); err != nil {
			return err
		}
	}
	return nil
}
func fileHash(path string) (int64, []byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, nil, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return n, h.Sum(nil), err
}

func ValidateExecutable(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("media executable paths must be absolute")
	}
	cmd := exec.Command(path, "-version")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd = exec.CommandContext(ctx, path, "-version")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("%s is unavailable: %w", path, err)
	}
	if !strings.Contains(strings.ToLower(string(output)), strings.TrimPrefix(filepath.Base(path), "/")) {
		return errors.New("media executable returned an unexpected version response")
	}
	return nil
}
