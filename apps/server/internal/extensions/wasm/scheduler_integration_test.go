package wasm

import (
	"context"
	"errors"
	"testing"
	"time"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

func schedulerJobs(ids ...string) []packagemanifest.BackgroundJob {
	jobs := make([]packagemanifest.BackgroundJob, 0, len(ids))
	for _, id := range ids {
		jobs = append(jobs, packagemanifest.BackgroundJob{ID: id, IntervalMinutes: 5})
	}
	return jobs
}

func TestSyncJobsReconciles(t *testing.T) {
	pool := kvPool(t)
	ctx := context.Background()
	kvSeedOrg(t, pool)
	const packageID = "acme.scheduler-sync"
	t.Cleanup(func() {
		_ = SyncJobs(ctx, pool, packageID, nil) //nolint:errcheck
	})

	if err := SyncJobs(ctx, pool, packageID, schedulerJobs("alpha", "beta")); err != nil {
		t.Fatalf("SyncJobs returned error: %v", err)
	}
	rows, err := ListJobs(ctx, pool, packageID)
	if err != nil || len(rows) != 2 {
		t.Fatalf("ListJobs = %d rows, %v", len(rows), err)
	}
	if rows[0].JobID != "alpha" || rows[0].LastStatus != "never" || rows[0].LastRunAt != nil {
		t.Fatalf("new job row = %+v, want never/unrun", rows[0])
	}

	updated := []packagemanifest.BackgroundJob{{ID: "alpha", IntervalMinutes: 60}}
	if err := SyncJobs(ctx, pool, packageID, updated); err != nil {
		t.Fatalf("resync returned error: %v", err)
	}
	rows, err = ListJobs(ctx, pool, packageID)
	if err != nil || len(rows) != 1 || rows[0].JobID != "alpha" || rows[0].IntervalMinutes != 60 {
		t.Fatalf("resync rows = %+v, %v", rows, err)
	}
}

func TestSchedulerRunOnce(t *testing.T) {
	pool := kvPool(t)
	ctx := context.Background()
	kvSeedOrg(t, pool)
	const packageID = "acme.scheduler-run"
	t.Cleanup(func() {
		_ = SyncJobs(ctx, pool, packageID, nil) //nolint:errcheck
	})

	if err := SyncJobs(ctx, pool, packageID, schedulerJobs("good", "bad", "late")); err != nil {
		t.Fatalf("SyncJobs returned error: %v", err)
	}
	// New jobs start due after one interval; force good+bad due and push
	// "late" out so the pass must skip it.
	if _, err := pool.Exec(ctx,
		`UPDATE external_plugin_jobs SET next_run_at = now() - make_interval(mins => 1)
		 WHERE package_id = $1 AND job_id IN ('good', 'bad')`, packageID); err != nil {
		t.Fatalf("force jobs due: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE external_plugin_jobs SET next_run_at = now() + make_interval(hours => 1)
		 WHERE package_id = $1 AND job_id = 'late'`, packageID); err != nil {
		t.Fatalf("defer job: %v", err)
	}

	calls := map[string]int{}
	scheduler := NewScheduler(pool, func(_ context.Context, _, jobID string) (int32, error) {
		calls[jobID]++
		if jobID == "bad" {
			return 0, errors.New("boom")
		}
		return 0, nil
	}, time.Minute, nil)
	ran, err := scheduler.RunOnce(ctx)
	if err != nil || ran != 2 {
		t.Fatalf("RunOnce = %d, %v; want 2, nil", ran, err)
	}
	if len(calls) != 2 || calls["late"] != 0 {
		t.Fatalf("invoked = %v, want good+bad only", calls)
	}

	rows, err := ListJobs(ctx, pool, packageID)
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	byID := map[string]JobRow{}
	for _, row := range rows {
		byID[row.JobID] = row
	}
	if byID["good"].LastStatus != "ok" || byID["good"].ConsecutiveFailures != 0 {
		t.Fatalf("good row = %+v", byID["good"])
	}
	bad := byID["bad"]
	if bad.LastStatus != "error" || bad.LastError != "boom" || bad.ConsecutiveFailures != 1 {
		t.Fatalf("bad row = %+v", bad)
	}
	if byID["late"].LastStatus != "never" || byID["late"].LastRunAt != nil {
		t.Fatalf("late row = %+v, want untouched", byID["late"])
	}

	// The claim lease holds: a second immediate pass finds nothing due.
	ran, err = scheduler.RunOnce(ctx)
	if err != nil || ran != 0 {
		t.Fatalf("second RunOnce = %d, %v; want 0, nil", ran, err)
	}
}
