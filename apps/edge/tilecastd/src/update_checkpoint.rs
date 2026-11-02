//! Verified pre-update state checkpoints (Phase 2 of the Edge production
//! readiness plan).
//!
//! A candidate release migrates `state.db` forward on its first boot. When
//! the candidate then rolls back, the previous daemon refuses the newer
//! schema and the screen sits in recovery mode with no playback. This module
//! closes that gap without touching the root helper or adding reverse
//! migrations:
//!
//! 1. Before the coordinator asks for activation of a release whose state
//!    schema is newer than this database, it writes a verified checkpoint:
//!    a `VACUUM INTO` copy of `state.db` plus a manifest with its SHA-256.
//! 2. When the previous daemon finds a newer schema after a rollback, it
//!    verifies the checkpoint, extracts the facts the candidate wrote after
//!    the checkpoint (completed commands, queued outbox rows, the activity
//!    sequence watermark, renderer supervision) from the newer database with
//!    explicit old-schema column lists, restores the checkpoint over
//!    `state.db`, and replays those facts in one transaction.
//! 3. The newer database is kept aside as `state-migrated-backup.db` and the
//!    checkpoint as `state-preupdate-backup.db`, so an operator keeps a
//!    manual recovery path. A `restore-intent.json` marker makes a restore
//!    that crashes partway redo cleanly at the next boot.
//!
//! Anything that cannot be proven safe fails closed into recovery mode with
//! an explicit reason: a missing or corrupt checkpoint, a checkpoint for a
//! different schema, or a newer database whose command, outbox or renderer
//! tables no longer match the old column lists (a future migration that
//! renames those tables is the documented case where automatic recovery
//! cannot work). A restore never re-executes a command: completed and
//! executing rows come back with their terminal state, and normal startup
//! recovery converts restored `executing` rows to `command_interrupted`.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use edge_protocol::digest::{Sha256Digest, Sha256Hasher};
use edge_state::repo::renderer::RendererRecord;
use rusqlite::{Connection, OpenFlags};

const MANIFEST_FORMAT: u32 = 1;
const MANIFEST_NAME: &str = "manifest.json";
const CHECKPOINT_NAME: &str = "checkpoint.db";
const INTENT_NAME: &str = "restore-intent.json";
const PREUPDATE_BACKUP_NAME: &str = "state-preupdate-backup.db";
const MIGRATED_BACKUP_NAME: &str = "state-migrated-backup.db";
/// The repository bounds, mirrored so a hostile newer database cannot make
/// the restore allocate without limit.
const MAX_COMMAND_ROWS: usize = 5_000;
const MAX_OUTBOX_ROWS: usize = 500;

/// Recovery reason codes. [`crate::daemon::StateMode::Recovery`] carries a
/// `&'static str`, so these are constants.
pub const REASON_CHECKPOINT_MISSING: &str = "update_checkpoint_missing";
pub const REASON_CHECKPOINT_CORRUPT: &str = "update_checkpoint_corrupt";
pub const REASON_CHECKPOINT_SCHEMA_MISMATCH: &str = "update_checkpoint_schema_mismatch";
pub const REASON_DELTA_INCOMPATIBLE: &str = "update_delta_incompatible";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointError {
    /// No checkpoint exists for this database.
    Missing,
    /// The checkpoint or its manifest fails verification.
    Corrupt,
    /// The checkpoint is for a different schema than this build supports.
    SchemaMismatch { found: u32, supported: u32 },
    /// The newer database changed a table the restore reads.
    DeltaIncompatible,
    /// The disk cannot hold the checkpoint.
    InsufficientSpace,
    /// Any other I/O or database failure.
    Io,
}

impl CheckpointError {
    pub fn reason_code(self) -> &'static str {
        match self {
            Self::Missing => REASON_CHECKPOINT_MISSING,
            Self::Corrupt => REASON_CHECKPOINT_CORRUPT,
            Self::SchemaMismatch { .. } => REASON_CHECKPOINT_SCHEMA_MISMATCH,
            Self::DeltaIncompatible => REASON_DELTA_INCOMPATIBLE,
            Self::InsufficientSpace => "insufficient_disk",
            Self::Io => "state_db_query_failed",
        }
    }
}

/// Whether the coordinator must checkpoint before activating a release.
/// A checkpoint is needed exactly when the candidate would advance the
/// database past what this build (the rollback target) can open.
pub fn needs_checkpoint(candidate_schema: u32, current_schema: u32) -> bool {
    candidate_schema > current_schema
}

#[derive(Debug, Clone)]
pub struct CheckpointPaths {
    pub dir: PathBuf,
    pub db: PathBuf,
    pub manifest: PathBuf,
    pub intent: PathBuf,
}

