package wasm

import (
	"context"
	"errors"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// KV bounds for plugin-owned storage.
const (
	// MaxKVKeyBytes caps one storage key. Keys are UTF-8 text; the host
	// rejects anything longer before touching the store.
	MaxKVKeyBytes = 128
	// MaxKVValueBytes caps one stored value at 64 KiB, matching the
	// database CHECK constraint.
	MaxKVValueBytes = 64 << 10
	// MaxKVPackageBytes caps one package's total stored values at 1 MiB.
	// Set checks the quota inside its write transaction.
	MaxKVPackageBytes = 1 << 20
)

// ErrKVNotFound answers a read for a key the package never stored.
var ErrKVNotFound = errors.New("wasm: storage key not found")

// KVStore is plugin-owned key/value storage: one namespace per package,
// bounded keys and values, and a per-package quota.
type KVStore interface {
	Get(ctx context.Context, packageID, key string) ([]byte, error)
	Set(ctx context.Context, packageID, key string, value []byte) error
	// RemovePackage deletes every key one package stored. Package
	// removal calls it after the activation row is gone.
	RemovePackage(ctx context.Context, packageID string) error
}

// MemoryKV is a KVStore for tests. It enforces the same bounds and
// quota as the Postgres store.
type MemoryKV struct {
	mu     sync.Mutex
	values map[string]map[string][]byte
}

// NewMemoryKV returns an empty test store.
func NewMemoryKV() *MemoryKV {
	return &MemoryKV{values: map[string]map[string][]byte{}}
}

// Get implements KVStore.
func (s *MemoryKV) Get(_ context.Context, packageID, key string) ([]byte, error) {
	if len(key) == 0 || len(key) > MaxKVKeyBytes {
		return nil, errors.New("wasm: storage key must hold 1 to 128 bytes")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	values, ok := s.values[packageID]
	if !ok {
		return nil, ErrKVNotFound
	}
	value, ok := values[key]
	if !ok {
		return nil, ErrKVNotFound
	}
	return append([]byte{}, value...), nil
}

// Set implements KVStore.
func (s *MemoryKV) Set(_ context.Context, packageID, key string, value []byte) error {
	if len(key) == 0 || len(key) > MaxKVKeyBytes {
		return errors.New("wasm: storage key must hold 1 to 128 bytes")
	}
	if len(value) > MaxKVValueBytes {
		return errors.New("wasm: storage value exceeds 64 KiB")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	values, ok := s.values[packageID]
	if !ok {
		values = map[string][]byte{}
		s.values[packageID] = values
	}
	total := len(value)
	for existingKey, existing := range values {
		if existingKey != key {
			total += len(existing)
		}
	}
	if total > MaxKVPackageBytes {
		return errors.New("wasm: package storage quota exceeded")
	}
	values[key] = append([]byte{}, value...)
	return nil
}

// RemovePackage implements KVStore.
func (s *MemoryKV) RemovePackage(_ context.Context, packageID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.values, packageID)
	return nil
}

// PostgresKV is the production KVStore over external_plugin_kv.
type PostgresKV struct {
	pool *pgxpool.Pool
}

// NewPostgresKV returns a store over the pool.
func NewPostgresKV(pool *pgxpool.Pool) *PostgresKV {
	return &PostgresKV{pool: pool}
}

// Get implements KVStore. One organization per installation, so reads
// filter by package alone, matching the installer.
func (s *PostgresKV) Get(ctx context.Context, packageID, key string) ([]byte, error) {
	if len(key) == 0 || len(key) > MaxKVKeyBytes {
		return nil, errors.New("wasm: storage key must hold 1 to 128 bytes")
	}
	var value []byte
	err := s.pool.QueryRow(ctx,
		`SELECT value FROM external_plugin_kv WHERE package_id = $1 AND key = $2`,
		packageID, key).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrKVNotFound
	}
	if err != nil {
		return nil, err
	}
	return value, nil
}

// Set implements KVStore. The quota check and the upsert share one
// transaction with a package lock, so concurrent writers cannot jointly
// exceed the per-package cap.
func (s *PostgresKV) Set(ctx context.Context, packageID, key string, value []byte) error {
	if len(key) == 0 || len(key) > MaxKVKeyBytes {
		return errors.New("wasm: storage key must hold 1 to 128 bytes")
	}
	if len(value) > MaxKVValueBytes {
		return errors.New("wasm: storage value exceeds 64 KiB")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "external_plugin_kv:"+packageID); err != nil {
		return err
	}
	var total int64
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(SUM(octet_length(value)), 0) FROM external_plugin_kv
		 WHERE package_id = $1 AND key <> $2`,
		packageID, key).Scan(&total)
	if err != nil {
		return err
	}
	if total+int64(len(value)) > MaxKVPackageBytes {
		return errors.New("wasm: package storage quota exceeded")
	}
	tag, execErr := tx.Exec(ctx,
		`INSERT INTO external_plugin_kv(organization_id, package_id, key, value, updated_at)
		 SELECT id, $1, $2, $3, now() FROM organization_settings WHERE singleton
		 ON CONFLICT (organization_id, package_id, key)
		 DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		packageID, key, value)
	if execErr != nil {
		return execErr
	}
	if tag.RowsAffected() == 0 {
		return errors.New("wasm: organization is not initialized")
	}
	return tx.Commit(ctx)
}

// RemovePackage implements KVStore.
func (s *PostgresKV) RemovePackage(ctx context.Context, packageID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM external_plugin_kv WHERE package_id = $1`, packageID)
	return err
}
