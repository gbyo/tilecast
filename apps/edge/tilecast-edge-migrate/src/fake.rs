//! An in-memory machine for the migration tests. It models unit-file and
//! runtime state for the system and kiosk managers, the legacy files, the
//! task units and the Edge daemon's status, and it records every moment that
//! breaks a migration invariant:
//!
//! * I1: both stacks enabled on disk;
//! * I2: both stacks active (two holders of the device credential);
//! * a legacy file changed.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::Timestamp;
use edge_protocol::bounded::ShortToken;
use edge_protocol::ipc::status::DaemonStatus;
use serde_json::json;

use crate::host::*;
use crate::state::{FileDigest, KioskRecord, ReleaseRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    /// Connects, shows the server's presentation and keeps progressing.
    Healthy,
    /// Never reaches the server.
    NeverConnects,
    /// The server's presentation is incompatible with the renderer.
    Incompatible,
    /// Accepted with evidence once, then the screen freezes.
    Frozen,
    /// The legacy player comes back while Edge settles.
    LegacyReturns,
    /// A fresh installation on its setup surface (clean install).
    Unpaired,
}

#[derive(Debug, Clone, Copy, Default)]
struct Unit {
    enabled: bool,
    active: bool,
}

#[derive(Debug)]
pub struct World {
    pub now_ms: i64,
    units: HashMap<String, Unit>,
    pub legacy: (bool, bool),
    legacy_files: BTreeMap<String, Vec<u8>>,
    pub probation: bool,
    pub staged: bool,
    pub violations: Vec<String>,
    pub edge: Edge,
    pub probe_usable: bool,
    pub self_test_passes: bool,
    pub compat_exit: i32,
    pub import_exit: i32,
    pub imports: usize,
    daemon_started_ms: i64,
    pub has_display_manager: bool,
    pub legacy_installed: bool,
}

pub struct FakeHost {
    pub world: Mutex<World>,
}

impl FakeHost {
    pub fn migration() -> Self {
        let mut units = HashMap::new();
        units.insert("gdm3.service".to_owned(), Unit { enabled: true, active: true });
        units.insert(CONSOLE_UNIT.to_owned(), Unit { enabled: true, active: false });
        let legacy_files = [
            ("installation.json", &b"{\"playerInstallationId\":\"p\"}"[..]),
            ("credential.json", b"{\"deviceCredential\":\"secret\"}"),
            ("manifest-active.json", b"{}"),
        ]
        .into_iter()
        .map(|(name, bytes)| (name.to_owned(), bytes.to_vec()))
        .collect();
        Self {
            world: Mutex::new(World {
                now_ms: 1_800_000_000_000,
                units,
                legacy: (true, true),
                legacy_files,
                probation: false,
                staged: false,
                violations: vec![],
                edge: Edge::Healthy,
                probe_usable: true,
                self_test_passes: true,
                compat_exit: 0,
                import_exit: 0,
                imports: 0,
                daemon_started_ms: 0,
                has_display_manager: true,
                legacy_installed: true,
            }),
        }
    }

    pub fn clean() -> Self {
        let host = Self::migration();
        {
            let mut world = host.world.lock().unwrap();
            world.legacy = (false, false);
            world.legacy_installed = false;
            world.legacy_files.clear();
        }
        host
    }

    pub fn with(self, change: impl FnOnce(&mut World)) -> Self {
        change(&mut self.world.lock().unwrap());
        self
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }

    pub fn unit_state(&self, name: &str) -> (bool, bool) {
        let unit = self.world().units.get(name).copied().unwrap_or_default();
        (unit.enabled, unit.active)
    }

    /// A reboot: runtime state is lost and enabled units start after the
    /// boot recovery has run (which is ordered before them).
    pub fn reboot(&self) {
        let mut world = self.world();
        for unit in world.units.values_mut() {
            unit.active = false;
        }
        world.legacy.1 = false;
        world.probation = false;
    }

    pub fn finish_boot(&self) {
        let mut world = self.world();
        let names: Vec<String> = world.units.keys().cloned().collect();
        for name in names {
            if world.units[&name].enabled && !name.contains("migrate") {
                world.units.get_mut(&name).unwrap().active = true;
            }
        }
        if world.legacy.0 {
            world.legacy.1 = true;
        }
        world.check();
    }
}