pub fn checkpoint_paths(state_dir: &Path) -> CheckpointPaths {
    let dir = state_dir.join("update-checkpoint");
    CheckpointPaths {
        db: dir.join(CHECKPOINT_NAME),
        manifest: dir.join(MANIFEST_NAME),
        intent: dir.join(INTENT_NAME),
        dir,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointManifest {
    format: u32,
    db_schema: u32,
    created_by_version: String,
    candidate_version: String,
    checkpoint_sha256: String,
    created_at_ms: i64,
}

fn quote_path(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    if !text.is_empty() && text.len() <= 4096 { Some(text.replace('\'', "''")) } else { None }
}

fn hash_file(path: &Path) -> std::io::Result<Sha256Digest> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256Hasher::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finish())
}

fn sync_dir(dir: &Path) -> std::io::Result<()> {
    File::open(dir)?.sync_all()
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Some(parent) = path.parent() {
        sync_dir(parent)?;
    }
    Ok(())
}

fn schema_of(connection: &Connection) -> rusqlite::Result<u32> {
    let version: Option<u32> =
        connection.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get(0))?;
    Ok(version.unwrap_or(0))
}

fn integrity_ok(path: &Path) -> bool {
    let Ok(connection) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0)).is_ok_and(|result| result == "ok")
}

/// Creates (or replaces) the verified pre-update checkpoint of the open
/// database. The caller passes the schema the coordinator observed and the
/// candidate release identity. `VACUUM INTO` copies a WAL database into one
/// clean file while this process keeps serving reads.
pub async fn create_checkpoint(
    db: &edge_state::StateDb,
    state_dir: &Path,
    own_version: &str,
    candidate_version: &str,
    current_schema: u32,
    now_ms: i64,
) -> Result<(), CheckpointError> {
    let paths = checkpoint_paths(state_dir);
    fs::create_dir_all(&paths.dir).map_err(|_| CheckpointError::Io)?;
    let _ = fs::set_permissions(&paths.dir, fs::Permissions::from_mode(0o700));
    let tmp = paths.dir.join("checkpoint.db.tmp");
    let _ = fs::remove_file(&tmp);
    let Some(quoted) = quote_path(&tmp) else { return Err(CheckpointError::Io) };
    let statement = format!("VACUUM INTO '{quoted}'");
    db.run(move |connection| {
        connection.execute_batch(&statement).map_err(|source| match source {
            rusqlite::Error::SqliteFailure(error, _) if error.code == rusqlite::ErrorCode::DiskFull => {
                edge_state::StateError::InvalidValue("checkpoint disk full".into())
            }
            other => edge_state::StateError::Sql(other),
        })
    })
    .await
    .map_err(|error| match error {
        edge_state::StateError::InvalidValue(_) => CheckpointError::InsufficientSpace,
        _ => CheckpointError::Io,
    })?;
    let digest = hash_file(&tmp).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        if error.kind() == std::io::ErrorKind::StorageFull {
            CheckpointError::InsufficientSpace
        } else {
            CheckpointError::Io
        }
    })?;
    // Verify the copy before it becomes the checkpoint: it must open clean
    // and carry exactly the schema we run.
    if !integrity_ok(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(CheckpointError::Io);
    }
    let copied_schema = Connection::open_with_flags(&tmp, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .ok()
        .and_then(|connection| schema_of(&connection).ok());
    if copied_schema != Some(current_schema) {
        let _ = fs::remove_file(&tmp);
        return Err(CheckpointError::Io);
    }
    let manifest = CheckpointManifest {
        format: MANIFEST_FORMAT,
        db_schema: current_schema,
        created_by_version: own_version.chars().take(128).collect(),
        candidate_version: candidate_version.chars().take(128).collect(),
        checkpoint_sha256: digest.to_hex(),
        created_at_ms: now_ms,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|_| CheckpointError::Io)?;
    fs::rename(&tmp, &paths.db).map_err(|_| CheckpointError::Io)?;
    let _ = fs::set_permissions(&paths.db, fs::Permissions::from_mode(0o600));
    if let Err(error) = write_private(&paths.manifest, &bytes) {
        let _ = fs::remove_file(&paths.db);
        return Err(if error.kind() == std::io::ErrorKind::StorageFull {
            CheckpointError::InsufficientSpace
        } else {
            CheckpointError::Io
        });
    }
    tracing::info!(
        component = "update",
        event = "checkpoint_created",
        schema = current_schema,
        candidate = candidate_version
    );
    Ok(())
}

