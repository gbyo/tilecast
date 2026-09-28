package secret

import (
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestMemoryStoreRoundTrip(t *testing.T) {
	store := NewMemoryStore()
	if _, err := store.Get("ctx"); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("empty Get = %v", err)
	}
	if err := store.Set("ctx", "tcr_secret"); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get("ctx")
	if err != nil || got != "tcr_secret" {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if err := store.Delete("ctx"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get("ctx"); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("Get after Delete = %v", err)
	}
	if err := store.Check(); err != nil {
		t.Fatal(err)
	}
	// Deleting a missing entry is success, so logout stays idempotent.
	if err := store.Delete("ctx"); err != nil {
		t.Fatal(err)
	}
}
