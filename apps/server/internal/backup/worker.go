package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

// WorkerConfig carries everything the worker needs to run jobs.
type WorkerConfig struct {
	DatabaseURL       string
	MediaRoot         string
	UpdatesRoot       string
	ReservedFreeBytes int64
	Limits            Limits
	Build             version.Build
}

// MemoryJobStatus is the in-memory view of the active job. During a restore
// the database is mid-swap, so HTTP status responses come from here.
type MemoryJobStatus struct {
	JobID           uuid.UUID `json:"jobId"`
	Kind            string    `json:"kind"`
	Status          string    `json:"status"`
	Phase           string    `json:"phase"`
	ProgressPercent int       `json:"progressPercent"`
}

// Worker claims and executes backup jobs, drives the backup schedule, and
// applies retention. A single worker goroutine runs per process; cross-
// process exclusion comes from the backup_jobs partial unique index and
// FOR UPDATE SKIP LOCKED claiming.
type Worker struct {
	svc    *Service
	cfg    WorkerConfig
	logger *slog.Logger
	id     string

	mu      sync.Mutex
	current *MemoryJobStatus

	cancel context.CancelFunc
	done   chan struct{}
}

// NewWorker creates a backup worker.
func NewWorker(svc *Service, cfg WorkerConfig, logger *slog.Logger) *Worker {
	return &Worker{svc: svc, cfg: cfg, logger: logger, id: "backup-" + uuid.NewString()[:8]}
}

// CurrentStatus returns the in-memory active job, if any.
func (w *Worker) CurrentStatus() *MemoryJobStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.current == nil {
		return nil
	}
	copied := *w.current
	return &copied
}

func (w *Worker) setStatus(status *MemoryJobStatus) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.current = status
}

// Start launches the worker goroutine.
func (w *Worker) Start(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	w.done = make(chan struct{})
	go w.run(ctx)
}

// Stop cancels the worker and waits for it to exit.
func (w *Worker) Stop() {
	if w.cancel != nil {
		w.cancel()
	}
	if w.done != nil {
		<-w.done
	}
}

func (w *Worker) run(ctx context.Context) {
	defer close(w.done)
	w.startup(ctx)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	scheduleTicker := time.NewTicker(30 * time.Second)
	defer scheduleTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.claimAndRun(ctx)
		case <-scheduleTicker.C:
			w.tickSchedule(ctx)
		}
	}
}

// startup performs restart recovery: roll back any interrupted restore, fail
// jobs orphaned by a previous process, clear temporary files, reconcile the
// catalog with the backup root, and evaluate the schedule immediately so a
// run missed during downtime happens promptly.
func (w *Worker) startup(ctx context.Context) {
	if _, err := RecoverInterrupted(ctx, w.cfg.DatabaseURL, w.cfg.MediaRoot, w.cfg.UpdatesRoot, w.logger); err != nil {
		w.logger.Error("restore recovery failed", "error", err)
	}
	if _, err := w.svc.db.Exec(ctx, `UPDATE backup_jobs SET status = 'failed', error_code = 'interrupted', error_message = 'The job was interrupted by a server restart.', completed_at = now(), updated_at = now() WHERE status = 'running'`); err != nil {
		w.logger.Error("failing interrupted backup jobs failed", "error", err)
	}
	tmpDir := filepath.Join(w.svc.root, "tmp")
	if entries, err := os.ReadDir(tmpDir); err == nil {
		for _, entry := range entries {
			os.RemoveAll(filepath.Join(tmpDir, entry.Name()))
		}
	}
	if err := w.svc.ReconcileDisk(ctx); err != nil {
		w.logger.Error("backup catalog reconciliation failed", "error", err)
	}
	w.tickSchedule(ctx)
}

// leaseHeartbeat is how often a running job refreshes its lease. It is well
// inside the 15-minute lease the claim query uses, so a healthy job is never
// reclaimed by another process.
const leaseHeartbeat = time.Minute

// heartbeatLease refreshes a running job's lease every interval until the
// returned stop function is called. Errors are ignored: a missed refresh only
// matters if it persists until the lease lapses.
func heartbeatLease(ctx context.Context, db *pgxpool.Pool, jobID uuid.UUID, interval time.Duration) (stop func()) {
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, _ = db.Exec(ctx, `UPDATE backup_jobs SET locked_at = now() WHERE id = $1 AND status = 'running'`, jobID)
			}
		}
	}()
	return func() {
		close(done)
		<-finished
	}
}

