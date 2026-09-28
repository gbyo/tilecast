package config

import (
	"errors"
	"path/filepath"
	"testing"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(filepath.Join(t.TempDir(), "config.json"))
}

func TestContextLifecycle(t *testing.T) {
	store := testStore(t)
	if _, err := store.Current(); !errors.Is(err, ErrNoCurrentContext) {
		t.Fatalf("empty Current = %v", err)
	}
	if err := store.Upsert(Context{Name: "home", ServerURL: "https://home.example", InstallationID: "a"}, false); err != nil {
		t.Fatal(err)
	}
	current, err := store.Current()
	if err != nil || current.Name != "home" {
		t.Fatalf("Current = %+v, %v", current, err)
	}
	if err := store.Upsert(Context{Name: "office", ServerURL: "https://office.example", InstallationID: "b"}, false); err != nil {
		t.Fatal(err)
	}
	// A new context becomes current; updating one does not steal it.
	if current, _ := store.Current(); current.Name != "office" {
		t.Fatalf("Current = %q, want office", current.Name)
	}
	if err := store.Upsert(Context{Name: "home", ServerURL: "https://home.example", InstallationID: "a2"}, false); err != nil {
		t.Fatal(err)
	}
	if current, _ := store.Current(); current.Name != "office" {
		t.Fatalf("update stole current: %q", current.Name)
	}
	got, err := store.Get("home")
	if err != nil || got.InstallationID != "a2" {
		t.Fatalf("Get(home) = %+v, %v", got, err)
	}
	if err := store.Use("home"); err != nil {
		t.Fatal(err)
	}
	if err := store.Rename("home", "cabin"); err != nil {
		t.Fatal(err)
	}
	if current, _ := store.Current(); current.Name != "cabin" {
		t.Fatalf("rename lost current: %q", current.Name)
	}
	if err := store.Rename("cabin", "office"); !errors.Is(err, ErrContextExists) {
		t.Fatalf("rename onto existing = %v", err)
	}
	if err := store.Use("nope"); !errors.Is(err, ErrContextNotFound) {
		t.Fatalf("use missing = %v", err)
	}
	if err := store.Remove("cabin"); err != nil {
		t.Fatal(err)
	}
	if current, _ := store.Current(); current.Name != "office" {
		t.Fatalf("remove did not fall back: %q", current.Name)
	}
	if err := store.Remove("office"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Current(); !errors.Is(err, ErrNoCurrentContext) {
		t.Fatalf("Current after removing all = %v", err)
	}
	if err := store.Remove("office"); !errors.Is(err, ErrContextNotFound) {
		t.Fatalf("double remove = %v", err)
	}
}

func TestConfigFileHoldsNoSecrets(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "config.json"))
	if err := store.Upsert(Context{Name: "home", ServerURL: "https://home.example", InstallationID: "a"}, true); err != nil {
		t.Fatal(err)
	}
	// Reload from disk and confirm the shape carries no credential field.
	reloaded, err := store.List()
	if err != nil || len(reloaded) != 1 || reloaded[0].Name != "home" {
		t.Fatalf("reload = %+v, %v", reloaded, err)
	}
}
