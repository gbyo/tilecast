package database

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse pool config: %w", err)
	}

	// google/uuid slices are not registered by pgx automatically. Deployment
	// target queries pass []uuid.UUID to ANY($n), so register the PostgreSQL
	// uuid[] type before each pooled connection is used.
	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		conn.TypeMap().RegisterDefaultPgType([]uuid.UUID{}, "_uuid")
		return nil
	}

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

func Migrate(ctx context.Context, databaseURL string) error {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open migration connection: %w", err)
	}
	defer db.Close()

	// Migration 00111 removes invalid micro-sessions from playback_sessions.
	// That table has a self-referencing ON DELETE SET NULL foreign key, and
	// installations created before the supporting parent-session index can
	// otherwise spend minutes rescanning the table for every deleted row. The
	// migration has shipped and is immutable, so repair the missing support
	// index before Goose reaches it. Run the same repair after migration so a
	// fresh installation also receives the index once the table exists.
	if err := ensurePlaybackParentIndex(ctx, db); err != nil {
		return err
	}
	if err := useCatalog(); err != nil {
		return err
	}
	if err := goose.UpContext(ctx, db, migrationDir); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	if err := ensurePlaybackParentIndex(ctx, db); err != nil {
		return err
	}
	return nil
}

func ensurePlaybackParentIndex(ctx context.Context, db *sql.DB) error {
	const statement = `
DO $
BEGIN
	IF to_regclass('public.playback_sessions') IS NOT NULL THEN
		EXECUTE 'CREATE INDEX IF NOT EXISTS playback_sessions_parent_session_idx ON playback_sessions(parent_session_id)';
	END IF;
END
$;`
	if _, err := db.ExecContext(ctx, statement); err != nil {
		return fmt.Errorf("ensure playback parent-session index: %w", err)
	}
	return nil
}

// MigrateTo applies embedded migrations up to and including the given version.
// Restore uses it to rebuild the schema exactly as it was when a backup was
// created before loading the archived data.
func MigrateTo(ctx context.Context, databaseURL string, version int64) error {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open migration connection: %w", err)
	}
	defer db.Close()

	if err := useCatalog(); err != nil {
		return err
	}
	if err := goose.UpToContext(ctx, db, migrationDir, version); err != nil {
		return fmt.Errorf("apply migrations to version %d: %w", version, err)
	}
	return nil
}

// useCatalog points Goose at the combined core and plugin migrations.
func useCatalog() error {
	fsys, err := migrationFS()
	if err != nil {
		return fmt.Errorf("assemble migrations: %w", err)
	}
	goose.SetBaseFS(fsys)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set migration dialect: %w", err)
	}
	return nil
}

// LatestMigrationVersion reports the newest migration version embedded in
// this binary, core and plugin migrations alike.
func LatestMigrationVersion() (int64, error) {
	if err := useCatalog(); err != nil {
		return 0, err
	}
	files, err := goose.CollectMigrations(migrationDir, 0, goose.MaxVersion)
	if err != nil {
		return 0, fmt.Errorf("collect migrations: %w", err)
	}
	if len(files) == 0 {
		return 0, fmt.Errorf("no embedded migrations found")
	}
	return files[len(files)-1].Version, nil
}
