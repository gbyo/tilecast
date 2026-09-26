//! The update state machine: stage, activate, confirm, roll back, guard.
//!
//! | Operation  | Durable phases                                     | Side effects, in order |
//! | ---------- | -------------------------------------------------- | ---------------------- |
//! | stage      | none (the version directory appears by `rename`)   | private copy of the CAS object, verify, unpack into `<version>.staging`, rename |
//! | activate   | `ActivateIntent` → `Provisional`                   | arm the guard, stop renderer and daemon, candidate system files, `current`, daemon-reload, sysusers and tmpfiles, start daemon and renderer |
//! | confirm    | `ConfirmIntent` → `Confirmed`                      | disarm the guard, retention |
//! | rollback   | `RollbackIntent` → `RolledBack`                    | stop renderer and daemon, verify previous, previous system files, `current`, daemon-reload, sysusers and tmpfiles, start, disarm the guard |
//! | guard      | (reads the phase)                                  | finishes or undoes an interrupted operation; rolls back a candidate that did not confirm |
//!
//! Rules:
//!
//! * A phase is durable before its side effects start.
//! * Every step is idempotent, so the guard finishes an interrupted
//!   operation by running it again.
//! * A crash never confirms. Only `ConfirmIntent`, written after the
//!   confirmation checks passed, leads to `Confirmed`.
//! * The guard is armed before anything that runs changes, and it runs the
//!   previous release's helper (`host::UpdateHost::arm_guard`), so a
//!   candidate that cannot run cannot stop its own rollback.
//! * An installed version is never changed. The previous release and the
//!   candidate stay installed through the provisional window.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use edge_release::envelope::verify_envelope;
use edge_release::install::{
    Layout, StageOutcome, current_version, free_bytes, install_system_files, installed_versions, remove_leftovers,
    remove_version, switch_current, verify_installed,
};
use edge_release::manifest::{ReleaseError, hex, is_version_name, verify_manifest, version_code};
use edge_release::protocol::{HelperStatus, MAX_LISTED_VERSIONS, Phase, ReleaseRef};
use sha2::{Digest as _, Sha256};

use crate::host::{EDGE_DAEMON, EDGE_RENDERER, HostError, UnitActivity, UpdateHost};
use crate::transaction::{SCHEMA_VERSION, StateError, Transaction, TransactionStore};

/// Free space kept on the helper's filesystem after the private archive copy.
pub const WORK_RESERVE_BYTES: u64 = 64 * 1024 * 1024;

/// Durations and limits. Tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// The provisional window: a candidate that has not confirmed by then is
    /// rolled back. The Player Updates canary also waits ten minutes.
    pub provisional: Duration,
    /// Automatic restarts of the candidate daemon or renderer that the
    /// window tolerates before it rolls back without waiting for the end.
    pub daemon_restart_limit: u64,
    pub renderer_restart_limit: u64,
    /// How long a rollback watches the previous daemon come up, to report
    /// a refused newer state schema.
    pub after_rollback_wait: Duration,
    pub poll: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            provisional: Duration::from_secs(600),
            daemon_restart_limit: 3,
            renderer_restart_limit: 5,
            after_rollback_wait: Duration::from_secs(60),
            poll: Duration::from_secs(2),
        }
    }
}

/// Whether a rollback waits to see the previous daemon come up, to record a
/// refused newer state schema.
///
/// The guard never waits: its unit is ordered before the Edge units, so the
/// previous daemon's start job waits for the guard to exit, and waiting for
/// that daemon here would only hold the screen dark for
/// [`Timing::after_rollback_wait`]. After a guard rollback the refusal is
/// reported by the previous daemon's own status (`recovery_reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Watch {
    Previous,
    No,
}

/// The fixed roots the helper reads from.
#[derive(Debug, Clone)]
pub struct HelperPaths {
    /// `tilecastd`'s content store (`/var/lib/tilecast-edge/cas`).
    pub cas_root: PathBuf,
    /// The owner every content-store object must have. `None` only in tests.
    pub tilecast_uid: Option<u32>,
    /// Free space kept after the private archive copy
    /// ([`WORK_RESERVE_BYTES`] in production).
    pub reserve_bytes: u64,
}

