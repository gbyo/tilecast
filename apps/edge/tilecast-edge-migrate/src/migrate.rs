//! The migration and clean-install state machine.
//!
//! The binding sequence (Edge handoff §12) and where each step lives:
//!
//! | Step | What                                              | Phase after it   |
//! | ---- | ------------------------------------------------- | ---------------- |
//! | 1–2  | install and verify the signed release (`install`) | (before `run`)   |
//! | 2    | re-verify the installed tree                      | `Started`        |
//! | 3    | self-test: DRM probe and the self-test host       | `SelfTested`     |
//! | 4    | legacy presentation against the capability profile | `CompatChecked`  |
//! | 5    | migration lock (held by the process throughout)   |                  |
//! | 6    | stop and disable legacy and the display session   | `LegacyStopped`  |
//! | 7    | legacy files are never changed; hashed before and after |            |
//! | 8    | `tilecastd import-legacy --refresh`               | `Imported`       |
//! | 9    | enable and start Edge                             | `Settling`       |
//! | 10   | bounded settlement ([`crate::settle`])            |                  |
//! | 11   | accept                                            | `Accepted`       |
//! | 12   | otherwise roll back to the legacy player          | `RolledBack`     |
//!
//! Rules:
//!
//! * An intent phase is durable before its side effects start, so recovery
//!   after a crash knows what may have happened.
//! * Enablement changes before runtime state: the legacy unit is disabled
//!   before Edge is enabled, and Edge is disabled before the legacy unit is
//!   enabled again, so at most one stack is enabled on disk at any moment.
//!   Edge is confirmed inactive before the legacy player starts again, so
//!   only one stack holds the device credential.
//! * A crash before the cutover refuses the attempt (nothing changed). A
//!   crash during the cutover or settlement rolls back; it never accepts.
//! * Acceptance ends the rollback window. Legacy files are never removed
//!   here; that is a later maintenance action.

use std::time::Duration;

use serde_json::Value;

use crate::host::{
    COMPAT_OUTPUT, COMPAT_UNIT, CONSOLE_UNIT, DISPLAY_MANAGER_UNIT, DRM_PROBE_OUTPUT, DRM_PROBE_UNIT, EDGE_DAEMON,
    EDGE_ENABLED_UNITS, EDGE_RENDERER, EDGE_UNITS, Host, HostError, IMPORT_OUTPUT, IMPORT_UNIT, SELFTEST_HOST_UNIT,
    SELFTEST_OUTPUT, SELFTEST_RENDERER_UNIT, UPDATE_SOCKET,
};
use crate::settle::{Expectation, Verdict, evaluate, summary};
use crate::state::{Attempt, Backend, Kind, Phase, SCHEMA_VERSION, StateError, StateStore, UnitRecord};

/// Free space kept after the media copy and its import into the content
/// store (the legacy player's reserve).
const RESERVED_FREE_BYTES: u64 = 1024 * 1024 * 1024;
pub const SETTLE_SECONDS_RANGE: std::ops::RangeInclusive<u64> = 120..=3_600;
pub const DEFAULT_SETTLE_SECONDS: u64 = 600;

#[derive(Debug, Clone)]
pub struct Options {
    pub kind: Kind,
    pub kiosk_user: Option<String>,
    pub backend: Backend,
    pub settle_seconds: u64,
}

/// Durations, shortened by tests.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub poll: Duration,
    /// How long every settlement condition must hold without a break.
    pub stable: Duration,
    pub clean_stable: Duration,
    pub probe_timeout: Duration,
    pub self_test_timeout: Duration,
    pub compat_timeout: Duration,
    pub import_timeout: Duration,
    /// How long a rollback waits to see the legacy player active again.
    pub legacy_wait: Duration,
    pub process_exit_wait: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(2),
            stable: Duration::from_secs(60),
            clean_stable: Duration::from_secs(20),
            probe_timeout: Duration::from_secs(30),
            self_test_timeout: Duration::from_secs(150),
            compat_timeout: Duration::from_secs(60),
            import_timeout: Duration::from_secs(900),
            legacy_wait: Duration::from_secs(120),
            process_exit_wait: Duration::from_secs(15),
        }
    }
}