fn read_manifest(state_dir: &Path) -> Result<CheckpointManifest, CheckpointError> {
    let paths = checkpoint_paths(state_dir);
    let bytes = fs::read(&paths.manifest).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => CheckpointError::Missing,
        _ => CheckpointError::Corrupt,
    })?;
    if bytes.len() > 4096 {
        return Err(CheckpointError::Corrupt);
    }
    let manifest: CheckpointManifest = serde_json::from_slice(&bytes).map_err(|_| CheckpointError::Corrupt)?;
    if manifest.format != MANIFEST_FORMAT
        || manifest.created_by_version.is_empty()
        || manifest.created_by_version.len() > 128
        || manifest.candidate_version.is_empty()
        || manifest.candidate_version.len() > 128
        || Sha256Digest::parse(&manifest.checkpoint_sha256).is_err()
    {
        return Err(CheckpointError::Corrupt);
    }
    Ok(manifest)
}

/// Verifies the checkpoint against its manifest for a build that supports
/// `supported`. Any failure names its reason; nothing is changed.
pub fn verify_checkpoint(state_dir: &Path, supported: u32) -> Result<(), CheckpointError> {
    let manifest = read_manifest(state_dir)?;
    if manifest.db_schema != supported {
        return Err(CheckpointError::SchemaMismatch { found: manifest.db_schema, supported });
    }
    let paths = checkpoint_paths(state_dir);
    let digest = hash_file(&paths.db).map_err(|_| CheckpointError::Corrupt)?;
    if digest.to_hex() != manifest.checkpoint_sha256 {
        return Err(CheckpointError::Corrupt);
    }
    if !integrity_ok(&paths.db) {
        return Err(CheckpointError::Corrupt);
    }
    let schema = Connection::open_with_flags(&paths.db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .ok()
        .and_then(|connection| schema_of(&connection).ok());
    if schema != Some(supported) {
        return Err(CheckpointError::Corrupt);
    }
    Ok(())
}

/// Deletes the checkpoint after confirmation, or a stale one from an older
/// release. Best effort: a leftover checkpoint can never trigger a restore
/// while the database opens at a supported schema.
pub fn consume_checkpoint(state_dir: &Path) {
    let paths = checkpoint_paths(state_dir);
    let _ = fs::remove_file(&paths.db);
    let _ = fs::remove_file(&paths.manifest);
    let _ = fs::remove_dir(&paths.dir);
}

/// Deletes a checkpoint written by an older release. The daemon calls this
/// on a healthy boot so a leftover from a confirmed update never lingers.
/// A checkpoint for the current schema is kept: an activation may be in
/// progress, or a rollback may still need it.
pub fn prune_stale_checkpoint(state_dir: &Path, supported: u32) {
    match read_manifest(state_dir) {
        Ok(manifest) if manifest.db_schema < supported => consume_checkpoint(state_dir),
        _ => {}
    }
}

// ---- delta extraction ------------------------------------------------------

/// One post-checkpoint command fact, read with the old column list.
struct DeltaCommand {
    key: String,
    command_id: Option<String>,
    command_type: String,
    state: String,
    success: Option<i64>,
    code: Option<String>,
    message: Option<String>,
    report_state: String,
    received_at_ms: i64,
    acknowledged_at_ms: Option<i64>,
    executing_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
}

struct DeltaOutboxRow {
    kind: String,
    event_id: String,
    body: String,
    created_at_ms: i64,
    attempts: i64,
}

struct DeltaOutboxState {
    next_sequence: i64,
    dropped_activity: i64,
    dropped_telemetry: i64,
    rejected: i64,
    expired: i64,
    reported_dropped_activity: i64,
    open_sessions: Option<String>,
    updated_at_ms: i64,
}

struct Delta {
    commands: Vec<DeltaCommand>,
    outbox_rows: Vec<DeltaOutboxRow>,
    outbox_state: DeltaOutboxState,
    renderer: RendererRecord,
}

fn bounded_text(value: String, min: usize, max: usize) -> Result<String, CheckpointError> {
    if value.len() < min || value.len() > max {
        return Err(CheckpointError::DeltaIncompatible);
    }
    Ok(value)
}

/// Reads the facts the candidate wrote after the checkpoint from the newer
/// database, without migrating it. Explicit old-schema column lists keep a
/// future migration that renames these tables a clean abort instead of a
/// corrupt replay.
fn extract_delta(newer_db: &Path) -> Result<Delta, CheckpointError> {
    let connection = Connection::open_with_flags(newer_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| CheckpointError::DeltaIncompatible)?;
    let mut commands = Vec::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT idempotency_key, command_id, command_type, state, success, result_code,
                        result_message, report_state, received_at_ms, acknowledged_at_ms,
                        executing_at_ms, completed_at_ms
                 FROM player_commands WHERE state IN ('executing', 'completed') LIMIT ?1",
            )
            .map_err(|_| CheckpointError::DeltaIncompatible)?;
        let rows = statement
            .query_map([MAX_COMMAND_ROWS as i64], |row| {
                Ok(DeltaCommand {
                    key: row.get(0)?,
                    command_id: row.get(1)?,
                    command_type: row.get(2)?,
                    state: row.get(3)?,
                    success: row.get(4)?,
                    code: row.get(5)?,
                    message: row.get(6)?,
                    report_state: row.get(7)?,
                    received_at_ms: row.get(8)?,
                    acknowledged_at_ms: row.get(9)?,
                    executing_at_ms: row.get(10)?,
                    completed_at_ms: row.get(11)?,
                })
            })
            .map_err(|_| CheckpointError::DeltaIncompatible)?;
        for row in rows {
            let command = row.map_err(|_| CheckpointError::DeltaIncompatible)?;
            bounded_text(command.key.clone(), 1, 128)?;
            bounded_text(command.command_type.clone(), 1, 64)?;
            if !matches!(command.state.as_str(), "executing" | "completed") {
                return Err(CheckpointError::DeltaIncompatible);
            }
            if !matches!(command.report_state.as_str(), "none" | "pending" | "reported" | "abandoned" | "not_required")
            {
                return Err(CheckpointError::DeltaIncompatible);
            }
            if let Some(id) = &command.command_id
                && (id.len() != 36 || uuid::Uuid::parse_str(id).is_err())
            {
                return Err(CheckpointError::DeltaIncompatible);
            }
            commands.push(command);
            if commands.len() > MAX_COMMAND_ROWS {
                return Err(CheckpointError::DeltaIncompatible);
            }
        }
    }
    let mut outbox_rows = Vec::new();
    {
        let mut statement = connection
            .prepare("SELECT kind, event_id, body, created_at_ms, attempts FROM outbox ORDER BY id LIMIT ?1")
            .map_err(|_| CheckpointError::DeltaIncompatible)?;
        let rows = statement
            .query_map([MAX_OUTBOX_ROWS as i64], |row| {
                Ok(DeltaOutboxRow {
                    kind: row.get(0)?,
                    event_id: row.get(1)?,
                    body: row.get(2)?,
                    created_at_ms: row.get(3)?,
                    attempts: row.get(4)?,
                })
            })
            .map_err(|_| CheckpointError::DeltaIncompatible)?;
        for row in rows {
            let report = row.map_err(|_| CheckpointError::DeltaIncompatible)?;
            if !matches!(report.kind.as_str(), "activity_event" | "telemetry_sample") {
                return Err(CheckpointError::DeltaIncompatible);
            }
            bounded_text(report.event_id.clone(), 36, 36)?;
            bounded_text(report.body.clone(), 2, 65536)?;
            outbox_rows.push(report);
            if outbox_rows.len() > MAX_OUTBOX_ROWS {
                return Err(CheckpointError::DeltaIncompatible);
            }
        }
    }
    let outbox_state = connection
        .query_row(
            "SELECT next_sequence, dropped_activity, dropped_telemetry, rejected, expired,
                    reported_dropped_activity, open_sessions, updated_at_ms
             FROM outbox_state WHERE singleton = 1",
            [],
            |row| {
                Ok(DeltaOutboxState {
                    next_sequence: row.get(0)?,
                    dropped_activity: row.get(1)?,
                    dropped_telemetry: row.get(2)?,
                    rejected: row.get(3)?,
                    expired: row.get(4)?,
                    reported_dropped_activity: row.get(5)?,
                    open_sessions: row.get(6)?,
                    updated_at_ms: row.get(7)?,
                })
            },
        )
        .map_err(|_| CheckpointError::DeltaIncompatible)?;
    if outbox_state.next_sequence < 1 {
        return Err(CheckpointError::DeltaIncompatible);
    }
    if outbox_state.open_sessions.as_ref().is_some_and(|sessions| sessions.len() > 16384) {
        return Err(CheckpointError::DeltaIncompatible);
    }
    let renderer = edge_state::repo::renderer::get(&connection).map_err(|_| CheckpointError::DeltaIncompatible)?;
    Ok(Delta { commands, outbox_rows, outbox_state, renderer })
}