/// Every point where a crash leaves a distinct durable state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CrashPoint {
    AfterActivateIntent,
    AfterGuardArmed,
    AfterServicesStopped,
    AfterSystemFiles,
    AfterCurrentSwitched,
    AfterReload,
    AfterProvisionalSaved,
    AfterDaemonStarted,
    AfterRendererStarted,
    AfterConfirmIntent,
    AfterGuardDisarmed,
    AfterRetention,
    AfterRollbackIntent,
    AfterRollbackStopped,
    AfterRollbackSystemFiles,
    AfterRollbackCurrent,
    AfterRollbackReload,
    AfterRollbackStarted,
    AfterRollbackGuardDisarmed,
}

impl CrashPoint {
    pub const ACTIVATION: [CrashPoint; 9] = [
        Self::AfterActivateIntent,
        Self::AfterGuardArmed,
        Self::AfterServicesStopped,
        Self::AfterSystemFiles,
        Self::AfterCurrentSwitched,
        Self::AfterReload,
        Self::AfterProvisionalSaved,
        Self::AfterDaemonStarted,
        Self::AfterRendererStarted,
    ];
    pub const CONFIRMATION: [CrashPoint; 3] =
        [Self::AfterConfirmIntent, Self::AfterGuardDisarmed, Self::AfterRetention];
    pub const ROLLBACK: [CrashPoint; 7] = [
        Self::AfterRollbackIntent,
        Self::AfterRollbackStopped,
        Self::AfterRollbackSystemFiles,
        Self::AfterRollbackCurrent,
        Self::AfterRollbackReload,
        Self::AfterRollbackStarted,
        Self::AfterRollbackGuardDisarmed,
    ];

    pub fn name(self) -> String {
        format!("{self:?}")
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ACTIVATION.into_iter().chain(Self::CONFIRMATION).chain(Self::ROLLBACK).find(|point| point.name() == value)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    /// Fault injection: the process "died" here.
    #[error("crash injected at {0:?}")]
    Crashed(CrashPoint),
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Release(#[from] ReleaseError),
    #[error("host operation failed: {0}")]
    Host(#[from] HostError),
    #[error("refused: {0}")]
    Refused(&'static str),
    /// A rollback could not finish. The transaction stays in
    /// `RollbackIntent`, and the guard tries again.
    #[error("rollback incomplete: {0}")]
    RollbackIncomplete(&'static str),
}

impl UpdateError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Crashed(_) => "crashed",
            Self::State(_) => "update_state_unavailable",
            Self::Release(error) => error.reason_code(),
            Self::Host(_) => "host_operation_failed",
            Self::Refused(code) | Self::RollbackIncomplete(code) => code,
        }
    }
}

impl From<std::io::Error> for UpdateError {
    fn from(error: std::io::Error) -> Self {
        Self::Release(ReleaseError::Io(error))
    }
}

pub struct Updater<'a, H: UpdateHost> {
    host: &'a H,
    layout: Layout,
    store: TransactionStore,
    key: [u8; 32],
    paths: HelperPaths,
    timing: Timing,
    crash_at: Option<CrashPoint>,
}

impl<H: UpdateHost> std::fmt::Debug for Updater<'_, H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Updater").field("store", &self.store).finish_non_exhaustive()
    }
}

fn release_ref(release: &edge_release::VerifiedRelease) -> ReleaseRef {
    ReleaseRef {
        version_name: release.manifest.version_name.clone(),
        version_code: release.manifest.version_code,
        manifest_sha256: release.manifest_sha256.clone(),
    }
}

impl<'a, H: UpdateHost> Updater<'a, H> {
    pub fn new(host: &'a H, layout: Layout, store: TransactionStore, key: [u8; 32], paths: HelperPaths) -> Self {
        Self { host, layout, store, key, paths, timing: Timing::default(), crash_at: None }
    }

    pub fn with_timing(mut self, timing: Timing) -> Self {
        self.timing = timing;
        self
    }

    pub fn crash_at(mut self, point: Option<CrashPoint>) -> Self {
        self.crash_at = point;
        self
    }

    pub fn store(&self) -> &TransactionStore {
        &self.store
    }

