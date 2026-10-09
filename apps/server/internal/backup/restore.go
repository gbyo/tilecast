package backup

import (
	"compress/gzip"
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

// preRestoreSchema holds the previous database contents from schema rename
// until a restore fully succeeds. Its presence after a crash means the
// restore did not complete and the previous contents are authoritative.
const preRestoreSchema = "tilecast_prerestore"

// ErrIdentityMismatch is returned when the archive belongs to a different
// installation and the caller did not explicitly confirm.
var ErrIdentityMismatch = fmt.Errorf("archive belongs to a different installation")

// RestorePlan summarizes what a restore would do, for operator confirmation.
type RestorePlan struct {
	ArchivePath           string
	SizeBytes             int64
	Manifest              Manifest
	CurrentInstallationID string
	IdentityMismatch      bool
	CurrentSchemaVersion  int64
	BinarySchemaVersion   int64
}

// Plan inspects an archive and compares it with the current installation.
func Plan(ctx context.Context, db *pgxpool.Pool, archivePath string, limits Limits) (RestorePlan, error) {
	manifest, size, err := Inspect(ctx, archivePath, limits)
	if err != nil {
		return RestorePlan{}, err
	}
	binaryVersion, err := database.LatestMigrationVersion()
	if err != nil {
		return RestorePlan{}, err
	}
	if manifest.SchemaVersion > binaryVersion {
		return RestorePlan{}, fmt.Errorf("archive schema version %d is newer than this server supports (%d); upgrade Tilecast before restoring", manifest.SchemaVersion, binaryVersion)
	}
	plan := RestorePlan{
		ArchivePath:         archivePath,
		SizeBytes:           size,
		Manifest:            manifest,
		BinarySchemaVersion: binaryVersion,
	}
	if db != nil {
		if err := db.QueryRow(ctx, `SELECT installation_id FROM organization_settings WHERE singleton`).Scan(&plan.CurrentInstallationID); err != nil && !isMissingRelation(err) && err != pgx.ErrNoRows {
			return RestorePlan{}, fmt.Errorf("read current installation identity: %w", err)
		}
		if err := db.QueryRow(ctx, `SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY id DESC LIMIT 1`).Scan(&plan.CurrentSchemaVersion); err != nil && !isMissingRelation(err) && err != pgx.ErrNoRows {
			return RestorePlan{}, fmt.Errorf("read current schema version: %w", err)
		}
	}
	plan.IdentityMismatch = plan.CurrentInstallationID != "" && plan.CurrentInstallationID != manifest.InstallationID
	return plan, nil
}

// ApplyOptions configures a restore.
type ApplyOptions struct {
	DB                      *pgxpool.Pool
	DatabaseURL             string
	MediaRoot               string
	UpdatesRoot             string
	BackupRoot              string
	ArchivePath             string
	Build                   version.Build
	ReservedFreeBytes       int64
	Limits                  Limits
	SkipPreRestoreBackup    bool
	ConfirmIdentityMismatch bool
	Progress                func(phase string, percent int)
	Logger                  *slog.Logger
}

// ApplyResult reports a completed restore.
type ApplyResult struct {
	Manifest         Manifest
	PreRestoreBackup string
}

// Apply performs a full staged restore:
//
//  1. verify the archive end to end
//  2. create a pre-restore backup (unless skipped)
//  3. stage files beside the live roots
//  4. rebuild the database in a fresh schema while the previous contents are
//     kept under a renamed schema
//  5. activate files with atomic renames
//  6. validate, then drop the previous state; on any failure the previous
//     database and files are put back
//
// The caller is responsible for blocking traffic (maintenance mode) before
// calling Apply and for resetting connection pools afterwards.
func Apply(ctx context.Context, opts ApplyOptions) (ApplyResult, error) {
	if opts.Progress == nil {
		opts.Progress = func(string, int) {}
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}

	recovered, err := RecoverInterrupted(ctx, opts.DatabaseURL, opts.MediaRoot, opts.UpdatesRoot, opts.Logger)
	if err != nil {
		return ApplyResult{}, fmt.Errorf("recover from a previously interrupted restore: %w", err)
	}
	if recovered {
		opts.Logger.Warn("recovered a previously interrupted restore before starting")
	}

	opts.Progress("verifying_archive", 5)
	verified, err := Verify(ctx, opts.ArchivePath, opts.Limits)
	if err != nil {
		return ApplyResult{}, fmt.Errorf("archive verification failed: %w", err)
	}
	manifest := verified.Manifest

	plan, err := Plan(ctx, opts.DB, opts.ArchivePath, opts.Limits)
	if err != nil {
		return ApplyResult{}, err
	}
	if plan.IdentityMismatch && !opts.ConfirmIdentityMismatch {
		return ApplyResult{}, ErrIdentityMismatch
	}

	result := ApplyResult{Manifest: manifest}
	if !opts.SkipPreRestoreBackup {
		opts.Progress("pre_restore_backup", 15)
		preRestore, err := Create(ctx, CreateOptions{
			DB:                opts.DB,
			MediaRoot:         opts.MediaRoot,
			UpdatesRoot:       opts.UpdatesRoot,
			BackupRoot:        opts.BackupRoot,
			Kind:              KindPreRestore,
			Build:             opts.Build,
			ReservedFreeBytes: opts.ReservedFreeBytes,
			Limits:            opts.Limits,
		})
		if err != nil {
			return ApplyResult{}, fmt.Errorf("pre-restore backup failed; nothing was changed: %w", err)
		}
		result.PreRestoreBackup = preRestore.FileName
	}

	opts.Progress("staging_files", 35)
	if err := stageFiles(ctx, opts.ArchivePath, manifest, opts.MediaRoot, opts.UpdatesRoot, opts.Limits, nil); err != nil {
		cleanupStaging(opts.MediaRoot, opts.UpdatesRoot)
		return ApplyResult{}, fmt.Errorf("staging restored files failed; nothing was changed: %w", err)
	}

	opts.Progress("restoring_database", 55)
	if err := restoreDatabase(ctx, opts, manifest); err != nil {
		cleanupStaging(opts.MediaRoot, opts.UpdatesRoot)
		return ApplyResult{}, err
	}
	if err := discardInterruptedUploads(ctx, opts.DatabaseURL); err != nil {
		rollbackErr := rollbackDatabase(ctx, opts.DatabaseURL)
		cleanupStaging(opts.MediaRoot, opts.UpdatesRoot)
		if rollbackErr != nil {
			return ApplyResult{}, fmt.Errorf("discarding interrupted uploads failed (%v) and database rollback also failed: %w", err, rollbackErr)
		}
		return ApplyResult{}, fmt.Errorf("discarding interrupted uploads failed; the previous state was restored: %w", err)
	}

	opts.Progress("activating_files", 80)
	if err := activateStagedFiles(opts.MediaRoot, opts.UpdatesRoot); err != nil {
		rollbackErr := rollbackDatabase(ctx, opts.DatabaseURL)
		cleanupStaging(opts.MediaRoot, opts.UpdatesRoot)
		if rollbackErr != nil {
			return ApplyResult{}, fmt.Errorf("file activation failed (%v) and database rollback also failed: %w", err, rollbackErr)
		}
		return ApplyResult{}, fmt.Errorf("file activation failed; the previous state was restored: %w", err)
	}

	opts.Progress("validating", 90)
	if err := validateRestoredState(ctx, opts, manifest); err != nil {
		fileErr := rollbackActivatedFiles(opts.MediaRoot, opts.UpdatesRoot)
		dbErr := rollbackDatabase(ctx, opts.DatabaseURL)
		cleanupStaging(opts.MediaRoot, opts.UpdatesRoot)
		if fileErr != nil || dbErr != nil {
			return ApplyResult{}, fmt.Errorf("post-restore validation failed (%v) and rollback also reported errors (files: %v, database: %v)", err, fileErr, dbErr)
		}
		return ApplyResult{}, fmt.Errorf("post-restore validation failed; the previous state was restored: %w", err)
	}

	opts.Progress("finalizing", 96)
	if err := finalizeDatabase(ctx, opts.DatabaseURL); err != nil {
		// The restored state is active and valid; only cleanup failed.
		opts.Logger.Error("restore succeeded but dropping the pre-restore schema failed", "error", err)
	}
	finalizeActivatedFiles(opts.MediaRoot, opts.UpdatesRoot)
	opts.Progress("complete", 100)
	return result, nil
}

func cleanupStaging(mediaRoot, updatesRoot string) {
	os.RemoveAll(mediaRoot + stagingSuffix)
	os.RemoveAll(updatesRoot + stagingSuffix)
}

// restoreDatabase rebuilds the database from the archive inside a fresh
// public schema. The previous schema stays renamed until finalizeDatabase.
// discardInterruptedUploads removes restored upload sessions that were still in
// progress. The archive omits their temporary files, so resuming one would
// append to an empty file at the saved offset and corrupt the media object.
// Removing the session makes a resume fail cleanly, and the upload starts again.
func discardInterruptedUploads(ctx context.Context, databaseURL string) error {
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect to discard uploads: %w", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `DELETE FROM upload_sessions WHERE status IN ('pending','uploading','finalizing')`); err != nil {
		return fmt.Errorf("discard interrupted uploads: %w", err)
	}
	return nil
}

