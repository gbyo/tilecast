//! Binding-scoped offline manifests, trial evidence, promotion, and pin lifetime.
//!
//! An activation trial shows the pending manifest and promotes it only after
//! the current renderer accepted exactly that activation and reported content
//! evidence for it. Core owns the trial outcome durably:
//!
//! * the trial is recorded as running before the host shows the manifest, so
//!   a process that ends during it without an orderly shutdown counts the
//!   trial as failed after a restart;
//! * a failed trial holds the manifest back on a bounded backoff, then tries
//!   it again, instead of retrying at once or never;
//! * only a refusal of the whole activation, or no content evidence before
//!   the deadline, fails a trial. An item failure is a diagnostic: the
//!   Runtime isolates the item and keeps rotating.
use crate::{Dependencies, ManifestPreparationError, NativeConfiguration, NativeManifest, manifest_pin_holder};
use player_cas::ContentStore;
use player_state::repo::{
    binding::{self, CredentialState},
    cas::{self, PinReason},
    manifests::{self, ActivationTrial, Binding, Stage, StoredManifest, TrialState},
    playback,
};
use player_types::{Sha256Digest, Timestamp};

pub const ACTIVATION_TRIAL_TIMEOUT_MS: i64 = 30_000;

/// How long a manifest whose trial failed `failures` times in a row is held
/// back before it is tried again. Bounded, so a transient failure (a slow
/// network, a renderer restart) recovers without a new server change, and a
/// manifest that keeps failing is tried at most hourly.
pub fn trial_retry_delay_ms(failures: u32) -> i64 {
    match failures {
        0 | 1 => 60_000,
        2 => 5 * 60_000,
        3 => 15 * 60_000,
        _ => MAX_TRIAL_RETRY_DELAY_MS,
    }
}

const MAX_TRIAL_RETRY_DELAY_MS: i64 = 60 * 60_000;

/// Why a trial failed, for logs and the heartbeat. Stable reason codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrialFailure {
    /// The renderer refused the whole activation.
    Refused,
    /// No accepted content evidence before the trial deadline.
    NoEvidence,
    /// The host could not issue the activation.
    ActivationRejected,
    /// The process ended while the trial was running.
    Interrupted,
}