    fn crash(&self, point: CrashPoint) -> Result<(), UpdateError> {
        if self.crash_at == Some(point) {
            tracing::error!(component = "update", event = "crash_injected", point = ?point);
            return Err(UpdateError::Crashed(point));
        }
        Ok(())
    }

    fn save(&self, transaction: &mut Transaction, phase: Phase, detail: &str) -> Result<(), UpdateError> {
        transaction.phase = phase;
        transaction.record(self.host.now_ms(), detail);
        tracing::info!(component = "update", event = "phase", phase = ?phase, detail);
        self.store.save(transaction)?;
        Ok(())
    }

    // ---- stage ------------------------------------------------------------

    /// Verifies the envelope, copies the content-store object it names into
    /// the helper's private directory while hashing it, and stages the
    /// release from that copy.
    pub async fn stage(
        &self,
        artifact_sha256: &str,
        envelope_bytes: &[u8],
        signature: &[u8],
    ) -> Result<StageOutcome, UpdateError> {
        let envelope = verify_envelope(envelope_bytes, signature, &self.key)?;
        envelope.check_host()?;
        if envelope.envelope.artifact_sha256 != artifact_sha256 {
            return Err(UpdateError::Refused("artifact_mismatch"));
        }
        let version = envelope.envelope.version_name.clone();
        let dir = self.layout.version_dir(&version);
        if std::fs::symlink_metadata(&dir).is_ok() {
            let installed =
                verify_installed(&dir, &self.key).map_err(|_| ReleaseError::InstalledCorrupt(version.clone()))?;
            if installed.manifest_sha256 != envelope.envelope.release_manifest_sha256 {
                return Err(ReleaseError::InstalledCorrupt(version).into());
            }
            return Ok(StageOutcome::AlreadyStaged { version });
        }
        if let Some(current) = current_version(&self.layout)
            && version_code(&current).is_some_and(|code| code >= envelope.envelope.version_code)
        {
            return Err(UpdateError::Refused("update_not_newer"));
        }
        remove_leftovers(&self.layout)?;
        let work = self.store.work_dir();
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&work)?;
        let size = envelope.envelope.artifact_size_bytes;
        if free_bytes(&work)? < size.saturating_add(self.paths.reserve_bytes) {
            return Err(ReleaseError::InsufficientSpace("update work directory").into());
        }
        let private = work.join("archive.partial");
        let _ = std::fs::remove_file(&private);
        let staged = self.copy_and_stage(&private, &envelope);
        let _ = std::fs::remove_file(&private);
        staged
    }

    fn copy_and_stage(
        &self,
        private: &Path,
        envelope: &edge_release::VerifiedEnvelope,
    ) -> Result<StageOutcome, UpdateError> {
        let size = envelope.envelope.artifact_size_bytes;
        let mut source = open_cas_object(&self.paths, &envelope.artifact, size)?;
        let mut copy = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(private)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut copied = 0u64;
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            copied += read as u64;
            if copied > size {
                return Err(UpdateError::Refused("artifact_digest_mismatch"));
            }
            hasher.update(&buffer[..read]);
            copy.write_all(&buffer[..read])?;
        }
        if copied != size || hex(&hasher.finalize()) != envelope.envelope.artifact_sha256 {
            return Err(UpdateError::Refused("artifact_digest_mismatch"));
        }
        copy.sync_all()?;
        let (outcome, _) = edge_release::archive::stage_from_archive(&mut copy, envelope, &self.layout, &self.key)?;
        tracing::info!(component = "update", event = "staged", version = outcome.version());
        Ok(outcome)
    }

    // ---- activate ---------------------------------------------------------

    /// Checks that `version` can be activated and writes `ActivateIntent`.
    /// Nothing that runs has changed when this returns.
    pub fn begin_activation(&self, version: &str) -> Result<Transaction, UpdateError> {
        if !is_version_name(version) {
            return Err(UpdateError::Refused("invalid_version"));
        }
        if let Some(open) = self.store.load()? {
            if !open.phase.is_terminal() {
                return Err(UpdateError::Refused("transaction_open"));
            }
            self.store.archive(&open)?;
        }
        let current = current_version(&self.layout).ok_or(UpdateError::Refused("no_current_release"))?;
        if current == version {
            return Err(UpdateError::Refused("already_current"));
        }
        let previous = verify_installed(&self.layout.version_dir(&current), &self.key)
            .map_err(|_| UpdateError::Refused("current_release_corrupt"))?;
        let candidate_dir = self.layout.version_dir(version);
        if std::fs::symlink_metadata(&candidate_dir).is_err() {
            return Err(UpdateError::Refused("release_not_staged"));
        }
        let candidate = verify_installed(&candidate_dir, &self.key)?;
        if candidate.manifest.version_code <= previous.manifest.version_code {
            return Err(UpdateError::Refused("update_not_newer"));
        }
        let mut transaction = Transaction {
            schema_version: SCHEMA_VERSION,
            transaction_id: uuid::Uuid::new_v4().to_string(),
            candidate: release_ref(&candidate),
            previous: release_ref(&previous),
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
        };
        self.save(&mut transaction, Phase::ActivateIntent, "activation requested")?;
        self.crash(CrashPoint::AfterActivateIntent)?;
        Ok(transaction)
    }

    /// Runs an activation that [`Updater::begin_activation`] started. A
    /// failure rolls back before this returns.
    pub async fn run_activation(&self, mut transaction: Transaction) -> Result<Transaction, UpdateError> {
        match self.activation_steps(&mut transaction).await {
            Ok(()) => Ok(transaction),
            Err(error @ UpdateError::Crashed(_)) => Err(error),
            Err(error) => {
                let reason = format!("activation_failed_{}", error.reason_code());
                tracing::error!(component = "update", event = "activation_failed", error = %error);
                self.rollback_transaction(&mut transaction, &reason, Watch::Previous).await?;
                Ok(transaction)
            }
        }
    }

    pub async fn activate(&self, version: &str) -> Result<Transaction, UpdateError> {
        let transaction = self.begin_activation(version)?;
        self.run_activation(transaction).await
    }

    async fn activation_steps(&self, transaction: &mut Transaction) -> Result<(), UpdateError> {
        self.host.arm_guard(&transaction.previous.version_name).await?;
        self.crash(CrashPoint::AfterGuardArmed)?;
        // WPE WebKit finds its helper processes under `current`: the renderer
        // stops before `current` moves (docs/tilecast-edge-next.md §4).
        self.host.stop(EDGE_RENDERER).await?;
        self.host.stop(EDGE_DAEMON).await?;
        self.crash(CrashPoint::AfterServicesStopped)?;
        let candidate_dir = self.layout.version_dir(&transaction.candidate.version_name);
        let verified = verify_installed(&candidate_dir, &self.key)?;
        if verified.manifest_sha256 != transaction.candidate.manifest_sha256 {
            return Err(ReleaseError::InstalledCorrupt(transaction.candidate.version_name.clone()).into());
        }
        install_system_files(&candidate_dir, &self.layout)?;
        self.crash(CrashPoint::AfterSystemFiles)?;
        switch_current(&self.layout, &transaction.candidate.version_name)?;
        tracing::info!(component = "update", event = "current_switched", version = %transaction.candidate.version_name);
        self.crash(CrashPoint::AfterCurrentSwitched)?;
        self.host.reload().await?;
        self.host.apply_system_configuration().await?;
        self.crash(CrashPoint::AfterReload)?;
        let now = self.host.boottime_ms();
        transaction.boot_id = Some(self.host.boot_id());
        transaction.provisional_since_ms = Some(now);
        transaction.deadline_ms = Some(now + self.timing.provisional.as_millis() as i64);
        // `start` resets systemd's restart counters, so the candidate's
        // restarts count from zero whoever starts it: this activation, or the
        // guard after an interruption.
        transaction.daemon_restarts_base = Some(0);
        transaction.renderer_restarts_base = Some(0);
        self.save(transaction, Phase::Provisional, "candidate is current; waiting for confirmation")?;
        self.crash(CrashPoint::AfterProvisionalSaved)?;
        self.host.start(EDGE_DAEMON).await?;
        self.crash(CrashPoint::AfterDaemonStarted)?;
        self.host.start(EDGE_RENDERER).await?;
        self.crash(CrashPoint::AfterRendererStarted)?;
        Ok(())
    }

    // ---- confirm ----------------------------------------------------------

    /// Ends the provisional window of `version` if the running candidate's
    /// own status shows it working ([`crate::evidence`]).
    pub async fn confirm(&self, version: &str) -> Result<Transaction, UpdateError> {
        let Some(mut transaction) = self.store.load()? else {
            return match self.store.latest()? {
                Some(done) if done.phase == Phase::Confirmed && done.candidate.version_name == version => Ok(done),
                _ => Err(UpdateError::Refused("not_provisional")),
            };
        };
        if transaction.candidate.version_name != version {
            return Err(UpdateError::Refused("not_provisional"));
        }
        match transaction.phase {
            Phase::Confirmed => {
                self.store.archive(&transaction)?;
                return Ok(transaction);
            }
            Phase::ConfirmIntent => {
                self.finish_confirm(&mut transaction).await?;
                return Ok(transaction);
            }
            Phase::Provisional => {}
            _ => return Err(UpdateError::Refused("not_provisional")),
        }
        if let Some(reason) = self.expired(&transaction) {
            self.rollback_transaction(&mut transaction, reason, Watch::Previous).await?;
            return Err(UpdateError::Refused(reason));
        }
        let status = self.host.daemon_status().await;
        if let Err(reason) = crate::evidence::check(status.as_ref(), version) {
            tracing::info!(component = "update", event = "confirmation_refused", reason);
            return Err(UpdateError::Refused(reason));
        }
        self.save(&mut transaction, Phase::ConfirmIntent, "confirmation checks passed")?;
        self.crash(CrashPoint::AfterConfirmIntent)?;
        self.finish_confirm(&mut transaction).await?;
        Ok(transaction)
    }

    async fn finish_confirm(&self, transaction: &mut Transaction) -> Result<(), UpdateError> {
        self.host.disarm_guard().await?;
        self.crash(CrashPoint::AfterGuardDisarmed)?;
        if let Err(error) = self.retention(transaction) {
            // Retention frees space; a failure never undoes a confirmation.
            tracing::warn!(component = "update", event = "retention_failed", error = %error);
        }
        self.crash(CrashPoint::AfterRetention)?;
        self.save(transaction, Phase::Confirmed, "candidate confirmed; it is the accepted release")?;
        self.store.archive(transaction)?;
        Ok(())
    }

    /// Keeps the confirmed release, the previous one and anything newer
    /// (a release staged for a later activation). Removes the rest.
    fn retention(&self, transaction: &Transaction) -> std::io::Result<()> {
        remove_leftovers(&self.layout)?;
        for version in installed_versions(&self.layout)? {
            let keep = version == transaction.candidate.version_name
                || version == transaction.previous.version_name
                || version_code(&version).is_some_and(|code| code > transaction.candidate.version_code);
            if !keep {
                remove_version(&self.layout, &version)?;
                tracing::info!(component = "update", event = "release_removed", version);
            }
        }
        Ok(())
    }

    // ---- rollback ---------------------------------------------------------

    /// A rollback that the candidate daemon or an operator asks for.
    pub async fn rollback(&self, reason: &str) -> Result<Transaction, UpdateError> {
        let Some(mut transaction) = self.store.load()? else {
            return match self.store.latest()? {
                Some(done) if done.phase == Phase::RolledBack => Ok(done),
                Some(done) if done.phase == Phase::Confirmed => Err(UpdateError::Refused("already_confirmed")),
                _ => Err(UpdateError::Refused("no_transaction")),
            };
        };
        match transaction.phase {
            Phase::Confirmed | Phase::ConfirmIntent => Err(UpdateError::Refused("already_confirmed")),
            Phase::RolledBack => Ok(transaction),
            Phase::ActivateIntent | Phase::Provisional | Phase::RollbackIntent => {
                self.rollback_transaction(&mut transaction, reason, Watch::Previous).await?;
                Ok(transaction)
            }
        }
    }

    /// Idempotent: a crash at any point is finished by running it again.
    async fn rollback_transaction(
        &self,
        transaction: &mut Transaction,
        reason: &str,
        watch: Watch,
    ) -> Result<(), UpdateError> {
        if transaction.phase != Phase::RollbackIntent {
            transaction.reason = Some(reason.chars().take(64).collect());
            self.save(transaction, Phase::RollbackIntent, reason)?;
            self.crash(CrashPoint::AfterRollbackIntent)?;
        }
        let _ = self.host.stop(EDGE_RENDERER).await;
        let _ = self.host.stop(EDGE_DAEMON).await;
        self.crash(CrashPoint::AfterRollbackStopped)?;
        let previous_dir = self.layout.version_dir(&transaction.previous.version_name);
        let verified = verify_installed(&previous_dir, &self.key)
            .ok()
            .filter(|release| release.manifest_sha256 == transaction.previous.manifest_sha256);
        if verified.is_none() {
            // Never leave the screen dark: run whatever is current, and keep
            // the transaction open so the guard keeps trying and status says why.
            transaction.record(self.host.now_ms(), "the previous release does not verify");
            self.store.save(transaction)?;
            let _ = self.host.start(EDGE_DAEMON).await;
            let _ = self.host.start(EDGE_RENDERER).await;
            return Err(UpdateError::RollbackIncomplete("previous_release_corrupt"));
        }
        install_system_files(&previous_dir, &self.layout)?;
        self.crash(CrashPoint::AfterRollbackSystemFiles)?;
        switch_current(&self.layout, &transaction.previous.version_name)?;
        tracing::info!(component = "update", event = "current_switched", version = %transaction.previous.version_name);
        self.crash(CrashPoint::AfterRollbackCurrent)?;
        self.host.reload().await?;
        self.host.apply_system_configuration().await?;
        self.crash(CrashPoint::AfterRollbackReload)?;
        self.host.start(EDGE_DAEMON).await?;
        self.host.start(EDGE_RENDERER).await?;
        self.crash(CrashPoint::AfterRollbackStarted)?;
        self.host.disarm_guard().await?;
        self.crash(CrashPoint::AfterRollbackGuardDisarmed)?;
        let detail = format!("rolled back to {}", transaction.previous.version_name);
        self.save(transaction, Phase::RolledBack, &detail)?;
        if watch == Watch::Previous {
            self.watch_previous(transaction).await?;
        }
        self.store.archive(transaction)?;
        Ok(())
    }

    /// The previous daemon refuses a state schema that the candidate
    /// migrated past it (docs/tilecast-edge.md §6.1) and enters recovery
    /// mode. Record that, so status and the server can say why the screen
    /// needs attention; the database is never changed here.
    async fn watch_previous(&self, transaction: &mut Transaction) -> Result<(), UpdateError> {
        let deadline = self.host.boottime_ms() + self.timing.after_rollback_wait.as_millis() as i64;
        loop {
            if let Some(status) = self.host.daemon_status().await
                && status.daemon_version.as_str() == transaction.previous.version_name
            {
                let refused = status.mode == edge_protocol::ipc::status::DaemonMode::Recovery
                    && status.recovery_reason.as_ref().is_some_and(|r| r.as_str() == "state_db_newer_schema");
                if refused {
                    transaction.schema_incompatible = true;
                    transaction.record(self.host.now_ms(), "the previous release refused the newer state schema");
                    self.store.save(transaction)?;
                    tracing::error!(component = "update", event = "rollback_schema_incompatible");
                }
                return Ok(());
            }
            if self.host.boottime_ms() >= deadline {
                return Ok(());
            }
            self.host.sleep(self.timing.poll).await;
        }
    }

    // ---- guard ------------------------------------------------------------

    fn expired(&self, transaction: &Transaction) -> Option<&'static str> {
        if transaction.boot_id.as_deref() != Some(self.host.boot_id().as_str()) {
            return Some("rebooted_while_provisional");
        }
        if transaction.deadline_ms.is_none_or(|deadline| self.host.boottime_ms() >= deadline) {
            return Some("confirmation_timeout");
        }
        None
    }

    /// The boot and timer check. Finishes or undoes an interrupted
    /// operation, and rolls back a candidate that has not confirmed in time,
    /// was restarted by a reboot, or keeps crashing.
    pub async fn guard(&self) -> Result<Option<Transaction>, UpdateError> {
        let Some(mut transaction) = self.store.load()? else {
            self.host.disarm_guard().await?;
            return Ok(None);
        };
        match transaction.phase {
            Phase::Confirmed | Phase::RolledBack => {
                self.host.disarm_guard().await?;
                self.store.archive(&transaction)?;
            }
            Phase::ActivateIntent => {
                self.rollback_transaction(&mut transaction, "activation_interrupted", Watch::No).await?;
            }
            Phase::RollbackIntent => {
                let reason = transaction.reason.clone().unwrap_or_else(|| "rollback_interrupted".into());
                self.rollback_transaction(&mut transaction, &reason, Watch::No).await?;
            }
            Phase::ConfirmIntent => self.finish_confirm(&mut transaction).await?,
            Phase::Provisional => {
                let restarted = |now: Result<u64, HostError>, base: Option<u64>, limit: u64| {
                    now.ok().zip(base).is_some_and(|(now, base)| now.saturating_sub(base) > limit)
                };
                let daemon = self.host.activity(EDGE_DAEMON).await.ok();
                let renderer = self.host.activity(EDGE_RENDERER).await.ok();
                let reason = if let Some(reason) = self.expired(&transaction) {
                    Some(reason)
                } else if restarted(
                    self.host.restarts(EDGE_DAEMON).await,
                    transaction.daemon_restarts_base,
                    self.timing.daemon_restart_limit,
                ) {
                    Some("candidate_daemon_restarting")
                } else if restarted(
                    self.host.restarts(EDGE_RENDERER).await,
                    transaction.renderer_restarts_base,
                    self.timing.renderer_restart_limit,
                ) {
                    Some("candidate_renderer_restarting")
                } else if daemon == Some(UnitActivity::Failed) {
                    // systemd stopped restarting it (its start limit).
                    Some("candidate_daemon_failed")
                } else if renderer == Some(UnitActivity::Failed) {
                    Some("candidate_renderer_failed")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    self.rollback_transaction(&mut transaction, reason, Watch::No).await?;
                } else {
                    // An activation interrupted after `Provisional` may not
                    // have started the candidate. Only a stopped unit is
                    // started: `start` resets the restart counter, and a
                    // crashing candidate's restarts are the evidence above.
                    for (unit, activity) in [(EDGE_DAEMON, daemon), (EDGE_RENDERER, renderer)] {
                        if activity == Some(UnitActivity::Inactive) {
                            let _ = self.host.start(unit).await;
                        }
                    }
                }
            }
        }
        Ok(Some(transaction))
    }

    // ---- status -----------------------------------------------------------

    pub fn status(&self) -> HelperStatus {
        let current = current_version(&self.layout).and_then(|version| {
            verify_manifest(&self.layout.version_dir(&version), &self.key).ok().map(|release| release_ref(&release))
        });
        let mut installed = installed_versions(&self.layout).unwrap_or_default();
        installed.truncate(MAX_LISTED_VERSIONS);
        let transaction = self.store.latest().ok().flatten().map(|t| t.view(self.host.boottime_ms()));
        HelperStatus { current, installed, transaction }
    }
}

