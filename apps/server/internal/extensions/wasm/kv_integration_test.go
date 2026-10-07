package wasm

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func kvPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func kvSeedOrg(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Wasm KV Test',$1)
		 ON CONFLICT (singleton) DO NOTHING`, uuid.New()); err != nil {
		t.Fatalf("seed organization: %v", err)
	}
}

func TestPostgresKVRoundtrip(t *testing.T) {
	pool := kvPool(t)
	ctx := context.Background()
	kvSeedOrg(t, pool)
	store := NewPostgresKV(pool)
	const packageID = "acme.athletics"
	t.Cleanup(func() { store.RemovePackage(ctx, packageID) }) //nolint:errcheck

	if _, err := store.Get(ctx, packageID, "missing"); !errors.Is(err, ErrKVNotFound) {
		t.Fatalf("Get missing = %v, want ErrKVNotFound", err)
	}
	if err := store.Set(ctx, packageID, "theme", []byte("dark")); err != nil {
		t.Fatalf("Set returned error: %v", err)
	}
	value, err := store.Get(ctx, packageID, "theme")
	if err != nil || string(value) != "dark" {
		t.Fatalf("Get = %q, %v", value, err)
	}
	if err := store.Set(ctx, packageID, "theme", []byte("light")); err != nil {
		t.Fatalf("overwrite returned error: %v", err)
	}
	value, err = store.Get(ctx, packageID, "theme")
	if err != nil || string(value) != "light" {
		t.Fatalf("Get after overwrite = %q, %v", value, err)
	}
	// Namespaces isolate packages.
	if _, err := store.Get(ctx, "acme.other", "theme"); !errors.Is(err, ErrKVNotFound) {
		t.Fatalf("cross-package Get = %v, want ErrKVNotFound", err)
	}
	if err := store.RemovePackage(ctx, packageID); err != nil {
		t.Fatalf("RemovePackage returned error: %v", err)
	}
	if _, err := store.Get(ctx, packageID, "theme"); !errors.Is(err, ErrKVNotFound) {
		t.Fatalf("Get after remove = %v, want ErrKVNotFound", err)
	}
}

func TestPostgresKVBounds(t *testing.T) {
	pool := kvPool(t)
	ctx := context.Background()
	kvSeedOrg(t, pool)
	store := NewPostgresKV(pool)
	const packageID = "acme.quota"
	t.Cleanup(func() { store.RemovePackage(ctx, packageID) }) //nolint:errcheck

	if err := store.Set(ctx, packageID, "", []byte("x")); err == nil {
		t.Fatal("Set accepted an empty key")
	}
	if err := store.Set(ctx, packageID, strings.Repeat("k", MaxKVKeyBytes+1), []byte("x")); err == nil {
		t.Fatal("Set accepted an oversized key")
	}
	if err := store.Set(ctx, packageID, "big", make([]byte, MaxKVValueBytes+1)); err == nil {
		t.Fatal("Set accepted an oversized value")
	}
	// Fill the quota with maximum values, then prove one more byte fails.
	full := make([]byte, MaxKVValueBytes)
	count := MaxKVPackageBytes / MaxKVValueBytes
	for i := 0; i < count; i++ {
		if err := store.Set(ctx, packageID, strings.Repeat("k", 8)+string(rune('a'+i)), full); err != nil {
			t.Fatalf("fill %d returned error: %v", i, err)
		}
	}
	if err := store.Set(ctx, packageID, "overflow", []byte("x")); err == nil {
		t.Fatal("Set exceeded the package quota")
	}
	// Overwriting a key in place does not count twice.
	if err := store.Set(ctx, packageID, strings.Repeat("k", 8)+"a", full); err != nil {
		t.Fatalf("overwrite at quota returned error: %v", err)
	}
}
