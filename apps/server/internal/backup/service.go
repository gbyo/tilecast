package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors mapped to API error codes by the HTTP layer.
var (
	ErrJobActive        = errors.New("another backup or restore job is already queued or running")
	ErrArchiveNotFound  = errors.New("backup archive not found")
	ErrLastBackup       = errors.New("this is the last complete backup and is protected from deletion")
	ErrArchiveNotUsable = errors.New("archive is not a complete verified backup")
)

const metaSuffix = ".meta.json"

// Archive is one catalog entry backed by a file in the backup root.
type Archive struct {
	ID               uuid.UUID           `json:"id"`
	FileName         string              `json:"fileName"`
	Kind             Kind                `json:"kind"`
	Status           string              `json:"status"`
	SizeBytes        int64               `json:"sizeBytes"`
	ArchiveSHA256    string              `json:"archiveSha256"`
	TilecastVersion  string              `json:"tilecastVersion"`
	SchemaVersion    int64               `json:"schemaVersion"`
	InstallationID   string              `json:"installationId"`
	OrganizationName string              `json:"organizationName"`
	Components       []ManifestComponent `json:"components"`
	Verification     string              `json:"verification"`
	VerifiedAt       *time.Time          `json:"verifiedAt,omitempty"`
	CreatedAt        time.Time           `json:"createdAt"`
}

