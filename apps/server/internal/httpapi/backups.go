package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/backup"
)

// restoreGate rejects all API traffic while a restore is replacing the
// database and files. Health probes stay reachable so operators and Studio
// can watch for the server to come back.
func (s *server) restoreGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.backups != nil && s.backups.Guard().RestoreActive() {
			path := r.URL.Path
			if path != "/healthz" && path != "/readyz" && strings.HasPrefix(path, "/api/") {
				writeError(w, http.StatusServiceUnavailable, "restore_in_progress", "A restore is in progress. Tilecast will be back shortly.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// blockDuringBackup rejects operations that would mutate Tilecast-managed
// files while a backup snapshot is being created. Database-only mutations
// stay available because the snapshot is transactionally consistent.
func (s *server) blockDuringBackup(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.backups != nil && !s.backups.Guard().DashboardWritesAllowed() {
			writeError(w, http.StatusConflict, "backup_in_progress", "A backup is being created. File changes are paused until it completes.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) sessionUserID(r *http.Request) *uuid.UUID {
	if principal, ok := principalOf(r); ok {
		id := principal.User.ID
		return &id
	}
	return nil
}

func (s *server) listBackups(w http.ResponseWriter, r *http.Request) {
	archives, err := s.backups.List(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	currentJob, err := s.backups.CurrentJob(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	recent, err := s.backups.RecentJobs(r.Context(), 10)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	last, err := s.backups.LastSuccessful(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	schedule, err := s.backups.Schedule(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if archives == nil {
		archives = []backup.Archive{}
	}
	if recent == nil {
		recent = []backup.Job{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"backups":        archives,
		"currentJob":     currentJob,
		"recentJobs":     recent,
		"lastSuccessful": last,
		"schedule":       schedule,
	}})
}

func (s *server) createBackup(w http.ResponseWriter, r *http.Request) {
	job, err := s.backups.EnqueueBackup(r.Context(), "manual", s.sessionUserID(r))
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": job})
}

func (s *server) currentBackupJob(w http.ResponseWriter, r *http.Request) {
	if status := s.backupWorker.CurrentStatus(); status != nil {
		writeJSON(w, http.StatusOK, map[string]any{"data": status})
		return
	}
	job, err := s.backups.CurrentJob(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": job})
}

func (s *server) getBackupJob(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup_job_not_found", "The backup job does not exist.")
		return
	}
	job, err := s.backups.GetJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "backup_job_not_found", "The backup job does not exist.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": job})
}

func (s *server) verifyBackup(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup_not_found", "The backup does not exist.")
		return
	}
	job, err := s.backups.EnqueueVerify(r.Context(), id, "manual", s.sessionUserID(r))
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": job})
}

func (s *server) restorePlan(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup_not_found", "The backup does not exist.")
		return
	}
	archive, err := s.backups.Get(r.Context(), id)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	plan, err := backup.Plan(r.Context(), s.db, s.backups.ArchivePath(archive), s.backupLimits)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "backup_archive_invalid", "The archive could not be read: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"archive":               archive,
		"organizationName":      plan.Manifest.OrganizationName,
		"installationId":        plan.Manifest.InstallationID,
		"tilecastVersion":       plan.Manifest.TilecastVersion,
		"schemaVersion":         plan.Manifest.SchemaVersion,
		"createdAt":             plan.Manifest.CreatedAt,
		"sizeBytes":             plan.SizeBytes,
		"components":            plan.Manifest.Components,
		"identityMismatch":      plan.IdentityMismatch,
		"currentInstallationId": plan.CurrentInstallationID,
	}})
}

func (s *server) restoreBackup(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup_not_found", "The backup does not exist.")
		return
	}
	var body struct {
		ConfirmIdentityMismatch bool `json:"confirmIdentityMismatch"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
	}
	userID := s.sessionUserID(r)
	job, err := s.backups.EnqueueRestore(r.Context(), id, userID, body.ConfirmIdentityMismatch)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": job})
}

func (s *server) downloadBackup(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup_not_found", "The backup does not exist.")
		return
	}
	archive, err := s.backups.Get(r.Context(), id)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+archive.FileName+`"`)
	w.Header().Set("Content-Type", "application/x-tar")
	http.ServeFile(w, r, s.backups.ArchivePath(archive))
}

func (s *server) deleteBackup(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup_not_found", "The backup does not exist.")
		return
	}
	force := r.URL.Query().Get("force") == "true"
	archive, err := s.backups.Delete(r.Context(), id, force)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	s.recordHTTPAudit(r, s.sessionUserID(r), "backup.deleted", "system", "", archive.FileName, "success", "A backup was deleted.", map[string]any{"kind": string(archive.Kind), "sizeBytes": archive.SizeBytes}, false)
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"deleted": true}})
}

func (s *server) writeBackupError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, backup.ErrJobActive):
		writeError(w, http.StatusConflict, "backup_job_active", "Another backup or restore job is already running.")
	case errors.Is(err, backup.ErrArchiveNotFound):
		writeError(w, http.StatusNotFound, "backup_not_found", "The backup does not exist.")
	case errors.Is(err, backup.ErrLastBackup):
		writeError(w, http.StatusConflict, "last_backup_protected", "This is the last complete backup. Confirm again to delete it anyway.")
	case errors.Is(err, backup.ErrArchiveNotUsable):
		writeError(w, http.StatusUnprocessableEntity, "backup_archive_invalid", "The archive is not a complete backup and cannot be restored.")
	default:
		s.internalError(w, r, err)
	}
}
