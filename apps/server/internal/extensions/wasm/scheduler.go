package wasm

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/execution"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Scheduler runs declared background jobs at their intervals. Claiming is
// one atomic UPDATE with a subselect under SKIP LOCKED: two server processes
// never run the same job twice, and a crash mid-run only delays the job
// until the claim lease expires. Execution is at-least-once; guests must
// tolerate a repeated run.
const (
	schedulerBatch = 4
	claimLease     = 5 * time.Minute
	realtimeLease  = 15 * time.Second
)

// Scheduler polls external_plugin_jobs and invokes claimed jobs through
// Invoke. Production wires Invoke to Service.InvokeJob; tests substitute
// a stub.
type Scheduler struct {
	pool     *pgxpool.Pool
	invoke   func(ctx context.Context, packageID, jobID string) (int32, error)
	interval time.Duration
	logger   *slog.Logger
	kind     string
}

// NewScheduler builds a scheduler over pool. interval is the poll cadence;
// one minute keeps worst-case lateness small without busy polling.
func NewScheduler(pool *pgxpool.Pool, invoke func(ctx context.Context, packageID, jobID string) (int32, error), interval time.Duration, logger *slog.Logger) *Scheduler {
	if interval <= 0 {
		interval = time.Minute
	}
	return &Scheduler{pool: pool, invoke: invoke, interval: interval, logger: logger, kind: "ordinary"}
}

// NewRealtimeScheduler uses a separate bounded worker pool and a one-second
// due scan. Ordinary jobs retain their minute-based cadence.
func NewRealtimeScheduler(pool *pgxpool.Pool, invoke func(context.Context, string, string) (int32, error), logger *slog.Logger) *Scheduler {
	return &Scheduler{pool: pool, invoke: invoke, interval: time.Second, logger: logger, kind: "realtime"}
}

// Run polls until ctx ends. One overdue pass runs immediately at startup so
// a restart does not wait a full interval for missed jobs.
func (s *Scheduler) Run(ctx context.Context) {
	if s.kind == "ordinary" {
		s.reconcile(ctx)
	}
	if _, err := s.RunOnce(ctx); err != nil && s.logger != nil {
		s.logger.Error("wasm scheduler pass failed", "error", err)
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if s.kind == "ordinary" {
				s.reconcile(ctx)
			}
			if _, err := s.RunOnce(ctx); err != nil && s.logger != nil {
				s.logger.Error("wasm scheduler pass failed", "error", err)
			}
		}
	}
}

func (s *Scheduler) reconcile(ctx context.Context) {
	rows, err := s.pool.Query(ctx, `SELECT package_id FROM installed_packages UNION SELECT package_id FROM external_plugin_jobs`)
	if err != nil {
		if s.logger != nil {
			s.logger.Error("package job reconciliation failed", "error", err)
		}
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		if s.logger != nil {
			s.logger.Error("package job reconciliation failed", "error", err)
		}
		return
	}
	for _, id := range ids {
		if err := SyncInstalledJobs(ctx, s.pool, id, nil); err != nil && s.logger != nil {
			s.logger.Error("package job reconciliation failed", "package_id", id, "error", err)
		}
	}
}

// RunOnce claims due jobs and runs each through Invoke. A guest failure
// records last_status=error and reschedules on the same interval; only a
// database failure aborts the pass.
func (s *Scheduler) RunOnce(ctx context.Context) (int, error) {
	claimed, err := claimJobs(ctx, s.pool, schedulerBatch, s.kind)
	if err != nil {
		return 0, err
	}
	run := func(job claimedJob) error {
		callCtx := context.WithValue(ctx, claimedEpochKey{}, job.epoch)
		timeout := JobTimeout
		if s.kind == "realtime" {
			timeout = RealtimeJobTimeout
		}
		callCtx, cancel := context.WithTimeout(callCtx, timeout)
		defer cancel()
		status, err := s.invoke(callCtx, job.packageID, job.jobID)
		record := jobOutcome{status: status, err: err}
		return recordJobOutcome(ctx, s.pool, job, record)
	}
	if s.kind == "realtime" {
		var wg sync.WaitGroup
		failures := make(chan error, len(claimed))
		for _, job := range claimed {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := run(job); err != nil {
					failures <- err
				}
			}()
		}
		wg.Wait()
		close(failures)
		for err := range failures {
			return len(claimed), err
		}
	} else {
		for _, job := range claimed {
			if err := run(job); err != nil {
				return 0, err
			}
		}
	}
	return len(claimed), nil
}

type claimedJob struct {
	packageID string
	jobID     string
	interval  time.Duration
	epoch     *uuid.UUID
	token     uuid.UUID
	claimedAt time.Time
}

type claimedEpochKey struct{}