func (w *Worker) claimAndRun(ctx context.Context) {
	row := w.svc.db.QueryRow(ctx, `UPDATE backup_jobs SET status = 'running', locked_at = now(), locked_by = $1, updated_at = now()
		WHERE id = (SELECT id FROM backup_jobs WHERE status = 'queued' OR (status = 'running' AND locked_at < now() - interval '15 minutes' AND kind <> 'restore')
			ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING id, kind, trigger, archive_id, requested_by, confirm_identity_mismatch`, w.id)
	var (
		jobID                   uuid.UUID
		kind, trigger           string
		archiveID, requestedBy  *uuid.UUID
		confirmIdentityMismatch bool
	)
	if err := row.Scan(&jobID, &kind, &trigger, &archiveID, &requestedBy, &confirmIdentityMismatch); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			w.logger.Error("claim backup job failed", "error", err)
		}
		return
	}

	w.setStatus(&MemoryJobStatus{JobID: jobID, Kind: kind, Status: "running"})
	defer w.setStatus(nil)
	// Phase updates refresh the lease only when a phase changes. A single step
	// can run far longer than the lease, so refresh it on a timer as well.
	stopLease := heartbeatLease(ctx, w.svc.db, jobID, leaseHeartbeat)
	defer stopLease()

	switch kind {
	case "backup":
		w.runBackup(ctx, jobID, trigger, requestedBy)
	case "verify":
		w.runVerify(ctx, jobID, archiveID, requestedBy)
	case "restore":
		w.runRestore(ctx, jobID, archiveID, requestedBy, confirmIdentityMismatch)
	default:
		w.finishJob(ctx, jobID, "failed", "unsupported_job", "Unsupported job kind.")
	}
}

func (w *Worker) progressFunc(ctx context.Context, jobID uuid.UUID, kind string) func(string, int) {
	return func(phase string, percent int) {
		w.setStatus(&MemoryJobStatus{JobID: jobID, Kind: kind, Status: "running", Phase: phase, ProgressPercent: percent})
		// Best effort: during a restore the job table may be mid-swap.
		_, _ = w.svc.db.Exec(ctx, `UPDATE backup_jobs SET phase = $2, progress_percent = $3, locked_at = now(), updated_at = now() WHERE id = $1`, jobID, phase, min(percent, 100))
	}
}

func (w *Worker) runBackup(ctx context.Context, jobID uuid.UUID, trigger string, requestedBy *uuid.UUID) {
	guard := w.svc.guard
	guard.Begin(GuardBackup, jobID.String())
	defer guard.End()

	kind := KindManual
	switch trigger {
	case "scheduled":
		kind = KindScheduled
	case "pre_restore":
		kind = KindPreRestore
	}
	result, err := Create(ctx, CreateOptions{
		DB:                w.svc.db,
		MediaRoot:         w.cfg.MediaRoot,
		UpdatesRoot:       w.cfg.UpdatesRoot,
		BackupRoot:        w.svc.root,
		Kind:              kind,
		Build:             w.cfg.Build,
		ReservedFreeBytes: w.cfg.ReservedFreeBytes,
		Limits:            w.cfg.Limits,
		Progress:          w.progressFunc(ctx, jobID, "backup"),
	})
	if err != nil {
		w.logger.Error("backup failed", "error", err)
		w.finishJob(ctx, jobID, "failed", "backup_failed", err.Error())
		w.audit(ctx, requestedBy, "backup.create_failed", "failure", "", map[string]any{"trigger": trigger})
		return
	}

	now := time.Now().UTC()
	archive := Archive{
		ID:               uuid.New(),
		FileName:         result.FileName,
		Kind:             kind,
		Status:           "complete",
		SizeBytes:        result.SizeBytes,
		ArchiveSHA256:    result.ArchiveSHA256,
		TilecastVersion:  result.Manifest.TilecastVersion,
		SchemaVersion:    result.Manifest.SchemaVersion,
		InstallationID:   result.Manifest.InstallationID,
		OrganizationName: result.Manifest.OrganizationName,
		Components:       result.Manifest.Components,
		Verification:     "verified",
		VerifiedAt:       &now,
		CreatedAt:        result.Manifest.CreatedAt,
	}
	if err := w.svc.RegisterArchive(ctx, archive); err != nil {
		w.logger.Error("register finished backup failed", "error", err)
		w.finishJob(ctx, jobID, "failed", "backup_register_failed", err.Error())
		return
	}
	if _, err := w.svc.db.Exec(ctx, `UPDATE backup_jobs SET archive_id = $2, updated_at = now() WHERE id = $1`, jobID, archive.ID); err != nil {
		w.logger.Error("link backup job to archive failed", "error", err)
	}
	w.finishJob(ctx, jobID, "succeeded", "", "")
	w.audit(ctx, requestedBy, "backup.created", "success", result.FileName, map[string]any{"trigger": trigger, "sizeBytes": result.SizeBytes, "kind": string(kind)})

	if trigger == "scheduled" {
		w.applyRetention(ctx)
	}
}

