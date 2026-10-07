package wasm

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Scheduler runs declared background jobs at their intervals. Claiming is
// one atomic UPDATE with a subselect under SKIP LOCKED: two server processes
// never run the same job twice, and a crash mid-run only delays the job
// until the claim lease expires. Execution is at-least-once; guests must
// tolerate a repeated run.
const (
	schedulerBatch = 10
	claimLease     = 5 * time.Minute
)

// Scheduler polls external_plugin_jobs and invokes claimed jobs through
// Invoke. Production wires Invoke to Service.InvokeJob; tests substitute
// a stub.
type Scheduler struct {
	pool     *pgxpool.Pool
	invoke   func(ctx context.Context, packageID, jobID string) (int32, error)
	interval time.Duration
	logger   *slog.Logger
}

// NewScheduler builds a scheduler over pool. interval is the poll cadence;
// one minute keeps worst-case lateness small without busy polling.
func NewScheduler(pool *pgxpool.Pool, invoke func(ctx context.Context, packageID, jobID string) (int32, error), interval time.Duration, logger *slog.Logger) *Scheduler {
	if interval <= 0 {
		interval = time.Minute
	}
	return &Scheduler{pool: pool, invoke: invoke, interval: interval, logger: logger}
}

// Run polls until ctx ends. One overdue pass runs immediately at startup so
// a restart does not wait a full interval for missed jobs.
func (s *Scheduler) Run(ctx context.Context) {
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
			if _, err := s.RunOnce(ctx); err != nil && s.logger != nil {
				s.logger.Error("wasm scheduler pass failed", "error", err)
			}
		}
	}
}

// RunOnce claims due jobs and runs each through Invoke. A guest failure
// records last_status=error and reschedules on the same interval; only a
// database failure aborts the pass.
func (s *Scheduler) RunOnce(ctx context.Context) (int, error) {
	claimed, err := claimDueJobs(ctx, s.pool, schedulerBatch)
	if err != nil {
		return 0, err
	}
	for _, job := range claimed {
		status, err := s.invoke(ctx, job.packageID, job.jobID)
		record := jobOutcome{status: status, err: err}
		if recordErr := recordJobOutcome(ctx, s.pool, job, record); recordErr != nil {
			return 0, recordErr
		}
	}
	return len(claimed), nil
}

type claimedJob struct {
	packageID string
	jobID     string
	interval  time.Duration
}

func claimDueJobs(ctx context.Context, pool *pgxpool.Pool, limit int) ([]claimedJob, error) {
	rows, err := pool.Query(ctx, `
		UPDATE external_plugin_jobs job SET next_run_at = now() + make_interval(mins => $2)
		FROM (
			SELECT organization_id, package_id, job_id
			FROM external_plugin_jobs
			WHERE next_run_at <= now()
			ORDER BY next_run_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED
		) claim
		WHERE job.organization_id = claim.organization_id
		  AND job.package_id = claim.package_id
		  AND job.job_id = claim.job_id
		RETURNING job.package_id, job.job_id, job.interval_minutes`,
		limit, int(claimLease.Minutes()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var claimed []claimedJob
	for rows.Next() {
		var job claimedJob
		var minutes int
		if err := rows.Scan(&job.packageID, &job.jobID, &minutes); err != nil {
			return nil, err
		}
		job.interval = time.Duration(minutes) * time.Minute
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
		    next_run_at = now() + make_interval(mins => $4),
		    last_status = $3,
		    last_error = $5,
		    consecutive_failures = CASE WHEN $6 THEN 0 ELSE consecutive_failures + 1 END
		WHERE package_id = $1 AND job_id = $2`,
		job.packageID, job.jobID, lastStatus, int(job.interval.Minutes()), lastError, succeeded)
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
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	for _, job := range jobs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO external_plugin_jobs(
				organization_id, package_id, job_id, interval_minutes,
				next_run_at, last_status)
			SELECT id, $1, $2, $3, now() + make_interval(mins => $3), 'never'
			FROM organization_settings WHERE singleton
			ON CONFLICT (organization_id, package_id, job_id)
			DO UPDATE SET interval_minutes = EXCLUDED.interval_minutes`,
			packageID, job.ID, job.IntervalMinutes); err != nil {
			return err
		}
	}
	ids := make([]string, 0, len(jobs))
	for _, job := range jobs {
		ids = append(ids, job.ID)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM external_plugin_jobs WHERE package_id = $1 AND NOT (job_id = ANY($2))`,
		packageID, ids); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// JobRow is one declared job with its scheduler cursor, for the Studio
// status surface.
type JobRow struct {
	JobID               string     `json:"jobId"`
	IntervalMinutes     int        `json:"intervalMinutes"`
	NextRunAt           time.Time  `json:"nextRunAt"`
	LastRunAt           *time.Time `json:"lastRunAt,omitempty"`
	LastStatus          string     `json:"lastStatus"`
	LastError           string     `json:"lastError"`
	ConsecutiveFailures int        `json:"consecutiveFailures"`
}

// ListJobs returns the declared jobs for one installed package.
func ListJobs(ctx context.Context, pool *pgxpool.Pool, packageID string) ([]JobRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT job_id, interval_minutes, next_run_at, last_run_at,
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
		if err := rows.Scan(&job.JobID, &job.IntervalMinutes, &job.NextRunAt,
			&job.LastRunAt, &job.LastStatus, &job.LastError,
			&job.ConsecutiveFailures); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}