func claimDueJobs(ctx context.Context, pool *pgxpool.Pool, limit int) ([]claimedJob, error) {
	return claimJobs(ctx, pool, limit, "ordinary")
}

func claimJobs(ctx context.Context, pool *pgxpool.Pool, limit int, kind string) ([]claimedJob, error) {
	lease := claimLease
	if kind == "realtime" {
		lease = realtimeLease
	}
	token := uuid.New()
	rows, err := pool.Query(ctx, `
		UPDATE external_plugin_jobs job SET next_run_at = now() + make_interval(secs => $2), claim_token=$4
		FROM (
			SELECT organization_id, package_id, job_id
			FROM external_plugin_jobs
			WHERE next_run_at <= now() AND job_kind=$3
			ORDER BY next_run_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED
		) claim
		WHERE job.organization_id = claim.organization_id
		  AND job.package_id = claim.package_id
		  AND job.job_id = claim.job_id
		RETURNING job.package_id, job.job_id,
		 COALESCE(job.interval_seconds, job.interval_minutes*60), job.execution_epoch, now()`,
		limit, int(lease.Seconds()), kind, token)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var claimed []claimedJob
	for rows.Next() {
		var job claimedJob
		var seconds int
		if err := rows.Scan(&job.packageID, &job.jobID, &seconds, &job.epoch, &job.claimedAt); err != nil {
			return nil, err
		}
		job.interval = time.Duration(seconds) * time.Second
		job.token = token
		claimed = append(claimed, job)
	}
	return claimed, rows.Err()
}

type jobOutcome struct {
	status int32
	err    error
}

func recordJobOutcome(ctx context.Context, pool *pgxpool.Pool, job claimedJob, outcome jobOutcome) error {
	lastStatus := "ok"
	lastError := ""
	succeeded := true
	if outcome.err != nil || outcome.status != 0 {
		lastStatus = "error"
		lastError = truncateError(outcome.err, outcome.status)
		succeeded = false
	}
	_, err := pool.Exec(ctx, `
		UPDATE external_plugin_jobs
		SET last_run_at = now(),
		    next_run_at = CASE WHEN job_kind='realtime' THEN
		      $9::timestamptz + make_interval(secs => $4::double precision * (floor(GREATEST(0, extract(epoch FROM (now()-$9::timestamptz))) / $4::double precision)::integer+1))
		      ELSE now() + make_interval(secs => $4::double precision) END,
		    claim_token = NULL,
		    last_status = $3,
		    last_error = $5,
		    consecutive_failures = CASE WHEN $6 THEN 0 ELSE consecutive_failures + 1 END
		WHERE package_id = $1 AND job_id = $2 AND claim_token=$7
		  AND execution_epoch IS NOT DISTINCT FROM $8::uuid`,
		job.packageID, job.jobID, lastStatus, int(job.interval.Seconds()), lastError, succeeded,
		job.token, job.epoch, job.claimedAt)
	return err
}

func truncateError(invokeErr error, status int32) string {
	message := fmt.Sprintf("guest exited with status %d", status)
	if invokeErr != nil {
		message = invokeErr.Error()
	}
	runes := []rune(message)
	if len(runes) > 512 {
		return string(runes[:512])
	}
	return message
}

// SyncJobs reconciles the job rows for one package activation. New jobs
// start due after one interval; removed jobs lose their rows; surviving
// jobs keep their cursor but take the new interval.
func SyncJobs(ctx context.Context, pool *pgxpool.Pool, packageID string, jobs []packagemanifest.BackgroundJob) error {
	return syncJobs(ctx, pool, packageID, jobs, true)
}

// SyncInstalledJobs refuses declarations from a removed activation. The jobs
// argument preserves the lifecycle test hook; the installed row is authority.
func SyncInstalledJobs(ctx context.Context, pool *pgxpool.Pool, packageID string, jobs []packagemanifest.BackgroundJob) error {
	return syncJobs(ctx, pool, packageID, jobs, false)
}

