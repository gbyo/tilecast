//! Offline activation ordering. Hosts project opaque Runtime documents.
use crate::{
    ActivationGate, NativeConfiguration, NativeManifest, OfflineActivationCoordinator, RendererActivationRef,
    RendererRequirement, Source, TrialDecision, TrialEvidence, activation_gate, activation_grace_ms,
    overrides_activation_gate, should_activate_pending,
};
use player_state::repo::cas::PinReason;
use player_types::Sha256Digest;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MAX_SLEEP: Duration = Duration::from_secs(30);
const IDLE_SLEEP: Duration = Duration::from_secs(60);

/// Native activation origin; visual states remain Runtime-owned payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationSource {
    StatusSurface,
    Fixture,
    ServerManifest,
    SafeMode,
    Policy,
}
impl ActivationSource {
    pub fn as_token(self) -> &'static str {
        match self {
            Self::StatusSurface => "status_surface",
            Self::Fixture => "fixture",
            Self::ServerManifest => "server_manifest",
            Self::SafeMode => "safe_mode",
            Self::Policy => "policy",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ActivationTime {
    pub local_ms: i64,
    pub offset_ms: i64,
}
impl ActivationTime {
    pub fn presentation_ms(self) -> i64 {
        self.local_ms.saturating_add(self.offset_ms)
    }
}

/// The key and projection are host-owned. Core compares keys but does not
/// inspect presentation fields or synchronized renderer wire data.
#[derive(Debug)]
pub struct OfflineProjection<P, K> {
    pub projection: P,
    pub key: K,
    pub source: Source,
    pub requirements: Vec<RendererRequirement>,
    pub next_transition_ms: Option<i64>,
}

#[derive(Debug)]
pub struct OfflineCurrent<K> {
    pub source: ActivationSource,
    pub manifest: Option<Sha256Digest>,
    pub key: K,
    pub accepted: bool,
    pub evidence: bool,
    pub playing: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct OfflineRendererHealth {
    pub safe_mode: bool,
    pub current_error: bool,
}

#[async_trait::async_trait]
pub trait OfflineActivationHost: Send + Sync {
    type Configuration: Send + Sync;
    type Projection: Send;
    type Key: PartialEq + Send;
    fn configuration(&self) -> Self::Configuration;
    fn native_configuration<'a>(&self, configuration: &'a Self::Configuration) -> &'a NativeConfiguration;
    fn project(
        &self,
        candidate: &NativeManifest,
        configuration: &Self::Configuration,
        time: ActivationTime,
    ) -> Result<OfflineProjection<Self::Projection, Self::Key>, &'static str>;
    async fn current(&self) -> Option<OfflineCurrent<Self::Key>>;
    async fn health(&self) -> OfflineRendererHealth;
    async fn set_clock_offset(&self, offset_ms: i64);
    async fn supports(&self, requirements: &[RendererRequirement]) -> bool;
    async fn show_gate(
        &self,
        gate: ActivationGate,
        candidate: Option<&NativeManifest>,
        configuration: &Self::Configuration,
        time: ActivationTime,
    );
    async fn show_waiting(&self, now_ms: i64);
    async fn activate(
        &self,
        candidate: &NativeManifest,
        projection: Self::Projection,
        time: ActivationTime,
    ) -> Result<RendererActivationRef, &'static str>;
    fn promoted(&self);
}

#[derive(Debug)]
pub struct OfflineActivationSignals<'a> {
    pub wake: &'a Notify,
    pub item_boundary: &'a AtomicBool,
    pub shutdown: &'a CancellationToken,
}

pub async fn drive_offline_activation<H: OfflineActivationHost>(
    mut state: OfflineActivationCoordinator,
    host: &H,
    signals: OfflineActivationSignals<'_>,
) {
    loop {
        let boundary = signals.item_boundary.swap(false, Ordering::Relaxed);
        let next_at = tick(&mut state, host, boundary).await;
        let now_ms = state.now_ms();
        let delay = next_at
            .map(|at| Duration::from_millis(at.saturating_sub(now_ms).max(50) as u64).min(MAX_SLEEP))
            .unwrap_or(IDLE_SLEEP);
        tokio::select! {
            () = signals.shutdown.cancelled() => return,
            () = signals.wake.notified() => {},
            () = tokio::time::sleep(delay) => {},
        }
    }
}

fn earliest(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

async fn show<H: OfflineActivationHost>(
    state: &OfflineActivationCoordinator,
    host: &H,
    candidate: &NativeManifest,
    current: Option<&OfflineCurrent<H::Key>>,
    configuration: &H::Configuration,
    time: ActivationTime,
) -> Option<i64> {
    let resolved = match host.project(candidate, configuration, time) {
        Ok(resolved) => resolved,
        Err(reason) => {
            tracing::warn!(component = "activation", event = "selection_failed", reason);
            return None;
        }
    };
    let same = current.is_some_and(|current| {
        current.source == ActivationSource::ServerManifest
            && current.manifest == Some(candidate.digest)
            && current.key == resolved.key
    });
    let next = resolved.next_transition_ms.map(|at| at.saturating_sub(time.offset_ms));
    if !same {
        if state.pin(PinReason::ActivePresentation, candidate).await.is_err() {
            return next;
        }
        if let Err(reason) = host.activate(candidate, resolved.projection, time).await {
            tracing::warn!(component = "activation", event = "activation_rejected", reason);
        }
    }
    next
}

async fn tick<H: OfflineActivationHost>(
    state: &mut OfflineActivationCoordinator,
    host: &H,
    item_boundary: bool,
) -> Option<i64> {
    let mut local = state.load().await?;
    let binding = local.binding.clone();
    let time = ActivationTime { local_ms: local.local_now_ms, offset_ms: local.offset_ms };
    host.set_clock_offset(time.offset_ms).await;
    let configuration = host.configuration();
    let (gate, hours_change_ms) =
        activation_gate(host.native_configuration(&configuration), local.playback_disabled, time.presentation_ms());
    let hours_wake = hours_change_ms.map(|ms| time.local_ms.saturating_add(ms));
    let current = host.current().await;
    state.retain_pending(&mut local, current.as_ref().and_then(|current| current.manifest)).await;
    let retry_at = Some(time.local_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
    if host.health().await.safe_mode {
        state.suspend_trial();
        return retry_at;
    }
    let parse = |stored: &player_state::repo::manifests::StoredManifest| {
        NativeManifest::parse(stored.document.clone(), binding.screen_id, stored.digest)
    };
    let active_candidate = local.active.as_ref().and_then(|stored| parse(stored).ok());
    'pending: {
        if let Some(stored) = local.pending.as_ref() {
            if state.pending_rejected(stored.digest) {
                break 'pending;
            }
            let candidate = match parse(stored) {
                Ok(candidate) => candidate,
                Err(error) => {
                    if state.note_invalid(stored.digest) {
                        tracing::warn!(
                            component = "activation",
                            event = "pending_invalid",
                            reason = error.reason_code()
                        );
                    }
                    break 'pending;
                }
            };
            if let Some(gate) = gate
                && !host
                    .project(&candidate, &configuration, time)
                    .is_ok_and(|resolved| overrides_activation_gate(resolved.source))
            {
                state.suspend_trial();
                host.show_gate(gate, active_candidate.as_ref().or(Some(&candidate)), &configuration, time).await;
                return earliest(hours_wake, retry_at);
            }
            if let Some(current) = current.as_ref().filter(|current| current.manifest == Some(stored.digest)) {
                let renderer_error = host.health().await.current_error;
                let evidence = TrialEvidence {
                    manifest: current.manifest,
                    accepted: current.accepted,
                    meaningful: current.evidence,
                    renderer_error,
                };
                let decision = state.trial_decision(stored.digest, time.local_ms, evidence);
                match decision {
                    TrialDecision::Failed => {
                        tracing::warn!(component = "activation", event = "pending_trial_failed", manifest = %stored.digest.short(), renderer_error);
                        break 'pending;
                    }
                    TrialDecision::Promote => {
                        if state.promote(&binding, stored, &candidate, evidence).await {
                            state.suspend_trial();
                            host.promoted();
                            return Some(time.local_ms.saturating_add(50));
                        }
                        return retry_at;
                    }
                    TrialDecision::AwaitEvidence { deadline_ms } => {
                        let next = show(state, host, &candidate, Some(current), &configuration, time).await;
                        return earliest(Some(next.unwrap_or(deadline_ms).min(deadline_ms)), hours_wake);
                    }
                    TrialDecision::NotCurrent => return None,
                }
            }
            let resolved = match host.project(&candidate, &configuration, time) {
                Ok(resolved) => resolved,
                Err(reason) => {
                    if state.note_invalid(stored.digest) {
                        tracing::warn!(component = "activation", event = "pending_selection_failed", reason);
                    }
                    break 'pending;
                }
            };
            if !host.supports(&resolved.requirements).await {
                return retry_at;
            }
            let takeover = overrides_activation_gate(resolved.source);
            let playing = current
                .as_ref()
                .is_some_and(|current| current.source == ActivationSource::ServerManifest && current.playing);
            let grace_at = stored.stored_at.unix_millis().saturating_add(activation_grace_ms(&stored.document));
            if should_activate_pending(playing, takeover, item_boundary, time.local_ms, grace_at) {
                if state.verify_content(&candidate).await.is_err() {
                    return retry_at;
                }
                match host.activate(&candidate, resolved.projection, time).await {
                    Ok(reference) => {
                        state.start_trial(stored.digest, time.local_ms);
                        tracing::info!(component = "activation", event = "activation_started", manifest = %stored.digest.short(),
                            version = stored.version, generation = reference.generation, boundary = item_boundary,
                            grace_expired = time.local_ms >= grace_at, takeover);
                    }
                    Err(reason) => {
                        tracing::warn!(component = "activation", event = "activation_rejected", reason);
                        return retry_at;
                    }
                }
                return Some(time.local_ms.saturating_add(250));
            }
            return Some(grace_at);
        }
    }
    let Some(stored) = local.active.as_ref() else {
        if let Some(gate) = gate {
            host.show_gate(gate, None, &configuration, time).await;
            return earliest(hours_wake, retry_at);
        }
        if current.as_ref().is_some_and(|current| {
            matches!(current.source, ActivationSource::ServerManifest | ActivationSource::Policy)
        }) {
            host.show_waiting(time.local_ms).await;
        }
        return hours_wake;
    };
    let candidate = match parse(stored) {
        Ok(candidate) => candidate,
        Err(error) => {
            tracing::warn!(component = "activation", event = "active_invalid", reason = error.reason_code());
            return None;
        }
    };
    if state.verify_content(&candidate).await.is_err() {
        tracing::warn!(component = "activation", event = "active_cache_unavailable", manifest = %stored.digest.short());
        return retry_at;
    }
    let resolved = host.project(&candidate, &configuration, time);
    if let Some(gate) = gate
        && !resolved.as_ref().is_ok_and(|resolved| overrides_activation_gate(resolved.source))
    {
        host.show_gate(gate, Some(&candidate), &configuration, time).await;
        let next =
            resolved.ok().and_then(|resolved| resolved.next_transition_ms).map(|at| at.saturating_sub(time.offset_ms));
        return earliest(hours_wake, next);
    }
    earliest(show(state, host, &candidate, current.as_ref(), &configuration, time).await, hours_wake)
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_state::repo::{
        binding::{self, CredentialState, ServerBinding},
        manifests::{self, Binding, StoredManifest, Target},
    };
    use player_types::{InstallationId, ScreenId, Timestamp, time::ManualClock};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex, atomic::AtomicUsize};

    #[derive(Debug)]
    struct Space;
    impl player_cas::space::SpaceProbe for Space {
        fn available_bytes(&self, _: &std::path::Path) -> std::io::Result<u64> {
            Ok(1 << 40)
        }
    }

    struct Host {
        current: Mutex<Option<(Sha256Digest, Value)>>,
        supported: AtomicBool,
        evidence: AtomicBool,
        activations: AtomicUsize,
        promotions: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl OfflineActivationHost for Host {
        type Configuration = NativeConfiguration;
        type Projection = Value;
        type Key = Value;
        fn configuration(&self) -> NativeConfiguration {
            NativeConfiguration::default()
        }
        fn native_configuration<'a>(&self, configuration: &'a NativeConfiguration) -> &'a NativeConfiguration {
            configuration
        }
        fn project(
            &self,
            candidate: &NativeManifest,
            _: &NativeConfiguration,
            _: ActivationTime,
        ) -> Result<OfflineProjection<Value, Value>, &'static str> {
            let payload = candidate.document["playlist"].clone();
            Ok(OfflineProjection {
                projection: payload.clone(),
                key: payload,
                source: Source::Direct,
                requirements: vec![],
                next_transition_ms: None,
            })
        }
        async fn current(&self) -> Option<OfflineCurrent<Value>> {
            self.current.lock().unwrap().as_ref().map(|(digest, key)| OfflineCurrent {
                source: ActivationSource::ServerManifest,
                manifest: Some(*digest),
                key: key.clone(),
                accepted: true,
                evidence: self.evidence.load(Ordering::Relaxed),
                playing: true,
            })
        }
        async fn health(&self) -> OfflineRendererHealth {
            OfflineRendererHealth { safe_mode: false, current_error: false }
        }
        async fn set_clock_offset(&self, _: i64) {}
        async fn supports(&self, _: &[RendererRequirement]) -> bool {
            self.supported.load(Ordering::Relaxed)
        }
        async fn show_gate(
            &self,
            _: ActivationGate,
            _: Option<&NativeManifest>,
            _: &NativeConfiguration,
            _: ActivationTime,
        ) {
        }
        async fn show_waiting(&self, _: i64) {}
        async fn activate(
            &self,
            candidate: &NativeManifest,
            payload: Value,
            _: ActivationTime,
        ) -> Result<RendererActivationRef, &'static str> {
            self.activations.fetch_add(1, Ordering::Relaxed);
            *self.current.lock().unwrap() = Some((candidate.digest, payload));
            Ok(RendererActivationRef {
                activation_id: player_types::ActivationId::from_uuid(uuid::Uuid::from_u128(3)),
                generation: 1,
            })
        }
        fn promoted(&self) {
            self.promotions.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[tokio::test]
    async fn offline_driver_preserves_opaque_fields_and_waits_for_support_and_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let db =
            player_state::StateDb::open(dir.path().join("state.db"), player_state::OpenOptions::default()).unwrap();
        let now = Timestamp::parse("2026-10-04T12:00:00Z").unwrap();
        let clock = ManualClock::new(now);
        let binding = Binding {
            installation_id: InstallationId::from_uuid(uuid::Uuid::from_u128(1)),
            screen_id: ScreenId::from_uuid(uuid::Uuid::from_u128(2)),
            server_url: "https://signs.example.org".into(),
        };
        let document = json!({"schemaVersion":11,"mode":"presentation","screenId":binding.screen_id,"manifestVersion":1,
            "assets":[],"playlists":[],"schedules":[],"widgets":[],"dataSources":[],"plugins":[],"layouts":[],
            "playlist":{"id":uuid::Uuid::from_u128(4),"items":[],"unknownRuntimeVisual":{"newTransition":"spiral"}}});
        let digest = crate::manifest_digest(&document);
        let write = binding.clone();
        let expected = document["playlist"].clone();
        db.run(move |connection| {
            binding::put(
                connection,
                &ServerBinding {
                    server_url: write.server_url.clone(),
                    installation_id: write.installation_id,
                    screen_id: Some(write.screen_id),
                    organization_name: None,
                    screen_name: None,
                    credential_state: CredentialState::Stored,
                    identity_verified_at: Some(now),
                    bound_at: now,
                },
                now,
            )?;
            assert!(manifests::put_target(
                connection,
                &Target {
                    binding: write.clone(),
                    digest,
                    version: 1,
                    document: document.clone(),
                    fetched_at: now,
                    etag: "1".into(),
                },
            )?);
            assert!(manifests::put_pending_for_target(
                connection,
                &StoredManifest { binding: write, digest, version: 1, document, stored_at: now }
            )?);
            Ok(())
        })
        .await
        .unwrap();
        let store = player_cas::ContentStore::open(
            dir.path().join("cas"),
            dir.path().join("partial"),
            db.clone(),
            clock.clone(),
            Arc::new(Space),
            player_cas::StorePolicy { limit_bytes: 1 << 30, reserved_free_bytes: 0 },
            Arc::new(player_cas::LruByDomain),
        )
        .await
        .unwrap();
        let mut state =
            OfflineActivationCoordinator::new(crate::Dependencies { state: db.clone(), clock }, Some(store));
        let host = Host {
            current: Mutex::new(None),
            supported: AtomicBool::new(false),
            evidence: AtomicBool::new(false),
            activations: AtomicUsize::new(0),
            promotions: AtomicUsize::new(0),
        };
        tick(&mut state, &host, false).await;
        assert_eq!(host.activations.load(Ordering::Relaxed), 0, "absent connected support blocks activation");
        host.supported.store(true, Ordering::Relaxed);
        tick(&mut state, &host, false).await;
        assert_eq!(host.current.lock().unwrap().as_ref().unwrap().1, expected);
        tick(&mut state, &host, false).await;
        assert_eq!(host.activations.load(Ordering::Relaxed), 1, "unchanged opaque key preserves activation");
        assert_eq!(host.promotions.load(Ordering::Relaxed), 0, "acceptance alone cannot promote");
        host.evidence.store(true, Ordering::Relaxed);
        tick(&mut state, &host, false).await;
        assert_eq!(host.promotions.load(Ordering::Relaxed), 1);
        assert!(state.load().await.unwrap().pending.is_none());
        let mut restarted =
            OfflineActivationCoordinator::new(crate::Dependencies { state: db, clock: ManualClock::new(now) }, None);
        assert_eq!(restarted.load().await.unwrap().active.unwrap().document["playlist"], expected);
    }

    #[test]
    fn pending_activation_waits_for_a_boundary_unless_grace_or_takeover_applies() {
        assert!(!should_activate_pending(true, false, false, 999, 1_000));
        assert!(should_activate_pending(true, false, true, 999, 1_000));
        assert!(should_activate_pending(true, false, false, 1_000, 1_000));
        assert!(should_activate_pending(true, true, false, 999, 1_000));
        assert!(should_activate_pending(false, false, false, 999, 1_000));
    }
}
