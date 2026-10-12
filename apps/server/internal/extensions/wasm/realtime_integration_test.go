package wasm

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/execution"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
)

func seedRealtimePackage(t *testing.T, pool *pgxpool.Pool, id string) (uuid.UUID, uuid.UUID, string) {
	t.Helper()
	kvSeedOrg(t, pool)
	epoch, storage := uuid.New(), uuid.New()
	digest := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	manifest := map[string]any{
		"apiVersion": 4, "packageId": id, "packageVersion": "1.0.0", "name": "Realtime test", "description": "Bounded realtime job.",
		"publisher": map[string]any{"id": "acme", "name": "Acme"}, "repository": "https://github.com/acme/realtime", "license": "AGPL-3.0-only",
		"tilecast": map[string]any{"version": ">=1.0.0 <2.0.0"}, "distribution": map[string]any{"oci": "ghcr.io/acme/realtime"},
		"contributions": []any{map[string]any{"type": "plugin", "path": "./plugin"}}, "runtime": map[string]any{"module": "./runtime/server.wasm"},
		"capabilities": map[string]any{"realtime": map[string]any{"jobs": []any{map[string]any{"id": "refresh", "intervalSeconds": 5}}}},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(context.Background(), `INSERT INTO installed_packages
	 (organization_id,package_id,package_version,digest,source_kind,source_reference,registry_reference,trust_state,manifest,execution_epoch,storage_epoch)
	 SELECT id,$1,'1.0.0',$2,'custom','https://github.com/acme/realtime','ghcr.io/acme/realtime','verified',$3,$4,$5
	 FROM organization_settings WHERE singleton`, id, digest, raw, epoch, storage)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM installed_packages WHERE package_id=$1`, id)
		_ = SyncJobs(ctx, pool, id, nil)
		_ = NewPostgresKV(pool).RemovePackage(ctx, id)
	})
	if err := SyncJobs(context.Background(), pool, id, nil); err != nil {
		t.Fatal(err)
	}
	return epoch, storage, digest
}

func TestJobStopsWhenAnotherReplicaReplacesActivation(t *testing.T) {
	pool := kvPool(t)
	ctx := context.Background()
	const id = "acme.realtime-cancel"
	epoch, _, _ := seedRealtimePackage(t, pool, id)
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "runtime", "server.wasm"), loopGuest(t), 0600); err != nil {
		t.Fatal(err)
	}
	var reads atomic.Int32
	service, err := NewService(ctx, installer.NewService(pool, "1.0.0"), func(context.Context, string, string) (string, error) { reads.Add(1); return dir, nil }, NewPostgresKV(pool), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close(ctx) })
	// Verified bytes stay in the bounded memory cache for this epoch. A new
	// epoch performs a new retained-artifact lookup instead of inheriting them.
	if _, err := service.prepare(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := service.prepare(ctx, id); err != nil {
		t.Fatal(err)
	}
	if reads.Load() != 1 {
		t.Fatalf("artifact read %d times", reads.Load())
	}
	done := make(chan error, 1)
	go func() {
		_, err := service.InvokeJob(context.WithValue(ctx, claimedEpochKey{}, &epoch), id, "refresh")
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	changedAt := time.Now()
	if _, err := pool.Exec(ctx, `UPDATE installed_packages SET execution_epoch=$2 WHERE package_id=$1`, id, uuid.New()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("old infinite guest succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("old guest survived activation replacement")
	}
	if time.Since(changedAt) >= 3*time.Second {
		t.Fatal("replacement cancellation exceeded its bound")
	}
	if _, err := service.InvokeJob(context.WithValue(ctx, claimedEpochKey{}, &epoch), id, "refresh"); !errors.Is(err, execution.ErrChanged) {
		t.Fatalf("stale claimed epoch invoked replacement: %v", err)
	}
	if reads.Load() != 2 {
		t.Fatalf("new activation did not reverify artifact: %d reads", reads.Load())
	}
}

func TestRealtimeReplicaClaimsDoNotOverlap(t *testing.T) {
	pool := kvPool(t)
	ctx := context.Background()
	const id = "acme.realtime-replicas"
	seedRealtimePackage(t, pool, id)
	if _, err := pool.Exec(ctx, `UPDATE external_plugin_jobs SET next_run_at=now() WHERE package_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	started, finish := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	invoke := func(ctx context.Context, _, _ string) (int32, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-finish:
			return 0, nil
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	first, second := NewRealtimeScheduler(pool, invoke, nil), NewRealtimeScheduler(pool, invoke, nil)
	done := make(chan error, 1)
	go func() { _, err := first.RunOnce(ctx); done <- err }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("job did not start")
	}
	ran, err := second.RunOnce(ctx)
	close(finish)
	if firstErr := <-done; firstErr != nil {
		t.Fatal(firstErr)
	}
	if err != nil || ran != 0 || calls.Load() != 1 {
		t.Fatalf("second replica: ran=%d calls=%d error=%v", ran, calls.Load(), err)
	}
	rows, err := ListJobs(ctx, pool, id)
	if err != nil || len(rows) != 1 || rows[0].Kind != "realtime" || rows[0].IntervalSeconds != 5 || rows[0].LastStatus != "ok" {
		t.Fatalf("status: %+v, %v", rows, err)
	}
	// A realtime pass never consumes an ordinary job and vice versa.
	if _, err := pool.Exec(ctx, `UPDATE external_plugin_jobs SET next_run_at=now() WHERE package_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	ran, err = NewScheduler(pool, invoke, time.Minute, nil).RunOnce(ctx)
	if err != nil || ran != 0 {
		t.Fatalf("ordinary consumed realtime: %d, %v", ran, err)
	}
}

func TestReplacedRealtimeClaimCannotRescheduleNewActivation(t *testing.T) {
	pool := kvPool(t)
	ctx := context.Background()
	const id = "acme.realtime-replaced"
	seedRealtimePackage(t, pool, id)
	_, err := pool.Exec(ctx, `UPDATE external_plugin_jobs SET next_run_at=now() WHERE package_id=$1`, id)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := claimJobs(ctx, pool, 4, "realtime")
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	_, err = pool.Exec(ctx, `UPDATE installed_packages SET execution_epoch=$2 WHERE package_id=$1`, id, uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	// Old inputs cannot override the currently installed declaration.
	if err := SyncJobs(ctx, pool, id, schedulerJobs("obsolete")); err != nil {
		t.Fatal(err)
	}
	if err := recordJobOutcome(ctx, pool, claimed[0], jobOutcome{err: errors.New("old failure")}); err != nil {
		t.Fatal(err)
	}
	rows, err := ListJobs(ctx, pool, id)
	if err != nil || len(rows) != 1 || rows[0].JobID != "refresh" || rows[0].LastStatus != "never" || rows[0].LastRunAt != nil {
		t.Fatalf("old claim changed replacement: %+v %v", rows, err)
	}
}

func TestKVActivationAndReinstallFences(t *testing.T) {
	pool := kvPool(t)
	ctx := context.Background()
	const id = "acme.kv-epochs"
	epoch, storage, digest := seedRealtimePackage(t, pool, id)
	store := NewPostgresKV(pool)
	guest := func(epoch, storage uuid.UUID) context.Context {
		return context.WithValue(ctx, invocationKey{}, &invocation{packageID: id, executionEpoch: epoch, storageEpoch: storage, digest: digest})
	}
	old := guest(epoch, storage)
	if err := store.Set(old, id, "cursor", []byte("baseline")); err != nil {
		t.Fatal(err)
	}
	updated := uuid.New()
	if _, err := pool.Exec(ctx, `UPDATE installed_packages SET execution_epoch=$2 WHERE package_id=$1`, id, updated); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(old, id, "cursor", []byte("stale")); !errors.Is(err, execution.ErrChanged) {
		t.Fatalf("old write accepted: %v", err)
	}
	value, err := store.Get(guest(updated, storage), id, "cursor")
	if err != nil || string(value) != "baseline" {
		t.Fatalf("update lost storage: %q %v", value, err)
	}
	newEpoch, newStorage := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `UPDATE installed_packages SET execution_epoch=$2,storage_epoch=$3 WHERE package_id=$1`, id, newEpoch, newStorage); err != nil {
		t.Fatal(err)
	}
	reinstalled := guest(newEpoch, newStorage)
	if _, err := store.Get(reinstalled, id, "cursor"); !errors.Is(err, ErrKVNotFound) {
		t.Fatalf("reinstall inherited old storage: %v", err)
	}
	if err := store.Set(reinstalled, id, "cursor", []byte("new")); err != nil {
		t.Fatal(err)
	}
	if err := store.RemovePackage(ctx, id); err != nil {
		t.Fatal(err)
	}
	value, err = store.Get(reinstalled, id, "cursor")
	if err != nil || string(value) != "new" {
		t.Fatalf("delayed cleanup deleted reinstall: %q %v", value, err)
	}
}
