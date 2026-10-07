package wasm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

func storageOn() *bool {
	value := true
	return &value
}

func v2Manifest() packagemanifest.Manifest {
	return packagemanifest.Manifest{
		APIVersion:     2,
		PackageID:      "acme.athletics",
		PackageVersion: "2.4.1",
		Runtime:        &packagemanifest.Runtime{Module: "./runtime/plugin.wasm"},
		Capabilities: &packagemanifest.Capabilities{
			Network:    &packagemanifest.NetworkCapability{Hosts: []string{"api.example.com"}},
			Background: &packagemanifest.BackgroundCapability{Jobs: []packagemanifest.BackgroundJob{{ID: "refresh", IntervalMinutes: 60}}},
			Storage:    storageOn(),
			StudioUI:   &packagemanifest.StudioUICapability{Entry: "./studio/index.html"},
		},
	}
}

func writeLayout(t *testing.T, module []byte, entry string) string {
	t.Helper()
	dir := t.TempDir()
	if module != nil {
		path := filepath.Join(dir, "runtime", "plugin.wasm")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, module, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if entry != "" {
		path := filepath.Join(dir, "studio", "index.html")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(entry), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func validModule(t *testing.T) []byte {
	t.Helper()
	return assemble(validSpec())
}

func TestValidatePackageRuntime(t *testing.T) {
	t.Run("version 1 is inert", func(t *testing.T) {
		if err := ValidatePackageRuntime(t.TempDir(), packagemanifest.Manifest{APIVersion: 1}); err != nil {
			t.Fatalf("ValidatePackageRuntime returned error: %v", err)
		}
	})

	t.Run("full declarations pass", func(t *testing.T) {
		dir := writeLayout(t, validModule(t), "<!DOCTYPE html><title>acme</title>")
		if err := ValidatePackageRuntime(dir, v2Manifest()); err != nil {
			t.Fatalf("ValidatePackageRuntime returned error: %v", err)
		}
	})

	t.Run("studio-only needs no module", func(t *testing.T) {
		manifest := v2Manifest()
		manifest.Runtime = nil
		manifest.Capabilities = &packagemanifest.Capabilities{StudioUI: &packagemanifest.StudioUICapability{Entry: "./studio/index.html"}}
		dir := writeLayout(t, nil, "<!DOCTYPE html><title>acme</title>")
		if err := ValidatePackageRuntime(dir, manifest); err != nil {
			t.Fatalf("ValidatePackageRuntime returned error: %v", err)
		}
	})

	t.Run("missing module", func(t *testing.T) {
		dir := writeLayout(t, nil, "<!DOCTYPE html><title>acme</title>")
		err := ValidatePackageRuntime(dir, v2Manifest())
		if err == nil || !strings.Contains(err.Error(), "runtime module") {
			t.Fatalf("error = %v, want a runtime module failure", err)
		}
	})

	t.Run("malformed module", func(t *testing.T) {
		dir := writeLayout(t, []byte("not wasm"), "<!DOCTYPE html><title>acme</title>")
		err := ValidatePackageRuntime(dir, v2Manifest())
		if err == nil || !strings.Contains(err.Error(), "bad magic") {
			t.Fatalf("error = %v, want a magic failure", err)
		}
	})

	t.Run("jobs require run_job", func(t *testing.T) {
		spec := validSpec()
		spec.exports = []testExport{{name: "handle_ui_request", kind: 0, index: 6}}
		dir := writeLayout(t, assemble(spec), "<!DOCTYPE html><title>acme</title>")
		err := ValidatePackageRuntime(dir, v2Manifest())
		if err == nil || !strings.Contains(err.Error(), "run_job") {
			t.Fatalf("error = %v, want a run_job failure", err)
		}
	})

	t.Run("studio calls require handle_ui_request", func(t *testing.T) {
		manifest := v2Manifest()
		manifest.Capabilities.Background = nil
		spec := validSpec()
		spec.exports = []testExport{{name: "run_job", kind: 0, index: 5}}
		dir := writeLayout(t, assemble(spec), "<!DOCTYPE html><title>acme</title>")
		err := ValidatePackageRuntime(dir, manifest)
		if err == nil || !strings.Contains(err.Error(), "handle_ui_request") {
			t.Fatalf("error = %v, want a handle_ui_request failure", err)
		}
	})

	t.Run("missing studio entry", func(t *testing.T) {
		dir := writeLayout(t, validModule(t), "")
		err := ValidatePackageRuntime(dir, v2Manifest())
		if err == nil || !strings.Contains(err.Error(), "Studio UI entry") {
			t.Fatalf("error = %v, want a Studio UI entry failure", err)
		}
	})
}
