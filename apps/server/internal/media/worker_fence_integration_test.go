package media

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

// A worker that lost its lease must not change the job its replacement now runs.
func TestSupersededWorkerCannotCompleteJob(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE media_jobs, organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err = auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Fence", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"}); err != nil {
		t.Fatal(err)
	}

	service := NewService(pool, nil, Config{})
	worker := NewWorkerPool(service, slog.New(slog.NewTextHandler(io.Discard, nil)))
	job, replacement := uuid.New(), "replacement-worker"
	// The replacement claimed the job on its second attempt.
	if _, err = pool.Exec(ctx, `INSERT INTO media_jobs(id,kind,status,attempts,locked_by,locked_at) VALUES($1,'clean_expired_uploads','running',2,$2,now())`, job, replacement); err != nil {
		t.Fatal(err)
	}
	stale := staleJob(job, 1)
	worker.complete(ctx, stale)
	var status, lockedBy string
	if err = pool.QueryRow(ctx, `SELECT status,locked_by FROM media_jobs WHERE id=$1`, job).Scan(&status, &lockedBy); err != nil {
		t.Fatal(err)
	}
	if status != "running" || lockedBy != replacement {
		t.Fatalf("stale completion changed the job: status=%s locked_by=%s", status, lockedBy)
	}
}

func staleJob(id uuid.UUID, attempts int) job {
	return job{ID: id, Kind: "clean_expired_uploads", Attempts: attempts, MaxAttempts: 5}
}

// A job whose worker died on its final attempt (for example a file that gets
// the process killed) is not reclaimed forever. Its asset fails instead.
func TestExhaustedStaleJobFailsInsteadOfRunningAgain(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE media_jobs, assets, organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Poison", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	asset := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by) SELECT $1,id,'Clip','video','clip.mp4','video/mp4',$2,100,'processing',$3 FROM organization_settings`, asset, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	exhausted, retryable := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO media_jobs(id,asset_id,kind,status,attempts,max_attempts,locked_by,locked_at) VALUES($1,$2,'optimize_video','running',5,5,'dead-worker',now()-interval '11 minutes')`, exhausted, asset); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO media_jobs(id,kind,status,attempts,max_attempts,locked_by,locked_at,created_at) VALUES($1,'clean_expired_uploads','running',2,5,'dead-worker',now()-interval '11 minutes',now()+interval '1 second')`, retryable); err != nil {
		t.Fatal(err)
	}
	worker := NewWorkerPool(NewService(pool, nil, Config{}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	claimed, err := worker.claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if claimed == nil || claimed.ID != retryable || claimed.Attempts != 3 {
		t.Fatalf("claimed %#v, want the retryable job on its third attempt", claimed)
	}
	var jobStatus, assetStatus string
	if err = pool.QueryRow(ctx, `SELECT status FROM media_jobs WHERE id=$1`, exhausted).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT processing_status FROM assets WHERE id=$1`, asset).Scan(&assetStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "failed" || assetStatus != "failed" {
		t.Fatalf("exhausted job=%s asset=%s, want both failed", jobStatus, assetStatus)
	}

	// With nothing left to claim, the failure must still be committed.
	if _, err = pool.Exec(ctx, `DELETE FROM media_jobs`); err != nil {
		t.Fatal(err)
	}
	asset = uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by) SELECT $1,id,'Clip 2','video','clip2.mp4','video/mp4',$2,100,'processing',$3 FROM organization_settings`, asset, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	only := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO media_jobs(id,asset_id,kind,status,attempts,max_attempts,locked_by,locked_at) VALUES($1,$2,'optimize_video','running',5,5,'dead-worker',now()-interval '11 minutes')`, only, asset); err != nil {
		t.Fatal(err)
	}
	if claimed, err = worker.claim(ctx); err != nil || claimed != nil {
		t.Fatalf("claim with only exhausted work = %#v, %v", claimed, err)
	}
	if err = pool.QueryRow(ctx, `SELECT status FROM media_jobs WHERE id=$1`, only).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT processing_status FROM assets WHERE id=$1`, asset).Scan(&assetStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "failed" || assetStatus != "failed" {
		t.Fatalf("exhausted-only claim rolled back: job=%s asset=%s", jobStatus, assetStatus)
	}
}

// With originals discarded, a poster job that runs after optimize_video still
// has a source: the playback variant.
func TestVideoPosterSourceFallsBackToPlaybackVariant(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE media_jobs, asset_variants, assets, organization_settings, users CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Poster", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	asset := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,created_by) SELECT $1,id,'Clip','video','clip.mov','video/quicktime',$2,100,'processing',$3 FROM organization_settings`, asset, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO asset_variants(id,asset_id,kind,storage_provider,storage_key,mime_type,file_size,sha256,player_compatible,deleted_at) VALUES($1,$2,'original','local','originals/clip','video/quicktime',100,$3,FALSE,now()),($4,$2,'playback','local','playback/clip','video/mp4',90,$3,TRUE,NULL)`, uuid.New(), asset, make([]byte, 32), uuid.New()); err != nil {
		t.Fatal(err)
	}
	worker := NewWorkerPool(NewService(pool, nil, Config{}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	key, err := worker.previewSource(ctx, asset, true)
	if err != nil || key != "playback/clip" {
		t.Fatalf("poster source=%q err=%v, want the playback variant", key, err)
	}
	if _, err = worker.previewSource(ctx, asset, false); err == nil {
		t.Fatal("an image thumbnail must not fall back to a playback variant")
	}
}