/// Every point where a crash leaves a distinct durable state. The crash
/// tests run each of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CrashPoint {
    AfterStarted,
    AfterSelfTest,
    AfterCompat,
    AfterCutoverIntent,
    AfterProbation,
    AfterRecoverEnabled,
    AfterLegacyDisabled,
    AfterLegacyStopped,
    AfterDisplayStopped,
    AfterLegacyStoppedSaved,
    AfterStage,
    AfterImport,
    AfterImportedSaved,
    AfterEdgeStartIntent,
    AfterEdgeEnabled,
    AfterDaemonStarted,
    AfterRendererStarted,
    AfterSettlingSaved,
    DuringSettling,
    AfterAcceptIntent,
    AfterProbationCleared,
    AfterRecoverDisabled,
    AfterRollbackIntent,
    AfterEdgeDisabled,
    AfterEdgeStopped,
    AfterDisplayRestored,
    AfterLegacyEnabled,
    AfterLegacyStarted,
}

impl CrashPoint {
    pub const ALL: [CrashPoint; 28] = [
        Self::AfterStarted,
        Self::AfterSelfTest,
        Self::AfterCompat,
        Self::AfterCutoverIntent,
        Self::AfterProbation,
        Self::AfterRecoverEnabled,
        Self::AfterLegacyDisabled,
        Self::AfterLegacyStopped,
        Self::AfterDisplayStopped,
        Self::AfterLegacyStoppedSaved,
        Self::AfterStage,
        Self::AfterImport,
        Self::AfterImportedSaved,
        Self::AfterEdgeStartIntent,
        Self::AfterEdgeEnabled,
        Self::AfterDaemonStarted,
        Self::AfterRendererStarted,
        Self::AfterSettlingSaved,
        Self::DuringSettling,
        Self::AfterAcceptIntent,
        Self::AfterProbationCleared,
        Self::AfterRecoverDisabled,
        Self::AfterRollbackIntent,
        Self::AfterEdgeDisabled,
        Self::AfterEdgeStopped,
        Self::AfterDisplayRestored,
        Self::AfterLegacyEnabled,
        Self::AfterLegacyStarted,
    ];

    pub fn name(self) -> String {
        format!("{self:?}")
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|point| point.name() == value)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    /// Fault injection: the process "died" here.
    #[error("crash injected at {0:?}")]
    Crashed(CrashPoint),
    #[error(transparent)]
    State(#[from] StateError),
    #[error("an unfinished attempt exists; run `tilecast-edge-migrate recover` first")]
    Unfinished,
    #[error("the installed release is not valid: {0}")]
    Release(String),
    /// A rollback could not confirm Edge stopped. The attempt stays in
    /// `RollbackIntent` and the boot recovery retries; the legacy player is
    /// not started while Edge may still run.
    #[error("rollback incomplete: {0}")]
    RollbackIncomplete(String),
    #[error("the rollback window has ended: the migration was accepted")]
    AlreadyAccepted,
    /// Acceptance could not finish its side effects; the boot recovery
    /// retries from `AcceptIntent`.
    #[error("acceptance incomplete: {0}")]
    AcceptIncomplete(String),
}

pub struct Migrator<'a, H: Host> {
    host: &'a H,
    store: StateStore,
    timing: Timing,
    crash_at: Option<CrashPoint>,
}

impl<H: Host> std::fmt::Debug for Migrator<'_, H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Migrator").field("store", &self.store).finish_non_exhaustive()
    }
}

type Step = Result<(), MigrateError>;

enum Stop {
    /// Refuse before the cutover.
    Refuse(String),
    /// Roll back after the cutover started.
    Rollback(String),
    Error(MigrateError),
}

impl From<MigrateError> for Stop {
    fn from(error: MigrateError) -> Self {
        Self::Error(error)
    }
}

impl From<StateError> for Stop {
    fn from(error: StateError) -> Self {
        Self::Error(error.into())
    }
}

fn refuse(reason: impl Into<String>) -> Stop {
    Stop::Refuse(reason.into())
}

fn roll_back(reason: impl Into<String>) -> Stop {
    Stop::Rollback(reason.into())
}