impl TrialFailure {
    pub fn reason_code(self) -> &'static str {
        match self {
            Self::Refused => "renderer_refused",
            Self::NoEvidence => "no_content_evidence",
            Self::ActivationRejected => "activation_rejected",
            Self::Interrupted => "trial_interrupted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationGate {
    Rest,
    Disabled,
}

pub fn activation_gate(
    config: &NativeConfiguration,
    disabled: bool,
    now_ms: i64,
) -> (Option<ActivationGate>, Option<i64>) {
    let hours = crate::evaluate_active_hours(config.active_hours.as_ref(), now_ms);
    let gate = if !hours.active {
        Some(ActivationGate::Rest)
    } else if disabled {
        Some(ActivationGate::Disabled)
    } else {
        None
    };
    (gate, hours.ms_until_transition)
}

pub fn should_activate_pending(playing: bool, takeover: bool, boundary: bool, now_ms: i64, grace_at_ms: i64) -> bool {
    !playing || takeover || boundary || now_ms >= grace_at_ms
}

pub fn overrides_activation_gate(source: crate::Source) -> bool {
    matches!(source, crate::Source::Takeover | crate::Source::QuickPresent)
}

pub fn activation_grace_ms(document: &serde_json::Value) -> i64 {
    let seconds = document
        .get("activationGraceSeconds")
        .and_then(serde_json::Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .unwrap_or(30)
        .clamp(1, 3_600);
    (seconds * 1_000) as i64
}

#[derive(Debug, Clone)]
pub struct OfflineManifestState {
    pub binding: Binding,
    pub active: Option<StoredManifest>,
    pub pending: Option<StoredManifest>,
    pub target: Option<Sha256Digest>,
    /// The durable trial of `pending`, when one was recorded.
    pub trial: Option<ActivationTrial>,
    pub local_now_ms: i64,
    pub offset_ms: i64,
    pub playback_disabled: bool,
}

impl OfflineManifestState {
    /// When the pending manifest failed its trial and is held back, the
    /// local time at which it may be tried again. A retry time further away
    /// than the longest delay means the wall clock stepped back (a device
    /// that booted with a wrong clock, then synchronized): the hold ends
    /// instead of lasting as long as the step.
    pub fn pending_held_until(&self) -> Option<i64> {
        let pending = self.pending.as_ref()?;
        self.trial
            .as_ref()
            .filter(|trial| trial.digest == pending.digest && trial.state == TrialState::Failed)
            .and_then(|trial| trial.retry_at)
            .map(|retry_at| retry_at.unix_millis())
            .filter(|retry_at| {
                *retry_at > self.local_now_ms && retry_at - self.local_now_ms <= MAX_TRIAL_RETRY_DELAY_MS
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrialEvidence {
    pub manifest: Option<Sha256Digest>,
    pub accepted: bool,
    pub meaningful: bool,
    /// The renderer refused the whole activation. Item failures are not here.
    pub refused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrialDecision {
    NotCurrent,
    Failed(TrialFailure),
    Promote,
    AwaitEvidence { deadline_ms: i64 },
}

#[derive(Debug)]
pub struct OfflineActivationCoordinator {
    dependencies: Dependencies,
    store: Option<ContentStore>,
    binding: Option<Binding>,
    invalid_pending: Option<Sha256Digest>,
    /// The trial this process started, with its local start time. A durable
    /// running trial that this process did not start was interrupted.
    trial: Option<(Sha256Digest, i64)>,
    plugin_refresh: Option<(Sha256Digest, Sha256Digest)>,
}

impl OfflineActivationCoordinator {
    pub fn new(dependencies: Dependencies, store: Option<ContentStore>) -> Self {
        Self { dependencies, store, binding: None, invalid_pending: None, trial: None, plugin_refresh: None }
    }

    pub async fn load(&mut self) -> Option<OfflineManifestState> {
        let db = self.dependencies.state.clone();
        let db = &db;
        let bound = db.run(|connection| binding::get(connection)).await.ok().flatten()?;
        if bound.credential_state != CredentialState::Stored {
            self.binding = None;
            return None;
        }
        let binding = Binding {
            installation_id: bound.installation_id,
            screen_id: bound.screen_id?,
            server_url: bound.server_url,
        };
        if self.binding.as_ref() != Some(&binding) {
            self.binding = Some(binding.clone());
            self.invalid_pending = None;
            self.trial = None;
            self.plugin_refresh = None;
        }
        let read = |stage| {
            let binding = binding.clone();
            async move { db.run(move |connection| manifests::get_for(connection, stage, &binding)).await }
        };
        let (Ok(active), Ok(pending)) = (read(Stage::Active).await, read(Stage::Pending).await) else { return None };
        let target_binding = binding.clone();
        let target = db
            .run(move |connection| manifests::target(connection, &target_binding))
            .await
            .ok()?
            .map(|target| target.digest);
        let local_now_ms = self.dependencies.clock.now().unix_millis();
        let trial_binding = binding.clone();
        let mut trial = db.run(move |connection| manifests::trial(connection, &trial_binding)).await.ok()?;
        // A running trial that this process did not start ended with the
        // previous process. Count it, so a manifest that takes the process
        // down cannot crash-loop the Player.
        if let Some(interrupted) = trial.as_ref().filter(|trial| {
            trial.state == TrialState::Running && self.trial.is_none_or(|(digest, _)| digest != trial.digest)
        }) {
            let digest = interrupted.digest;
            tracing::warn!(component = "activation", event = "trial_interrupted", manifest = %digest.short());
            self.record_failure(&binding, digest, TrialFailure::Interrupted, local_now_ms).await;
            let reread = binding.clone();
            trial = db.run(move |connection| manifests::trial(connection, &reread)).await.ok()?;
        }
        let (offset_ms, playback_disabled) = match db.run(|connection| playback::get(connection)).await {
            Ok(flags) => (flags.server_clock_offset_ms.unwrap_or_default(), flags.playback_disabled),
            Err(error) => {
                // A row that cannot be decoded must not lift an administrative
                // disable. Keep the flag when it is readable, else stay disabled.
                tracing::warn!(component = "activation", event = "playback_state_unreadable", error = %error);
                let disabled = db.run(|connection| playback::disabled(connection)).await.unwrap_or(true);
                (0, disabled)
            }
        };
        Some(OfflineManifestState {
            binding,
            active,
            pending,
            target,
            trial,
            local_now_ms,
            offset_ms,
            playback_disabled,
        })
    }

    /// Records a failed trial durably and holds the manifest back. Returns
    /// the local time at which it may be tried again.
    pub async fn record_failure(
        &mut self,
        binding: &Binding,
        digest: Sha256Digest,
        failure: TrialFailure,
        now_ms: i64,
    ) -> Option<i64> {
        if self.trial.is_some_and(|(trial, _)| trial == digest) {
            self.trial = None;
        }
        let previous = {
            let binding = binding.clone();
            self.dependencies
                .state
                .run(move |connection| manifests::trial(connection, &binding))
                .await
                .ok()
                .flatten()
                .filter(|trial| trial.digest == digest)
                .map_or(0, |trial| trial.failures)
        };
        let retry_at_ms = now_ms.saturating_add(trial_retry_delay_ms(previous.saturating_add(1)));
        let retry_at = Timestamp::from_unix_millis(retry_at_ms)?;
        let binding = binding.clone();
        let failures = self
            .dependencies
            .state
            .run(move |connection| {
                manifests::fail_trial(connection, &binding, &digest, failure.reason_code(), retry_at)
            })
            .await
            .ok()
            .flatten()?;
        tracing::warn!(component = "activation", event = "pending_trial_failed", manifest = %digest.short(),
            reason = failure.reason_code(), failures, retry_in_ms = retry_at_ms - now_ms);
        Some(retry_at_ms)
    }

    pub async fn retain_pending(&mut self, state: &mut OfflineManifestState, on_screen: Option<Sha256Digest>) {
        if let Some(stale) = state.pending.as_ref().filter(|pending| state.target != Some(pending.digest)) {
            let (binding, digest) = (state.binding.clone(), stale.digest);
            if self
                .dependencies
                .state
                .run(move |connection| manifests::discard_pending(connection, &binding, &digest))
                .await
                .is_ok()
            {
                tracing::info!(component = "activation", event = "pending_superseded", manifest = %digest.short());
            }
            state.pending = None;
            state.trial = None;
        }
        if self.trial.is_some_and(|(digest, _)| state.pending.as_ref().is_none_or(|pending| pending.digest != digest)) {
            self.trial = None;
        }
        self.sweep_pins(&state.active, &state.pending, on_screen).await;
    }

    pub(crate) fn plugin_refresh_matches(&self, base: Sha256Digest, on_screen: Option<Sha256Digest>) -> bool {
        self.plugin_refresh.is_some_and(|(proven_base, delivered)| proven_base == base && on_screen == Some(delivered))
    }

    pub(crate) fn note_plugin_refresh(&mut self, base: Sha256Digest, delivered: Sha256Digest) {
        self.plugin_refresh = Some((base, delivered));
    }

    /// Returns true only for the first projection failure for this pending digest.
    pub fn note_invalid(&mut self, digest: Sha256Digest) -> bool {
        if self.invalid_pending == Some(digest) {
            false
        } else {
            self.invalid_pending = Some(digest);
            true
        }
    }

    /// A policy surface or safe mode took the screen from a running trial.
    /// That is not a failure: the deadline restarts when the trial resumes.
    pub async fn suspend_trial(&mut self, binding: &Binding) {
        if let Some((digest, _)) = self.trial.take() {
            let binding = binding.clone();
            let _ = self
                .dependencies
                .state
                .run(move |connection| manifests::suspend_trial(connection, &binding, &digest))
                .await;
        }
    }

    /// An orderly shutdown is not a failure: the trial resumes after the
    /// restart. Only a process that ended without this (a crash, a kill, a
    /// power loss) leaves a running trial that counts as interrupted.
    pub async fn shutdown(&mut self) {
        if let Some(binding) = self.binding.clone() {
            self.suspend_trial(&binding).await;
        }
    }

    /// Records the trial as running before the host shows the manifest.
    /// Returns false (and starts nothing) when the record cannot be written:
    /// an unrecorded trial could crash-loop the Player.
    pub async fn start_trial(&mut self, binding: &Binding, digest: Sha256Digest, now_ms: i64) -> bool {
        let Some(now) = Timestamp::from_unix_millis(now_ms) else { return false };
        if self.binding.as_ref() != Some(binding) {
            self.binding = Some(binding.clone());
            self.invalid_pending = None;
            self.plugin_refresh = None;
        }
        let write = binding.clone();
        let started = self
            .dependencies
            .state
            .run(move |connection| manifests::begin_trial(connection, &write, &digest, now))
            .await
            .unwrap_or(false);
        if started {
            self.trial = Some((digest, now_ms));
        }
        started
    }

    pub fn trial_decision(&mut self, digest: Sha256Digest, now_ms: i64, evidence: TrialEvidence) -> TrialDecision {
        if evidence.manifest != Some(digest) {
            return TrialDecision::NotCurrent;
        }
        let started = self.trial.get_or_insert((digest, now_ms));
        if started.0 != digest {
            *started = (digest, now_ms);
        }
        let deadline_ms = started.1.saturating_add(ACTIVATION_TRIAL_TIMEOUT_MS);
        if evidence.refused {
            TrialDecision::Failed(TrialFailure::Refused)
        } else if evidence.accepted && evidence.meaningful {
            TrialDecision::Promote
        } else if now_ms >= deadline_ms {
            TrialDecision::Failed(TrialFailure::NoEvidence)
        } else {
            TrialDecision::AwaitEvidence { deadline_ms }
        }
    }

    pub async fn pin(&self, reason: PinReason, candidate: &NativeManifest) -> Result<(), ManifestPreparationError> {
        let store = self.store.as_ref().ok_or(ManifestPreparationError::StoreUnavailable)?;
        let digests = candidate.verify_content(store).await?;
        store.replace_pins(reason, &manifest_pin_holder(&candidate.digest), digests).await?;
        Ok(())
    }

    pub(crate) fn now_ms(&self) -> i64 {
        self.dependencies.clock.now().unix_millis()
    }

    pub async fn verify_content(&self, candidate: &NativeManifest) -> Result<(), ManifestPreparationError> {
        let store = self.store.as_ref().ok_or(ManifestPreparationError::StoreUnavailable)?;
        candidate.verify_content(store).await.map(|_| ())
    }

    pub async fn sweep_pins(
        &self,
        active: &Option<StoredManifest>,
        pending: &Option<StoredManifest>,
        on_screen: Option<Sha256Digest>,
    ) {
        let keep: Vec<String> = active
            .iter()
            .chain(pending.iter())
            .map(|stored| stored.digest)
            .chain(on_screen)
            .map(|digest| manifest_pin_holder(&digest))
            .collect();
        let result = self
            .dependencies
            .state
            .run(move |connection| {
                let mut released = 0;
                for reason in [PinReason::ActivePresentation, PinReason::PendingPresentation] {
                    released += cas::retain_holders(connection, reason, crate::MANIFEST_PIN_PREFIX, &keep)?;
                }
                Ok(released)
            })
            .await;
        if let Ok(released) = result
            && released > 0
        {
            tracing::info!(component = "activation", event = "pins_drained", released);
        }
    }

    /// Commit only the still-current target after the caller supplies accepted
    /// generation-bound evidence. Recheck verified bytes before changing pins.
    pub async fn promote(
        &mut self,
        binding: &Binding,
        pending: &StoredManifest,
        candidate: &NativeManifest,
        evidence: TrialEvidence,
    ) -> bool {
        if evidence.manifest != Some(candidate.digest)
            || !evidence.accepted
            || !evidence.meaningful
            || evidence.refused
            || pending.digest != candidate.digest
            || pending.binding != *binding
            || self.trial.is_none_or(|(digest, _)| digest != candidate.digest)
        {
            return false;
        }
        if self.pin(PinReason::ActivePresentation, candidate).await.is_err() {
            return false;
        }
        let binding = binding.clone();
        let digest = candidate.digest;
        let Ok(true) = self
            .dependencies
            .state
            .run(move |connection| manifests::promote_pending(connection, &binding, &digest))
            .await
        else {
            return false;
        };
        if let Some(store) = &self.store {
            let cleared_pending =
                store.replace_pins(PinReason::PendingPresentation, &manifest_pin_holder(&digest), Vec::new()).await;
            let cleared_migration = store.replace_pins(PinReason::Migration, "legacy-import", Vec::new()).await;
            if cleared_pending.is_err() || cleared_migration.is_err() {
                tracing::warn!(component = "activation", event = "old_pin_drain_incomplete", manifest = %digest.short());
            }
        }
        self.trial = None;
        self.sweep_pins(&Some(pending.clone()), &None, Some(digest)).await;
        tracing::info!(component = "activation", event = "activated", manifest = %digest.short(), manifest_version = pending.version);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_state::repo::binding::ServerBinding;
    use player_state::repo::manifests::Target;
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, ScreenId, Timestamp, time::ManualClock};
    use serde_json::json;
    use std::sync::Arc;

    #[derive(Debug)]
    struct Space;
    impl player_cas::space::SpaceProbe for Space {
        fn available_bytes(&self, _: &std::path::Path) -> std::io::Result<u64> {
            Ok(1 << 40)
        }
    }

    #[derive(Debug, Default)]
    struct TestOpener;
    impl player_cas::SecureOpener for TestOpener {
        fn open_regular(&self, path: &std::path::Path, max_bytes: u64) -> std::io::Result<player_cas::RegularOpen> {
            use player_cas::RegularOpen;
            let metadata = match std::fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(RegularOpen::Missing);
                }
                Err(error) => return Err(error),
            };
            if metadata.file_type().is_symlink() {
                return Ok(RegularOpen::Refused);
            }
            let file = std::fs::File::open(path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.len() > max_bytes {
                return Ok(RegularOpen::Refused);
            }
            Ok(RegularOpen::Opened(file, metadata.len()))
        }
    }

    async fn fixture() -> (tempfile::TempDir, OfflineActivationCoordinator, Binding) {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let now = Timestamp::parse("2026-10-04T12:00:00Z").unwrap();
        let dependencies = Dependencies { state, clock: ManualClock::new(now) };
        let binding = Binding {
            installation_id: InstallationId::from_uuid(uuid::Uuid::from_u128(1)),
            screen_id: ScreenId::from_uuid(uuid::Uuid::from_u128(2)),
            server_url: "https://signs.example.org".into(),
        };
        let bind = binding.clone();
        dependencies
            .state
            .run(move |connection| {
                binding::put(
                    connection,
                    &ServerBinding {
                        server_url: bind.server_url,
                        installation_id: bind.installation_id,
                        screen_id: Some(bind.screen_id),
                        organization_name: None,
                        screen_name: None,
                        credential_state: CredentialState::Stored,
                        identity_verified_at: Some(now),
                        bound_at: now,
                    },
                    now,
                )
            })
            .await
            .unwrap();
        let store = ContentStore::open(
            dir.path().join("cas"),
            dir.path().join("partial"),
            dependencies.state.clone(),
            dependencies.clock.clone(),
            Arc::new(Space),
            Arc::new(TestOpener),
            player_cas::StorePolicy { limit_bytes: 1 << 30, reserved_free_bytes: 0 },
            Arc::new(player_cas::LruByDomain),
        )
        .await
        .unwrap();
        (dir, OfflineActivationCoordinator::new(dependencies, Some(store)), binding)
    }

    async fn pending(
        core: &OfflineActivationCoordinator,
        binding: &Binding,
        version: i64,
    ) -> (StoredManifest, NativeManifest) {
        let document = json!({"schemaVersion":11,"mode":"presentation","screenId":binding.screen_id,"manifestVersion":version,
            "assets":[],"playlists":[],"schedules":[],"widgets":[],"dataSources":[],"plugins":[],"layouts":[],
            "playlist":{"id":uuid::Uuid::from_u128(4),"items":[],"futureRuntimeOption":{"transition":"unknown"}}});
        let digest = crate::manifest_digest(&document);
        let now = core.dependencies.clock.now();
        let stored =
            StoredManifest { binding: binding.clone(), digest, version, document: document.clone(), stored_at: now };
        let target = Target {
            binding: binding.clone(),
            digest,
            version,
            document: document.clone(),
            fetched_at: now,
            etag: version.to_string(),
        };
        let write = stored.clone();
        core.dependencies
            .state
            .run(move |connection| {
                assert!(manifests::put_target(connection, &target)?);
                assert!(manifests::put_pending_for_target(connection, &write)?);
                Ok(())
            })
            .await
            .unwrap();
        (stored, NativeManifest::parse(document, binding.screen_id, digest).unwrap())
    }

    fn evidence(digest: Sha256Digest) -> TrialEvidence {
        TrialEvidence { manifest: Some(digest), accepted: true, meaningful: true, refused: false }
    }

    async fn trial_row(core: &OfflineActivationCoordinator, binding: &Binding) -> Option<ActivationTrial> {
        let binding = binding.clone();
        core.dependencies.state.run(move |connection| manifests::trial(connection, &binding)).await.unwrap()
    }

    #[tokio::test]
    async fn unreadable_playback_state_keeps_the_disable_flag() {
        let (dir, mut core, _) = fixture().await;
        let db = core.dependencies.state.clone();
        let write = |disabled: i64| {
            db.run(move |connection| {
                connection.execute("DELETE FROM playback_state", [])?;
                connection.execute(
                    "INSERT INTO playback_state (id, playback_disabled, server_clock_offset_ms,
                                                 server_clock_synchronized_at_ms, updated_at_ms)
                     VALUES (1, ?1, 5000, ?2, 0)",
                    [disabled, i64::MAX],
                )?;
                Ok(())
            })
        };
        write(1).await.unwrap();
        let state = core.load().await.unwrap();
        assert!(state.playback_disabled, "a decode failure must not lift the administrative disable");
        assert_eq!(state.offset_ms, 0);
        write(0).await.unwrap();
        let state = core.load().await.unwrap();
        assert!(!state.playback_disabled);
        drop(dir);
    }

    #[tokio::test]
    async fn promotion_requires_current_trial_acceptance_and_meaningful_evidence() {
        let (dir, mut core, binding) = fixture().await;
        let (stored, candidate) = pending(&core, &binding, 1).await;
        let proof = evidence(stored.digest);
        assert!(!core.promote(&binding, &stored, &candidate, proof).await, "no current trial");
        assert!(core.start_trial(&binding, stored.digest, core.dependencies.clock.now().unix_millis()).await);
        assert!(!core.promote(&binding, &stored, &candidate, TrialEvidence { meaningful: false, ..proof }).await);
        assert!(!core.promote(&binding, &stored, &candidate, TrialEvidence { accepted: false, ..proof }).await);
        assert!(!core.promote(&binding, &stored, &candidate, TrialEvidence { refused: true, ..proof }).await);
        assert!(
            !core
                .promote(
                    &binding,
                    &stored,
                    &candidate,
                    TrialEvidence { manifest: Some(Sha256Digest::of(b"stale")), ..proof }
                )
                .await
        );
        assert_eq!(trial_row(&core, &binding).await.unwrap().state, TrialState::Running);
        assert!(core.promote(&binding, &stored, &candidate, proof).await);
        assert_eq!(trial_row(&core, &binding).await, None, "promotion commits the trial with the manifest");
        let clock = core.dependencies.clock.clone();
        drop(core);
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let mut restarted = OfflineActivationCoordinator::new(Dependencies { state, clock }, None);
        let local = restarted.load().await.unwrap();
        assert_eq!(local.active.unwrap().document, stored.document, "opaque Runtime fields survive offline restart");
        assert!(local.pending.is_none());
    }

    #[tokio::test]
    async fn replaced_targets_cannot_promote_and_binding_changes_reset_trial_state() {
        let (_dir, mut core, binding) = fixture().await;
        let (first, candidate) = pending(&core, &binding, 1).await;
        core.load().await.unwrap();
        assert!(core.start_trial(&binding, first.digest, 0).await);
        let (_newer, _) = pending(&core, &binding, 2).await;
        assert!(!core.promote(&binding, &first, &candidate, evidence(first.digest)).await);
        let mut local = core.load().await.unwrap();
        assert_eq!(local.pending.as_ref().unwrap().version, 2);
        assert!(local.trial.is_none(), "the replacement pending carries no trial of the old one");
        // The latest target is now newer than that pending document.
        let third = Target {
            binding: binding.clone(),
            digest: Sha256Digest::of(b"third"),
            version: 3,
            document: json!({"manifestVersion":3}),
            etag: "third".into(),
            fetched_at: core.dependencies.clock.now(),
        };
        assert!(
            core.dependencies.state.run(move |connection| manifests::put_target(connection, &third)).await.unwrap()
        );
        local = core.load().await.unwrap();
        core.retain_pending(&mut local, Some(first.digest)).await;
        assert!(local.pending.is_none());
        assert!(core.trial.is_none());
        core.dependencies
            .state
            .run(|connection| {
                let mut bound = binding::get(connection)?.unwrap();
                bound.server_url = "https://new.example.org".into();
                let now = bound.bound_at;
                binding::put(connection, &bound, now)
            })
            .await
            .unwrap();
        let local = core.load().await.unwrap();
        assert!(local.active.is_none() && local.pending.is_none() && local.trial.is_none());
    }

    #[tokio::test]
    async fn policy_suspension_restarts_the_trial_deadline_and_failures_are_held_then_retried() {
        let (_dir, mut core, binding) = fixture().await;
        let (stored, _) = pending(&core, &binding, 1).await;
        let digest = stored.digest;
        let waiting = TrialEvidence { accepted: true, meaningful: false, ..evidence(digest) };
        assert!(core.start_trial(&binding, digest, 1000).await);
        assert_eq!(core.trial_decision(digest, 2000, waiting), TrialDecision::AwaitEvidence { deadline_ms: 31000 });
        core.suspend_trial(&binding).await;
        assert_eq!(trial_row(&core, &binding).await.unwrap().state, TrialState::Idle, "suspension is not a failure");
        assert_eq!(core.trial_decision(digest, 90000, waiting), TrialDecision::AwaitEvidence { deadline_ms: 120000 });
        assert_eq!(core.trial_decision(digest, 120000, waiting), TrialDecision::Failed(TrialFailure::NoEvidence));
        assert_eq!(core.trial_decision(Sha256Digest::of(b"other"), 120000, waiting), TrialDecision::NotCurrent);
        // Evidence that arrives by the deadline still promotes.
        assert_eq!(core.trial_decision(digest, 120000, evidence(digest)), TrialDecision::Promote);
        let now = core.dependencies.clock.now().unix_millis();
        let retry = core.record_failure(&binding, digest, TrialFailure::NoEvidence, now).await.unwrap();
        assert_eq!(retry, now + trial_retry_delay_ms(1));
        let local = core.load().await.unwrap();
        assert_eq!(local.pending_held_until(), Some(retry), "a failed manifest is held back, not forgotten");
        let failed = local.trial.unwrap();
        assert_eq!((failed.failures, failed.reason.as_deref()), (1, Some("no_content_evidence")));
        // A second failure in a row backs off further, within a bound.
        let second = core.record_failure(&binding, digest, TrialFailure::Refused, now).await.unwrap();
        assert_eq!(second, now + trial_retry_delay_ms(2));
        assert!(trial_retry_delay_ms(u32::MAX) <= 60 * 60_000);
        // The device booted with a clock a year ahead, failed the trial, and
        // then synchronized. The hold must not last a year.
        let mut local = core.load().await.unwrap();
        local.local_now_ms = second - trial_retry_delay_ms(2) - 365 * 24 * 60 * 60_000;
        assert_eq!(local.pending_held_until(), None, "a wall-clock step back ends the hold");
    }

    #[tokio::test]
    async fn an_item_failure_never_fails_a_trial_but_a_refusal_does() {
        let (_dir, mut core, binding) = fixture().await;
        let (stored, _) = pending(&core, &binding, 1).await;
        let digest = stored.digest;
        assert!(core.start_trial(&binding, digest, 0).await);
        // The tracker never sets `refused` for an isolated item failure, so
        // the trial waits for content evidence from the next item.
        let waiting = TrialEvidence { accepted: true, meaningful: false, ..evidence(digest) };
        assert_eq!(core.trial_decision(digest, 1000, waiting), TrialDecision::AwaitEvidence { deadline_ms: 30000 });
        assert_eq!(core.trial_decision(digest, 2000, evidence(digest)), TrialDecision::Promote);
        assert_eq!(
            core.trial_decision(digest, 2000, TrialEvidence { refused: true, ..waiting }),
            TrialDecision::Failed(TrialFailure::Refused)
        );
    }

    #[tokio::test]
    async fn a_trial_running_when_the_process_ended_is_counted_and_held_back() {
        let (dir, mut core, binding) = fixture().await;
        let (stored, _) = pending(&core, &binding, 1).await;
        let now = core.dependencies.clock.now().unix_millis();
        assert!(core.start_trial(&binding, stored.digest, now).await);
        // This process started the trial: it is running, not interrupted.
        assert_eq!(core.load().await.unwrap().trial.unwrap().state, TrialState::Running);
        let clock = core.dependencies.clock.clone();
        drop(core);
        // The process ended mid-trial (a crash, an OOM kill, a power cut).
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let mut restarted = OfflineActivationCoordinator::new(Dependencies { state, clock }, None);
        let local = restarted.load().await.unwrap();
        let trial = local.trial.clone().unwrap();
        assert_eq!(
            (trial.state, trial.failures, trial.reason.as_deref()),
            (TrialState::Failed, 1, Some("trial_interrupted"))
        );
        assert_eq!(local.pending_held_until(), Some(now + trial_retry_delay_ms(1)));
        assert_eq!(local.pending.unwrap().digest, stored.digest, "the pending manifest is kept for its retry");
        // Loading again does not count the same interruption twice.
        assert_eq!(restarted.load().await.unwrap().trial.unwrap().failures, 1);
    }

    #[tokio::test]
    async fn a_failed_target_read_skips_activation_without_discarding_pending() {
        let (_dir, mut core, binding) = fixture().await;
        let (stored, _) = pending(&core, &binding, 1).await;
        core.dependencies
            .state
            .run(|connection| {
                connection.execute("DROP TABLE manifest_target", [])?;
                Ok(())
            })
            .await
            .unwrap();
        // A failed read is not a missing target: the tick skips instead of
        // feeding retain_pending a state that would discard prepared work.
        assert!(core.load().await.is_none());
        if let Some(mut local) = core.load().await {
            core.retain_pending(&mut local, None).await;
        }
        let lookup = binding.clone();
        let kept = core
            .dependencies
            .state
            .run(move |connection| manifests::get_for(connection, Stage::Pending, &lookup))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kept.digest, stored.digest);
    }
}
