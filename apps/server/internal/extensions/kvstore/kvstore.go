// Package kvstore holds the rules every Tilecast plugin key/value store
// shares: the bounds, the validation, the write serialization of one
// namespace, and the quota arithmetic. The package KV of WebAssembly
// packages (external_plugin_kv) and storage.kv@1 of bundled Plugin Manifest
// API 3 plugins (plugin_kv) both use it, so the limits cannot drift apart.
package kvstore

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Bounds of one namespace.
const (
	// MaxKeyBytes caps one key, in bytes.
	MaxKeyBytes = 128
	// MaxValueBytes caps one value at 64 KiB.
	MaxValueBytes = 64 << 10
	// MaxNamespaceBytes caps the live values of one namespace at 1 MiB.
	MaxNamespaceBytes = 1 << 20
)

var (
	// ErrNotFound answers a read of a key the namespace does not hold.
	ErrNotFound = errors.New("storage key not found")
	// ErrInvalidKey refuses an empty key or one longer than MaxKeyBytes.
	ErrInvalidKey = errors.New("a storage key holds 1 to 128 bytes")
	// ErrValueTooLarge refuses a value over MaxValueBytes.
	ErrValueTooLarge = errors.New("a storage value holds at most 64 KiB")
	// ErrQuotaExceeded refuses a write that would take the namespace over
	// MaxNamespaceBytes.
	ErrQuotaExceeded = errors.New("the storage quota of 1 MiB is exceeded")
)

// CheckKey validates a key.
func CheckKey(key string) error {
	if len(key) == 0 || len(key) > MaxKeyBytes {
		return ErrInvalidKey
	}
	return nil
}

// CheckEntry validates a key and a value.
func CheckEntry(key string, value []byte) error {
	if err := CheckKey(key); err != nil {
		return err
	}
	if len(value) > MaxValueBytes {
		return ErrValueTooLarge
	}
	return nil
}

// CheckQuota reports whether a namespace whose other keys hold others bytes
// can store a value of n bytes.
func CheckQuota(others int64, n int) error {
	if others+int64(n) > MaxNamespaceBytes {
		return ErrQuotaExceeded
	}
	return nil
}

// Lock serializes the writers of one namespace until tx ends. A writer
// takes the lock before it sums the namespace, so two concurrent writers
// cannot each see room and together pass the quota. name must be unique
// across stores, for example "external_plugin_kv:<package>".
func Lock(ctx context.Context, tx pgx.Tx, name string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, name)
	return err
}
