//! Everything the helper does to the machine, other than the release files
//! themselves, goes through [`UpdateHost`].
//!
//! The production implementation (`linux.rs`) reaches systemd over D-Bus and
//! runs two fixed programs (`systemd-sysusers`, `systemd-tmpfiles`) with
//! fixed arguments and a cleared environment. The crash-point tests use an
//! in-memory implementation with the same contract.
//!
//! Every unit name is a constant of this crate. Nothing from a request, the
//! daemon or the server becomes a unit name, a path to execute or an
//! argument. The only variable part of a written file is the guard's
//! `ExecStart=`, which names the previous release by its validated version.

use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::ipc::status::DaemonStatus;

pub const EDGE_DAEMON: &str = "tilecast-edge.service";
pub const EDGE_RENDERER: &str = "tilecast-renderer.service";
pub const GUARD_SERVICE: &str = "tilecast-edge-update-guard.service";
pub const GUARD_TIMER: &str = "tilecast-edge-update-guard.timer";

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("{0}")]
    Failed(String),
    #[error("timed out: {0}")]
    Timeout(&'static str),
}

impl HostError {
    pub fn failed(message: impl std::fmt::Display) -> Self {
        Self::Failed(message.to_string().chars().take(200).collect())
    }
}

/// What systemd reports for a unit (`ActiveState`), reduced to what the
/// guard decides on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitActivity {
    /// Active, activating, reloading or deactivating, including a service
    /// waiting for its automatic restart.
    Running,
    /// Stopped, or never started.
    Inactive,
    /// systemd gave up on it, for example after its start limit.
    Failed,
}

#[async_trait]
pub trait UpdateHost: Send + Sync {
    /// Stops a unit and waits for its stop job.
    async fn stop(&self, unit: &str) -> Result<(), HostError>;
    /// Clears the unit's failed state, which also sets systemd's restart
    /// counter (`NRestarts`) to zero, queues a start job and returns: the
    /// candidate may take a while, and the guard, not this call, decides
    /// whether it came up.
    async fn start(&self, unit: &str) -> Result<(), HostError>;
    async fn activity(&self, unit: &str) -> Result<UnitActivity, HostError>;
    /// `systemctl daemon-reload`.
    async fn reload(&self) -> Result<(), HostError>;
    /// `systemd-sysusers` and `systemd-tmpfiles --create` for the Edge
    /// configuration that is now installed.
    async fn apply_system_configuration(&self) -> Result<(), HostError>;
    /// Writes and enables the guard units, with `ExecStart=` naming the
    /// helper of `previous_version`, and starts the guard timer.
    async fn arm_guard(&self, previous_version: &str) -> Result<(), HostError>;
    /// Stops, disables and removes the guard units. Idempotent.
    async fn disarm_guard(&self) -> Result<(), HostError>;
    /// systemd's `NRestarts` for a unit: automatic restarts since the last
    /// [`UpdateHost::start`].
    async fn restarts(&self, unit: &str) -> Result<u64, HostError>;
    /// The daemon's status over its socket, or `None` if it does not answer.
    async fn daemon_status(&self) -> Option<DaemonStatus>;
    fn boot_id(&self) -> String;
    /// `CLOCK_BOOTTIME` in milliseconds.
    fn boottime_ms(&self) -> i64;
    /// Wall-clock milliseconds, for event records only.
    fn now_ms(&self) -> i64;
    async fn sleep(&self, duration: Duration);
}