func (w *Worker) runVerify(ctx context.Context, jobID uuid.UUID, archiveID, requestedBy *uuid.UUID) {
	if archiveID == nil {
		w.finishJob(ctx, jobID, "failed", "archive_missing", "The archive to verify no longer exists.")
		return
	}
	archive, err := w.svc.Get(ctx, *archiveID)
	if err != nil {
		w.finishJob(ctx, jobID, "failed", "archive_missing", "The archive to verify no longer exists.")
		return
	}
	progress := w.progressFunc(ctx, jobID, "verify")
	progress("verifying", 10)
	result, err := Verify(ctx, w.svc.ArchivePath(archive), w.cfg.Limits)
	now := time.Now().UTC()
	if err != nil {
		w.logger.Warn("backup verification failed", "file", archive.FileName, "error", err)
		if markErr := w.svc.MarkVerification(ctx, archive.ID, false, now); markErr != nil {
			w.logger.Error("record verification failure failed", "error", markErr)
		}
		w.finishJob(ctx, jobID, "failed", "verification_failed", err.Error())
		w.audit(ctx, requestedBy, "backup.verify_failed", "failure", archive.FileName, nil)
		return
	}
	// Verification proves the manifest; refresh catalog metadata from it so
	// archives dropped into the backup root become fully described.
	archive.Status = "complete"
	archive.ArchiveSHA256 = result.ArchiveSHA256
	archive.SizeBytes = result.SizeBytes
	archive.TilecastVersion = result.Manifest.TilecastVersion
	archive.SchemaVersion = result.Manifest.SchemaVersion
	archive.InstallationID = result.Manifest.InstallationID
	archive.OrganizationName = result.Manifest.OrganizationName
	archive.Components = result.Manifest.Components
	archive.Verification = "verified"
	archive.VerifiedAt = &now
	archive.CreatedAt = result.Manifest.CreatedAt
	if err := w.svc.RegisterArchive(ctx, archive); err != nil {
		w.finishJob(ctx, jobID, "failed", "backup_register_failed", err.Error())
		return
	}
	w.finishJob(ctx, jobID, "succeeded", "", "")
	w.audit(ctx, requestedBy, "backup.verified", "success", archive.FileName, nil)
}

