//! The migrator's durable record of one attempt.
//!
//! Every side effect on the host is preceded by a durable write of the phase
//! that names it (an "intent"), so that after a crash or power loss the
//! recovery pass knows what may have happened and can finish or undo it.
//! The file is written as a temporary file, synced, renamed over the old
//! file, and the directory is synced.

use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Root-owned, 0700. Survives reboots.
pub const STATE_DIR: &str = "/var/lib/tilecast-edge-migrate";
/// Root-owned, 0755, tmpfs: unit outputs, the probation marker and the lock.
pub const RUN_DIR: &str = "/run/tilecast-edge-migrate";
pub const SCHEMA_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const MAX_EVENTS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// The attempt exists; nothing outside the migrator's files has changed.
    Started,
    /// The release self-test passed on this machine.
    SelfTested,
    /// The legacy cached presentation is compatible with the installed build.
    CompatChecked,
    /// Written before the legacy player or the display session is touched.
    CutoverIntent,
    /// The legacy player is disabled and stopped, and no legacy process runs.
    LegacyStopped,
    /// `tilecastd import-legacy` succeeded.
    Imported,
    /// Written before the Edge units are enabled or started.
    EdgeStartIntent,
    /// Edge runs; the bounded settlement window is open.
    Settling,
    /// Settlement passed; written before the acceptance side effects.
    AcceptIntent,
    Accepted,
    /// Written before the rollback side effects.
    RollbackIntent,
    RolledBack,
    /// The attempt stopped before the cutover; nothing was changed.
    Refused,
}

impl Phase {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Accepted | Self::RolledBack | Self::Refused)
    }

    /// Whether the host may have changed: the legacy player or display
    /// session touched, or Edge enabled.
    pub fn is_cutover(self) -> bool {
        matches!(
            self,
            Self::CutoverIntent
                | Self::LegacyStopped
                | Self::Imported
                | Self::EdgeStartIntent
                | Self::Settling
                | Self::RollbackIntent
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// One-way migration from the Electron Linux Player.
    Migration,
    /// A machine with no legacy player.
    CleanInstall,
}

/// The output that the renderer will use after the cutover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    Drm,
    /// Screenless qualification rigs and the systemd integration test only.
    Headless,
}