/// Opens the content-store object for `digest`: a regular file at the path
/// the digest names under the fixed root, reached without following any
/// link, owned by the tilecast account, of exactly `size` bytes.
fn open_cas_object(
    paths: &HelperPaths,
    digest: &edge_protocol::Sha256Digest,
    size: u64,
) -> Result<std::fs::File, UpdateError> {
    let path = paths.cas_root.join("sha256").join(digest.fanout()).join(digest.to_hex());
    let file = open_no_links(&path)?.ok_or(UpdateError::Refused("artifact_not_downloaded"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != size {
        return Err(UpdateError::Refused("artifact_not_downloaded"));
    }
    if let Some(uid) = paths.tilecast_uid
        && std::os::unix::fs::MetadataExt::uid(&metadata) != uid
    {
        return Err(UpdateError::Refused("artifact_owner_invalid"));
    }
    Ok(file)
}

/// No component of the path may be a link. This is not `openat2`: the
/// helper's `RestrictSUIDSGID=` makes that call fail with `ENOSYS`.
fn open_no_links(path: &Path) -> Result<Option<std::fs::File>, UpdateError> {
    let opened = edge_platform::fs::open_regular_no_links(path, edge_release::envelope::MAX_ARTIFACT_BYTES)
        .map_err(|error| std::io::Error::new(error.kind(), format!("open content-store object: {error}")))?;
    Ok(opened.map(|(file, _)| file))
}