fn host_reason(prefix: &str, error: &HostError) -> String {
    let detail: String = error.to_string().chars().take(160).collect();
    format!("{prefix}: {detail}")
}

impl<'a, H: Host> Migrator<'a, H> {
    pub fn new(host: &'a H, store: StateStore) -> Self {
        Self { host, store, timing: Timing::default(), crash_at: None }
    }

    pub fn with_timing(mut self, timing: Timing) -> Self {
        self.timing = timing;
        self
    }

    /// Fault injection for tests and the `integration-test` build.
    pub fn crash_at(mut self, point: Option<CrashPoint>) -> Self {
        self.crash_at = point;
        self
    }

    fn crash(&self, point: CrashPoint) -> Step {
        if self.crash_at == Some(point) {
            tracing::error!(component = "migrate", event = "crash_injected", point = ?point);
            return Err(MigrateError::Crashed(point));
        }
        Ok(())
    }

    fn save(&self, attempt: &mut Attempt, phase: Phase, detail: &str) -> Step {
        attempt.phase = phase;
        attempt.record(self.host.now_ms(), detail);
        tracing::info!(component = "migrate", event = "phase", phase = ?phase, detail);
        self.store.save(attempt)?;
        Ok(())
    }

    /// Runs a new attempt to a terminal phase.
    pub async fn run(&self, options: &Options) -> Result<Attempt, MigrateError> {
        if let Some(previous) = self.store.load()? {
            if !previous.phase.is_terminal() {
                return Err(MigrateError::Unfinished);
            }
            self.store.archive(&previous)?;
        }
        let release = self.host.verify_release().map_err(|e| MigrateError::Release(e.to_string()))?;
        let mut attempt = Attempt {
            schema_version: SCHEMA_VERSION,
            attempt_id: uuid::Uuid::new_v4().to_string(),
            kind: options.kind,
            phase: Phase::Started,
            backend: options.backend,
            release,
            kiosk: None,
            legacy_unit: None,
            display_units: vec![],
            legacy_files: vec![],
            drm_probe: None,
            self_test: None,
            compat: None,
            import: None,
            media_copied: None,
            settle_seconds: options.settle_seconds.clamp(*SETTLE_SECONDS_RANGE.start(), *SETTLE_SECONDS_RANGE.end()),
            edge_started_at_ms: None,
            settle_deadline_ms: None,
            settlement: None,
            reason: None,
            legacy_files_unchanged: None,
            legacy_active_after_rollback: None,
            events: vec![],
            updated_at_ms: 0,
        };
        self.save(&mut attempt, Phase::Started, "release verified")?;
        self.crash(CrashPoint::AfterStarted)?;
        match self.forward(&mut attempt, options).await {
            Ok(()) => Ok(attempt),
            Err(Stop::Refuse(reason)) => {
                self.refuse(&mut attempt, &reason).await?;
                Ok(attempt)
            }
            Err(Stop::Rollback(reason)) => {
                self.rollback(&mut attempt, &reason).await?;
                Ok(attempt)
            }
            Err(Stop::Error(error)) => Err(error),
        }
    }

    async fn forward(&self, attempt: &mut Attempt, options: &Options) -> Result<(), Stop> {
        self.preflight(attempt, options).await?;
        self.self_test(attempt).await?;
        if attempt.kind == Kind::Migration {
            self.compat(attempt).await?;
        }
        self.cutover(attempt).await?;
        if attempt.kind == Kind::Migration {
            self.import(attempt).await?;
        }
        self.start_edge(attempt).await?;
        self.settle(attempt).await?;
        self.save(attempt, Phase::AcceptIntent, "settlement passed")?;
        self.crash(CrashPoint::AfterAcceptIntent)?;
        self.finish_accept(attempt).await?;
        Ok(())
    }

