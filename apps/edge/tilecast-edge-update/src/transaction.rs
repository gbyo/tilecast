//! The update transaction record: the helper's only durable state.
//!
//! It is root-owned (`/var/lib/tilecast-edge-update`, mode 0700), separate
//! from the player's `state.db`, and holds only what a recovery needs: the
//! previous and candidate releases, the phase, and the provisional window.
//! It never holds a credential, a server address or anything from the
//! server beyond the signed release identities.
//!
//! Every side effect is preceded by a durable write of the phase that names
//! it, so that after a crash or power loss the guard knows what may have
//! happened and can finish or undo it. A finished transaction is moved to
//! `previous.json`.

use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use edge_release::protocol::{Phase, ReleaseRef, TransactionView};
use serde::{Deserialize, Serialize};

pub const STATE_DIR: &str = "/var/lib/tilecast-edge-update";
pub const SCHEMA_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 256 * 1024;
const MAX_EVENTS: usize = 64;
const RECORD: &str = "transaction.json";
const PREVIOUS: &str = "previous.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventRecord {
    pub at_ms: i64,
    pub phase: Phase,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transaction {
    pub schema_version: u32,
    pub transaction_id: String,
    pub candidate: ReleaseRef,
    pub previous: ReleaseRef,
    pub phase: Phase,
    /// `/proc/sys/kernel/random/boot_id` when the window opened. A different
    /// boot means the machine restarted while the candidate was provisional.
    pub boot_id: Option<String>,
    /// `CLOCK_BOOTTIME` milliseconds, which wall-clock changes do not move.
    pub provisional_since_ms: Option<i64>,
    pub deadline_ms: Option<i64>,
    /// `NRestarts` of the daemon and the renderer when the window opened.
    pub daemon_restarts_base: Option<u64>,
    pub renderer_restarts_base: Option<u64>,
    pub reason: Option<String>,
    #[serde(default)]
    pub schema_incompatible: bool,
    #[serde(default)]
    pub events: Vec<EventRecord>,
    pub updated_at_ms: i64,
}

impl Transaction {
    pub fn record(&mut self, at_ms: i64, detail: impl Into<String>) {
        if self.events.len() >= MAX_EVENTS {
            self.events.remove(0);
        }
        let detail: String = detail.into().chars().take(200).collect();
        self.events.push(EventRecord { at_ms, phase: self.phase, detail });
        self.updated_at_ms = at_ms;
    }