func syncJobs(ctx context.Context, pool *pgxpool.Pool, packageID string, jobs []packagemanifest.BackgroundJob, allowUninstalled bool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	ctx, err = execution.Lock(ctx, tx, packageID)
	if err != nil {
		return err
	}
	// Re-read the activation under the lifecycle fence. A delayed reconciliation
	// must not replace the jobs of a newer activation or reinstall.
	var raw []byte
	var epoch *uuid.UUID
	err = tx.QueryRow(ctx, `SELECT manifest, execution_epoch FROM installed_packages WHERE package_id=$1`, packageID).Scan(&raw, &epoch)
	var realtime []packagemanifest.RealtimeJob
	if err == nil {
		manifest, parseErr := packagemanifest.Parse(raw)
		if parseErr != nil {
			return parseErr
		}
		jobs = nil
		if manifest.Capabilities != nil {
			if manifest.Capabilities.Background != nil {
				jobs = manifest.Capabilities.Background.Jobs
			}
			if manifest.Capabilities.Realtime != nil {
				realtime = manifest.Capabilities.Realtime.Jobs
			}
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	} else if !allowUninstalled {
		jobs = nil
	}
	for _, job := range jobs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO external_plugin_jobs(
				organization_id, package_id, job_id, interval_minutes,
				next_run_at, last_status, execution_epoch, job_kind)
			SELECT id, $1, $2, $3, now() + make_interval(mins => $3), 'never', $4, 'ordinary'
			FROM organization_settings WHERE singleton
			ON CONFLICT (organization_id, package_id, job_id)
			DO UPDATE SET interval_minutes = EXCLUDED.interval_minutes, interval_seconds=NULL, job_kind='ordinary',
			 execution_epoch=EXCLUDED.execution_epoch,
			 claim_token=CASE WHEN external_plugin_jobs.execution_epoch IS NOT DISTINCT FROM EXCLUDED.execution_epoch THEN external_plugin_jobs.claim_token ELSE NULL END,
			 next_run_at=CASE WHEN external_plugin_jobs.execution_epoch IS NOT DISTINCT FROM EXCLUDED.execution_epoch THEN external_plugin_jobs.next_run_at ELSE EXCLUDED.next_run_at END`,
			packageID, job.ID, job.IntervalMinutes, epoch); err != nil {
			return err
		}
	}
	ids := make([]string, 0, len(jobs))
	for _, job := range jobs {
		ids = append(ids, job.ID)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM external_plugin_jobs WHERE package_id = $1 AND job_kind='ordinary' AND NOT (job_id = ANY($2))`,
		packageID, ids); err != nil {
		return err
	}
	realtimeIDs := make([]string, 0, len(realtime))
	for _, job := range realtime {
		realtimeIDs = append(realtimeIDs, job.ID)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM external_plugin_jobs WHERE package_id=$1 AND job_kind='realtime' AND NOT(job_id=ANY($2))`, packageID, realtimeIDs); err != nil {
		return err
	}
	for _, job := range realtime {
		if _, err := tx.Exec(ctx, `INSERT INTO external_plugin_jobs
		 (organization_id,package_id,job_id,interval_seconds,job_kind,execution_epoch,next_run_at,last_status)
		 SELECT id,$1,$2,$3,'realtime',$4,now()+make_interval(secs=>$3::integer),'never' FROM organization_settings WHERE singleton
		 ON CONFLICT(organization_id,package_id,job_id) DO UPDATE SET interval_seconds=EXCLUDED.interval_seconds,
		 interval_minutes=NULL,job_kind='realtime',execution_epoch=EXCLUDED.execution_epoch,
		 claim_token=CASE WHEN external_plugin_jobs.execution_epoch IS NOT DISTINCT FROM EXCLUDED.execution_epoch THEN external_plugin_jobs.claim_token ELSE NULL END,
		 next_run_at=CASE WHEN external_plugin_jobs.execution_epoch IS NOT DISTINCT FROM EXCLUDED.execution_epoch THEN external_plugin_jobs.next_run_at ELSE EXCLUDED.next_run_at END`, packageID, job.ID, int(job.IntervalSeconds), epoch); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// JobRow is one declared job with its scheduler cursor, for the Studio
// status surface.
type JobRow struct {
	JobID               string     `json:"jobId"`
	IntervalMinutes     int        `json:"intervalMinutes,omitempty"`
	IntervalSeconds     int        `json:"intervalSeconds,omitempty"`
	Kind                string     `json:"kind"`
	NextRunAt           time.Time  `json:"nextRunAt"`
	LastRunAt           *time.Time `json:"lastRunAt,omitempty"`
	LastStatus          string     `json:"lastStatus"`
	LastError           string     `json:"lastError"`
	ConsecutiveFailures int        `json:"consecutiveFailures"`
}

// ListJobs returns the declared jobs for one installed package.
func ListJobs(ctx context.Context, pool *pgxpool.Pool, packageID string) ([]JobRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT job_id, COALESCE(interval_minutes,0), COALESCE(interval_seconds,0), job_kind, next_run_at, last_run_at,
		       last_status, last_error, consecutive_failures
		FROM external_plugin_jobs
		WHERE package_id = $1
		ORDER BY job_id`, packageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []JobRow{}
	for rows.Next() {
		var job JobRow
		if err := rows.Scan(&job.JobID, &job.IntervalMinutes, &job.IntervalSeconds, &job.Kind, &job.NextRunAt,
			&job.LastRunAt, &job.LastStatus, &job.LastError,
			&job.ConsecutiveFailures); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}
