package pipeline

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/wasm"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// lifecycleManifest builds an activation-ready manifest: version 2 with
// one background job when jobs are given, version 1 without execution
// state otherwise.
func lifecycleManifest(version string, jobs []packagemanifest.BackgroundJob) packagemanifest.Manifest {
	manifest := packagemanifest.Manifest{
		APIVersion:     1,
		PackageID:      "acme.lifecycle",
		PackageVersion: version,
		Name:           "Lifecycle",
		Description:    "Execution-state lifecycle coverage.",
		Publisher:      packagemanifest.Publisher{ID: "acme", Name: "Acme"},
		Repository:     "https://github.com/acme/tilecast-lifecycle",
		License:        "MIT",
		Tilecast:       packagemanifest.TilecastCompat{Version: pipelineRange},
		Distribution:   packagemanifest.Distribution{OCI: "ghcr.io/acme/tilecast-lifecycle"},
		Contributions: []packagemanifest.Contribution{
			{Type: packagemanifest.ContributionPlugin, Path: "./plugin"},
		},
	}
	if jobs != nil {
		manifest.APIVersion = 2
		manifest.Runtime = &packagemanifest.Runtime{Module: "./runtime/plugin.wasm"}
		manifest.Capabilities = &packagemanifest.Capabilities{
			Background: &packagemanifest.BackgroundCapability{Jobs: jobs},
		}
	}
	return manifest
}

func lifecycleActivation(manifest packagemanifest.Manifest, digest string, f *pipelineFixture) installer.Activation {
	return installer.Activation{
		Manifest:          manifest,
		Digest:            digest,
		SourceKind:        installer.SourceCustom,
		SourceReference:   "https://github.com/acme/tilecast-lifecycle@v1",
		RegistryReference: "ghcr.io/acme/tilecast-lifecycle",
		SignerIdentity:    "https://github.com/acme/tilecast-lifecycle/.github/workflows/release.yml",
		Trust:             installer.TrustVerified,
		InstalledBy:       f.userID,
		Contributions: []installer.Contribution{
			{Kind: "plugin", ID: "acme.lifecycle", Path: "./plugin"},
		},
	}
}

func lifecycleWASM(t *testing.T, f *pipelineFixture) (*wasm.Service, wasm.KVStore) {
	t.Helper()
	ctx := context.Background()
	store := wasm.NewPostgresKV(f.pool)
	service, err := wasm.NewService(ctx, f.installer,
		func(context.Context, string, string) (string, error) {
			return "", errors.New("content is unused in lifecycle tests")
		},
		store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { service.Close(ctx) }) //nolint:errcheck
	return service, store
}

func lifecycleDigest(seed byte) string {
	return "sha256:" + strings.Repeat(string([]byte{seed}), 64)
}