func (w *Worker) runRestore(ctx context.Context, jobID uuid.UUID, archiveID, requestedBy *uuid.UUID, confirmIdentityMismatch bool) {
	if archiveID == nil {
		w.finishJob(ctx, jobID, "failed", "archive_missing", "The archive to restore no longer exists.")
		return
	}
	archive, err := w.svc.Get(ctx, *archiveID)
	if err != nil {
		w.finishJob(ctx, jobID, "failed", "archive_missing", "The archive to restore no longer exists.")
		return
	}

	guard := w.svc.guard
	guard.Begin(GuardRestore, jobID.String())
	defer guard.End()

	w.audit(ctx, requestedBy, "restore.requested", "success", archive.FileName, map[string]any{"archiveInstallationId": archive.InstallationID})

	result, err := Apply(ctx, ApplyOptions{
		DB:                      w.svc.db,
		DatabaseURL:             w.cfg.DatabaseURL,
		MediaRoot:               w.cfg.MediaRoot,
		UpdatesRoot:             w.cfg.UpdatesRoot,
		BackupRoot:              w.svc.root,
		ArchivePath:             w.svc.ArchivePath(archive),
		Build:                   w.cfg.Build,
		ReservedFreeBytes:       w.cfg.ReservedFreeBytes,
		Limits:                  w.cfg.Limits,
		ConfirmIdentityMismatch: confirmIdentityMismatch,
		Progress:                w.progressFunc(ctx, jobID, "restore"),
		Logger:                  w.logger,
	})
	if err != nil {
		code := "restore_failed"
		if errors.Is(err, ErrIdentityMismatch) {
			code = "restore_identity_mismatch"
		}
		w.logger.Error("restore failed", "error", err)
		// Apply either changed nothing or rolled back; connections may still
		// need refreshing if a partial swap happened.
		w.svc.db.Reset()
		w.finishJob(ctx, jobID, "failed", code, err.Error())
		action := "restore.failed"
		if strings.Contains(err.Error(), "previous state was restored") || strings.Contains(err.Error(), "previous database was restored") {
			action = "restore.rolled_back"
		}
		w.audit(ctx, requestedBy, action, "failure", archive.FileName, nil)
		return
	}

	// The database has been replaced: reset pooled connections, then write
	// completion records into the restored database.
	w.svc.db.Reset()
	w.setStatus(&MemoryJobStatus{JobID: jobID, Kind: "restore", Status: "succeeded", Phase: "complete", ProgressPercent: 100})
	if _, err := w.svc.db.Exec(ctx, `INSERT INTO backup_jobs (id, kind, trigger, status, phase, progress_percent, completed_at)
		VALUES ($1, 'restore', 'manual', 'succeeded', 'complete', 100, now())
		ON CONFLICT (id) DO UPDATE SET status = 'succeeded', phase = 'complete', progress_percent = 100, completed_at = now(), updated_at = now()`, jobID); err != nil {
		w.logger.Error("record restore completion failed", "error", err)
	}
	if err := w.svc.ReconcileDisk(ctx); err != nil {
		w.logger.Error("post-restore catalog reconciliation failed", "error", err)
	}
	// The requesting user may not exist in the restored database; audit the
	// outcome without a user reference.
	w.audit(ctx, nil, "restore.succeeded", "success", archive.FileName, map[string]any{"preRestoreBackup": result.PreRestoreBackup})
	w.verifyHealth(ctx)
}

// verifyHealth mirrors the /healthz and /readyz checks after a restore:
// database reachable and media storage writable.
func (w *Worker) verifyHealth(ctx context.Context) {
	if err := w.svc.db.Ping(ctx); err != nil {
		w.logger.Error("post-restore health check: database ping failed", "error", err)
		return
	}
	if err := validateRestoredFiles(w.cfg.MediaRoot, w.cfg.UpdatesRoot); err != nil {
		w.logger.Error("post-restore health check: storage validation failed", "error", err)
		return
	}
	w.logger.Info("post-restore health checks passed")
}

func (w *Worker) finishJob(ctx context.Context, jobID uuid.UUID, status, errorCode, errorMessage string) {
	if len(errorMessage) > 2000 {
		errorMessage = errorMessage[:2000]
	}
	if _, err := w.svc.db.Exec(ctx, `UPDATE backup_jobs SET status = $2, error_code = $3, error_message = $4, progress_percent = CASE WHEN $2 = 'succeeded' THEN 100 ELSE progress_percent END, completed_at = now(), updated_at = now() WHERE id = $1`, jobID, status, errorCode, errorMessage); err != nil {
		w.logger.Error("record job completion failed", "error", err)
	}
}

// audit records a backup audit event. Metadata never contains secrets,
// passphrases, archive contents, database URLs, or filesystem paths.
func (w *Worker) audit(ctx context.Context, userID *uuid.UUID, action, result, resourceName string, metadata map[string]any) {
	if metadata == nil {
		metadata = map[string]any{}
	}
	payload, err := json.Marshal(metadata)
	if err != nil {
		payload = []byte(`{}`)
	}
	if _, err := w.svc.db.Exec(ctx, `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_name, result, summary, metadata)
		VALUES (gen_random_uuid(), $1, $2, 'system', $3, $4, $5, $6)`, userID, action, nullable(resourceName), result, auditSummary(action), payload); err != nil {
		w.logger.Error("record backup audit event failed", "action", action, "error", err)
	}
}

func nullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func auditSummary(action string) string {
	switch action {
	case "backup.created":
		return "A backup was created."
	case "backup.create_failed":
		return "A backup attempt failed."
	case "backup.verified":
		return "A backup was verified."
	case "backup.verify_failed":
		return "A backup failed verification."
	case "backup.deleted":
		return "A backup was deleted."
	case "restore.requested":
		return "A restore was requested."
	case "restore.succeeded":
		return "A restore completed successfully."
	case "restore.failed":
		return "A restore failed."
	case "restore.rolled_back":
		return "A restore failed and the previous state was restored."
	}
	return "Backup activity."
}

// tickSchedule evaluates the scheduled-backup settings and queues a run when
// due. Missed slots (for example while the server was off) trigger a single
// catch-up run.
func (w *Worker) tickSchedule(ctx context.Context) {
	cfg, err := w.readScheduleSettings(ctx)
	if err != nil {
		w.logger.Error("read backup schedule settings failed", "error", err)
		return
	}
	now := time.Now().UTC()
	if !cfg.Enabled {
		_, _ = w.svc.db.Exec(ctx, `UPDATE backup_schedule_state SET next_run_at = NULL, updated_at = now() WHERE singleton`)
		return
	}

	var lastRun, nextRun *time.Time
	err = w.svc.db.QueryRow(ctx, `SELECT last_run_at, next_run_at FROM backup_schedule_state WHERE singleton`).Scan(&lastRun, &nextRun)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := w.svc.db.Exec(ctx, `INSERT INTO backup_schedule_state (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING`); err != nil {
			return
		}
	} else if err != nil {
		w.logger.Error("read backup schedule state failed", "error", err)
		return
	}

	anchor := now.Add(-24 * time.Hour * 8)
	if lastRun != nil {
		anchor = *lastRun
	}
	due := cfg.NextRun(anchor)
	if due.After(now) {
		_, _ = w.svc.db.Exec(ctx, `UPDATE backup_schedule_state SET next_run_at = $1, updated_at = now() WHERE singleton`, due)
		return
	}
	// A slot is due (possibly missed while the server was down). Queue one
	// run; overlapping jobs are rejected by the partial unique index and the
	// slot is retried on the next tick.
	if _, err := w.svc.EnqueueBackup(ctx, "scheduled", nil); err != nil {
		if !errors.Is(err, ErrJobActive) {
			w.logger.Error("queue scheduled backup failed", "error", err)
		}
		return
	}
	next := cfg.NextRun(now)
	if _, err := w.svc.db.Exec(ctx, `UPDATE backup_schedule_state SET last_run_at = $1, next_run_at = $2, updated_at = now() WHERE singleton`, now, next); err != nil {
		w.logger.Error("update backup schedule state failed", "error", err)
	}
}

func (w *Worker) readScheduleSettings(ctx context.Context) (ScheduleConfig, error) {
	var payload []byte
	err := w.svc.db.QueryRow(ctx, `SELECT settings FROM organization_runtime_settings LIMIT 1`).Scan(&payload)
	values := map[string]any{}
	if err == nil && len(payload) > 0 {
		if err := json.Unmarshal(payload, &values); err != nil {
			return ScheduleConfig{}, fmt.Errorf("decode runtime settings: %w", err)
		}
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) && !isMissingRelation(err) {
		return ScheduleConfig{}, err
	}
	return ParseScheduleSettings(values)
}

// applyRetention deletes old scheduled backups beyond the configured count
// or age. The newest complete backup of any kind is always protected, so
// retention can never remove the last known-good backup.
func (w *Worker) applyRetention(ctx context.Context) {
	cfg, err := w.readScheduleSettings(ctx)
	if err != nil {
		w.logger.Error("read retention settings failed", "error", err)
		return
	}
	archives, err := w.svc.List(ctx)
	if err != nil {
		w.logger.Error("list backups for retention failed", "error", err)
		return
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -cfg.RetentionAgeDays)
	kept := 0
	for _, archive := range archives {
		if archive.Kind != KindScheduled || archive.Status != "complete" {
			continue
		}
		kept++
		if kept <= cfg.RetentionCount && !archive.CreatedAt.Before(cutoff) {
			continue
		}
		if _, err := w.svc.Delete(ctx, archive.ID, false); err != nil {
			if errors.Is(err, ErrLastBackup) {
				continue
			}
			w.logger.Error("retention delete failed", "file", archive.FileName, "error", err)
			continue
		}
		w.audit(ctx, nil, "backup.deleted", "success", archive.FileName, map[string]any{"reason": "retention"})
	}
}
