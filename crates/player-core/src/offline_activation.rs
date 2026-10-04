//! Binding-scoped offline manifests, trial evidence, promotion, and pin lifetime.
use crate::{Dependencies, ManifestPreparationError, NativeConfiguration, NativeManifest, manifest_pin_holder};
use player_cas::ContentStore;
use player_state::repo::{
    binding::{self, CredentialState},
    cas::{self, PinReason},
    manifests::{self, Binding, Stage, StoredManifest},
    playback,
};
use player_types::Sha256Digest;

pub const ACTIVATION_TRIAL_TIMEOUT_MS: i64 = 30_000;

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
    pub local_now_ms: i64,
    pub offset_ms: i64,
    pub playback_disabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrialEvidence {
    pub manifest: Option<Sha256Digest>,
    pub accepted: bool,
    pub meaningful: bool,
    pub renderer_error: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrialDecision {
    NotCurrent,
    Failed,
    Promote,
    AwaitEvidence { deadline_ms: i64 },
}

#[derive(Debug)]
pub struct OfflineActivationCoordinator {
    dependencies: Dependencies,
    store: Option<ContentStore>,
    binding: Option<Binding>,
    invalid_pending: Option<Sha256Digest>,
    pending_error_version: Option<Sha256Digest>,
    trial: Option<(Sha256Digest, i64)>,
}

impl OfflineActivationCoordinator {
    pub fn new(dependencies: Dependencies, store: Option<ContentStore>) -> Self {
        Self { dependencies, store, binding: None, invalid_pending: None, pending_error_version: None, trial: None }
    }

    pub async fn load(&mut self) -> Option<OfflineManifestState> {
        let db = &self.dependencies.state;
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
            self.pending_error_version = None;
            self.trial = None;
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
            .ok()
            .flatten()
            .map(|target| target.digest);
        let local_now_ms = self.dependencies.clock.now().unix_millis();
        let flags = db.run(|connection| playback::get(connection)).await.unwrap_or_default();
        Some(OfflineManifestState {
            binding,
            active,
            pending,
            target,
            local_now_ms,
            offset_ms: flags.server_clock_offset_ms.unwrap_or_default(),
            playback_disabled: flags.playback_disabled,
        })
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
        }
        if self.trial.is_some_and(|(digest, _)| state.pending.as_ref().is_none_or(|pending| pending.digest != digest)) {
            self.trial = None;
        }
        self.sweep_pins(&state.active, &state.pending, on_screen).await;
    }

    pub fn pending_rejected(&self, digest: Sha256Digest) -> bool {
        self.pending_error_version == Some(digest)
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

    pub fn suspend_trial(&mut self) {
        self.trial = None;
    }
    pub fn start_trial(&mut self, digest: Sha256Digest, now_ms: i64) {
        self.trial = Some((digest, now_ms));
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
        if evidence.renderer_error || (now_ms >= deadline_ms && !(evidence.accepted && evidence.meaningful)) {
            self.pending_error_version = Some(digest);
            self.trial = None;
            TrialDecision::Failed
        } else if evidence.accepted && evidence.meaningful {
            TrialDecision::Promote
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
        &self,
        binding: &Binding,
        pending: &StoredManifest,
        candidate: &NativeManifest,
        evidence: TrialEvidence,
    ) -> bool {
        if evidence.manifest != Some(candidate.digest)
            || !evidence.accepted
            || !evidence.meaningful
            || evidence.renderer_error
            || pending.digest != candidate.digest
            || pending.binding != *binding
            || self.trial.is_none_or(|(digest, _)| digest != candidate.digest)
            || self.pending_rejected(candidate.digest)
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
                manifests::put_target(connection, &target)?;
                assert!(manifests::put_pending_for_target(connection, &write)?);
                Ok(())
            })
            .await
            .unwrap();
        (stored, NativeManifest::parse(document, binding.screen_id, digest).unwrap())
    }

    fn evidence(digest: Sha256Digest) -> TrialEvidence {
        TrialEvidence { manifest: Some(digest), accepted: true, meaningful: true, renderer_error: false }
    }

    #[tokio::test]
    async fn promotion_requires_current_trial_acceptance_and_meaningful_evidence() {
        let (dir, mut core, binding) = fixture().await;
        let (stored, candidate) = pending(&core, &binding, 1).await;
        let proof = evidence(stored.digest);
        assert!(!core.promote(&binding, &stored, &candidate, proof).await, "no current trial");
        core.start_trial(stored.digest, core.dependencies.clock.now().unix_millis());
        assert!(!core.promote(&binding, &stored, &candidate, TrialEvidence { meaningful: false, ..proof }).await);
        assert!(!core.promote(&binding, &stored, &candidate, TrialEvidence { accepted: false, ..proof }).await);
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
        assert!(core.promote(&binding, &stored, &candidate, proof).await);
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
        core.start_trial(first.digest, 0);
        let (_newer, _) = pending(&core, &binding, 2).await;
        assert!(!core.promote(&binding, &first, &candidate, evidence(first.digest)).await);
        let mut local = core.load().await.unwrap();
        assert_eq!(local.pending.as_ref().unwrap().version, 2);
        // The latest target is now newer than that pending document.
        let third = Target {
            binding: binding.clone(),
            digest: Sha256Digest::of(b"third"),
            version: 3,
            document: json!({"manifestVersion":3}),
            etag: "third".into(),
            fetched_at: core.dependencies.clock.now(),
        };
        core.dependencies.state.run(move |connection| manifests::put_target(connection, &third)).await.unwrap();
        local = core.load().await.unwrap();
        core.retain_pending(&mut local, Some(first.digest)).await;
        assert!(local.pending.is_none());
        assert!(core.trial.is_none());
        core.pending_error_version = Some(first.digest);
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
        assert!(local.active.is_none() && local.pending.is_none());
        assert!(!core.pending_rejected(first.digest));
    }

    #[tokio::test]
    async fn policy_suspension_restarts_the_trial_deadline_and_failures_stay_rejected() {
        let (_dir, mut core, _binding) = fixture().await;
        let digest = Sha256Digest::of(b"trial");
        let waiting = TrialEvidence { accepted: true, meaningful: false, ..evidence(digest) };
        core.start_trial(digest, 1000);
        assert_eq!(core.trial_decision(digest, 2000, waiting), TrialDecision::AwaitEvidence { deadline_ms: 31000 });
        core.suspend_trial();
        assert_eq!(core.trial_decision(digest, 90000, waiting), TrialDecision::AwaitEvidence { deadline_ms: 120000 });
        assert_eq!(core.trial_decision(digest, 120000, waiting), TrialDecision::Failed);
        assert!(core.pending_rejected(digest));
        assert_eq!(core.trial_decision(Sha256Digest::of(b"other"), 120000, waiting), TrialDecision::NotCurrent);
    }
}