func restoreDatabase(ctx context.Context, opts ApplyOptions, manifest Manifest) error {
	conn, err := pgx.Connect(ctx, opts.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect for database restore: %w", err)
	}
	defer conn.Close(ctx)

	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)`, preRestoreSchema).Scan(&exists); err != nil {
		return fmt.Errorf("check for interrupted restore: %w", err)
	}
	if exists {
		return fmt.Errorf("a previous interrupted restore was found; restart the server or run recovery first")
	}

	if _, err := conn.Exec(ctx, `ALTER SCHEMA public RENAME TO `+quoteIdentifier(preRestoreSchema)); err != nil {
		return fmt.Errorf("set aside current database contents: %w", err)
	}
	if _, err := conn.Exec(ctx, `CREATE SCHEMA public`); err != nil {
		_ = rollbackDatabase(ctx, opts.DatabaseURL)
		return fmt.Errorf("create restore schema: %w", err)
	}

	if err := loadDatabaseContents(ctx, opts, manifest); err != nil {
		if rollbackErr := rollbackDatabase(ctx, opts.DatabaseURL); rollbackErr != nil {
			return fmt.Errorf("database restore failed (%v) and rollback also failed: %w", err, rollbackErr)
		}
		return fmt.Errorf("database restore failed; the previous database was restored: %w", err)
	}
	return nil
}

func loadDatabaseContents(ctx context.Context, opts ApplyOptions, manifest Manifest) error {
	if err := database.MigrateTo(ctx, opts.DatabaseURL, manifest.SchemaVersion); err != nil {
		return fmt.Errorf("rebuild schema at version %d: %w", manifest.SchemaVersion, err)
	}

	conn, err := pgx.Connect(ctx, opts.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect for data load: %w", err)
	}
	defer conn.Close(ctx)

	// The rebuilt schema must contain exactly the archived tables.
	schemaTables, err := listTableNames(ctx, conn)
	if err != nil {
		return err
	}
	manifestTables := make(map[string]TableDump, len(manifest.Database.Tables))
	for _, table := range manifest.Database.Tables {
		manifestTables[table.Name] = table
	}
	if len(schemaTables) != len(manifestTables) {
		return fmt.Errorf("rebuilt schema has %d tables but the archive lists %d", len(schemaTables), len(manifestTables))
	}
	for _, name := range schemaTables {
		if _, ok := manifestTables[name]; !ok {
			return fmt.Errorf("rebuilt schema table %s is not present in the archive", name)
		}
	}

	// Foreign keys are dropped for the bulk load (row order inside the
	// archive is arbitrary and self-referencing tables exist) and re-added
	// afterwards, which re-validates every reference. User triggers are
	// disabled so activity/audit triggers do not fire on restored rows.
	constraints, err := captureForeignKeys(ctx, conn)
	if err != nil {
		return err
	}
	for _, constraint := range constraints {
		if _, err := conn.Exec(ctx, fmt.Sprintf(`ALTER TABLE ONLY %s DROP CONSTRAINT %s`, constraint.table, quoteIdentifier(constraint.name))); err != nil {
			return fmt.Errorf("prepare bulk load (drop %s): %w", constraint.name, err)
		}
	}
	for _, name := range schemaTables {
		if _, err := conn.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s DISABLE TRIGGER USER`, quoteIdentifier(name))); err != nil {
			return fmt.Errorf("disable triggers on %s: %w", name, err)
		}
	}

	loaded := make(map[string]bool, len(manifestTables))
	_, err = walkArchive(opts.ArchivePath, opts.Limits, func(entry archiveEntry) error {
		table, ok := tableFromArchivePath(entry.Path)
		if !ok {
			return nil
		}
		dump, listed := manifestTables[table]
		if !listed {
			return fmt.Errorf("archive contains data for unknown table %s", table)
		}
		gz, err := gzip.NewReader(entry.Body)
		if err != nil {
			return fmt.Errorf("open data for table %s: %w", table, err)
		}
		copied, err := conn.PgConn().CopyFrom(ctx, gz, fmt.Sprintf(`COPY %s FROM STDIN`, quoteIdentifier(table)))
		if err != nil {
			return fmt.Errorf("load table %s: %w", table, err)
		}
		if closeErr := gz.Close(); closeErr != nil {
			return fmt.Errorf("data for table %s is corrupt: %w", table, closeErr)
		}
		if copied.RowsAffected() != dump.Rows {
			return fmt.Errorf("table %s loaded %d rows but the archive recorded %d", table, copied.RowsAffected(), dump.Rows)
		}
		loaded[table] = true
		return nil
	})
	if err != nil {
		return err
	}
	for name := range manifestTables {
		if !loaded[name] {
			return fmt.Errorf("archive is missing data for table %s", name)
		}
	}

	for _, name := range schemaTables {
		if _, err := conn.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s ENABLE TRIGGER USER`, quoteIdentifier(name))); err != nil {
			return fmt.Errorf("re-enable triggers on %s: %w", name, err)
		}
	}
	for _, constraint := range constraints {
		if _, err := conn.Exec(ctx, fmt.Sprintf(`ALTER TABLE ONLY %s ADD CONSTRAINT %s %s`, constraint.table, quoteIdentifier(constraint.name), constraint.definition)); err != nil {
			return fmt.Errorf("restored data violates constraint %s: %w", constraint.name, err)
		}
	}

	if err := restoreSequences(ctx, conn, manifest.Database.Sequences); err != nil {
		return err
	}

	// Existing browser sessions must not survive a restore.
	if _, err := conn.Exec(ctx, `DELETE FROM sessions`); err != nil {
		return fmt.Errorf("invalidate browser sessions: %w", err)
	}

	// Bring the restored data forward to this binary's schema.
	if err := database.Migrate(ctx, opts.DatabaseURL); err != nil {
		return fmt.Errorf("migrate restored database to the current version: %w", err)
	}

	// Confirm the restored identity matches the archive.
	var installationID string
	if err := conn.QueryRow(ctx, `SELECT installation_id FROM organization_settings WHERE singleton`).Scan(&installationID); err != nil {
		return fmt.Errorf("restored database has no installation identity: %w", err)
	}
	if installationID != manifest.InstallationID {
		return fmt.Errorf("restored installation identity does not match the archive")
	}
	return nil
}

type foreignKey struct {
	table      string
	name       string
	definition string
}

func captureForeignKeys(ctx context.Context, conn *pgx.Conn) ([]foreignKey, error) {
	rows, err := conn.Query(ctx, `SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace ORDER BY conname`)
	if err != nil {
		return nil, fmt.Errorf("list foreign keys: %w", err)
	}
	defer rows.Close()
	var constraints []foreignKey
	for rows.Next() {
		var fk foreignKey
		if err := rows.Scan(&fk.table, &fk.name, &fk.definition); err != nil {
			return nil, fmt.Errorf("scan foreign key: %w", err)
		}
		constraints = append(constraints, fk)
	}
	return constraints, rows.Err()
}

func listTableNames(ctx context.Context, conn *pgx.Conn) ([]string, error) {
	rows, err := conn.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'goose_db_version' ORDER BY tablename`)
	if err != nil {
		return nil, fmt.Errorf("list restored tables: %w", err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		tables = append(tables, name)
	}
	return tables, rows.Err()
}