    async fn preflight(&self, attempt: &mut Attempt, options: &Options) -> Result<(), Stop> {
        for unit in EDGE_UNITS {
            let state = self.host.unit(unit).await.map_err(|e| refuse(host_reason("unit_state_unreadable", &e)))?;
            if state.enabled || state.active {
                return Err(refuse("edge_already_enabled"));
            }
        }
        match options.kind {
            Kind::Migration => {
                let user = options.kiosk_user.as_deref().ok_or_else(|| refuse("kiosk_account_required"))?;
                let kiosk =
                    self.host.resolve_kiosk(user).await.map_err(|e| refuse(host_reason("kiosk_account", &e)))?;
                let legacy = self.host.legacy_unit(&kiosk).await.map_err(|e| refuse(host_reason("legacy_unit", &e)))?;
                if !legacy.loaded {
                    return Err(refuse("legacy_unit_not_found"));
                }
                attempt.legacy_unit =
                    Some(UnitRecord { name: legacy.id, was_enabled: legacy.enabled, was_active: legacy.active });
                let files = self.host.snapshot_legacy(&kiosk).map_err(|e| refuse(host_reason("legacy_state", &e)))?;
                if !files.iter().any(|file| file.path == "credential.json") {
                    return Err(refuse("legacy_player_not_paired"));
                }
                attempt.legacy_files = files;
                attempt.kiosk = Some(kiosk);
            }
            Kind::CleanInstall => {
                let running = self.host.legacy_processes(None).map_err(|e| refuse(host_reason("process_scan", &e)))?;
                if running > 0 {
                    return Err(refuse("legacy_player_running"));
                }
            }
        }
        if attempt.backend == Backend::Drm {
            for name in [DISPLAY_MANAGER_UNIT, CONSOLE_UNIT] {
                let state = self.host.unit(name).await.map_err(|e| refuse(host_reason("display_unit", &e)))?;
                if state.loaded && (state.enabled || state.active) {
                    attempt.display_units.push(UnitRecord {
                        name: state.id,
                        was_enabled: state.enabled,
                        was_active: state.active,
                    });
                }
            }
        }
        self.save(attempt, Phase::Started, "preflight passed")?;
        Ok(())
    }

    async fn self_test(&self, attempt: &mut Attempt) -> Result<(), Stop> {
        if attempt.backend == Backend::Drm {
            let probe = self
                .host
                .run_task(DRM_PROBE_UNIT, DRM_PROBE_OUTPUT, self.timing.probe_timeout)
                .await
                .map_err(|e| refuse(host_reason("drm_probe_failed", &e)))?;
            let usable = probe.output.as_ref().and_then(|o| o.get("usable")).and_then(Value::as_bool);
            attempt.drm_probe = probe.output;
            if probe.exit_status != 0 || usable != Some(true) {
                return Err(refuse("drm_output_unavailable"));
            }
        }
        // The renderer waits for the host's socket, so it can start first.
        let _ = self.host.start_detached(SELFTEST_RENDERER_UNIT).await;
        let result = self.host.run_task(SELFTEST_HOST_UNIT, SELFTEST_OUTPUT, self.timing.self_test_timeout).await;
        let _ = self.host.stop(SELFTEST_RENDERER_UNIT).await;
        let result = result.map_err(|e| refuse(host_reason("self_test_failed", &e)))?;
        let passed = result.output.as_ref().and_then(|o| o.get("outcome")).and_then(Value::as_str) == Some("passed");
        let reason = result.output.as_ref().and_then(|o| o.get("reason")).and_then(Value::as_str).map(str::to_owned);
        attempt.self_test = result.output;
        if result.exit_status != 0 || !passed {
            return Err(refuse(format!("self_test_failed: {}", reason.unwrap_or_else(|| "no report".into()))));
        }
        self.save(attempt, Phase::SelfTested, "self-test passed")?;
        self.crash(CrashPoint::AfterSelfTest)?;
        Ok(())
    }

    async fn compat(&self, attempt: &mut Attempt) -> Result<(), Stop> {
        let kiosk = attempt.kiosk.clone().ok_or_else(|| refuse("kiosk_account_required"))?;
        self.host.stage_compat(&kiosk).map_err(|e| refuse(host_reason("legacy_state", &e)))?;
        let result = self
            .host
            .run_task(COMPAT_UNIT, COMPAT_OUTPUT, self.timing.compat_timeout)
            .await
            .map_err(|e| refuse(host_reason("compat_check_failed", &e)))?;
        attempt.compat = result.output;
        match result.exit_status {
            0 => {}
            3 => return Err(refuse("legacy_presentation_incompatible")),
            _ => return Err(refuse("compat_check_failed")),
        }
        self.save(attempt, Phase::CompatChecked, "legacy presentation is compatible")?;
        self.crash(CrashPoint::AfterCompat)?;
        Ok(())
    }