    pub fn view(&self, now_boottime_ms: i64) -> TransactionView {
        TransactionView {
            transaction_id: self.transaction_id.clone(),
            candidate: self.candidate.clone(),
            previous: self.previous.clone(),
            phase: self.phase,
            reason: self.reason.clone(),
            schema_incompatible: self.schema_incompatible,
            provisional_remaining_ms: match (self.phase, self.deadline_ms) {
                (Phase::Provisional, Some(deadline)) => Some(deadline.saturating_sub(now_boottime_ms).max(0) as u64),
                _ => None,
            },
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("update state I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("the update transaction file is invalid")]
    Invalid,
    #[error("the update transaction was written by a newer helper (schema {0})")]
    Newer(u32),
    #[error("another update operation holds the lock")]
    Locked,
}

#[derive(Debug, Clone)]
pub struct TransactionStore {
    dir: PathBuf,
}

impl TransactionStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn ensure(&self) -> Result<(), StateError> {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.dir)?;
        Ok(())
    }

    fn read(&self, name: &str) -> Result<Option<Transaction>, StateError> {
        let Some(bytes) = edge_platform::fs::read_regular(&self.dir.join(name), MAX_STATE_BYTES)? else {
            return Ok(None);
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| StateError::Invalid)?;
        let schema = value.get("schemaVersion").and_then(serde_json::Value::as_u64).ok_or(StateError::Invalid)?;
        if schema > u64::from(SCHEMA_VERSION) {
            return Err(StateError::Newer(schema as u32));
        }
        serde_json::from_value(value).map(Some).map_err(|_| StateError::Invalid)
    }

    /// The open transaction.
    pub fn load(&self) -> Result<Option<Transaction>, StateError> {
        self.read(RECORD)
    }

    /// The open transaction, or else the last finished one.
    pub fn latest(&self) -> Result<Option<Transaction>, StateError> {
        match self.read(RECORD)? {
            Some(open) => Ok(Some(open)),
            None => self.read(PREVIOUS),
        }
    }

    pub fn save(&self, transaction: &Transaction) -> Result<(), StateError> {
        self.ensure()?;
        let bytes = serde_json::to_vec_pretty(transaction).map_err(|_| StateError::Invalid)?;
        edge_release::install::write_atomic(&self.dir, RECORD, &bytes, 0o600)?;
        Ok(())
    }

    /// Moves a finished transaction to `previous.json`. The guard units run
    /// only while `transaction.json` exists.
    pub fn archive(&self, transaction: &Transaction) -> Result<(), StateError> {
        let bytes = serde_json::to_vec_pretty(transaction).map_err(|_| StateError::Invalid)?;
        edge_release::install::write_atomic(&self.dir, PREVIOUS, &bytes, 0o600)?;
        match std::fs::remove_file(self.dir.join(RECORD)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        edge_release::install::sync_dir(&self.dir)?;
        Ok(())
    }

    /// Where the helper keeps its private copy of an archive while it stages.
    pub fn work_dir(&self) -> PathBuf {
        self.dir.join("work")
    }
}

/// One update operation at a time, across the socket-activated helper and the
/// guard (which runs the previous release's binary). The kernel drops the
/// lock when the holder exits.
#[derive(Debug)]
pub struct UpdateLock {
    _file: std::fs::File,
}

impl UpdateLock {
    pub fn try_acquire(dir: &Path) -> Result<Self, StateError> {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
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

    /// Waits up to `timeout` for the lock.
    pub async fn acquire(dir: &Path, timeout: std::time::Duration) -> Result<Self, StateError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match Self::try_acquire(dir) {
                Err(StateError::Locked) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
                other => return other,
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn release(version: &str) -> ReleaseRef {
        ReleaseRef {
            version_name: version.into(),
            version_code: edge_release::manifest::version_code(version).unwrap_or(1),
            manifest_sha256: "0".repeat(64),
        }
    }

    pub(crate) fn transaction() -> Transaction {
        Transaction {
            schema_version: SCHEMA_VERSION,
            transaction_id: "t".into(),
            candidate: release("0.2.0"),
            previous: release("0.1.0"),
            phase: Phase::ActivateIntent,
            boot_id: None,
            provisional_since_ms: None,
            deadline_ms: None,
            daemon_restarts_base: None,
            renderer_restarts_base: None,
            reason: None,
            schema_incompatible: false,
            events: vec![],
            updated_at_ms: 0,
        }
    }

    #[test]
    fn the_record_round_trips_is_private_and_refuses_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let store = TransactionStore::new(dir.path().join("state"));
        assert!(store.latest().unwrap().is_none());
        let mut value = transaction();
        for i in 0..100 {
            value.record(i, "event");
        }
        assert_eq!(value.events.len(), MAX_EVENTS);
        store.save(&value).unwrap();
        assert_eq!(store.load().unwrap(), Some(value.clone()));
        let mode = std::fs::metadata(dir.path().join("state/transaction.json")).unwrap();
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&mode.permissions()) & 0o777, 0o600);

        store.archive(&value).unwrap();
        assert!(store.load().unwrap().is_none());
        assert_eq!(store.latest().unwrap(), Some(value.clone()), "the last finished one");

        let mut newer = serde_json::to_value(&value).unwrap();
        newer["schemaVersion"] = serde_json::json!(SCHEMA_VERSION + 1);
        std::fs::write(dir.path().join("state/transaction.json"), serde_json::to_vec(&newer).unwrap()).unwrap();
        assert!(matches!(store.load(), Err(StateError::Newer(_))));
    }

    #[test]
    fn one_lock_holder_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let held = UpdateLock::try_acquire(dir.path()).unwrap();
        assert!(matches!(UpdateLock::try_acquire(dir.path()), Err(StateError::Locked)));
        drop(held);
        UpdateLock::try_acquire(dir.path()).unwrap();
    }
}