/// Replays an extracted delta onto the restored database in one
/// transaction. The replay is idempotent: command rows converge on the
/// newer values, outbox rows insert once by event ID, watermarks take the
/// maximum, and supervision takes the newer row.
fn replay_delta(connection: &Connection, delta: &Delta) -> rusqlite::Result<()> {
    let tx = connection.unchecked_transaction()?;
    {
        let mut insert = tx.prepare(
            "INSERT OR IGNORE INTO player_commands (idempotency_key, command_id, command_type, state,
                                                   report_state, received_at_ms)
             VALUES (?1, ?2, ?3, 'received', 'none', ?4)",
        )?;
        let mut converge = tx.prepare(
            "UPDATE player_commands SET command_id = ?2, state = ?3, success = ?4, result_code = ?5,
                 result_message = ?6, report_state = ?7, acknowledged_at_ms = ?8, executing_at_ms = ?9,
                 completed_at_ms = ?10
             WHERE idempotency_key = ?1",
        )?;
        for command in &delta.commands {
            insert.execute(rusqlite::params![
                command.key,
                command.command_id,
                command.command_type,
                command.received_at_ms
            ])?;
            converge.execute(rusqlite::params![
                command.key,
                command.command_id,
                command.state,
                command.success,
                command.code,
                command.message,
                command.report_state,
                command.acknowledged_at_ms,
                command.executing_at_ms,
                command.completed_at_ms
            ])?;
        }
    }
    {
        let mut insert = tx.prepare(
            "INSERT OR IGNORE INTO outbox (kind, event_id, body, created_at_ms, attempts)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for report in &delta.outbox_rows {
            insert.execute(rusqlite::params![
                report.kind,
                report.event_id,
                report.body,
                report.created_at_ms,
                report.attempts
            ])?;
        }
    }
    let outbox = &delta.outbox_state;
    tx.execute(
        "UPDATE outbox_state SET next_sequence = MAX(next_sequence, ?1),
             dropped_activity = MAX(dropped_activity, ?2),
             dropped_telemetry = MAX(dropped_telemetry, ?3),
             rejected = MAX(rejected, ?4), expired = MAX(expired, ?5),
             reported_dropped_activity = MAX(reported_dropped_activity, ?6),
             open_sessions = ?7, updated_at_ms = MAX(updated_at_ms, ?8)
         WHERE singleton = 1",
        rusqlite::params![
            outbox.next_sequence,
            outbox.dropped_activity,
            outbox.dropped_telemetry,
            outbox.rejected,
            outbox.expired,
            outbox.reported_dropped_activity,
            outbox.open_sessions,
            outbox.updated_at_ms
        ],
    )?;
    let renderer = &delta.renderer;
    tx.execute(
        "INSERT INTO renderer_state (id, last_ready_at_ms, last_progress_at_ms, restart_count,
                                     last_error_code, safe_mode, safe_mode_reason, updated_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET last_ready_at_ms = excluded.last_ready_at_ms,
             last_progress_at_ms = excluded.last_progress_at_ms,
             restart_count = excluded.restart_count,
             last_error_code = excluded.last_error_code, safe_mode = excluded.safe_mode,
             safe_mode_reason = excluded.safe_mode_reason, updated_at_ms = excluded.updated_at_ms",
        rusqlite::params![
            renderer.last_ready_at.map(|t| t.unix_millis()),
            renderer.last_progress_at.map(|t| t.unix_millis()),
            renderer.restart_count as i64,
            renderer.last_error_code,
            i64::from(renderer.safe_mode),
            renderer.safe_mode_reason,
            outbox.updated_at_ms,
        ],
    )?;
    tx.commit()
}