    /// Steps 5–7: stop the legacy player and the display session.
    async fn cutover(&self, attempt: &mut Attempt) -> Result<(), Stop> {
        self.save(attempt, Phase::CutoverIntent, "cutover starts")?;
        self.crash(CrashPoint::AfterCutoverIntent)?;
        self.host.set_probation(true).map_err(|e| roll_back(host_reason("probation_marker", &e)))?;
        self.crash(CrashPoint::AfterProbation)?;
        self.host.arm_recovery().await.map_err(|e| roll_back(host_reason("recover_unit", &e)))?;
        self.crash(CrashPoint::AfterRecoverEnabled)?;
        if let Some(kiosk) = attempt.kiosk.clone() {
            self.host.legacy_disable(&kiosk).await.map_err(|e| roll_back(host_reason("legacy_disable", &e)))?;
            self.crash(CrashPoint::AfterLegacyDisabled)?;
            self.host.legacy_stop(&kiosk).await.map_err(|e| roll_back(host_reason("legacy_stop", &e)))?;
            self.crash(CrashPoint::AfterLegacyStopped)?;
        }
        for unit in attempt.display_units.clone() {
            self.host
                .disable(&[unit.name.as_str()])
                .await
                .map_err(|e| roll_back(host_reason("display_disable", &e)))?;
            self.host.stop(&unit.name).await.map_err(|e| roll_back(host_reason("display_stop", &e)))?;
        }
        self.crash(CrashPoint::AfterDisplayStopped)?;
        if let Some(kiosk) = attempt.kiosk.clone() {
            let state = self.host.legacy_unit(&kiosk).await.map_err(|e| roll_back(host_reason("legacy_unit", &e)))?;
            if state.enabled || state.active {
                return Err(roll_back("legacy_still_enabled"));
            }
        }
        let deadline = self.host.now_ms() + self.timing.process_exit_wait.as_millis() as i64;
        loop {
            let running = self
                .host
                .legacy_processes(attempt.kiosk.as_ref())
                .map_err(|e| roll_back(host_reason("process_scan", &e)))?;
            if running == 0 {
                break;
            }
            if self.host.now_ms() >= deadline {
                return Err(roll_back("legacy_still_running"));
            }
            self.host.sleep(Duration::from_millis(500)).await;
        }
        // The legacy player may write its own files while it runs; the
        // reference snapshot is the one taken after it stopped.
        if let Some(kiosk) = attempt.kiosk.clone() {
            attempt.legacy_files =
                self.host.snapshot_legacy(&kiosk).map_err(|e| roll_back(host_reason("legacy_state", &e)))?;
        }
        self.save(attempt, Phase::LegacyStopped, "legacy player and display session stopped")?;
        self.crash(CrashPoint::AfterLegacyStoppedSaved)?;
        Ok(())
    }

    /// Step 8.
    async fn import(&self, attempt: &mut Attempt) -> Result<(), Stop> {
        let kiosk = attempt.kiosk.clone().ok_or_else(|| roll_back("kiosk_account_required"))?;
        // The media is copied once for the import and once more into the
        // content store; copy it only if both fit above the reserve.
        let free = self.host.free_state_bytes().unwrap_or(0);
        let budget = free.saturating_sub(RESERVED_FREE_BYTES) / 2;
        let staged = self.host.stage_import(&kiosk, budget);
        let staged = match staged {
            Ok(staged) => staged,
            Err(error) => {
                let _ = self.host.clear_import_stage();
                return Err(roll_back(host_reason("legacy_copy_failed", &error)));
            }
        };
        attempt.media_copied = Some(staged.media_copied);
        self.crash(CrashPoint::AfterStage)?;
        let result = self.host.run_task(IMPORT_UNIT, IMPORT_OUTPUT, self.timing.import_timeout).await;
        // The copy holds a copy of the credential file: never keep it.
        let cleared = self.host.clear_import_stage();
        let result = result.map_err(|e| roll_back(host_reason("import_failed", &e)))?;
        cleared.map_err(|e| roll_back(host_reason("legacy_copy_not_removed", &e)))?;
        let outcome = result.output.as_ref().and_then(|o| o.get("outcome")).and_then(Value::as_str);
        let reason = result.output.as_ref().and_then(|o| o.get("reason")).and_then(Value::as_str).map(str::to_owned);
        attempt.import = result.output.clone();
        self.crash(CrashPoint::AfterImport)?;
        if result.exit_status != 0 || !matches!(outcome, Some("imported" | "already_complete")) {
            return Err(roll_back(format!("import_failed: {}", reason.unwrap_or_else(|| "no report".into()))));
        }
        self.save(attempt, Phase::Imported, "legacy state imported")?;
        self.crash(CrashPoint::AfterImportedSaved)?;
        Ok(())
    }