// Job is one backup, verify, or restore job.
type Job struct {
	ID              uuid.UUID  `json:"id"`
	Kind            string     `json:"kind"`
	Trigger         string     `json:"trigger"`
	ArchiveID       *uuid.UUID `json:"archiveId,omitempty"`
	Status          string     `json:"status"`
	Phase           string     `json:"phase"`
	ProgressPercent int        `json:"progressPercent"`
	ErrorCode       string     `json:"errorCode,omitempty"`
	ErrorMessage    string     `json:"errorMessage,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	CompletedAt     *time.Time `json:"completedAt,omitempty"`
}

// ScheduleState reports scheduler bookkeeping.
type ScheduleState struct {
	LastRunAt *time.Time `json:"lastRunAt,omitempty"`
	NextRunAt *time.Time `json:"nextRunAt,omitempty"`
}

// Service manages the archive catalog and job queue.
type Service struct {
	db    *pgxpool.Pool
	root  string
	guard *Guard
}

// NewService creates the backup service and ensures the backup root exists.
func NewService(db *pgxpool.Pool, root string, guard *Guard) (*Service, error) {
	if err := os.MkdirAll(filepath.Join(root, "tmp"), 0o750); err != nil {
		return nil, fmt.Errorf("create backup root: %w", err)
	}
	return &Service{db: db, root: root, guard: guard}, nil
}

// Root returns the configured backup root directory.
func (s *Service) Root() string { return s.root }

// Guard returns the shared write guard.
func (s *Service) Guard() *Guard { return s.guard }

// ArchivePath resolves a catalog entry to its file path. Callers never pass
// filesystem paths through the API; only catalog IDs.
func (s *Service) ArchivePath(archive Archive) string {
	return filepath.Join(s.root, archive.FileName)
}

// List returns all catalog entries, newest first.
func (s *Service) List(ctx context.Context) ([]Archive, error) {
	rows, err := s.db.Query(ctx, `SELECT id, file_name, kind, status, size_bytes, archive_sha256, tilecast_version, schema_version, installation_id, organization_name, components, verification, verified_at, created_at FROM backup_archives ORDER BY created_at DESC, file_name DESC`)
	if err != nil {
		return nil, fmt.Errorf("list backups: %w", err)
	}
	defer rows.Close()
	var archives []Archive
	for rows.Next() {
		archive, err := scanArchive(rows)
		if err != nil {
			return nil, err
		}
		archives = append(archives, archive)
	}
	return archives, rows.Err()
}

// Get returns one catalog entry.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Archive, error) {
	row := s.db.QueryRow(ctx, `SELECT id, file_name, kind, status, size_bytes, archive_sha256, tilecast_version, schema_version, installation_id, organization_name, components, verification, verified_at, created_at FROM backup_archives WHERE id = $1`, id)
	archive, err := scanArchive(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Archive{}, ErrArchiveNotFound
	}
	return archive, err
}

// LastSuccessful returns the newest complete archive, if any.
func (s *Service) LastSuccessful(ctx context.Context) (*Archive, error) {
	row := s.db.QueryRow(ctx, `SELECT id, file_name, kind, status, size_bytes, archive_sha256, tilecast_version, schema_version, installation_id, organization_name, components, verification, verified_at, created_at FROM backup_archives WHERE status = 'complete' ORDER BY created_at DESC LIMIT 1`)
	archive, err := scanArchive(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &archive, nil
}

type rowScanner interface{ Scan(dest ...any) error }

func scanArchive(row rowScanner) (Archive, error) {
	var archive Archive
	var components []byte
	if err := row.Scan(&archive.ID, &archive.FileName, &archive.Kind, &archive.Status, &archive.SizeBytes, &archive.ArchiveSHA256, &archive.TilecastVersion, &archive.SchemaVersion, &archive.InstallationID, &archive.OrganizationName, &components, &archive.Verification, &archive.VerifiedAt, &archive.CreatedAt); err != nil {
		return Archive{}, err
	}
	if len(components) > 0 {
		if err := json.Unmarshal(components, &archive.Components); err != nil {
			return Archive{}, fmt.Errorf("decode archive components: %w", err)
		}
	}
	return archive, nil
}

// EnqueueBackup queues a backup job. Only one job may be active.
func (s *Service) EnqueueBackup(ctx context.Context, trigger string, requestedBy *uuid.UUID) (Job, error) {
	return s.enqueue(ctx, "backup", trigger, nil, requestedBy, false)
}

// EnqueueVerify queues a verification job for an existing archive.
func (s *Service) EnqueueVerify(ctx context.Context, archiveID uuid.UUID, trigger string, requestedBy *uuid.UUID) (Job, error) {
	if _, err := s.Get(ctx, archiveID); err != nil {
		return Job{}, err
	}
	return s.enqueue(ctx, "verify", trigger, &archiveID, requestedBy, false)
}

// EnqueueRestore queues a restore job for a complete archive.
func (s *Service) EnqueueRestore(ctx context.Context, archiveID uuid.UUID, requestedBy *uuid.UUID, confirmIdentityMismatch bool) (Job, error) {
	archive, err := s.Get(ctx, archiveID)
	if err != nil {
		return Job{}, err
	}
	if archive.Status != "complete" {
		return Job{}, ErrArchiveNotUsable
	}
	return s.enqueue(ctx, "restore", "manual", &archiveID, requestedBy, confirmIdentityMismatch)
}

func (s *Service) enqueue(ctx context.Context, kind, trigger string, archiveID *uuid.UUID, requestedBy *uuid.UUID, confirmIdentityMismatch bool) (Job, error) {
	id := uuid.New()
	_, err := s.db.Exec(ctx, `INSERT INTO backup_jobs (id, kind, trigger, archive_id, requested_by, confirm_identity_mismatch) VALUES ($1, $2, $3, $4, $5, $6)`, id, kind, trigger, archiveID, requestedBy, confirmIdentityMismatch)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Job{}, ErrJobActive
		}
		return Job{}, fmt.Errorf("queue %s job: %w", kind, err)
	}
	return s.GetJob(ctx, id)
}

// GetJob returns one job.
func (s *Service) GetJob(ctx context.Context, id uuid.UUID) (Job, error) {
	row := s.db.QueryRow(ctx, `SELECT id, kind, trigger, archive_id, status, phase, progress_percent, error_code, error_message, created_at, completed_at FROM backup_jobs WHERE id = $1`, id)
	return scanJob(row)
}

// CurrentJob returns the queued or running job, if any.
func (s *Service) CurrentJob(ctx context.Context) (*Job, error) {
	row := s.db.QueryRow(ctx, `SELECT id, kind, trigger, archive_id, status, phase, progress_percent, error_code, error_message, created_at, completed_at FROM backup_jobs WHERE status IN ('queued', 'running') LIMIT 1`)
	job, err := scanJob(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}

// RecentJobs returns the most recent jobs, newest first.
func (s *Service) RecentJobs(ctx context.Context, limit int) ([]Job, error) {
	rows, err := s.db.Query(ctx, `SELECT id, kind, trigger, archive_id, status, phase, progress_percent, error_code, error_message, created_at, completed_at FROM backup_jobs ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	defer rows.Close()
	var jobs []Job
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func scanJob(row rowScanner) (Job, error) {
	var job Job
	if err := row.Scan(&job.ID, &job.Kind, &job.Trigger, &job.ArchiveID, &job.Status, &job.Phase, &job.ProgressPercent, &job.ErrorCode, &job.ErrorMessage, &job.CreatedAt, &job.CompletedAt); err != nil {
		return Job{}, err
	}
	return job, nil
}

// Delete removes an archive, its sidecar, and its catalog row. The newest
// complete backup is protected unless force is set, so an installation can
// never accidentally lose its last known-good backup.
func (s *Service) Delete(ctx context.Context, id uuid.UUID, force bool) (Archive, error) {
	archive, err := s.Get(ctx, id)
	if err != nil {
		return Archive{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Archive{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// Two deletions of complete archives must not both see the other one and
	// both proceed. The lock serializes the guard with the row delete, so the
	// second request sees the first one's committed removal.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tilecast.backup.catalog'))`); err != nil {
		return Archive{}, err
	}
	if !force && archive.Status == "complete" {
		var newerComplete int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM backup_archives WHERE status = 'complete' AND id <> $1`, id).Scan(&newerComplete); err != nil {
			return Archive{}, err
		}
		if newerComplete == 0 {
			return Archive{}, ErrLastBackup
		}
	}
	path := s.ArchivePath(archive)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return Archive{}, fmt.Errorf("delete archive file: %w", err)
	}
	os.Remove(path + metaSuffix)
	if _, err := tx.Exec(ctx, `DELETE FROM backup_archives WHERE id = $1`, id); err != nil {
		return Archive{}, fmt.Errorf("remove catalog entry: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Archive{}, fmt.Errorf("commit archive delete: %w", err)
	}
	return archive, nil
}

// RegisterArchive upserts a catalog row and writes the sidecar metadata file
// so the catalog can be rebuilt from disk after a restore or restart.
func (s *Service) RegisterArchive(ctx context.Context, archive Archive) error {
	if archive.ID == uuid.Nil {
		archive.ID = uuid.New()
	}
	components, err := json.Marshal(archive.Components)
	if err != nil {
		return fmt.Errorf("encode components: %w", err)
	}
	_, err = s.db.Exec(ctx, `INSERT INTO backup_archives (id, file_name, kind, status, size_bytes, archive_sha256, tilecast_version, schema_version, installation_id, organization_name, components, verification, verified_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		ON CONFLICT (file_name) DO UPDATE SET kind = EXCLUDED.kind, status = EXCLUDED.status, size_bytes = EXCLUDED.size_bytes, archive_sha256 = EXCLUDED.archive_sha256, tilecast_version = EXCLUDED.tilecast_version, schema_version = EXCLUDED.schema_version, installation_id = EXCLUDED.installation_id, organization_name = EXCLUDED.organization_name, components = EXCLUDED.components, verification = EXCLUDED.verification, verified_at = EXCLUDED.verified_at, updated_at = now()`,
		archive.ID, archive.FileName, archive.Kind, archive.Status, archive.SizeBytes, archive.ArchiveSHA256, archive.TilecastVersion, archive.SchemaVersion, archive.InstallationID, archive.OrganizationName, components, archive.Verification, archive.VerifiedAt, archive.CreatedAt)
	if err != nil {
		return fmt.Errorf("register archive: %w", err)
	}
	return s.writeSidecar(archive)
}

// MarkVerification records a verification outcome.
func (s *Service) MarkVerification(ctx context.Context, id uuid.UUID, verified bool, at time.Time) error {
	state := "failed"
	if verified {
		state = "verified"
	}
	if _, err := s.db.Exec(ctx, `UPDATE backup_archives SET verification = $2, verified_at = $3, updated_at = now() WHERE id = $1`, id, state, at); err != nil {
		return fmt.Errorf("record verification: %w", err)
	}
	archive, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	return s.writeSidecar(archive)
}

func (s *Service) writeSidecar(archive Archive) error {
	payload, err := json.MarshalIndent(archive, "", "  ")
	if err != nil {
		return fmt.Errorf("encode sidecar: %w", err)
	}
	path := filepath.Join(s.root, archive.FileName+metaSuffix)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o640); err != nil {
		return fmt.Errorf("write sidecar: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("finalize sidecar: %w", err)
	}
	return nil
}

// ReconcileDisk synchronizes the catalog with the backup root: sidecar
// metadata re-registers archives (the catalog itself is part of a restored
// database and may be stale), archives without sidecars are listed as
// unrecognized until verified, and rows whose file disappeared are marked
// missing.
func (s *Service) ReconcileDisk(ctx context.Context) error {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return fmt.Errorf("read backup root: %w", err)
	}
	onDisk := make(map[string]bool)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !strings.HasSuffix(name, ".tar") {
			continue
		}
		onDisk[name] = true
		info, err := entry.Info()
		if err != nil {
			continue
		}
		sidecar := filepath.Join(s.root, name+metaSuffix)
		if payload, err := os.ReadFile(sidecar); err == nil {
			var archive Archive
			if err := json.Unmarshal(payload, &archive); err == nil && archive.FileName == name {
				archive.SizeBytes = info.Size()
				if err := s.RegisterArchive(ctx, archive); err != nil {
					return err
				}
				continue
			}
		}
		// No usable sidecar: register a placeholder; verification fills in
		// the metadata.
		placeholder := Archive{
			ID:           uuid.New(),
			FileName:     name,
			Kind:         KindImported,
			Status:       "unrecognized",
			SizeBytes:    info.Size(),
			Verification: "unverified",
			CreatedAt:    info.ModTime().UTC(),
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO backup_archives (id, file_name, kind, status, size_bytes, verification, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (file_name) DO NOTHING`,
			placeholder.ID, placeholder.FileName, placeholder.Kind, placeholder.Status, placeholder.SizeBytes, placeholder.Verification, placeholder.CreatedAt); err != nil {
			return fmt.Errorf("register discovered archive: %w", err)
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE backup_archives SET status = 'missing', updated_at = now() WHERE NOT (file_name = ANY($1)) AND status <> 'missing'`, keys(onDisk)); err != nil {
		return fmt.Errorf("mark missing archives: %w", err)
	}
	return nil
}

func keys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	return out
}

// BeginExternalJob records a running job owned by an external process (the
// CLI), so the in-server worker and other CLI invocations cannot start an
// overlapping job.
func (s *Service) BeginExternalJob(ctx context.Context, kind string) (uuid.UUID, error) {
	id := uuid.New()
	_, err := s.db.Exec(ctx, `INSERT INTO backup_jobs (id, kind, trigger, status, locked_at, locked_by) VALUES ($1, $2, 'cli', 'running', now(), 'cli')`, id, kind)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return uuid.Nil, ErrJobActive
		}
		return uuid.Nil, fmt.Errorf("record CLI job: %w", err)
	}
	return id, nil
}

// TouchExternalJob refreshes the job lease so the in-server worker does not
// treat a long-running CLI job as stale.
func (s *Service) TouchExternalJob(ctx context.Context, id uuid.UUID) {
	_, _ = s.db.Exec(ctx, `UPDATE backup_jobs SET locked_at = now(), updated_at = now() WHERE id = $1`, id)
}

// CompleteExternalJob finishes a CLI job record.
func (s *Service) CompleteExternalJob(ctx context.Context, id uuid.UUID, jobErr error) {
	status, code, message := "succeeded", "", ""
	if jobErr != nil {
		status, code, message = "failed", "cli_failed", jobErr.Error()
		if len(message) > 2000 {
			message = message[:2000]
		}
	}
	_, _ = s.db.Exec(ctx, `UPDATE backup_jobs SET status = $2, error_code = $3, error_message = $4, completed_at = now(), updated_at = now() WHERE id = $1`, id, status, code, message)
}

// Schedule returns scheduler bookkeeping for the UI.
func (s *Service) Schedule(ctx context.Context) (ScheduleState, error) {
	var state ScheduleState
	err := s.db.QueryRow(ctx, `SELECT last_run_at, next_run_at FROM backup_schedule_state WHERE singleton`).Scan(&state.LastRunAt, &state.NextRunAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ScheduleState{}, nil
	}
	if err != nil {
		return ScheduleState{}, fmt.Errorf("read schedule state: %w", err)
	}
	return state, nil
}