// ---- restore ---------------------------------------------------------------

fn write_intent(paths: &CheckpointPaths) -> Result<(), CheckpointError> {
    write_private(&paths.intent, b"{\"restore\":1}").map_err(|_| CheckpointError::Io)
}

/// Restores the verified checkpoint over a newer `state.db` and replays the
/// newer database's post-checkpoint facts. The caller retries opening the
/// database afterwards. The procedure is redo-safe: a crash before cleanup
/// reruns the whole restore from the intact checkpoint at the next boot.
pub fn restore_checkpoint(state_dir: &Path, supported: u32) -> Result<(), CheckpointError> {
    restore_inner(state_dir, supported, EdgeFileSystem)
}

trait FileSystem {
    fn copy(&self, from: &Path, to: &Path) -> std::io::Result<u64>;
}

struct EdgeFileSystem;

impl FileSystem for EdgeFileSystem {
    fn copy(&self, from: &Path, to: &Path) -> std::io::Result<u64> {
        fs::copy(from, to)
    }
}

fn restore_inner(state_dir: &Path, supported: u32, files: impl FileSystem) -> Result<(), CheckpointError> {
    verify_checkpoint(state_dir, supported)?;
    let paths = checkpoint_paths(state_dir);
    let state_db = state_dir.join("state.db");
    // The delta is extracted before anything moves: an incompatible newer
    // database aborts with every file untouched.
    let delta = extract_delta(&state_db)?;
    write_intent(&paths)?;
    // Set the newer database aside first, so a crash always leaves either
    // the newer database or the restored one, never neither.
    let migrated_backup = state_dir.join(MIGRATED_BACKUP_NAME);
    let _ = fs::remove_file(&migrated_backup);
    fs::rename(&state_db, &migrated_backup).map_err(|_| CheckpointError::Io)?;
    let _ = fs::remove_file(state_dir.join("state.db-wal"));
    let _ = fs::remove_file(state_dir.join("state.db-shm"));
    if let Err(error) = files.copy(&paths.db, &state_db) {
        // Best effort to put the newer database back; the intent marker
        // reruns the restore either way.
        let _ = fs::rename(&migrated_backup, &state_db);
        return Err(if error.kind() == std::io::ErrorKind::StorageFull {
            CheckpointError::InsufficientSpace
        } else {
            CheckpointError::Io
        });
    }
    let _ = fs::set_permissions(&state_db, fs::Permissions::from_mode(0o600));
    if File::open(&state_db).and_then(|file| file.sync_all()).is_err() {
        return Err(CheckpointError::Io);
    }
    if sync_dir(state_dir).is_err() {
        return Err(CheckpointError::Io);
    }
    let restored = edge_state::open_connection(&state_db, edge_state::OpenOptions::default())
        .map_err(|_| CheckpointError::Corrupt)?;
    replay_delta(&restored, &delta).map_err(|_| CheckpointError::DeltaIncompatible)?;
    drop(restored);
    // Consume the checkpoint last: the pre-update copy stays for manual
    // recovery, the manifest goes so this checkpoint never restores again,
    // and the intent goes last so a crash replays idempotently.
    let preupdate_backup = state_dir.join(PREUPDATE_BACKUP_NAME);
    let _ = fs::remove_file(&preupdate_backup);
    if fs::rename(&paths.db, &preupdate_backup).is_err() {
        return Err(CheckpointError::Io);
    }
    let _ = fs::remove_file(&paths.manifest);
    if sync_dir(state_dir).is_err() {
        return Err(CheckpointError::Io);
    }
    let _ = fs::remove_file(&paths.intent);
    let _ = fs::remove_dir(&paths.dir);
    let _ = sync_dir(state_dir);
    tracing::info!(
        component = "update",
        event = "rollback_restored",
        commands = delta.commands.len(),
        outbox_rows = delta.outbox_rows.len()
    );
    Ok(())
}