impl Backend {
    pub fn platform(self) -> &'static str {
        match self {
            Self::Drm => "drm",
            Self::Headless => "headless",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseRef {
    pub version_name: String,
    pub version_code: u64,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KioskRecord {
    pub user: String,
    pub uid: u32,
    pub home: PathBuf,
    pub data_dir: PathBuf,
}

/// A unit's persistent and runtime state before the cutover, so a rollback
/// restores exactly what it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnitRecord {
    pub name: String,
    pub was_enabled: bool,
    pub was_active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDigest {
    /// Relative to the legacy data directory.
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventRecord {
    pub at_ms: i64,
    pub phase: Phase,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attempt {
    pub schema_version: u32,
    pub attempt_id: String,
    pub kind: Kind,
    pub phase: Phase,
    pub backend: Backend,
    pub release: ReleaseRef,
    pub kiosk: Option<KioskRecord>,
    pub legacy_unit: Option<UnitRecord>,
    #[serde(default)]
    pub display_units: Vec<UnitRecord>,
    #[serde(default)]
    pub legacy_files: Vec<FileDigest>,
    pub drm_probe: Option<Value>,
    pub self_test: Option<Value>,
    pub compat: Option<Value>,
    pub import: Option<Value>,
    pub media_copied: Option<bool>,
    pub settle_seconds: u64,
    pub edge_started_at_ms: Option<i64>,
    pub settle_deadline_ms: Option<i64>,
    /// The last status sample that settlement accepted or refused.
    pub settlement: Option<Value>,
    /// Why the attempt was refused or rolled back.
    pub reason: Option<String>,
    /// After a rollback: the legacy files still hash as before the cutover.
    pub legacy_files_unchanged: Option<bool>,
    /// After a rollback: the legacy unit was seen active again.
    pub legacy_active_after_rollback: Option<bool>,
    #[serde(default)]
    pub events: Vec<EventRecord>,
    pub updated_at_ms: i64,
}

impl Attempt {
    pub fn record(&mut self, at_ms: i64, detail: impl Into<String>) {
        if self.events.len() >= MAX_EVENTS {
            self.events.remove(0);
        }
        self.events.push(EventRecord { at_ms, phase: self.phase, detail: detail.into() });
        self.updated_at_ms = at_ms;
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("migration state I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("the migration state file is invalid")]
    Invalid,
    #[error("the migration state was written by a newer migrator (schema {0})")]
    Newer(u32),
    #[error("another migration is running")]
    Locked,
}

/// The state directory and its files.
#[derive(Debug, Clone)]
pub struct StateStore {
    dir: PathBuf,
}

impl StateStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self) -> PathBuf {
        self.dir.join("state.json")
    }

    pub fn ensure(&self) -> Result<(), StateError> {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.dir)?;
        Ok(())
    }

    pub fn load(&self) -> Result<Option<Attempt>, StateError> {
        let Some(bytes) = edge_platform::fs::read_regular(&self.path(), MAX_STATE_BYTES)? else {
            return Ok(None);
        };
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| StateError::Invalid)?;
        let schema = value.get("schemaVersion").and_then(Value::as_u64).ok_or(StateError::Invalid)? as u32;
        if schema > SCHEMA_VERSION {
            return Err(StateError::Newer(schema));
        }
        serde_json::from_value(value).map(Some).map_err(|_| StateError::Invalid)
    }

    pub fn save(&self, attempt: &Attempt) -> Result<(), StateError> {
        self.ensure()?;
        let bytes = serde_json::to_vec_pretty(attempt).map_err(|_| StateError::Invalid)?;
        write_atomic(&self.dir, "state.json", &bytes)?;
        Ok(())
    }

    /// Moves a finished attempt aside before a new one starts.
    pub fn archive(&self, attempt: &Attempt) -> Result<(), StateError> {
        let bytes = serde_json::to_vec_pretty(attempt).map_err(|_| StateError::Invalid)?;
        write_atomic(&self.dir, "previous.json", &bytes)?;
        match std::fs::remove_file(self.path()) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        sync_dir(&self.dir)?;
        Ok(())
    }
}

/// Writes `name` in `dir` with mode 0600: temporary file, sync, rename,
/// directory sync.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    edge_release::install::write_atomic(dir, name, bytes, 0o600)
}

pub use edge_release::install::sync_dir;

/// An exclusive lock held for the life of one migrator process. The kernel
/// releases it if the process dies, so a stale lock never blocks recovery.
#[derive(Debug)]
pub struct MigrationLock {
    _file: std::fs::File,
}

impl MigrationLock {
    pub fn acquire(dir: &Path) -> Result<Self, StateError> {
        std::fs::DirBuilder::new().recursive(true).mode(0o755).create(dir)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(dir.join("lock"))?;
        match rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(Self { _file: file }),
            Err(rustix::io::Errno::WOULDBLOCK) => Err(StateError::Locked),
            Err(error) => Err(StateError::Io(error.into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn attempt() -> Attempt {
        Attempt {
            schema_version: SCHEMA_VERSION,
            attempt_id: "a".into(),
            kind: Kind::Migration,
            phase: Phase::Started,
            backend: Backend::Drm,
            release: ReleaseRef { version_name: "0.1.0".into(), version_code: 1000, manifest_sha256: "00".into() },
            kiosk: None,
            legacy_unit: None,
            display_units: vec![],
            legacy_files: vec![],
            drm_probe: None,
            self_test: None,
            compat: None,
            import: None,
            media_copied: None,
            settle_seconds: 600,
            edge_started_at_ms: None,
            settle_deadline_ms: None,
            settlement: None,
            reason: None,
            legacy_files_unchanged: None,
            legacy_active_after_rollback: None,
            events: vec![],
            updated_at_ms: 0,
        }
    }

    #[test]
    fn state_round_trips_and_a_newer_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path().join("state"));
        assert!(store.load().unwrap().is_none());
        let mut value = attempt();
        for i in 0..200 {
            value.record(i, "event");
        }
        assert_eq!(value.events.len(), MAX_EVENTS);
        store.save(&value).unwrap();
        assert_eq!(store.load().unwrap(), Some(value.clone()));
        let mode = std::fs::metadata(dir.path().join("state/state.json")).unwrap();
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&mode.permissions()) & 0o777, 0o600);

        let mut newer = serde_json::to_value(&value).unwrap();
        newer["schemaVersion"] = serde_json::json!(SCHEMA_VERSION + 1);
        std::fs::write(dir.path().join("state/state.json"), serde_json::to_vec(&newer).unwrap()).unwrap();
        assert!(matches!(store.load(), Err(StateError::Newer(_))));
        std::fs::write(dir.path().join("state/state.json"), b"{").unwrap();
        assert!(matches!(store.load(), Err(StateError::Invalid)));
    }

    #[test]
    fn one_lock_holder_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let held = MigrationLock::acquire(dir.path()).unwrap();
        assert!(matches!(MigrationLock::acquire(dir.path()), Err(StateError::Locked)));
        drop(held);
        MigrationLock::acquire(dir.path()).unwrap();
    }

    #[test]
    fn phases_classify_the_recovery_action() {
        assert!(Phase::Settling.is_cutover() && !Phase::Settling.is_terminal());
        assert!(!Phase::CompatChecked.is_cutover() && !Phase::AcceptIntent.is_cutover());
        assert!(Phase::Accepted.is_terminal() && Phase::RolledBack.is_terminal() && Phase::Refused.is_terminal());
    }
}
