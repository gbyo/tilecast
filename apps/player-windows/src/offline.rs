//! Offline activation: Core drives the loop over the committed manifest;
//! the host projects, shows, and activates through the presentation engine.
//!
//! What may reach the screen follows the reference player's precedence:
//! safe mode first, then the rest surface outside configured active hours,
//! then the disabled surface while an administrator has disabled playback,
//! then content. A takeover or Quick Present outranks both the rest and the
//! disabled surfaces. A pending manifest is never promoted while a policy
//! surface is shown, because it has not produced evidence on screen; it is
//! tried when content returns.

use std::sync::Arc;

use player_core::Source;

use crate::daemon::DaemonContext;
use crate::player_config::WindowsPlayerConfig;
use crate::presentation::{PlaybackIdentity, PresentationEngine};
use crate::projection::{Projector, ResolvedPresentation};

fn lock(context: &DaemonContext) -> std::sync::MutexGuard<'_, PresentationEngine> {
    context.presentation.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn identity(candidate: &player_core::NativeManifest, resolved: &ResolvedPresentation) -> PlaybackIdentity {
    let selection = &resolved.selection;
    PlaybackIdentity {
        manifest: candidate.digest,
        manifest_version: candidate.version,
        selection_source: match selection.source {
            Source::Takeover => "takeover",
            Source::QuickPresent => "quick_present",
            Source::Schedule => "schedule",
            Source::Direct => "direct",
            Source::None => "none",
        },
        playlist_id: selection.playlist_id,
        layout_id: selection.layout_id,
        schedule_id: selection.schedule_id,
        takeover_id: selection.takeover_id,
        next_transition_ms: resolved.next_transition_ms,
    }
}

#[derive(Debug, PartialEq)]
struct SelectionKey {
    playlist: Option<uuid::Uuid>,
    layout: Option<uuid::Uuid>,
    schedule: Option<uuid::Uuid>,
    takeover: Option<uuid::Uuid>,
}

impl From<&PlaybackIdentity> for SelectionKey {
    fn from(identity: &PlaybackIdentity) -> Self {
        Self {
            playlist: identity.playlist_id,
            layout: identity.layout_id,
            schedule: identity.schedule_id,
            takeover: identity.takeover_id,
        }
    }
}

#[derive(Debug, PartialEq)]
struct PresentationKey {
    document: serde_json::Value,
    content: Vec<player_core::VerifiedContentRef>,
    timing: Option<(String, i64, Vec<u64>)>,
    identity: Option<SelectionKey>,
}

struct Host(Arc<DaemonContext>);

#[async_trait::async_trait]
impl player_core::OfflineActivationHost for Host {
    type Configuration = Arc<WindowsPlayerConfig>;
    type Projection = ResolvedPresentation;
    type Key = PresentationKey;

    fn configuration(&self) -> Self::Configuration {
        crate::config_sync::effective(&self.0)
    }
    fn native_configuration<'a>(&self, configuration: &'a Self::Configuration) -> &'a player_core::NativeConfiguration {
        &configuration.native
    }
    fn project(
        &self,
        candidate: &player_core::NativeManifest,
        configuration: &Self::Configuration,
        time: player_core::ActivationTime,
    ) -> Result<player_core::OfflineProjection<Self::Projection, Self::Key>, &'static str> {
        let resolved = Projector::new(candidate)
            .resolve(time.presentation_ms(), configuration)
            .map_err(|error| error.reason_code())?;
        let metadata = crate::renderer_adapter::metadata(&resolved.document, resolved.projection.as_ref(), false)
            .map_err(|_| "presentation_requirements_invalid")?;
        let identity = identity(candidate, &resolved);
        let key = PresentationKey {
            document: resolved.document.clone(),
            content: resolved.content.clone(),
            // Clock correction must not restart an existing synchronized timeline.
            timing: resolved
                .timing
                .as_ref()
                .map(|timing| (timing.group_id.clone(), timing.anchor_ms, timing.durations_ms.clone())),
            identity: Some(SelectionKey::from(&identity)),
        };
        Ok(player_core::OfflineProjection {
            key,
            source: resolved.selection.source,
            requirements: metadata.requirements,
            next_transition_ms: resolved.next_transition_ms,
            projection: resolved,
        })
    }
    async fn current(&self) -> Option<player_core::OfflineCurrent<Self::Key>> {
        let engine = lock(&self.0);
        engine.current().map(|activation| player_core::OfflineCurrent {
            source: activation.source,
            manifest: activation.manifest(),
            key: PresentationKey {
                document: activation.document.clone(),
                content: activation.content.clone(),
                timing: activation
                    .timing
                    .as_ref()
                    .map(|timing| (timing.group_id.clone(), timing.anchor_ms, timing.durations_ms.clone())),
                identity: activation.identity.as_ref().map(SelectionKey::from),
            },
            accepted: engine.current_is_accepted(),
            evidence: engine.current_has_activation_evidence(),
            playing: activation.document.get("state").and_then(serde_json::Value::as_str) == Some("playing"),
        })
    }
    async fn health(&self) -> player_core::OfflineRendererHealth {
        let engine = lock(&self.0);
        player_core::OfflineRendererHealth {
            safe_mode: engine.is_safe_mode(),
            current_error: engine.current_has_renderer_error(),
        }
    }
    async fn set_clock_offset(&self, offset_ms: i64) {
        lock(&self.0).set_clock_offset(offset_ms);
    }
    async fn supports(&self, requirements: &[player_core::RendererRequirement]) -> bool {
        lock(&self.0).renderer_supports(requirements)
    }
    async fn show_gate(
        &self,
        gate: player_core::ActivationGate,
        candidate: Option<&player_core::NativeManifest>,
        configuration: &Self::Configuration,
        time: player_core::ActivationTime,
    ) {
        let mut engine = lock(&self.0);
        match gate {
            player_core::ActivationGate::Rest => {
                engine.show_gate_rest(configuration, time.local_ms);
            }
            player_core::ActivationGate::Disabled => {
                engine.show_gate_disabled(candidate, configuration, time.local_ms);
            }
        }
    }
    async fn show_waiting(&self, now_ms: i64) {
        let configuration = crate::config_sync::effective(&self.0);
        lock(&self.0).show_waiting(&configuration, now_ms);
    }
    async fn activate(
        &self,
        candidate: &player_core::NativeManifest,
        resolved: Self::Projection,
        time: player_core::ActivationTime,
    ) -> Result<player_core::RendererActivationRef, &'static str> {
        let identity = identity(candidate, &resolved);
        lock(&self.0)
            .activate_server_presentation(identity, resolved, time.local_ms)
            .map(|reference| player_core::RendererActivationRef {
                activation_id: player_types::ids::ActivationId::from_uuid(reference.activation_id),
                generation: reference.generation,
            })
            .map_err(|error| {
                tracing::warn!(component = "activation", event = "activation_rejected", error = %error);
                "activation_rejected"
            })
    }
    fn promoted(&self) {
        self.0.manifest_wake.notify_one();
    }
}

/// Core drives offline activation; the host projects through the
/// presentation engine.
pub async fn run(context: Arc<DaemonContext>) {
    let Some(core) = context.core.as_ref() else {
        context.shutdown.cancelled().await;
        return;
    };
    let state = core.offline_activation(context.cas.clone());
    player_core::drive_offline_activation(
        state,
        &Host(context.clone()),
        player_core::OfflineActivationSignals {
            wake: &context.manifest_wake,
            item_boundary: &context.manifest_item_boundary,
            shutdown: &context.shutdown,
        },
    )
    .await;
}
