//! Activates prepared manifests from the local cache.
//!
//! Preparation (`manifest_sync`) stores a manifest as pending only after every
//! object it needs is verified and only while it is the target: the server's
//! latest valid manifest answer. This task decides what the renderer shows:
//!
//! * the committed (active) presentation, re-resolved at every schedule and
//!   availability boundary at the corrected clock, with or without a server;
//! * a pending presentation, activated at an item boundary, after its bounded
//!   grace period, immediately for a takeover or Quick Present, or when
//!   nothing is playing;
//! * promotion of that pending presentation to active only after the current
//!   renderer accepted exactly its activation and reported meaningful content
//!   evidence for it, and only while it is still the target.
//!
//! A pending manifest superseded by a newer target is discarded and never
//! promoted; if it was being tried on screen, the committed presentation
//! returns until the newer one is ready. Pins follow the same rule: only the
//! active, pending and on-screen manifests keep theirs.
//!
//! What may reach the screen follows the reference player's precedence
//! (`player.ts#buildPresentation`): safe mode first, then the rest surface
//! outside configured active hours, then the disabled surface while an
//! administrator has disabled playback, then content. A takeover or Quick
//! Present outranks both the rest and the disabled surfaces. A pending
//! manifest is never promoted while a policy surface is shown, because it
//! has not produced evidence on screen; it is tried when content returns.

use std::sync::Arc;

use edge_protocol::ipc::presentation::PresentationDocument;

use crate::daemon::DaemonContext;
use crate::manifest::{Candidate, ResolvedPresentation};
use crate::player_config::PlayerConfig;
use crate::presentation::{ActivationSource, PlaybackIdentity, ServerExtras};
use player_core::Source;

pub use player_core::{ActivationGate as Gate, should_activate_pending};

pub fn gate(config: &PlayerConfig, playback_disabled: bool, now_ms: i64) -> (Option<Gate>, Option<i64>) {
    player_core::activation_gate(&config.native, playback_disabled, now_ms)
}

/// A takeover or Quick Present outranks the policy surfaces.
pub use player_core::overrides_activation_gate as overrides_gate;

/// The surface for `gate`. The disabled surface carries the manifest's
/// branding logo when a verified candidate is available.
pub fn gate_document(
    gate: Gate,
    config: &PlayerConfig,
    candidate: Option<&Candidate>,
    now_ms: i64,
) -> (PresentationDocument, Vec<edge_protocol::ipc::presentation::ContentRef>) {
    use edge_protocol::bounded::{SafeText, ShortToken};
    match gate {
        Gate::Rest => (
            PresentationDocument::Sleep {
                display: ShortToken::new(config.runtime.power.outside_display.as_str()).ok(),
                text: Some(SafeText::lossy(&config.runtime.power.outside_text)),
                text_color: Some(SafeText::lossy(config.runtime.branding.text())),
            },
            Vec::new(),
        ),
        Gate::Disabled => {
            if let Some(Ok(surface)) = candidate.map(|candidate| candidate.disabled_surface(now_ms, config)) {
                return surface;
            }
            let branding = &config.runtime.branding;
            (
                PresentationDocument::Disabled(edge_protocol::ipc::presentation::StatusSurface {
                    title: SafeText::lossy(branding.disabled_title.as_deref().unwrap_or("Screen disabled")),
                    message: SafeText::lossy(branding.disabled_message.as_deref().unwrap_or("")),
                    background_color: Some(SafeText::lossy(branding.background())),
                    text_color: Some(SafeText::lossy(branding.text())),
                    logo_src: None,
                    footer_text: branding.footer_text.as_deref().map(SafeText::lossy),
                    status: Some(SafeText::lossy("disabled")),
                }),
                Vec::new(),
            )
        }
    }
}

/// Shows a policy surface unless it is already on screen.
async fn show_policy(
    context: &DaemonContext,
    document: PresentationDocument,
    content: Vec<edge_protocol::ipc::presentation::ContentRef>,
    local_now_ms: i64,
) {
    let mut engine = context.presentation.lock().await;
    let showing = engine.current().is_some_and(|current| {
        current.source == ActivationSource::Policy && current.document == document && current.content == content
    });
    if !showing {
        tracing::info!(component = "activation", event = "policy_surface", state = document.state_name());
        if let Err(error) = engine.activate(document, content, None, ActivationSource::Policy, local_now_ms) {
            tracing::warn!(component = "activation", event = "policy_surface_rejected", error = %error);
        }
    }
}