    /// Step 9.
    async fn start_edge(&self, attempt: &mut Attempt) -> Result<(), Stop> {
        self.save(attempt, Phase::EdgeStartIntent, "enabling Edge")?;
        self.crash(CrashPoint::AfterEdgeStartIntent)?;
        self.host.enable(&EDGE_ENABLED_UNITS).await.map_err(|e| roll_back(host_reason("edge_enable", &e)))?;
        self.crash(CrashPoint::AfterEdgeEnabled)?;
        // The update helper's socket: tilecastd can ask for updates from its
        // first start. Only a request ever starts the helper itself.
        let _ = self.host.start_detached(UPDATE_SOCKET).await;
        attempt.edge_started_at_ms = Some(self.host.now_ms());
        self.host.start(EDGE_DAEMON).await.map_err(|e| roll_back(host_reason("edge_start_failed", &e)))?;
        self.crash(CrashPoint::AfterDaemonStarted)?;
        self.host.start(EDGE_RENDERER).await.map_err(|e| roll_back(host_reason("renderer_start_failed", &e)))?;
        self.crash(CrashPoint::AfterRendererStarted)?;
        attempt.settle_deadline_ms = Some(self.host.now_ms() + attempt.settle_seconds as i64 * 1_000);
        self.save(attempt, Phase::Settling, "Edge started; settling")?;
        self.crash(CrashPoint::AfterSettlingSaved)?;
        Ok(())
    }

    /// Step 10.
    async fn settle(&self, attempt: &mut Attempt) -> Result<(), Stop> {
        let expected = Expectation {
            kind: attempt.kind,
            platform: attempt.backend.platform(),
            edge_started_at_ms: attempt.edge_started_at_ms.unwrap_or_default(),
        };
        let deadline = attempt.settle_deadline_ms.unwrap_or_default();
        let stable_ms = match attempt.kind {
            Kind::Migration => self.timing.stable.as_millis() as i64,
            Kind::CleanInstall => self.timing.clean_stable.as_millis() as i64,
        };
        let mut stable_since: Option<i64> = None;
        let mut progress_at_start = None;
        let mut daemon_started = None;
        let mut daemon_restarts = 0;
        let mut last_reason = "daemon_unreachable";
        let mut first = true;
        loop {
            if !first {
                self.crash(CrashPoint::DuringSettling)?;
            }
            first = false;
            let now = self.host.now_ms();
            if now >= deadline {
                attempt.settlement = Some(summary(self.host.edge_status().await.as_ref()));
                return Err(roll_back(format!("settlement_timeout: {last_reason}")));
            }
            let legacy_running = self
                .host
                .legacy_processes(attempt.kiosk.as_ref())
                .map_err(|e| roll_back(host_reason("process_scan", &e)))?;
            let legacy_active = match attempt.kiosk.as_ref() {
                Some(kiosk) => self.host.legacy_unit(kiosk).await.map(|u| u.active || u.enabled).unwrap_or(false),
                None => false,
            };
            if legacy_running > 0 || legacy_active {
                attempt.settlement = Some(summary(self.host.edge_status().await.as_ref()));
                return Err(roll_back("legacy_started_during_settlement"));
            }
            let status = self.host.edge_status().await;
            if let Some(started) = status.as_ref().map(|s| s.started_at) {
                if daemon_started.is_some_and(|previous| previous != started) {
                    daemon_restarts += 1;
                    stable_since = None;
                    if daemon_restarts > 3 {
                        attempt.settlement = Some(summary(status.as_ref()));
                        return Err(roll_back("daemon_restarting"));
                    }
                }
                daemon_started = Some(started);
            }
            match evaluate(status.as_ref(), &expected) {
                Verdict::Fail(reason) => {
                    attempt.settlement = Some(summary(status.as_ref()));
                    return Err(roll_back(reason));
                }
                Verdict::NotYet(reason) => {
                    if reason != last_reason || stable_since.is_some() {
                        attempt.settlement = Some(summary(status.as_ref()));
                        attempt.record(now, format!("waiting: {reason}"));
                        self.store.save(attempt)?;
                    }
                    last_reason = reason;
                    stable_since = None;
                }
                Verdict::Ready => {
                    let progress = status.as_ref().and_then(|s| s.renderer.last_progress_at);
                    let since = *stable_since.get_or_insert_with(|| {
                        progress_at_start = progress;
                        now
                    });
                    // A frozen screen keeps reporting the same last progress.
                    let advanced = attempt.kind == Kind::CleanInstall || progress != progress_at_start;
                    last_reason = if advanced { "stable_window" } else { "no_fresh_progress" };
                    if now - since >= stable_ms && advanced {
                        attempt.settlement = Some(summary(status.as_ref()));
                        return Ok(());
                    }
                }
            }
            self.host.sleep(self.timing.poll).await;
        }
    }

