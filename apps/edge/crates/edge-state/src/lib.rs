//! Tilecast Edge durable state.
//!
//! One SQLite database (`state.db`) holds every piece of Edge metadata that
//! must survive a restart. Large immutable bytes live in the CAS; secrets live
//! in the identity directory. See `migrations/0001_initial.sql` for the
//! schema conventions.
//!
//! # Opening
//!
//! [`StateDb::open`] applies fixed connection settings (WAL, `synchronous =
//! FULL`, foreign keys, busy timeout), then:
//!
//! 1. refuses a database whose schema is **newer** than this build knows
//!    ([`StateError::NewerSchema`]): a downgraded daemon must not write to a
//!    schema it does not understand;
//! 2. applies pending migrations, each in its own `BEGIN IMMEDIATE`
//!    transaction, so a crash mid-upgrade leaves the previous version intact;
//! 3. runs `PRAGMA quick_check` when asked (the daemon asks after an unclean
//!    shutdown) and reports [`StateError::Corrupt`] on failure.
//!
//! Any open error puts the daemon in recovery mode. Nothing in this crate
//! deletes or recreates a database: silently starting empty would discard the
//! node's identity binding and could strand a paired screen.
//!
//! # Access
//!
//! All SQL lives in [`repo`]. Other crates call typed repository functions
//! with a `&Connection` inside [`StateDb::run`], which executes the closure on
//! the blocking pool. Keep closures short and free of network I/O.

pub mod repo;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags};

/// A migration compiled into the binary. Shipped migrations are never edited;
/// add a new one instead.
#[derive(Debug)]
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "initial", sql: include_str!("../migrations/0001_initial.sql") },
    Migration { version: 2, name: "manifests", sql: include_str!("../migrations/0002_manifests.sql") },
];

pub fn latest_schema_version() -> u32 {
    MIGRATIONS.last().map_or(0, |m| m.version)
}

#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("state database could not be opened: {0}")]
    Open(#[source] rusqlite::Error),
    #[error("state database schema {found} is newer than this build supports ({supported})")]
    NewerSchema { found: u32, supported: u32 },
    #[error("state database migration {version} failed: {source}")]
    Migration {
        version: u32,
        #[source]
        source: rusqlite::Error,
    },
    #[error("state database failed its integrity check")]
    Corrupt,
    #[error("state database query failed: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("stored value is invalid: {0}")]
    InvalidValue(String),
    #[error("state database task failed")]
    Task,
}

impl StateError {
    /// Stable reason code for status reporting.
    pub fn reason_code(&self) -> &'static str {
        match self {
            StateError::Open(_) => "state_db_open_failed",
            StateError::NewerSchema { .. } => "state_db_newer_schema",
            StateError::Migration { .. } => "state_db_migration_failed",
            StateError::Corrupt => "state_db_corrupt",
            StateError::Sql(_) => "state_db_query_failed",
            StateError::InvalidValue(_) => "state_db_invalid_value",
            StateError::Task => "state_db_task_failed",
        }
    }
}

pub type Result<T> = std::result::Result<T, StateError>;

#[derive(Debug, Clone, Copy, Default)]
pub struct OpenOptions {
    /// Run `PRAGMA quick_check` after migrating.
    pub integrity_check: bool,
}

/// Opens a connection with the fixed Edge settings and migrates it.
pub fn open_connection(path: &Path, options: OpenOptions) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(StateError::Open)?;
    configure(&connection).map_err(StateError::Open)?;
    migrate(&connection)?;
    if options.integrity_check {
        let result: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if result != "ok" {
            return Err(StateError::Corrupt);
        }
    }
    Ok(connection)
}

fn configure(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(std::time::Duration::from_millis(5_000))?;
    // journal_mode returns the resulting mode as a row.
    let _mode: String = connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    // FULL: command-idempotency and update-transition rows must survive power
    // loss (RFC §8.1). Optimize individual hot paths, never this setting.
    connection.execute_batch(
        "PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;",
    )?;
    Ok(())
}

/// Current schema version recorded in the database (0 for a new file).
pub fn schema_version(connection: &Connection) -> Result<u32> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at_ms INTEGER NOT NULL
         );",
    )?;
    let version: Option<u32> =
        connection.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get(0))?;
    Ok(version.unwrap_or(0))
}

fn migrate(connection: &Connection) -> Result<()> {
    migrate_with(connection, MIGRATIONS)
}

/// Applies `migrations` above the current version. Public for tests that
/// exercise upgrade behavior with synthetic migrations.
pub fn migrate_with(connection: &Connection, migrations: &[Migration]) -> Result<()> {
    let current = schema_version(connection)?;
    let supported = migrations.last().map_or(0, |m| m.version);
    if current > supported {
        return Err(StateError::NewerSchema { found: current, supported });
    }
    for migration in migrations.iter().filter(|m| m.version > current) {
        apply(connection, migration).map_err(|source| StateError::Migration { version: migration.version, source })?;
        tracing::info!(
            component = "state",
            event = "migration_applied",
            version = migration.version,
            name = migration.name
        );
    }
    Ok(())
}

fn apply(connection: &Connection, migration: &Migration) -> rusqlite::Result<()> {
    // IMMEDIATE takes the write lock before any DDL runs. An explicit
    // statement keeps the shared-reference API.
    connection.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        connection.execute_batch(migration.sql)?;
        connection.execute(
            "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?1, ?2, ?3)",
            rusqlite::params![migration.version, migration.name, now_ms()],
        )?;
        connection.execute_batch(&format!("PRAGMA user_version = {}", migration.version))?;
        Ok(())
    })();
    match result {
        Ok(()) => connection.execute_batch("COMMIT"),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Shared handle to the state database.
#[derive(Debug, Clone)]
pub struct StateDb {
    connection: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl StateDb {
    /// Opens and migrates the database at `path` (blocking; call once at
    /// startup before the async runtime is busy, or from `spawn_blocking`).
    pub fn open(path: impl Into<PathBuf>, options: OpenOptions) -> Result<Self> {
        let path = path.into();
        let connection = open_connection(&path, options)?;
        Ok(Self { connection: Arc::new(Mutex::new(connection)), path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Runs `f` with the connection on the blocking pool.
    pub async fn run<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || {
            let mut guard = connection.lock().unwrap_or_else(|poison| poison.into_inner());
            f(&mut guard)
        })
        .await
        .map_err(|_| StateError::Task)?
    }

    /// Runs `f` synchronously on the current thread. For startup, shutdown,
    /// the one-shot legacy importer and tests.
    pub fn run_blocking<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Connection) -> Result<T>,
    {
        let mut guard = self.connection.lock().unwrap_or_else(|poison| poison.into_inner());
        f(&mut guard)
    }

    /// Checkpoints the WAL into the main file (clean shutdown).
    pub fn checkpoint(&self) -> Result<()> {
        self.run_blocking(|connection| {
            connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            Ok(())
        })
    }
}
