package services

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// The plugin SDK's typed client is generated from this registry, so the
// public Go API cannot drift from the capabilities the dispatcher serves.
func TestBundledClientIsCurrent(t *testing.T) {
	for _, file := range []struct {
		path   string
		render func() ([]byte, error)
	}{{BundledClientPath, BundledClientSource}, {BundledCatalogPath, BundledCatalogSource}} {
		want, err := file.render()
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", file.path))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%s is stale; run go run ./internal/extensions/services/gen from apps/server", file.path)
		}
	}
}

func TestBundledCallersAreExplicit(t *testing.T) {
	for _, capability := range All() {
		bundled := capability.AllowsCaller(CallerBundled)
		switch capability.ID {
		case "organization.read", "instance.read", "screens.read", "targets.resolve", "users.read-basic":
			if !bundled || !capability.AllowsCaller(CallerPackage) {
				t.Errorf("%s@%d should serve packages and bundled plugins", capability.ID, capability.Version)
			}
		case "settings.read", "secrets.read", "http.fetch", "storage.kv", "timers.schedule", "timers.cancel", "feeds.publish", "instances.read":
			if !bundled || capability.AllowsCaller(CallerPackage) {
				t.Errorf("%s@%d should serve bundled plugins only", capability.ID, capability.Version)
			}
		default:
			// Package-owned rows (managed presentations, runtime state,
			// package audit) and package Takeovers keep package attribution.
			if bundled {
				t.Errorf("%s@%d is not reviewed for bundled callers", capability.ID, capability.Version)
			}
		}
	}
}