    async fn finish_accept(&self, attempt: &mut Attempt) -> Step {
        self.host.set_probation(false).map_err(|e| MigrateError::AcceptIncomplete(e.to_string()))?;
        self.crash(CrashPoint::AfterProbationCleared)?;
        // A failure here leaves the recover unit enabled; at boot it finds
        // AcceptIntent and finishes the acceptance.
        self.host.disarm_recovery().await.map_err(|e| MigrateError::AcceptIncomplete(e.to_string()))?;
        self.crash(CrashPoint::AfterRecoverDisabled)?;
        self.save(attempt, Phase::Accepted, "migration accepted; the rollback window has ended")?;
        Ok(())
    }

    async fn refuse(&self, attempt: &mut Attempt, reason: &str) -> Step {
        let _ = self.host.stop(SELFTEST_RENDERER_UNIT).await;
        let _ = self.host.stop(SELFTEST_HOST_UNIT).await;
        attempt.reason = Some(reason.to_owned());
        self.save(attempt, Phase::Refused, reason)
    }

    /// Step 12. Idempotent: every step checks or repeats safely, so a crash
    /// at any point is finished by running it again.
    async fn rollback(&self, attempt: &mut Attempt, reason: &str) -> Step {
        if attempt.phase != Phase::RollbackIntent {
            attempt.reason = Some(reason.to_owned());
            self.save(attempt, Phase::RollbackIntent, reason)?;
            self.crash(CrashPoint::AfterRollbackIntent)?;
        }
        // Edge first: disabled on disk, then stopped, then confirmed.
        self.host.disable(&EDGE_ENABLED_UNITS).await.map_err(|e| MigrateError::RollbackIncomplete(e.to_string()))?;
        self.crash(CrashPoint::AfterEdgeDisabled)?;
        for unit in [EDGE_RENDERER, EDGE_DAEMON, UPDATE_SOCKET] {
            let _ = self.host.stop(unit).await;
        }
        for unit in EDGE_UNITS {
            let state = self.host.unit(unit).await.map_err(|e| MigrateError::RollbackIncomplete(e.to_string()))?;
            if state.active || state.enabled {
                return Err(MigrateError::RollbackIncomplete(format!("{unit} is still enabled or active")));
            }
        }
        self.crash(CrashPoint::AfterEdgeStopped)?;
        let _ = self.host.clear_import_stage();
        let _ = self.host.stop(SELFTEST_RENDERER_UNIT).await;
        let _ = self.host.stop(SELFTEST_HOST_UNIT).await;

        // The display session, exactly as it was.
        for unit in attempt.display_units.clone() {
            if unit.was_enabled {
                self.host
                    .enable(&[unit.name.as_str()])
                    .await
                    .map_err(|e| MigrateError::RollbackIncomplete(e.to_string()))?;
            }
            if unit.was_active {
                let _ = self.host.start_detached(&unit.name).await;
            }
        }
        self.crash(CrashPoint::AfterDisplayRestored)?;

        // The legacy player, exactly as it was. Its files are compared with
        // the snapshot before it runs again and can change them itself.
        if let (Some(kiosk), Some(legacy)) = (attempt.kiosk.clone(), attempt.legacy_unit.clone()) {
            if attempt.legacy_files_unchanged.is_none() {
                let unchanged = self.host.snapshot_legacy(&kiosk).is_ok_and(|now| now == attempt.legacy_files);
                attempt.legacy_files_unchanged = Some(unchanged);
                self.store.save(attempt)?;
            }
            if legacy.was_enabled {
                // At boot the kiosk account's user manager may still be
                // starting; wait for it rather than leave no player enabled.
                let deadline = self.host.now_ms() + self.timing.legacy_wait.as_millis() as i64;
                loop {
                    match self.host.legacy_enable(&kiosk).await {
                        Ok(()) => break,
                        Err(error) if self.host.now_ms() >= deadline => {
                            return Err(MigrateError::RollbackIncomplete(error.to_string()));
                        }
                        Err(_) => self.host.sleep(Duration::from_secs(2)).await,
                    }
                }
            }
            self.crash(CrashPoint::AfterLegacyEnabled)?;
            if legacy.was_active {
                // A player tied to the graphical session may only start once
                // the session is back; enabling it is what lets that happen.
                let _ = self.host.legacy_start(&kiosk).await;
                self.crash(CrashPoint::AfterLegacyStarted)?;
                let deadline = self.host.now_ms() + self.timing.legacy_wait.as_millis() as i64;
                let mut active = false;
                while self.host.now_ms() < deadline {
                    if self.host.legacy_unit(&kiosk).await.is_ok_and(|u| u.active) {
                        active = true;
                        break;
                    }
                    self.host.sleep(Duration::from_secs(1)).await;
                }
                attempt.legacy_active_after_rollback = Some(active);
            }
        }
        self.host.set_probation(false).map_err(|e| MigrateError::RollbackIncomplete(e.to_string()))?;
        self.host.disarm_recovery().await.map_err(|e| MigrateError::RollbackIncomplete(e.to_string()))?;
        let detail = format!("rolled back: {}", attempt.reason.clone().unwrap_or_default());
        self.save(attempt, Phase::RolledBack, &detail)
    }

