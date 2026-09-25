package demo

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// This file holds every direct database write Demo Mode makes. Each one sets
// state that has no creation path in Tilecast because it only ever arises from
// the passage of time or from being the disposable demo database.

// backdateContact makes a screen look like its player last reported age ago.
// Real players reach this state by going silent; a seed cannot wait for that.
func backdateContact(ctx context.Context, db *pgxpool.Pool, screen uuid.UUID, age time.Duration) error {
	_, err := db.Exec(ctx, `UPDATE screens SET
		last_connected_at=now()-$2::interval-interval '9 hours',
		last_disconnected_at=now()-$2::interval,
		last_heartbeat_at=now()-$2::interval,
		updated_at=now()-$2::interval
		WHERE id=$1`, screen, fmt.Sprintf("%d seconds", int64(age.Seconds())))
	if err != nil {
		return fmt.Errorf("set last contact for demo screen %s: %w", screen, err)
	}
	return nil
}

// markInstallation gives the new installation the fixed demo identity. The
// identity is the marker a later reset checks before it wipes anything.
func markInstallation(ctx context.Context, db *pgxpool.Pool) error {
	_, err := db.Exec(ctx, `UPDATE organization_settings SET installation_id=$1 WHERE singleton=TRUE`, InstallationID)
	return err
}

// guardDisposable refuses to touch a database that holds any installation
// other than a demo one. An empty database is safe to seed.
func guardDisposable(ctx context.Context, db *pgxpool.Pool) error {
	var installations, marked int
	err := db.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE installation_id=$1) FROM organization_settings`, InstallationID).Scan(&installations, &marked)
	if err != nil {
		return fmt.Errorf("inspect demo database: %w", err)
	}
	var users int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&users); err != nil {
		return fmt.Errorf("inspect demo database: %w", err)
	}
	if installations == 0 && users == 0 {
		return nil
	}
	if installations != 1 || marked != 1 {
		return errNotDemoDatabase
	}
	return nil
}

// isSeeded reports whether the database already holds a demo installation.
func isSeeded(ctx context.Context, db *pgxpool.Pool) (bool, error) {
	var marked bool
	err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM organization_settings WHERE installation_id=$1) AND EXISTS(SELECT 1 FROM users)`, InstallationID).Scan(&marked)
	return marked, err
}

// wipe empties every application table in one transaction, and removes the
// media files the previous dataset stored. Migration history is kept, so the
// schema is untouched. The caller must have called guardDisposable.
func wipe(ctx context.Context, db *pgxpool.Pool, storage media.Storage) error {
	keys, err := storedKeys(ctx, db)
	if err != nil {
		return err
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// Background workers hold row locks briefly; waiting for them is expected,
	// but a lock that never clears must fail the reset rather than hang it.
	if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout='15s'`); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT quote_ident(tablename) FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'goose_db_version' ORDER BY tablename`)
	if err != nil {
		return err
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if len(tables) > 0 {
		if _, err = tx.Exec(ctx, `TRUNCATE TABLE `+strings.Join(tables, ",")+` RESTART IDENTITY CASCADE`); err != nil {
			return fmt.Errorf("empty demo database: %w", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if storage != nil {
		for _, key := range keys {
			_ = storage.Delete(key)
		}
	}
	return nil
}

func storedKeys(ctx context.Context, db *pgxpool.Pool) ([]string, error) {
	rows, err := db.Query(ctx, `SELECT storage_key FROM asset_variants UNION SELECT temporary_storage_key FROM upload_sessions`)
	if err != nil {
		return nil, fmt.Errorf("list demo media files: %w", err)
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