func TestRemoveDeletesExecutionState(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	service, store := lifecycleWASM(t, f)
	f.service.SetWASM(service, store)
	_ = wasm.SyncJobs(ctx, f.pool, "acme.lifecycle", nil) //nolint:errcheck
	_ = store.RemovePackage(ctx, "acme.lifecycle")        //nolint:errcheck

	manifest := lifecycleManifest("1.0.0", []packagemanifest.BackgroundJob{{ID: "refresh", IntervalMinutes: 15}})
	if _, err := f.installer.Activate(ctx, lifecycleActivation(manifest, lifecycleDigest('a'), f)); err != nil {
		t.Fatalf("activate: %v", err)
	}
	f.service.reconcileWASMJobs(ctx, "test", manifest.PackageID, manifest)
	if jobs, err := wasm.ListJobs(ctx, f.pool, manifest.PackageID); err != nil || len(jobs) != 1 {
		t.Fatalf("jobs after sync = %d, %v", len(jobs), err)
	}
	if err := store.Set(ctx, manifest.PackageID, "theme", []byte("dark")); err != nil {
		t.Fatalf("seed key: %v", err)
	}

	if err := f.service.Remove(ctx, manifest.PackageID, f.userID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	jobs, err := wasm.ListJobs(ctx, f.pool, manifest.PackageID)
	if err != nil || len(jobs) != 0 {
		t.Fatalf("jobs after remove = %d, %v", len(jobs), err)
	}
	if _, err := store.Get(ctx, manifest.PackageID, "theme"); !errors.Is(err, wasm.ErrKVNotFound) {
		t.Fatalf("key after remove = %v, want ErrKVNotFound", err)
	}
	if _, err := f.installer.Get(ctx, manifest.PackageID); !errors.Is(err, installer.ErrNotFound) {
		t.Fatalf("package after remove = %v, want ErrNotFound", err)
	}
}

func TestRollbackRestoresPreviousJobs(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	service, store := lifecycleWASM(t, f)
	f.service.SetWASM(service, store)
	_ = wasm.SyncJobs(ctx, f.pool, "acme.lifecycle", nil) //nolint:errcheck
	_ = store.RemovePackage(ctx, "acme.lifecycle")        //nolint:errcheck

	plain := lifecycleManifest("1.0.0", nil)
	if _, err := f.installer.Activate(ctx, lifecycleActivation(plain, lifecycleDigest('b'), f)); err != nil {
		t.Fatalf("activate v1: %v", err)
	}
	withJobs := lifecycleManifest("2.0.0", []packagemanifest.BackgroundJob{{ID: "refresh", IntervalMinutes: 15}})
	if _, err := f.installer.Activate(ctx, lifecycleActivation(withJobs, lifecycleDigest('c'), f)); err != nil {
		t.Fatalf("activate v2: %v", err)
	}
	f.service.reconcileWASMJobs(ctx, "test", withJobs.PackageID, withJobs)
	if jobs, err := wasm.ListJobs(ctx, f.pool, withJobs.PackageID); err != nil || len(jobs) != 1 {
		t.Fatalf("jobs after sync = %d, %v", len(jobs), err)
	}

	installed, err := f.service.Rollback(ctx, withJobs.PackageID, f.userID)
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if installed.Version != "1.0.0" {
		t.Fatalf("version after rollback = %q", installed.Version)
	}
	jobs, err := wasm.ListJobs(ctx, f.pool, withJobs.PackageID)
	if err != nil || len(jobs) != 0 {
		t.Fatalf("jobs after rollback = %d, %v", len(jobs), err)
	}
}

func TestSyncWASMJobsWithoutRuntime(t *testing.T) {
	service := &Service{}
	// A nil runtime leaves execution state untouched: no sync, no log,
	// no failure.
	service.reconcileWASMJobs(context.Background(), "test", "acme.lifecycle", packagemanifest.Manifest{})
	service.reconcileRemove(context.Background(), "acme.lifecycle", lifecycleDigest('z'))
}

// captureLifecycleLogs points the service at a buffer the test reads.
func captureLifecycleLogs(f *pipelineFixture) *strings.Builder {
	var logs strings.Builder
	f.service.logger = slog.New(slog.NewTextHandler(&logs, nil))
	return &logs
}

func injectSyncFailure(f *pipelineFixture, calls *int) {
	f.service.syncJobs = func(ctx context.Context, db *pgxpool.Pool, packageID string, jobs []packagemanifest.BackgroundJob) error {
		*calls++
		return errors.New("job sync is down")
	}
}

func TestInstallSucceedsWhenJobSyncFails(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	service, store := lifecycleWASM(t, f)
	f.service.SetWASM(service, store)
	logs := captureLifecycleLogs(f)
	var calls int
	injectSyncFailure(f, &calls)

	installed, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID)
	if err != nil {
		t.Fatalf("install with failing sync = %v, want success", err)
	}
	if installed.Version != "2.4.1" {
		t.Fatalf("installed version = %q", installed.Version)
	}
	if calls != 1 {
		t.Fatalf("sync calls = %d, want 1", calls)
	}
	if logged := logs.String(); !strings.Contains(logged, "package wasm job sync failed after commit") || !strings.Contains(logged, pipelinePID) {
		t.Fatalf("logs = %q, want the sync failure for %s", logged, pipelinePID)
	}
}

func TestMarketplaceInstallSucceedsWhenJobSyncFails(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	service, store := lifecycleWASM(t, f)
	f.service.SetWASM(service, store)
	logs := captureLifecycleLogs(f)
	var calls int
	injectSyncFailure(f, &calls)
	f.listing = f.catalogListing()

	installed, err := f.service.InstallMarketplace(ctx, pipelinePID, f.userID)
	if err != nil {
		t.Fatalf("marketplace install with failing sync = %v, want success", err)
	}
	if installed.Version != "2.4.1" {
		t.Fatalf("installed version = %q", installed.Version)
	}
	if calls != 1 {
		t.Fatalf("sync calls = %d, want 1", calls)
	}
	if logged := logs.String(); !strings.Contains(logged, "package wasm job sync failed after commit") {
		t.Fatalf("logs = %q, want the sync failure", logged)
	}
}

