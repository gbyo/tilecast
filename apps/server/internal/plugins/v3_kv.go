package plugins

import (
	"bytes"
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/kvstore"
)

// storage.kv@1 for bundled Plugin Manifest API 3 plugins
// (docs/plugin-storage.md). The namespace is the plugin the host bound into
// the call; no input names one. The bounds, the validation, the write lock,
// and the quota are the shared ones of internal/extensions/kvstore, the
// same as the package KV of WebAssembly packages.

func kvLockName(pluginID string) string { return "plugin_kv:" + pluginID }

// KVGet reads one value. A missing key answers kvstore.ErrNotFound.
func (s *Service) KVGet(ctx context.Context, pluginID, key string) ([]byte, error) {
	if err := kvstore.CheckKey(key); err != nil {
		return nil, err
	}
	var value []byte
	err := s.db.QueryRow(ctx, `SELECT value FROM plugin_kv WHERE plugin_id=$1 AND key=$2`, pluginID, key).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, kvstore.ErrNotFound
	}
	if value == nil && err == nil {
		value = []byte{}
	}
	return value, err
}

// KVSet stores one value. The quota check and the write share one
// transaction under the namespace lock, so concurrent writers cannot
// together pass 1 MiB.
func (s *Service) KVSet(ctx context.Context, pluginID, key string, value []byte) error {
	if err := kvstore.CheckEntry(key, value); err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := kvstore.Lock(ctx, tx, kvLockName(pluginID)); err != nil {
			return err
		}
		return s.kvWrite(ctx, tx, pluginID, key, value)
	})
}

// KVCompareAndSet writes value only when the current value equals expected
// byte for byte. A nil expected means the key must not exist. The
// comparison, the quota, and the write are one transaction under the
// namespace lock. It reports whether the value was swapped; a failed
// comparison changes nothing.
func (s *Service) KVCompareAndSet(ctx context.Context, pluginID, key string, expected *[]byte, value []byte) (bool, error) {
	if err := kvstore.CheckEntry(key, value); err != nil {
		return false, err
	}
	if expected != nil && len(*expected) > kvstore.MaxValueBytes {
		return false, kvstore.ErrValueTooLarge
	}
	swapped := false
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := kvstore.Lock(ctx, tx, kvLockName(pluginID)); err != nil {
			return err
		}
		var current []byte
		err := tx.QueryRow(ctx, `SELECT value FROM plugin_kv WHERE plugin_id=$1 AND key=$2`, pluginID, key).Scan(&current)
		exists := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if exists != (expected != nil) || exists && !bytes.Equal(current, *expected) {
			return nil
		}
		if err := s.kvWrite(ctx, tx, pluginID, key, value); err != nil {
			return err
		}
		swapped = true
		return nil
	})
	return swapped, err
}

// KVDelete removes one key and reports whether it existed.
func (s *Service) KVDelete(ctx context.Context, pluginID, key string) (bool, error) {
	if err := kvstore.CheckKey(key); err != nil {
		return false, err
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM plugin_kv WHERE plugin_id=$1 AND key=$2`, pluginID, key)
	return tag.RowsAffected() > 0, err
}

func (s *Service) kvWrite(ctx context.Context, tx pgx.Tx, pluginID, key string, value []byte) error {
	var others int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(octet_length(value)),0) FROM plugin_kv WHERE plugin_id=$1 AND key<>$2`,
		pluginID, key).Scan(&others); err != nil {
		return err
	}
	if err := kvstore.CheckQuota(others, len(value)); err != nil {
		return err
	}
	if value == nil {
		value = []byte{}
	}
	_, err := tx.Exec(ctx, `INSERT INTO plugin_kv(plugin_id,key,value) VALUES($1,$2,$3)
		ON CONFLICT (plugin_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, pluginID, key, value)
	return err
}
