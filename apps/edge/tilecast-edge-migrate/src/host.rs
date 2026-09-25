//! Everything the migrator does to the machine goes through [`Host`].
//!
//! The production implementation (`linux.rs`) talks to the system manager
//! over D-Bus, to the kiosk account's user manager through `systemctl` with a
//! fixed argument list, and to the filesystem through descriptor-relative
//! opens that never follow a link. The crash-point tests use an in-memory
//! implementation with the same contract.
//!
//! Every unit name the migrator passes is a constant in this crate; nothing
//! read from the machine or the server becomes a unit name, a path to
//! execute or an argument.

use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::ipc::status::DaemonStatus;
use serde_json::Value;

use crate::state::{FileDigest, KioskRecord, ReleaseRef};

pub const EDGE_DAEMON: &str = "tilecast-edge.service";
pub const EDGE_RENDERER: &str = "tilecast-renderer.service";
pub const EDGE_UNITS: [&str; 2] = [EDGE_DAEMON, EDGE_RENDERER];
pub const RECOVER_UNIT: &str = "tilecast-edge-migrate-recover.service";
pub const MIGRATE_UNIT: &str = "tilecast-edge-migrate.service";
pub const SELFTEST_HOST_UNIT: &str = "tilecast-edge-selftest.service";
pub const SELFTEST_RENDERER_UNIT: &str = "tilecast-renderer-selftest.service";
pub const DRM_PROBE_UNIT: &str = "tilecast-renderer-probe.service";
pub const COMPAT_UNIT: &str = "tilecast-edge-compat.service";
pub const IMPORT_UNIT: &str = "tilecast-edge-import.service";
/// The legacy Electron player's user unit (`apps/player-linux/src/core/autostart.ts`).
pub const LEGACY_UNIT: &str = "tilecast-player.service";
/// Units that can hold the display on a DRM host.
pub const DISPLAY_MANAGER_UNIT: &str = "display-manager.service";
pub const CONSOLE_UNIT: &str = "getty@tty1.service";

/// Output files the task units write, under the run directory.
pub const DRM_PROBE_OUTPUT: &str = "drm-probe.json";
pub const SELFTEST_OUTPUT: &str = "selftest.json";
pub const COMPAT_OUTPUT: &str = "compat.json";
pub const IMPORT_OUTPUT: &str = "import.json";

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("{0}")]
    Failed(String),
    #[error("timed out: {0}")]
    Timeout(&'static str),
}

impl HostError {
    pub fn failed(message: impl std::fmt::Display) -> Self {
        Self::Failed(message.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UnitState {
    /// `LoadState` is `loaded`.
    pub loaded: bool,
    /// The unit's own name; an alias such as `display-manager.service`
    /// resolves to the real unit.
    pub id: String,
    /// `UnitFileState` is `enabled` (or `enabled-runtime`, `alias`).
    pub enabled: bool,
    /// `ActiveState` is `active`, `activating` or `reloading`.
    pub active: bool,
}

/// A finished task unit: its main process exit status and its bounded
/// output file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskResult {
    pub exit_status: i32,
    pub output: Option<Value>,
}

/// What the migrator copied for the import unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageSummary {
    pub state_files: usize,
    pub media_files: usize,
    pub media_bytes: u64,
    pub media_copied: bool,
}

#[async_trait]
pub trait Host: Send + Sync {
    // System manager. Names are constants from this module.
    async fn unit(&self, name: &str) -> Result<UnitState, HostError>;
    async fn enable(&self, units: &[&str]) -> Result<(), HostError>;
    async fn disable(&self, units: &[&str]) -> Result<(), HostError>;
    /// Starts a unit and waits for its start job to finish.
    async fn start(&self, unit: &str) -> Result<(), HostError>;
    /// Enables the boot recovery and makes the Edge units require it, so an
    /// unaccepted Edge never starts at boot without the recovery.
    async fn arm_recovery(&self) -> Result<(), HostError>;
    /// Disables the boot recovery, which also removes the Edge units'
    /// dependency on it.
    async fn disarm_recovery(&self) -> Result<(), HostError>;
    /// Queues a start job and returns.
    async fn start_detached(&self, unit: &str) -> Result<(), HostError>;
    /// Stops a unit and waits for its stop job to finish.
    async fn stop(&self, unit: &str) -> Result<(), HostError>;
    /// Starts a task unit, waits at most `timeout` for it to finish, and
    /// reads its output file.
    async fn run_task(&self, unit: &str, output: &str, timeout: Duration) -> Result<TaskResult, HostError>;

    // The kiosk account's legacy player.
    async fn resolve_kiosk(&self, user: &str) -> Result<KioskRecord, HostError>;
    async fn legacy_unit(&self, kiosk: &KioskRecord) -> Result<UnitState, HostError>;
    async fn legacy_enable(&self, kiosk: &KioskRecord) -> Result<(), HostError>;
    async fn legacy_disable(&self, kiosk: &KioskRecord) -> Result<(), HostError>;
    async fn legacy_start(&self, kiosk: &KioskRecord) -> Result<(), HostError>;
    async fn legacy_stop(&self, kiosk: &KioskRecord) -> Result<(), HostError>;
    /// Running processes of the legacy player (read-only `/proc` scan).
    fn legacy_processes(&self, kiosk: Option<&KioskRecord>) -> Result<usize, HostError>;
    /// Size and SHA-256 of the legacy state files, to prove they never change.
    fn snapshot_legacy(&self, kiosk: &KioskRecord) -> Result<Vec<FileDigest>, HostError>;
    /// Copies the legacy cached manifest for the compatibility unit.
    fn stage_compat(&self, kiosk: &KioskRecord) -> Result<(), HostError>;
    /// Copies the legacy state for the import unit, and the cached media if
    /// `media_budget_bytes` covers it.
    fn stage_import(&self, kiosk: &KioskRecord, media_budget_bytes: u64) -> Result<StageSummary, HostError>;
    /// Removes the import copy (it holds a copy of the credential file).
    fn clear_import_stage(&self) -> Result<(), HostError>;
    /// Free bytes on the Edge state filesystem.
    fn free_state_bytes(&self) -> Result<u64, HostError>;

    // Edge.
    fn set_probation(&self, on: bool) -> Result<(), HostError>;
    fn verify_release(&self) -> Result<ReleaseRef, HostError>;
    /// The daemon's status over its socket, or `None` if it is unreachable.
    async fn edge_status(&self) -> Option<DaemonStatus>;

    fn now_ms(&self) -> i64;
    async fn sleep(&self, duration: Duration);
}
