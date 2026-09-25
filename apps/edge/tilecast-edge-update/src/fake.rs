//! An in-memory [`UpdateHost`] for the crash-point tests. Unit states,
//! restart counters, the boot and the clocks are simulated; the release
//! files are real files in a temporary layout.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::bounded::ShortToken;
use edge_protocol::ipc::status::{DaemonMode, DaemonStatus};

use crate::host::{EDGE_DAEMON, EDGE_RENDERER, HostError, UpdateHost};

/// How the daemon of a version behaves once it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Behavior {
    Healthy,
    /// Runs, but never reaches the server.
    NoServer,
    /// Connected, but the renderer never proves the presentation.
    NoEvidence,
    /// The renderer is in safe mode.
    SafeMode,
    /// Refuses the state database as newer than it knows.
    NewerSchemaRefused,
    /// Never answers on its socket.
    Silent,
}

#[derive(Debug)]
pub struct FakeState {
    pub active: BTreeSet<String>,
    pub guard_armed_for: Option<String>,
    pub reloads: u32,
    pub configuration_runs: u32,
    pub restarts: HashMap<String, u64>,
    pub boot_id: String,
    pub boottime_ms: i64,
    /// The version whose daemon runs (what `current` named at its start).
    pub running_version: Option<String>,
    pub behavior: HashMap<String, Behavior>,
    pub log: Vec<String>,
}

#[derive(Debug)]
pub struct FakeHost {
    pub state: Mutex<FakeState>,
    install_root: PathBuf,
}

impl FakeHost {
    pub fn new(install_root: PathBuf) -> Self {
        Self {
            state: Mutex::new(FakeState {
                active: [EDGE_DAEMON, EDGE_RENDERER].iter().map(|u| (*u).to_owned()).collect(),
                guard_armed_for: None,
                reloads: 0,
                configuration_runs: 0,
                restarts: HashMap::new(),
                boot_id: "boot-1".into(),
                boottime_ms: 1_000_000,
                running_version: None,
                behavior: HashMap::new(),
                log: vec![],
            }),
            install_root,
        }
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut FakeState) -> T) -> T {
        f(&mut self.state.lock().unwrap())
    }

    fn current(&self) -> Option<String> {
        std::fs::read_link(self.install_root.join("current")).ok().and_then(|p| p.to_str().map(str::to_owned))
    }

    pub fn is_active(&self, unit: &str) -> bool {
        self.with(|s| s.active.contains(unit))
    }

    /// A power loss: nothing runs, a new boot ID, the boot clock restarts.
    pub fn power_loss(&self) {
        self.with(|s| {
            s.active.clear();
            s.running_version = None;
            s.boot_id = format!("{}-next", s.boot_id);
            s.boottime_ms = 5_000;
            s.log.push("power loss".into());
        });
    }

    /// The boot: enabled units start (the guard first, when it is armed; the
    /// caller runs it) and then Edge.
    pub fn boot_edge(&self) {
        let version = self.current();
        self.with(|s| {
            s.active.insert(EDGE_DAEMON.into());
            s.active.insert(EDGE_RENDERER.into());
            s.running_version = version;
        });
    }

    pub fn advance(&self, duration: Duration) {
        self.with(|s| s.boottime_ms += duration.as_millis() as i64);
    }
}

pub fn status_for(version: &str, behavior: Behavior) -> Option<DaemonStatus> {
    let mut status = crate::evidence::tests::status(version);
    match behavior {
        Behavior::Healthy => {}
        Behavior::NoServer => status.link.state = ShortToken::new("retrying").unwrap(),
        Behavior::NoEvidence => status.presentation.as_mut().unwrap().evidence = false,
        Behavior::SafeMode => status.renderer.state = ShortToken::new("safe_mode").unwrap(),
        Behavior::NewerSchemaRefused => {
            status.mode = DaemonMode::Recovery;
            status.recovery_reason = ShortToken::new("state_db_newer_schema").ok();
        }
        Behavior::Silent => return None,
    }
    Some(status)
}

#[async_trait]
impl UpdateHost for FakeHost {
    async fn stop(&self, unit: &str) -> Result<(), HostError> {
        self.with(|s| {
            s.active.remove(unit);
            if unit == EDGE_DAEMON {
                s.running_version = None;
            }
            s.log.push(format!("stop {unit}"));
        });
        Ok(())
    }

    async fn start(&self, unit: &str) -> Result<(), HostError> {
        let version = self.current();
        self.with(|s| {
            if s.active.insert(unit.to_owned()) && unit == EDGE_DAEMON {
                s.running_version = version;
            }
            s.log.push(format!("start {unit}"));
        });
        Ok(())
    }

    async fn reload(&self) -> Result<(), HostError> {
        self.with(|s| s.reloads += 1);
        Ok(())
    }

    async fn apply_system_configuration(&self) -> Result<(), HostError> {
        self.with(|s| s.configuration_runs += 1);
        Ok(())
    }

    async fn arm_guard(&self, previous_version: &str) -> Result<(), HostError> {
        self.with(|s| {
            s.guard_armed_for = Some(previous_version.to_owned());
            s.log.push(format!("arm guard {previous_version}"));
        });
        Ok(())
    }

    async fn disarm_guard(&self) -> Result<(), HostError> {
        self.with(|s| s.guard_armed_for = None);
        Ok(())
    }

    async fn restarts(&self, unit: &str) -> Result<u64, HostError> {
        Ok(self.with(|s| s.restarts.get(unit).copied().unwrap_or(0)))
    }

    async fn daemon_status(&self) -> Option<DaemonStatus> {
        let (version, behavior) = self.with(|s| {
            let version = s.running_version.clone().filter(|_| s.active.contains(EDGE_DAEMON))?;
            let behavior = s.behavior.get(&version).copied().unwrap_or(Behavior::Healthy);
            Some((version, behavior))
        })?;
        status_for(&version, behavior)
    }

    fn boot_id(&self) -> String {
        self.with(|s| s.boot_id.clone())
    }

    fn boottime_ms(&self) -> i64 {
        self.with(|s| s.boottime_ms)
    }

    fn now_ms(&self) -> i64 {
        1_700_000_000_000 + self.boottime_ms()
    }

    async fn sleep(&self, duration: Duration) {
        self.advance(duration);
    }
}