func TestUpdateAndRollbackSucceedWhenJobSyncFails(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	service, store := lifecycleWASM(t, f)
	f.service.SetWASM(service, store)
	if _, err := f.service.InstallCustom(ctx, "https://github.com/acme/tilecast-athletics", f.userID); err != nil {
		t.Fatal(err)
	}
	f.rebuild(t, "2.5.0", "v2.5.0")
	logs := captureLifecycleLogs(f)
	var calls int
	injectSyncFailure(f, &calls)

	result, err := f.service.ApplyUpdate(ctx, pipelinePID, f.digest, f.userID)
	if err != nil {
		t.Fatalf("update with failing sync = %v, want success", err)
	}
	if !result.Updated || result.Installed.Version != "2.5.0" {
		t.Fatalf("result = %+v", result)
	}
	installed, err := f.service.Rollback(ctx, pipelinePID, f.userID)
	if err != nil {
		t.Fatalf("rollback with failing sync = %v, want success", err)
	}
	if installed.Version != "2.4.1" {
		t.Fatalf("version after rollback = %q", installed.Version)
	}
	if calls != 2 {
		t.Fatalf("sync calls = %d, want 2", calls)
	}
	if logged := logs.String(); !strings.Contains(logged, "package wasm job sync failed after commit") {
		t.Fatalf("logs = %q, want the sync failures", logged)
	}
}

func TestRemoveSucceedsWhenExecutionCleanupFails(t *testing.T) {
	f := newPipelineFixture(t)
	ctx := context.Background()
	service, store := lifecycleWASM(t, f)
	f.service.SetWASM(service, store)
	_ = wasm.SyncJobs(ctx, f.pool, "acme.lifecycle", nil) //nolint:errcheck
	_ = store.RemovePackage(ctx, "acme.lifecycle")        //nolint:errcheck

	manifest := lifecycleManifest("1.0.0", []packagemanifest.BackgroundJob{{ID: "refresh", IntervalMinutes: 15}})
	if _, err := f.installer.Activate(ctx, lifecycleActivation(manifest, lifecycleDigest('a'), f)); err != nil {
		t.Fatalf("activate: %v", err)
	}
	f.service.reconcileWASMJobs(ctx, "test", manifest.PackageID, manifest)
	if err := store.Set(ctx, manifest.PackageID, "theme", []byte("dark")); err != nil {
		t.Fatalf("seed key: %v", err)
	}

	logs := captureLifecycleLogs(f)
	var syncCalls, removeCalls int
	injectSyncFailure(f, &syncCalls)
	f.service.removeExec = func(ctx context.Context, digest, packageID string, store wasm.KVStore) error {
		removeCalls++
		return errors.New("execution removal is down")
	}
	if err := f.service.Remove(ctx, manifest.PackageID, f.userID); err != nil {
		t.Fatalf("remove with failing cleanup = %v, want success", err)
	}
	if _, err := f.installer.Get(ctx, manifest.PackageID); !errors.Is(err, installer.ErrNotFound) {
		t.Fatalf("package after remove = %v, want ErrNotFound", err)
	}
	// Both cleanups ran and failed loudly: the rows and the key are
	// still there, and the committed removal stands anyway.
	if syncCalls != 1 || removeCalls != 1 {
		t.Fatalf("sync calls = %d, remove calls = %d, want 1 each", syncCalls, removeCalls)
	}
	if jobs, err := wasm.ListJobs(ctx, f.pool, manifest.PackageID); err != nil || len(jobs) != 1 {
		t.Fatalf("jobs after failed cleanup = %d, %v", len(jobs), err)
	}
	if _, err := store.Get(ctx, manifest.PackageID, "theme"); err != nil {
		t.Fatalf("key after failed cleanup = %v, want it kept", err)
	}
	logged := logs.String()
	if !strings.Contains(logged, "package execution-state removal failed after commit") {
		t.Fatalf("logs = %q, want the removal failure", logged)
	}
	if !strings.Contains(logged, "package wasm job sync failed after commit") {
		t.Fatalf("logs = %q, want the sync failure", logged)
	}
}