impl World {
    fn edge_enabled(&self) -> bool {
        EDGE_UNITS.iter().any(|u| self.units.get(*u).is_some_and(|s| s.enabled))
    }

    fn edge_active(&self) -> bool {
        EDGE_UNITS.iter().any(|u| self.units.get(*u).is_some_and(|s| s.active))
    }

    fn check(&mut self) {
        if self.edge_enabled() && self.legacy.0 {
            self.violations.push("I1: both stacks enabled".into());
        }
        if self.edge_active() && self.legacy.1 {
            self.violations.push("I2: both stacks active".into());
        }
    }

    pub fn legacy_file_digests(&self) -> Vec<FileDigest> {
        self.legacy_files
            .iter()
            .map(|(path, bytes)| FileDigest {
                path: path.clone(),
                sha256: edge_protocol::Sha256Digest::of(bytes).to_hex(),
                size: bytes.len() as u64,
            })
            .collect()
    }

    fn status(&self) -> Option<DaemonStatus> {
        let daemon = self.units.get(EDGE_DAEMON).is_some_and(|u| u.active);
        if !daemon {
            return None;
        }
        let renderer = self.units.get(EDGE_RENDERER).is_some_and(|u| u.active);
        let mut status = crate::settle::tests::status(self.now_ms);
        status.started_at = Timestamp::from_unix_millis(self.daemon_started_ms).unwrap();
        status.renderer.connected = renderer;
        match self.edge {
            Edge::Healthy | Edge::LegacyReturns => {}
            Edge::NeverConnects => status.link.state = ShortToken::new("retrying").unwrap(),
            Edge::Incompatible => {
                status.renderer.incompatible_reason = Some(edge_protocol::bounded::SafeText::lossy("website"))
            }
            Edge::Frozen => status.renderer.last_progress_at = Timestamp::from_unix_millis(self.daemon_started_ms),
            Edge::Unpaired => {
                status.server = None;
                status.link.state = ShortToken::new("unbound").unwrap();
                status.link.last_contact_at = None;
                let presentation = status.presentation.as_mut().unwrap();
                presentation.source = ShortToken::new("status_surface").unwrap();
                presentation.manifest_sha256 = None;
                presentation.target_manifest_sha256 = None;
            }
        }
        Some(status)
    }
}

fn resolve(name: &str) -> &str {
    if name == DISPLAY_MANAGER_UNIT { "gdm3.service" } else { name }
}

#[async_trait]
impl Host for FakeHost {
    async fn unit(&self, name: &str) -> Result<UnitState, HostError> {
        let world = self.world();
        let id = resolve(name);
        if name == DISPLAY_MANAGER_UNIT && !world.has_display_manager {
            return Ok(UnitState::default());
        }
        let unit = world.units.get(id).copied().unwrap_or_default();
        Ok(UnitState { loaded: true, id: id.to_owned(), enabled: unit.enabled, active: unit.active })
    }

    async fn enable(&self, units: &[&str]) -> Result<(), HostError> {
        let mut world = self.world();
        for unit in units {
            world.units.entry(resolve(unit).to_owned()).or_default().enabled = true;
        }
        world.check();
        Ok(())
    }

    async fn disable(&self, units: &[&str]) -> Result<(), HostError> {
        let mut world = self.world();
        for unit in units {
            world.units.entry(resolve(unit).to_owned()).or_default().enabled = false;
        }
        Ok(())
    }

    async fn start(&self, unit: &str) -> Result<(), HostError> {
        let mut world = self.world();
        if unit == EDGE_DAEMON {
            world.daemon_started_ms = world.now_ms;
        }
        world.units.entry(resolve(unit).to_owned()).or_default().active = true;
        world.check();
        Ok(())
    }

    async fn arm_recovery(&self) -> Result<(), HostError> {
        self.enable(&[RECOVER_UNIT]).await
    }

    async fn disarm_recovery(&self) -> Result<(), HostError> {
        self.disable(&[RECOVER_UNIT]).await
    }

    async fn start_detached(&self, unit: &str) -> Result<(), HostError> {
        self.start(unit).await
    }

    async fn stop(&self, unit: &str) -> Result<(), HostError> {
        self.world().units.entry(resolve(unit).to_owned()).or_default().active = false;
        Ok(())
    }