fn identity(candidate: &Candidate, resolved: &ResolvedPresentation) -> PlaybackIdentity {
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

fn extras(resolved: &ResolvedPresentation, offset_ms: i64) -> ServerExtras {
    ServerExtras {
        timing: resolved.timing.as_ref().map(|timing| edge_protocol::ipc::event::SyncTiming {
            group_id: edge_protocol::bounded::SafeText::lossy(&timing.group_id),
            anchor_unix_ms: timing.anchor_ms,
            durations_ms: timing.durations_ms.clone(),
            clock_offset_ms: offset_ms,
        }),
        projection: resolved.projection.clone(),
        plugins: resolved.plugins.clone(),
        plugin_aliases: resolved.plugin_aliases.clone(),
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
    document: PresentationDocument,
    content: Vec<edge_protocol::ipc::presentation::ContentRef>,
    timing: Option<(String, i64, Vec<u64>)>,
    identity: Option<SelectionKey>,
}

struct Host(Arc<DaemonContext>);

#[async_trait::async_trait]
impl player_core::OfflineActivationHost for Host {
    type Configuration = Arc<PlayerConfig>;
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
        native: &player_core::NativeManifest,
        configuration: &Self::Configuration,
        time: player_core::ActivationTime,
    ) -> Result<player_core::OfflineProjection<Self::Projection, Self::Key>, &'static str> {
        let candidate = Candidate::from_native(native.clone());
        let mut resolved =
            candidate.presentation_with(time.presentation_ms(), configuration).map_err(|error| error.reason_code())?;
        // A recorded installation mismatch stops server content: the screen
        // shows the mismatch surface instead of anything the old server sent.
        if let Some(record) = crate::mismatch::content_blocked(&self.0) {
            resolved.document = crate::mismatch::mismatch_surface(&record);
            resolved.timing = None;
            resolved.content = Vec::new();
            resolved.projection = None;
            resolved.plugins = Vec::new();
            resolved.plugin_aliases = Vec::new();
        }
        // Durable playlist resume, before the activation key is computed: the
        // resumed order is the projection, so it never reads as a change.
        // After a mismatch gate the content is empty and this is a no-op.
        {
            let mut resume = self.0.resume.lock().unwrap_or_else(|poison| poison.into_inner());
            crate::resume::maybe_rotate(
                &mut resume,
                &mut resolved,
                &candidate.digest.to_hex(),
                candidate.version,
                configuration.runtime.playback.resume_after_restart(),
                time.presentation_ms(),
            );
        }
        let metadata = crate::renderer_adapter::metadata(
            &resolved.document,
            ActivationSource::ServerManifest,
            resolved.projection.as_ref(),
        )
        .map_err(|_| "presentation_requirements_invalid")?;
        let identity = identity(&candidate, &resolved);
        let key = PresentationKey {
            document: resolved.document.clone(),
            content: resolved.content.clone(),
            // Clock correction must not restart an existing synchronized timeline.
            timing: resolved.timing.as_ref().map(|t| (t.group_id.clone(), t.anchor_ms, t.durations_ms.clone())),
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
        let engine = self.0.presentation.lock().await;
        engine.current().map(|activation| player_core::OfflineCurrent {
            source: activation.source,
            manifest: activation.manifest(),
            key: PresentationKey {
                document: activation.document.clone(),
                content: activation.content.clone(),
                timing: activation
                    .timing
                    .as_ref()
                    .map(|t| (t.group_id.as_str().to_owned(), t.anchor_unix_ms, t.durations_ms.clone())),
                identity: activation.identity.as_ref().map(SelectionKey::from),
            },
            accepted: engine.current_is_accepted(),
            evidence: engine.current_has_activation_evidence(),
            playing: matches!(&activation.document, PresentationDocument::Playing { items, .. } if !items.is_empty()),
        })
    }
    async fn health(&self) -> player_core::OfflineRendererHealth {
        let engine = self.0.presentation.lock().await;
        player_core::OfflineRendererHealth {
            safe_mode: engine.is_safe_mode(),
            current_error: engine.current_has_renderer_error(),
        }
    }
    async fn set_clock_offset(&self, offset_ms: i64) {
        self.0.presentation.lock().await.set_clock_offset(offset_ms);
    }
    async fn supports(&self, requirements: &[player_core::RendererRequirement]) -> bool {
        self.0.presentation.lock().await.renderer_supports(requirements)
    }
    async fn show_gate(
        &self,
        gate: Gate,
        native: Option<&player_core::NativeManifest>,
        configuration: &Self::Configuration,
        time: player_core::ActivationTime,
    ) {
        let candidate = native.cloned().map(Candidate::from_native);
        let (document, content) = gate_document(gate, configuration, candidate.as_ref(), time.presentation_ms());
        show_policy(&self.0, document, content, time.local_ms).await;
    }
    async fn show_waiting(&self, now_ms: i64) {
        let surface = crate::daemon::status_surface_for(&self.0, true);
        let _ = self.0.presentation.lock().await.activate(
            surface,
            Vec::new(),
            None,
            ActivationSource::StatusSurface,
            now_ms,
        );
    }
    async fn activate(
        &self,
        native: &player_core::NativeManifest,
        resolved: Self::Projection,
        time: player_core::ActivationTime,
    ) -> Result<player_core::RendererActivationRef, &'static str> {
        let candidate = Candidate::from_native(native.clone());
        let identity = identity(&candidate, &resolved);
        let extras = extras(&resolved, time.offset_ms);
        self.0
            .presentation
            .lock()
            .await
            .activate_server_presentation(identity, resolved.document, resolved.content, extras, time.local_ms)
            .map(|reference| player_core::RendererActivationRef {
                activation_id: reference.activation_id,
                generation: reference.generation,
            })
            .map_err(|error| {
                tracing::warn!(component = "activation", event = "activation_rejected", error = %error);
                "activation_rejected"
            })
    }
    fn promoted(&self) {
        self.0.manifest_wake.notify_one();
        self.0.display_wake.notify_one();
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    if context.config.dev.fixture.is_some() {
        return;
    }
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