/// Completes or clears a restore intent left by a crash. A present
/// checkpoint means the restore never finished: redo it. An absent one
/// means the restore finished its file work: drop the marker and boot.
pub fn finish_interrupted_restore(state_dir: &Path, supported: u32) -> Result<bool, CheckpointError> {
    let paths = checkpoint_paths(state_dir);
    if !paths.intent.exists() {
        return Ok(false);
    }
    if paths.db.exists() && paths.manifest.exists() {
        restore_inner(state_dir, supported, EdgeFileSystem)?;
    } else {
        let _ = fs::remove_file(&paths.intent);
        let _ = fs::remove_dir(&paths.dir);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use edge_protocol::time::Timestamp;
    use edge_state::repo::commands::{self, CommandResult, ReportState};
    use edge_state::repo::outbox;
    use edge_state::repo::renderer;
    use edge_state::{OpenOptions, StateDb};

    const NEXT_MIGRATION: &[edge_state::Migration] =
        &[edge_state::Migration { version: 13, name: "test_probe", sql: "CREATE TABLE probe (id INTEGER);" }];

    fn now(ms: i64) -> Timestamp {
        Timestamp::from_unix_millis(ms).expect("test clock")
    }

    fn test_db(state_dir: &Path) -> StateDb {
        StateDb::open(state_dir.join("state.db"), OpenOptions::default()).expect("open test db")
    }

    fn complete_command(db: &StateDb, key: &str, id: &str, ms: i64) {
        db.run_blocking(|connection| {
            commands::observe(connection, key, id, "sync_now", now(ms))?;
            assert!(commands::begin_executing(connection, key, now(ms))?);
            assert!(
                commands::complete(
                    connection,
                    key,
                    &CommandResult::ok("synchronized", ""),
                    ReportState::Pending,
                    now(ms)
                )?,
                "completes once"
            );
            Ok(())
        })
        .expect("complete command");
    }

    fn next_sequence(db_path: &Path) -> i64 {
        let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open readable");
        connection
            .query_row("SELECT next_sequence FROM outbox_state WHERE singleton = 1", [], |row| row.get(0))
            .expect("read sequence")
    }

    #[test]
    fn checkpoint_is_needed_only_when_the_schema_advances() {
        assert!(!needs_checkpoint(9, 9));
        assert!(!needs_checkpoint(8, 9));
        assert!(needs_checkpoint(10, 9));
    }

    #[tokio::test]
    async fn checkpoint_roundtrip_verifies() {
        let root = tempfile::tempdir().expect("tempdir");
        let db = test_db(root.path());
        complete_command(&db, "key-1", "11111111-1111-1111-1111-111111111111", 1_000);
        let supported = edge_state::latest_schema_version();
        create_checkpoint(&db, root.path(), "0.2.0", "0.3.0", supported, 2_000).await.expect("checkpoint");
        assert!(verify_checkpoint(root.path(), supported).is_ok());
        // The checkpoint carries the same rows.
        let paths = checkpoint_paths(root.path());
        let connection = Connection::open_with_flags(&paths.db, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open copy");
        assert!(commands::get(&connection, "key-1").expect("read copy").is_some());
    }

    fn advance_to_candidate(root: &Path) {
        // The candidate migrates forward and writes post-checkpoint facts.
        let db_path = root.join("state.db");
        let connection = Connection::open(db_path).expect("open raw");
        edge_state::migrate_with(&connection, NEXT_MIGRATION).expect("candidate migrates");
        connection
            .execute_batch(
                "INSERT INTO player_commands (idempotency_key, command_id, command_type, state, success,
                                              result_code, report_state, received_at_ms, completed_at_ms)
                 VALUES ('key-new', '22222222-2222-2222-2222-222222222222', 'identify_screen', 'completed',
                         1, 'identified', 'pending', 3000, 3001);
                 INSERT INTO player_commands (idempotency_key, command_id, command_type, state, report_state,
                                              received_at_ms, executing_at_ms)
                 VALUES ('key-running', '33333333-3333-3333-3333-333333333333', 'sync_now', 'executing',
                         'none', 3002, 3003);",
            )
            .expect("newer commands");
        connection
            .execute_batch(
                "INSERT INTO outbox (kind, event_id, body, created_at_ms) VALUES
                 ('activity_event', '44444444-4444-4444-4444-444444444444', '{\"seq\":9}', 3004);
                 UPDATE outbox_state SET next_sequence = 10, updated_at_ms = 3004 WHERE singleton = 1;
                 INSERT INTO renderer_state (id, restart_count, safe_mode, updated_at_ms)
                 VALUES (1, 4, 1, 3005)
                 ON CONFLICT (id) DO UPDATE SET restart_count = 4, safe_mode = 1, updated_at_ms = 3005;",
            )
            .expect("newer outbox");
    }

    #[tokio::test]
    async fn rollback_restores_the_checkpoint_and_replays_candidate_facts() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        complete_command(&db, "key-1", "11111111-1111-1111-1111-111111111111", 1_000);
        create_checkpoint(&db, root.path(), "0.2.0", "0.3.0", supported, 2_000).await.expect("checkpoint");
        drop(db);
        advance_to_candidate(root.path());

        restore_checkpoint(root.path(), supported).expect("restore");

        // The previous release opens the database again.
        let db = test_db(root.path());
        let record = db
            .run_blocking(|connection| commands::get(connection, "key-new"))
            .expect("read")
            .expect("replayed command");
        assert_eq!(record.result.expect("result").code, "identified");
        // A command the candidate was running comes back executing, so
        // normal startup recovery reports it interrupted instead of rerun.
        let running = db
            .run_blocking(|connection| commands::get(connection, "key-running"))
            .expect("read")
            .expect("running command");
        assert_eq!(running.state, commands::CommandState::Executing);
        // Pre-checkpoint facts survive too.
        assert!(db.run_blocking(|connection| commands::get(connection, "key-1")).expect("read").is_some());
        let queued = db
            .run_blocking(|connection| outbox::pending(connection, outbox::OutboxKind::ActivityEvent, 10))
            .expect("read");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].event_id, "44444444-4444-4444-4444-444444444444");
        assert_eq!(next_sequence(&root.path().join("state.db")), 10);
        let supervision = db.run_blocking(|connection| renderer::get(connection)).expect("read supervision");
        assert_eq!(supervision.restart_count, 4);
        assert!(supervision.safe_mode);
        // The checkpoint is consumed; both databases stay for manual recovery.
        let paths = checkpoint_paths(root.path());
        assert!(!paths.db.exists());
        assert!(!paths.manifest.exists());
        assert!(!paths.intent.exists());
        assert!(root.path().join(PREUPDATE_BACKUP_NAME).exists());
        assert!(root.path().join(MIGRATED_BACKUP_NAME).exists());
    }

    #[tokio::test]
    async fn interrupted_restore_redoes_cleanly() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        create_checkpoint(&db, root.path(), "0.2.0", "0.3.0", supported, 2_000).await.expect("checkpoint");
        drop(db);
        advance_to_candidate(root.path());
        // A crash after the intent write reruns the whole restore.
        let paths = checkpoint_paths(root.path());
        write_intent(&paths).expect("intent");
        assert!(finish_interrupted_restore(root.path(), supported).expect("redo"));
        assert!(test_db(root.path()).run_blocking(|c| commands::get(c, "key-new")).expect("read").is_some());
        assert!(!paths.intent.exists());
        // No intent means nothing to do.
        assert!(!finish_interrupted_restore(root.path(), supported).expect("idle"));
    }

    #[tokio::test]
    async fn interrupted_cleanup_after_consume_only_drops_the_marker() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        create_checkpoint(&db, root.path(), "0.2.0", "0.3.0", supported, 2_000).await.expect("checkpoint");
        drop(db);
        advance_to_candidate(root.path());
        restore_checkpoint(root.path(), supported).expect("restore");
        // A crash between consuming the checkpoint and removing the intent
        // must not replay from backups: the replay already ran.
        let paths = checkpoint_paths(root.path());
        fs::create_dir_all(&paths.dir).expect("dir");
        write_intent(&paths).expect("intent");
        assert!(finish_interrupted_restore(root.path(), supported).expect("finish"));
        assert!(!paths.intent.exists());
        assert!(test_db(root.path()).run_blocking(|c| commands::get(c, "key-new")).expect("read").is_some());
    }

    #[tokio::test]
    async fn corrupt_checkpoint_fails_closed_without_touching_the_database() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        create_checkpoint(&db, root.path(), "0.2.0", "0.3.0", supported, 2_000).await.expect("checkpoint");
        drop(db);
        advance_to_candidate(root.path());
        let before = fs::read(root.path().join("state.db")).expect("read db");
        let paths = checkpoint_paths(root.path());
        fs::write(&paths.db, b"tampered").expect("tamper");
        assert_eq!(restore_checkpoint(root.path(), supported), Err(CheckpointError::Corrupt));
        assert_eq!(fs::read(root.path().join("state.db")).expect("read db"), before);
    }

    #[tokio::test]
    async fn missing_checkpoint_fails_closed() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        drop(db);
        advance_to_candidate(root.path());
        assert_eq!(restore_checkpoint(root.path(), supported), Err(CheckpointError::Missing));
    }

    #[tokio::test]
    async fn renamed_newer_tables_abort_the_restore() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        create_checkpoint(&db, root.path(), "0.2.0", "0.3.0", supported, 2_000).await.expect("checkpoint");
        drop(db);
        advance_to_candidate(root.path());
        // A future migration renames a table the restore reads.
        let connection = Connection::open(root.path().join("state.db")).expect("open raw");
        connection.execute_batch("ALTER TABLE outbox RENAME TO outbox_v2;").expect("rename");
        drop(connection);
        let before = fs::read(root.path().join("state.db")).expect("read db");
        assert_eq!(restore_checkpoint(root.path(), supported), Err(CheckpointError::DeltaIncompatible));
        assert_eq!(fs::read(root.path().join("state.db")).expect("read db"), before);
        // The checkpoint itself is intact for a manual recovery.
        assert!(verify_checkpoint(root.path(), supported).is_ok());
    }

    #[tokio::test]
    async fn checkpoint_for_another_schema_is_refused() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        create_checkpoint(&db, root.path(), "0.2.0", "0.3.0", supported, 2_000).await.expect("checkpoint");
        drop(db);
        let paths = checkpoint_paths(root.path());
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.manifest).expect("read")).expect("parse");
        manifest["db_schema"] = serde_json::json!(supported + 5);
        fs::write(&paths.manifest, serde_json::to_vec(&manifest).expect("encode")).expect("write");
        assert_eq!(
            verify_checkpoint(root.path(), supported),
            Err(CheckpointError::SchemaMismatch { found: supported + 5, supported })
        );
        advance_to_candidate(root.path());
        assert_eq!(
            restore_checkpoint(root.path(), supported),
            Err(CheckpointError::SchemaMismatch { found: supported + 5, supported })
        );
    }

    #[tokio::test]
    async fn stale_checkpoints_are_pruned_but_live_ones_kept() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        create_checkpoint(&db, root.path(), "0.1.0", "0.2.0", supported, 2_000).await.expect("checkpoint");
        // A checkpoint for the running schema may still be needed.
        prune_stale_checkpoint(root.path(), supported);
        assert!(checkpoint_paths(root.path()).manifest.exists());
        // One from an older release is debris from a confirmed update.
        prune_stale_checkpoint(root.path(), supported + 1);
        assert!(!checkpoint_paths(root.path()).manifest.exists());
    }

    struct FailingCopy;

    impl FileSystem for FailingCopy {
        fn copy(&self, _from: &Path, _to: &Path) -> std::io::Result<u64> {
            Err(std::io::Error::other("disk gone"))
        }
    }

    #[tokio::test]
    async fn failed_copy_puts_the_newer_database_back() {
        let root = tempfile::tempdir().expect("tempdir");
        let supported = edge_state::latest_schema_version();
        let db = test_db(root.path());
        create_checkpoint(&db, root.path(), "0.2.0", "0.3.0", supported, 2_000).await.expect("checkpoint");
        drop(db);
        advance_to_candidate(root.path());
        let before = fs::read(root.path().join("state.db")).expect("read db");
        assert_eq!(restore_inner(root.path(), supported, FailingCopy), Err(CheckpointError::Io));
        assert_eq!(fs::read(root.path().join("state.db")).expect("read db"), before);
    }
}