    async fn run_task(&self, unit: &str, _output: &str, _timeout: Duration) -> Result<TaskResult, HostError> {
        let mut world = self.world();
        let (exit_status, output) = match unit {
            DRM_PROBE_UNIT => (if world.probe_usable { 0 } else { 5 }, json!({"usable": world.probe_usable})),
            SELFTEST_HOST_UNIT => {
                if world.self_test_passes {
                    (0, json!({"outcome": "passed"}))
                } else {
                    (1, json!({"outcome": "failed", "reason": "evidence_timeout"}))
                }
            }
            COMPAT_UNIT => (world.compat_exit, json!({"outcome": "compatible"})),
            IMPORT_UNIT => {
                assert!(world.staged, "the import reads the staged copy");
                assert!(!world.legacy.1 && !world.edge_active(), "import runs with neither stack active");
                world.imports += 1;
                if world.import_exit == 0 {
                    (0, json!({"outcome": "imported"}))
                } else {
                    (1, json!({"outcome": "failed", "reason": "installation_identity_mismatch"}))
                }
            }
            other => return Err(HostError::failed(format!("unexpected task {other}"))),
        };
        Ok(TaskResult { exit_status, output: Some(output) })
    }

    async fn resolve_kiosk(&self, user: &str) -> Result<KioskRecord, HostError> {
        Ok(KioskRecord {
            user: user.to_owned(),
            uid: 1000,
            home: "/home/kiosk".into(),
            data_dir: "/home/kiosk/.local/share/tilecast-player".into(),
        })
    }

    async fn legacy_unit(&self, _kiosk: &KioskRecord) -> Result<UnitState, HostError> {
        let world = self.world();
        Ok(UnitState {
            loaded: world.legacy_installed,
            id: LEGACY_UNIT.into(),
            enabled: world.legacy.0,
            active: world.legacy.1,
        })
    }

    async fn legacy_enable(&self, _kiosk: &KioskRecord) -> Result<(), HostError> {
        let mut world = self.world();
        world.legacy.0 = true;
        world.check();
        Ok(())
    }

    async fn legacy_disable(&self, _kiosk: &KioskRecord) -> Result<(), HostError> {
        self.world().legacy.0 = false;
        Ok(())
    }

    async fn legacy_start(&self, _kiosk: &KioskRecord) -> Result<(), HostError> {
        let mut world = self.world();
        world.legacy.1 = true;
        world.check();
        Ok(())
    }

    async fn legacy_stop(&self, _kiosk: &KioskRecord) -> Result<(), HostError> {
        self.world().legacy.1 = false;
        Ok(())
    }

    fn legacy_processes(&self, _kiosk: Option<&KioskRecord>) -> Result<usize, HostError> {
        Ok(usize::from(self.world().legacy.1))
    }

    fn snapshot_legacy(&self, _kiosk: &KioskRecord) -> Result<Vec<FileDigest>, HostError> {
        Ok(self.world().legacy_file_digests())
    }

    fn stage_compat(&self, _kiosk: &KioskRecord) -> Result<(), HostError> {
        Ok(())
    }

    fn stage_import(&self, _kiosk: &KioskRecord, budget: u64) -> Result<StageSummary, HostError> {
        let mut world = self.world();
        world.staged = true;
        Ok(StageSummary { state_files: 3, media_files: 0, media_bytes: 0, media_copied: budget > 0 })
    }

    fn clear_import_stage(&self) -> Result<(), HostError> {
        self.world().staged = false;
        Ok(())
    }

    fn free_state_bytes(&self) -> Result<u64, HostError> {
        Ok(64 * 1024 * 1024 * 1024)
    }

    fn set_probation(&self, on: bool) -> Result<(), HostError> {
        self.world().probation = on;
        Ok(())
    }

    fn verify_release(&self) -> Result<ReleaseRef, HostError> {
        Ok(ReleaseRef { version_name: "0.1.0".into(), version_code: 1000, manifest_sha256: "ab".repeat(32) })
    }

    async fn edge_status(&self) -> Option<DaemonStatus> {
        let mut world = self.world();
        if world.edge == Edge::LegacyReturns && world.now_ms - world.daemon_started_ms > 20_000 {
            world.legacy.1 = true;
        }
        world.status()
    }

    fn now_ms(&self) -> i64 {
        self.world().now_ms
    }

    async fn sleep(&self, duration: Duration) {
        self.world().now_ms += duration.as_millis() as i64;
    }
}