func restoreSequences(ctx context.Context, conn *pgx.Conn, sequences []SequenceState) error {
	existing := make(map[string]bool)
	rows, err := conn.Query(ctx, `SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`)
	if err != nil {
		return fmt.Errorf("list restored sequences: %w", err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		existing[name] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, sequence := range sequences {
		if !existing[sequence.Name] {
			continue
		}
		if _, err := conn.Exec(ctx, `SELECT setval(quote_ident($1)::regclass, $2, $3)`, sequence.Name, sequence.Value, sequence.IsCalled); err != nil {
			return fmt.Errorf("restore sequence %s: %w", sequence.Name, err)
		}
	}
	return nil
}

// rollbackDatabase drops the partially-restored public schema and renames
// the previous contents back into place.
func rollbackDatabase(ctx context.Context, databaseURL string) error {
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect for database rollback: %w", err)
	}
	defer conn.Close(ctx)
	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)`, preRestoreSchema).Scan(&exists); err != nil {
		return fmt.Errorf("check rollback state: %w", err)
	}
	if !exists {
		return fmt.Errorf("no pre-restore database contents were found to roll back to")
	}
	if _, err := conn.Exec(ctx, `DROP SCHEMA IF EXISTS public CASCADE`); err != nil {
		return fmt.Errorf("drop partial restore: %w", err)
	}
	if _, err := conn.Exec(ctx, `ALTER SCHEMA `+quoteIdentifier(preRestoreSchema)+` RENAME TO public`); err != nil {
		return fmt.Errorf("restore previous database contents: %w", err)
	}
	return nil
}

func finalizeDatabase(ctx context.Context, databaseURL string) error {
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect to finalize restore: %w", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `DROP SCHEMA IF EXISTS `+quoteIdentifier(preRestoreSchema)+` CASCADE`); err != nil {
		return fmt.Errorf("drop pre-restore schema: %w", err)
	}
	return nil
}

// validateRestoredState checks the activated database and files: database
// reachable, expected row counts, identity present, storage writable.
func validateRestoredState(ctx context.Context, opts ApplyOptions, manifest Manifest) error {
	conn, err := pgx.Connect(ctx, opts.DatabaseURL)
	if err != nil {
		return fmt.Errorf("restored database is unreachable: %w", err)
	}
	defer conn.Close(ctx)
	if err := conn.Ping(ctx); err != nil {
		return fmt.Errorf("restored database does not respond: %w", err)
	}
	var installationID string
	if err := conn.QueryRow(ctx, `SELECT installation_id FROM organization_settings WHERE singleton`).Scan(&installationID); err != nil {
		return fmt.Errorf("restored database is missing its installation identity: %w", err)
	}
	if installationID != manifest.InstallationID {
		return fmt.Errorf("restored installation identity does not match the archive")
	}
	return validateRestoredFiles(opts.MediaRoot, opts.UpdatesRoot)
}

// RecoverInterrupted rolls back the database and file state left behind by a
// restore that crashed mid-way. The pre-restore schema (and .pre-restore
// directories) only exist while a restore is incomplete, so their presence
// means the previous state is authoritative.
func RecoverInterrupted(ctx context.Context, databaseURL, mediaRoot, updatesRoot string, logger *slog.Logger) (bool, error) {
	if logger == nil {
		logger = slog.Default()
	}
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return false, fmt.Errorf("connect for restore recovery: %w", err)
	}
	defer conn.Close(ctx)
	var pending bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)`, preRestoreSchema).Scan(&pending); err != nil {
		return false, fmt.Errorf("check for interrupted restore: %w", err)
	}
	if pending {
		logger.Warn("found an interrupted restore; rolling back to the previous state")
		if err := rollbackDatabase(ctx, databaseURL); err != nil {
			return false, err
		}
		if err := rollbackActivatedFiles(mediaRoot, updatesRoot); err != nil {
			return true, fmt.Errorf("database was rolled back but file rollback failed: %w", err)
		}
		cleanupStaging(mediaRoot, updatesRoot)
		return true, nil
	}
	// No pending database swap: any leftover directories belong to a restore
	// that fully committed (or staging that never activated) and are safe to
	// clear.
	finalizeActivatedFiles(mediaRoot, updatesRoot)
	return false, nil
}

func isMissingRelation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "42P01")
}