    /// Boot and post-crash recovery: finishes or undoes an interrupted
    /// attempt. Returns the attempt, if there is one.
    pub async fn recover(&self) -> Result<Option<Attempt>, MigrateError> {
        let Some(mut attempt) = self.store.load()? else { return Ok(None) };
        match attempt.phase {
            phase if phase.is_terminal() => {}
            Phase::Started | Phase::SelfTested | Phase::CompatChecked => {
                self.refuse(&mut attempt, "interrupted_before_cutover").await?;
            }
            Phase::AcceptIntent => self.finish_accept(&mut attempt).await?,
            _ => {
                let reason = attempt.reason.clone().unwrap_or_else(|| "interrupted".into());
                self.rollback(&mut attempt, &reason).await?;
            }
        }
        Ok(Some(attempt))
    }

    /// An operator's rollback during the rollback window.
    pub async fn operator_rollback(&self) -> Result<Option<Attempt>, MigrateError> {
        let Some(mut attempt) = self.store.load()? else { return Ok(None) };
        match attempt.phase {
            Phase::Accepted => Err(MigrateError::AlreadyAccepted),
            phase if phase.is_terminal() => Ok(Some(attempt)),
            Phase::Started | Phase::SelfTested | Phase::CompatChecked => {
                self.refuse(&mut attempt, "operator_cancelled").await?;
                Ok(Some(attempt))
            }
            _ => {
                self.rollback(&mut attempt, "operator_requested").await?;
                Ok(Some(attempt))
            }
        }
    }
}
