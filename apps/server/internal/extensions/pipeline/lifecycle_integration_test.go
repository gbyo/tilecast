package pipeline

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

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
	if err := f.service.syncWASMJobs(ctx, manifest.PackageID, manifest); err != nil {
		t.Fatalf("sync jobs: %v", err)
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
	if err := f.service.syncWASMJobs(ctx, withJobs.PackageID, withJobs); err != nil {
		t.Fatalf("sync jobs: %v", err)
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
	if err := service.syncWASMJobs(context.Background(), "acme.lifecycle", packagemanifest.Manifest{}); err != nil {
		t.Fatalf("nil runtime sync = %v, want nil", err)
	}
}
