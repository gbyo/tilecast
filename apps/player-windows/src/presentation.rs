//! The presentation engine: what the renderer should show, and whether it is.
//!
//! Ownership mirrors Edge: selection, scheduling, preparation, and health
//! are daemon concerns. The renderer receives a complete, validated,
//! prepared activation and reports evidence. This module:
//!
//! * holds the current activation and issues new ones
//!   ([`PresentationEngine::activate`]);
//! * validates every activation's content references before it can be sent
//!   (all referenced objects must be listed, and the caller guarantees they
//!   are verified and pinned in the CAS);
//! * sends the current activation once the renderer reports ready, only if
//!   the renderer advertises every feature the presentation requires.
//!   Otherwise the screen shows an explicit "unavailable" surface and the
//!   engine reports the reason, rather than silently dropping content;
//! * feeds meaningful evidence into the recovery ladder in Player Core and
//!   performs its actions through [`WebViewPort`](crate::renderer_adapter::WebViewPort).
//!
//! Server presentations arrive through the offline activation host in
//! [`crate::offline`]; status surfaces (setup, pairing, waiting, gates,
//! safe mode) are activated directly.

use player_core::{
    ActivationSource, HealAction, RendererActivation, RendererActivationRef, RendererCoordinator, RendererDispatch,
    RendererMetadata, RendererPort, RendererProfileMismatch, RendererRequirement, SemanticRendererCommand,
    SemanticRendererProgress, SupervisorConfig, VerifiedContentRef, VerifiedFrameRef,
};
use player_types::bounded::{SafeText, ShortToken};
use player_types::ids::ActivationId;
use player_types::{Sha256Digest, Timestamp};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::bridge;
use crate::media::MediaRegistry;
use crate::projection::{GroupTiming, MediaAlias, Projector, ResolvedPresentation};
use crate::ui::{UiEvent, UiHandle};

fn policy_time(now_ms: i64) -> Timestamp {
    Timestamp::from_unix_millis(now_ms).expect("native clock is in range")
}

fn semantic_ref(reference: &bridge::ActivationRef) -> RendererActivationRef {
    RendererActivationRef {
        activation_id: ActivationId::from_uuid(reference.activation_id),
        generation: reference.generation,
    }
}

/// Which verified presentation an activation shows and what selected it:
/// the same identifiers the reference player reports in its heartbeat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybackIdentity {
    /// The prepared manifest this activation shows.
    pub manifest: Sha256Digest,
    pub manifest_version: i64,
    pub selection_source: &'static str,
    pub playlist_id: Option<uuid::Uuid>,
    pub layout_id: Option<uuid::Uuid>,
    pub schedule_id: Option<uuid::Uuid>,
    pub takeover_id: Option<uuid::Uuid>,
    pub next_transition_ms: Option<i64>,
}

/// Everything a server presentation activation carries besides its document.
#[derive(Debug, Clone, Default)]
pub struct ServerExtras {
    /// The synchronized group's timeline, anchored at activation.
    pub timing: Option<GroupTiming>,
    pub projection: Option<Value>,
    pub plugins: Vec<Value>,
    pub plugin_aliases: Vec<MediaAlias>,
}

#[derive(Debug, Clone)]
pub struct Activation {
    pub id: ActivationId,
    pub generation: u64,
    /// The prepared manifest and selection for server-presentation
    /// activations.
    pub identity: Option<PlaybackIdentity>,
    pub document: Value,
    pub renderer_metadata: RendererMetadata,
    pub content: Vec<VerifiedContentRef>,
    pub frames: Vec<VerifiedFrameRef>,
    pub timing: Option<GroupTiming>,
    pub source: ActivationSource,
    pub extras: ServerExtras,
}

impl Activation {
    fn reference(&self) -> bridge::ActivationRef {
        bridge::ActivationRef { activation_id: *self.id.as_uuid(), generation: self.generation }
    }

    pub fn manifest(&self) -> Option<Sha256Digest> {
        self.identity.as_ref().map(|identity| identity.manifest)
    }
}

/// Why an activation was refused before it could reach the renderer.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum PresentationError {
    #[error("presentation requirements are invalid")]
    InvalidRequirements,
    #[error("the presentation references content outside its manifest")]
    UnlistedContent,
    #[error("the presentation content URI is malformed")]
    MalformedContentUri,
    #[error("the runtime payload is too large or has too many bindings")]
    Payload,
}

impl PresentationError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::InvalidRequirements => "presentation_requirements_invalid",
            Self::UnlistedContent => "presentation_content_unlisted",
            Self::MalformedContentUri => "presentation_content_malformed",
            Self::Payload => "presentation_payload_invalid",
        }
    }
}

fn validate_media_aliases(aliases: &[MediaAlias], content: &[VerifiedContentRef]) -> Result<(), PresentationError> {
    for alias in aliases {
        let digest = crate::projection::parse_content_uri(&alias.uri).ok_or(PresentationError::MalformedContentUri)?;
        if !content.iter().any(|reference| reference.sha256 == digest) {
            return Err(PresentationError::UnlistedContent);
        }
    }
    Ok(())
}

/// Every content URI inside a Runtime-bound value must name a listed,
/// verified object; anything else fails the activation.
fn validate_content_uris(value: &Value, content: &[VerifiedContentRef]) -> Result<(), PresentationError> {
    match value {
        Value::String(text) if text.to_ascii_lowercase().starts_with("tcmedia:") => {
            let digest = crate::projection::parse_content_uri(text).ok_or(PresentationError::MalformedContentUri)?;
            if !content.iter().any(|reference| reference.sha256 == digest) {
                return Err(PresentationError::UnlistedContent);
            }
            Ok(())
        }
        Value::Array(items) => items.iter().try_for_each(|item| validate_content_uris(item, content)),
        Value::Object(members) => members.values().try_for_each(|item| validate_content_uris(item, content)),
        _ => Ok(()),
    }
}

#[derive(Debug)]
struct RendererLink {
    session: uuid::Uuid,
    ready: Option<bridge::RuntimeReady>,
    port: crate::renderer_adapter::WebViewPort,
}

impl RendererLink {
    fn port(&self) -> &crate::renderer_adapter::WebViewPort {
        &self.port
    }
}

#[derive(Debug)]
pub struct PresentationEngine {
    media: Arc<Mutex<MediaRegistry>>,
    current: Option<Activation>,
    renderer: Option<RendererLink>,
    incompatible_reason: Option<String>,
    native: RendererCoordinator,
    restart_count: u64,
    fatal_restarts: u32,
    last_fatal_ms: i64,
    activity: Option<player_core::ActivityHandle>,
    clock_offset_ms: i64,
    remote: crate::remote_web::SurfaceTracker,
    startup_clear: player_core::StartupWebsiteClear,
}

impl PresentationEngine {
    pub fn new(media: Arc<Mutex<MediaRegistry>>, supervisor_config: SupervisorConfig, now_ms: i64) -> Self {
        Self {
            media,
            current: None,
            renderer: None,
            incompatible_reason: None,
            native: RendererCoordinator::new(
                crate::renderer_adapter::packaged_profile(),
                supervisor_config,
                policy_time(now_ms),
            ),
            restart_count: 0,
            fatal_restarts: 0,
            last_fatal_ms: 0,
            activity: None,
            clock_offset_ms: 0,
            remote: crate::remote_web::SurfaceTracker::new(),
            startup_clear: player_core::StartupWebsiteClear::default(),
        }
    }

    pub fn media(&self) -> Arc<Mutex<MediaRegistry>> {
        Arc::clone(&self.media)
    }

    pub fn set_activity(&mut self, activity: player_core::ActivityHandle) {
        self.activity = Some(activity);
    }

    fn signal(&self, signal: player_core::ActivitySignal) {
        if let Some(activity) = &self.activity {
            activity.send(signal);
        }
    }

    pub fn set_clock_offset(&mut self, offset_ms: i64) {
        self.clock_offset_ms = offset_ms;
    }

    /// Issues a new activation and sends it if a ready renderer is connected.
    pub fn activate(
        &mut self,
        document: Value,
        content: Vec<VerifiedContentRef>,
        timing: Option<GroupTiming>,
        source: ActivationSource,
        now_ms: i64,
    ) -> Result<bridge::ActivationRef, PresentationError> {
        self.activate_revision(document, content, Vec::new(), timing, source, None, ServerExtras::default(), now_ms)
    }

    /// Activates a prepared server presentation. The identity binds renderer
    /// acceptance and evidence to exactly this manifest.
    pub fn activate_server_presentation(
        &mut self,
        identity: PlaybackIdentity,
        resolved: ResolvedPresentation,
        now_ms: i64,
    ) -> Result<bridge::ActivationRef, PresentationError> {
        if let Some(projection) = &resolved.projection {
            validate_content_uris(projection, &resolved.content)?;
        }
        validate_media_aliases(&resolved.plugin_aliases, &resolved.content)?;
        for plugin in &resolved.plugins {
            validate_content_uris(plugin, &resolved.content)?;
        }
        let timing = resolved.timing.clone();
        let extras = ServerExtras {
            timing: timing.clone(),
            projection: resolved.projection,
            plugins: resolved.plugins,
            plugin_aliases: resolved.plugin_aliases,
        };
        self.activate_revision(
            resolved.document,
            resolved.content,
            resolved.frames,
            timing,
            ActivationSource::ServerManifest,
            Some(identity),
            extras,
            now_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn activate_revision(
        &mut self,
        document: Value,
        content: Vec<VerifiedContentRef>,
        frames: Vec<VerifiedFrameRef>,
        timing: Option<GroupTiming>,
        source: ActivationSource,
        identity: Option<PlaybackIdentity>,
        extras: ServerExtras,
        now_ms: i64,
    ) -> Result<bridge::ActivationRef, PresentationError> {
        validate_content_uris(&document, &content)?;
        let renderer_metadata = crate::renderer_adapter::metadata(
            &document,
            extras.projection.as_ref(),
            source == ActivationSource::SafeMode,
        )
        .map_err(|_| PresentationError::InvalidRequirements)?;
        let reference = self
            .native
            .begin_activation(
                ActivationId::from_uuid(uuid::Uuid::new_v4()),
                renderer_metadata.clone(),
                policy_time(now_ms),
            )
            .map_err(|_| PresentationError::InvalidRequirements)?;
        let activation = Activation {
            id: reference.activation_id,
            generation: reference.generation,
            identity,
            document,
            renderer_metadata,
            content,
            frames,
            timing,
            source,
            extras,
        };
        let reference = activation.reference();
        tracing::info!(
            component = "presentation",
            event = "activation_issued",
            generation = activation.generation,
            state = activation.document.get("state").and_then(|state| state.as_str()).unwrap_or(""),
            content = activation.content.len()
        );
        if let Some(presented) = presented(&activation) {
            self.signal(player_core::ActivitySignal::Presented(presented));
        }
        self.current = Some(activation);
        self.push_current();
        Ok(reference)
    }

    pub fn current(&self) -> Option<&Activation> {
        self.current.as_ref()
    }

    pub fn current_manifest(&self) -> Option<Sha256Digest> {
        self.current.as_ref().and_then(Activation::manifest)
    }

    /// The item the renderer last reported starting for the current
    /// activation, with when it started.
    pub fn current_item(&self) -> Option<(String, Timestamp)> {
        self.native.tracker().current_item()
    }

    pub fn current_is_server_manifest(&self) -> bool {
        self.current.as_ref().is_some_and(|activation| activation.source == ActivationSource::ServerManifest)
    }

    pub fn current_has_meaningful_progress(&self) -> bool {
        self.native.tracker().meaningful()
    }

    pub fn current_has_activation_evidence(&self) -> bool {
        self.native.has_activation_evidence()
    }

    /// Items of the current activation that the renderer proved with
    /// content evidence (an image shown, video progress, a layout rendered).
    pub fn content_evidence_items(&self) -> &BTreeSet<String> {
        self.native.tracker().content_items()
    }

    pub fn current_is_accepted(&self) -> bool {
        self.native.tracker().accepted_current()
    }

    pub fn current_has_renderer_error(&self) -> bool {
        self.native.tracker().has_error()
    }

    /// When the renderer last reported progress for any activation.
    pub fn last_progress_at(&self) -> Option<Timestamp> {
        self.native.tracker().last_progress()
    }

    /// The renderer state in the reference player's vocabulary
    /// (`safe_mode`, `disconnected`, `starting`, `incompatible`,
    /// `healthy`, `waiting_for_progress`).
    pub fn renderer_state(&self) -> &'static str {
        let link = self.renderer.as_ref();
        let ready = link.and_then(|link| link.ready.as_ref());
        match (link, ready, self.native.is_safe_mode()) {
            (_, _, true) => "safe_mode",
            (None, _, _) => "disconnected",
            (Some(_), None, _) => "starting",
            (Some(_), Some(_), _) if self.incompatible_reason.is_some() => "incompatible",
            (Some(_), Some(_), _) if self.native.tracker().last_progress().is_some() => "healthy",
            _ => "waiting_for_progress",
        }
    }

    /// Digests the current activation needs pinned.
    pub fn pinned_content(&self) -> BTreeSet<Sha256Digest> {
        self.current.iter().flat_map(|a| a.content.iter().map(|c| c.sha256)).collect()
    }

    pub fn is_safe_mode(&self) -> bool {
        self.native.is_safe_mode()
    }

    pub fn renderer_supports(&self, requirements: &[RendererRequirement]) -> bool {
        self.native.supports(requirements)
    }

    pub fn renderer_is_ready(&self) -> bool {
        self.renderer.as_ref().is_some_and(|link| link.ready.is_some())
    }

    pub fn renderer_session(&self) -> Option<uuid::Uuid> {
        self.renderer.as_ref().map(|link| link.session)
    }

    pub fn incompatible_reason(&self) -> Option<&str> {
        self.incompatible_reason.as_deref()
    }

    pub fn renderer_ready_info(&self) -> Option<&bridge::RuntimeReady> {
        self.renderer.as_ref().and_then(|link| link.ready.as_ref())
    }

    /// A WebView2 controller started (or restarted): the old session's
    /// grants are already dead; the new session binds here.
    pub fn renderer_connected(&mut self, session: uuid::Uuid, ui: UiHandle, now_ms: i64) {
        let port = crate::renderer_adapter::WebViewPort::new(ui, Arc::clone(&self.media), session);
        self.renderer = Some(RendererLink { session, ready: None, port });
        // A new controller takes the remote layers with it; the reloaded
        // Runtime re-creates what it still shows.
        self.remote.reset();
        self.native.connected(session, policy_time(now_ms));
    }

    pub fn renderer_disconnected(&mut self, session: uuid::Uuid) {
        self.native.disconnected(session);
        if self.renderer.as_ref().is_some_and(|link| link.session == session) {
            self.renderer = None;
            self.remote.reset();
        }
    }

    fn link_for(&mut self, session: uuid::Uuid) -> Option<&mut RendererLink> {
        self.renderer.as_mut().filter(|link| link.session == session)
    }

    pub fn renderer_ready(&mut self, session: uuid::Uuid, ready: bridge::RuntimeReady) {
        let Some(link) = self.link_for(session) else {
            return;
        };
        tracing::info!(
            component = "presentation",
            event = "renderer_ready",
            runtime = ready.runtime_version.as_str(),
            contract = ready.contract_version,
        );
        // The packaged profile is the ceiling; live support that fails its
        // bounds fails the renderer, not the ceiling.
        let profile = match crate::renderer_adapter::connected_profile(&ready) {
            Ok(profile) => profile,
            Err(error) => {
                tracing::warn!(component = "presentation", event = "renderer_support_invalid", error = %error);
                link.ready = Some(ready);
                self.incompatible_reason = Some("This display engine reported invalid capabilities.".to_string());
                self.post_unavailable();
                return;
            }
        };
        link.ready = Some(ready);
        self.native.ready(session, profile);
        self.push_current();
    }

    pub fn accepted(&mut self, session: uuid::Uuid, activation: &bridge::ActivationRef) {
        self.native.accepted(session, semantic_ref(activation));
    }

    pub fn rejected(&mut self, session: uuid::Uuid, activation: &bridge::ActivationRef, code: &str) {
        if self.native.rejected(session, semantic_ref(activation), ShortToken::new(code).ok()) {
            tracing::warn!(component = "presentation", event = "activation_rejected", code);
        }
    }

    /// Feeds one evidence report into Core. Returns whether it was
    /// meaningful for the current activation.
    pub fn progress(&mut self, session: uuid::Uuid, report: &bridge::EvidenceReport, now_ms: i64) -> bool {
        let Some(kind) = crate::renderer_adapter::evidence(&report.kind) else {
            return false;
        };
        let Some(activation) = report.activation.as_ref() else {
            return false;
        };
        let semantic = SemanticRendererProgress {
            activation: semantic_ref(activation),
            kind,
            item_id: report.item_id.as_deref().and_then(|id| SafeText::new(id).ok()),
            zone_id: report.zone_id.as_deref().and_then(|id| SafeText::new(id).ok()),
        };
        let decision = self.native.progress(session, &semantic, policy_time(now_ms));
        if let Some(kind) = decision.activity_signal {
            self.signal(player_core::ActivitySignal::Renderer { kind, item_id: report.item_id.clone() });
        }
        if !decision.meaningful {
            return false;
        }
        if decision.log_evidence {
            tracing::info!(
                component = "presentation",
                event = "evidence_accepted",
                generation = activation.generation,
                item = report.item_id.as_deref().unwrap_or(""),
                zone = report.zone_id.as_deref().unwrap_or(""),
                kind = report.kind.as_str()
            );
        }
        true
    }

    pub fn item_error(&mut self, session: uuid::Uuid, report: &bridge::PlaybackErrorReport) {
        let Some(activation) = report.activation.as_ref() else {
            return;
        };
        if self.native.rejected(session, semantic_ref(activation), ShortToken::new("playback-error").ok()) {
            self.signal(player_core::ActivitySignal::PlaybackError {
                item_id: report.item_id.clone(),
                message: report.message.clone(),
            });
        }
    }

    /// A WebView2 process exited. The crash feeds the ladder as a rejection
    /// of the current activation, so recovery stays spaced and safe mode
    /// stays the backstop; the crash itself is reported as a playback error.
    pub fn renderer_process_failed(&mut self, session: uuid::Uuid, kind: &str) {
        tracing::warn!(component = "presentation", event = "renderer_process_failed", kind);
        let Some(current) = self.current.as_ref() else {
            return;
        };
        let code = kind.replace(':', "-");
        self.native.rejected(
            session,
            RendererActivationRef { activation_id: current.id, generation: current.generation },
            ShortToken::new(code).ok(),
        );
        self.signal(player_core::ActivitySignal::PlaybackError {
            item_id: None,
            message: format!("renderer process failed: {kind}"),
        });
    }

    /// The controller or environment failed; the session is dead. Returns
    /// whether the UI thread accepted a restart: repeated failures stop
    /// restarting and leave the engine renderer-less for the operator.
    pub fn renderer_fatal(&mut self, session: uuid::Uuid, reason: &str, now_ms: i64) -> bool {
        tracing::warn!(component = "presentation", event = "renderer_fatal", reason);
        let ui = self.renderer.as_ref().filter(|link| link.session == session).map(|link| link.port.ui());
        self.renderer_disconnected(session);
        let Some(ui) = ui else {
            return false;
        };
        const MAX_FATAL_RESTARTS: u32 = 3;
        const FATAL_WINDOW_MS: i64 = 60_000;
        let recent = now_ms.saturating_sub(self.last_fatal_ms) < FATAL_WINDOW_MS;
        self.fatal_restarts = if recent { self.fatal_restarts + 1 } else { 1 };
        self.last_fatal_ms = now_ms;
        if self.fatal_restarts > MAX_FATAL_RESTARTS {
            tracing::error!(
                component = "presentation",
                event = "renderer_restart_abandoned",
                reason = "the renderer failed repeatedly; restart the player"
            );
            return false;
        }
        if ui.restart("renderer-fatal", 5_000).is_err() {
            return false;
        }
        self.restart_count += 1;
        true
    }

    /// Periodic supervision. Returns the action taken, for logging/tests.
    pub fn tick(&mut self, now_ms: i64) -> HealAction {
        let action = self.native.evaluate_recovery(policy_time(now_ms));
        self.execute_recovery(action, now_ms)
    }

    fn execute_recovery(&mut self, action: HealAction, now_ms: i64) -> HealAction {
        match action {
            HealAction::None => {}
            HealAction::Reactivate => {
                if let Some(current) = self.current.take() {
                    let _ = self.activate_revision(
                        current.document,
                        current.content,
                        current.frames,
                        current.timing,
                        current.source,
                        current.identity,
                        current.extras,
                        now_ms,
                    );
                }
            }
            HealAction::ReloadRenderer | HealAction::RestartRenderer => {
                if action == HealAction::RestartRenderer {
                    self.restart_count += 1;
                }
                if let Some(link) = &self.renderer {
                    let _ = self.native.dispatch_recovery(link.port(), action, uuid::Uuid::new_v4());
                }
            }
            HealAction::EnterSafeMode => {
                let reason = self.native.safe_mode_reason();
                let _ = self.activate(
                    serde_json::json!({"state": "safe-mode", "reason": reason.as_str()}),
                    Vec::new(),
                    None,
                    ActivationSource::SafeMode,
                    now_ms,
                );
            }
        }
        if action != HealAction::None {
            tracing::warn!(component = "presentation", event = "heal_action", action = ?action);
            if let Some(event) = self.native.recovery_event(action) {
                self.signal(player_core::ActivitySignal::Event(Box::new(event)));
            }
        }
        action
    }

    pub fn clear(&mut self, reason: &str) {
        self.current = None;
        self.native.clear();
        if let Some(link) = &self.renderer {
            let reason = ShortToken::new(reason).unwrap_or_else(|_| ShortToken::new("cleared").expect("literal"));
            let _ = link.port().clear(&reason);
        }
    }

    fn push_current(&mut self) {
        let Some(session) = self.renderer.as_ref().filter(|link| link.ready.is_some()).map(|link| link.session) else {
            return;
        };
        let Some(current) = self.current.clone() else { return };
        let semantic = match prepare(&current, self.clock_offset_ms) {
            Ok(semantic) => semantic,
            Err(error) => {
                tracing::error!(component = "media", event = "invalid_prepared_activation", error = %error);
                return;
            }
        };
        let link = match self.renderer.as_ref().filter(|link| link.session == session) {
            Some(link) => link,
            None => return,
        };
        let incompatible = match self.native.dispatch(session, &semantic, link.port()) {
            Ok(RendererDispatch::Queued) => {
                self.incompatible_reason = None;
                return;
            }
            Ok(RendererDispatch::Incompatible(missing)) => missing,
            Err(error) => {
                self.incompatible_reason = None;
                tracing::error!(component = "media", event = "renderer_activation_failed", error = %error);
                return;
            }
        };
        let missing: Vec<String> = incompatible
            .iter()
            .map(|(requirement, _)| match requirement {
                RendererRequirement::Feature(name) => name.as_str().to_owned(),
                RendererRequirement::PresentationSchema(version) => {
                    format!("presentation schema {version}")
                }
                RendererRequirement::Declarative { name, version }
                | RendererRequirement::WidgetComponent { name, version } => {
                    format!("{name} version {version}")
                }
            })
            .collect();
        if !missing.is_empty() {
            let reason = if incompatible.iter().any(|(_, source)| *source == RendererProfileMismatch::Packaged) {
                format!("This Player release does not support: {}.", missing.join(", "))
            } else {
                format!("This display engine does not support: {}.", missing.join(", "))
            };
            tracing::warn!(component = "presentation", event = "presentation_incompatible", missing = %missing.join(","));
            self.incompatible_reason = Some(reason);
            self.post_unavailable();
        }
    }

    /// Shows the explicit unavailable surface for [`Self::incompatible_reason`].
    fn post_unavailable(&self) {
        let Some(link) = self.renderer.as_ref().filter(|link| link.ready.is_some()) else {
            return;
        };
        let reason = self.incompatible_reason.as_deref().unwrap_or("This presentation cannot run here.");
        let _ = link.port().post_surface(&serde_json::json!({
            "state": "unavailable",
            "title": "Presentation unavailable",
            "message": reason,
            "status": "incompatible",
        }));
    }

    /// Issues the current activation again under a new generation: the
    /// runtime starts the presentation from the beginning (the reference
    /// player's `reload_playback`).
    pub fn reload_current(&mut self, now_ms: i64) -> bool {
        let Some(current) = self.current.take() else { return false };
        self.activate_revision(
            current.document,
            current.content,
            current.frames,
            current.timing,
            current.source,
            current.identity,
            current.extras,
            now_ms,
        )
        .is_ok()
    }

    /// Shows the screen's name over the presentation. Returns whether a ready
    /// renderer received the request.
    pub fn identify(&self, name: &str, duration_seconds: u32) -> bool {
        let Some(link) = self.renderer.as_ref().filter(|link| link.ready.is_some()) else {
            return false;
        };
        link.port()
            .send_command(
                uuid::Uuid::new_v4(),
                &SemanticRendererCommand::Identify { name: SafeText::lossy(name), duration_seconds },
            )
            .is_ok()
    }

    /// Sends a playback command to a ready renderer. Returns whether it was
    /// delivered; the renderer's evidence, not this, shows its effect.
    pub fn renderer_command(&self, command: SemanticRendererCommand) -> bool {
        let Some(link) = self.renderer.as_ref().filter(|link| link.ready.is_some()) else {
            return false;
        };
        link.port().send_command(uuid::Uuid::new_v4(), &command).is_ok()
    }

    /// Tracks a validated remote surface. Returns the code the Runtime
    /// sees on refusal. The caller builds the child view next; if that
    /// fails it must [`Self::remote_destroy`] to keep the tracker honest.
    pub fn remote_create(&mut self, spec: crate::remote_web::SurfaceSpec, now_ms: i64) -> Result<(), &'static str> {
        let surface_id = spec.surface_id.clone();
        self.remote.create(spec)?;
        if let Some(tracked) = self.remote.get_mut(&surface_id) {
            tracked.created_at_ms = now_ms;
        }
        Ok(())
    }

    /// Drops a tracked surface. Returns whether it was tracked.
    pub fn remote_destroy(&mut self, surface_id: &str) -> bool {
        self.remote.destroy(surface_id).is_some()
    }

    /// Drops tracked surfaces that never loaded in time. The caller
    /// destroys their child views and fails them to the Runtime.
    pub fn take_expired_remote(&mut self, now_ms: i64) -> Vec<String> {
        self.remote.take_expired(now_ms)
    }

    /// Asks the UI thread to clear remote browsing data, answering
    /// through the returned receiver. `None` means no ready renderer.
    pub fn request_remote_clear(&self) -> Option<tokio::sync::oneshot::Receiver<bool>> {
        let link = self.renderer.as_ref().filter(|link| link.ready.is_some())?;
        link.port().request_remote_clear().ok()
    }

    /// Begins the once-per-process startup website clear. Only a
    /// successful answer completes it; manual clears never touch it.
    pub fn begin_startup_clear(&mut self, available: bool, enabled: bool) -> bool {
        self.startup_clear.begin(available, enabled)
    }

    pub fn finish_startup_clear(&mut self, success: bool) {
        self.startup_clear.finish(success);
    }

    /// Asks the UI thread for a fresh controller; the current activation is
    /// restored when the new session reports ready.
    pub fn restart_renderer(&mut self, reason: &str) -> bool {
        let Some(link) = self.renderer.as_ref() else { return false };
        let reason = ShortToken::new(reason).unwrap_or_else(|_| ShortToken::new("command").expect("literal"));
        let sent = link.port().request_restart(&reason, 5_000).is_ok();
        if sent {
            self.restart_count += 1;
        }
        sent
    }

    /// Leaves safe mode and restarts the ladder. Returns whether safe mode
    /// was active. Activation shows the right presentation again.
    pub fn clear_safe_mode(&mut self, now_ms: i64) -> bool {
        self.native.clear_safe_mode(policy_time(now_ms))
    }

    /// Allows the next recovery rung at once and evaluates it (the reference
    /// player's `retry_player_recovery`).
    pub fn retry_recovery(&mut self, now_ms: i64) -> HealAction {
        let action = self.native.retry_recovery(policy_time(now_ms));
        self.execute_recovery(action, now_ms)
    }

    /// Asks the connected renderer for a preview. False without a renderer.
    pub fn request_preview(&self, request_id: uuid::Uuid, max_width: u32, max_height: u32, max_bytes: u32) -> bool {
        let Some(link) = self.renderer.as_ref().filter(|link| link.ready.is_some()) else {
            return false;
        };
        link.port()
            .request_capture(player_core::RendererCaptureRequest { request_id, max_width, max_height, max_bytes })
            .is_ok()
    }
}

/// Folds an activation into the semantic form Core dispatches: the Runtime
/// document plus the host envelope (timing, projection, plugins, and the
/// clock offset the port splits back into message fields).
fn prepare(
    activation: &Activation,
    clock_offset_ms: i64,
) -> Result<RendererActivation, player_core::RendererPortError> {
    use player_core::RendererPortError;
    let invalid = |_| RendererPortError::InvalidActivation;
    let mut projection = activation.extras.projection.clone().unwrap_or(Value::Null);
    if let Some(object) = projection.as_object_mut() {
        object.insert("clockOffsetMs".to_string(), Value::from(clock_offset_ms));
    }
    let timing = activation.timing.as_ref().map(|timing| {
        serde_json::json!({
            "groupId": timing.group_id,
            "anchorMs": timing.anchor_ms,
            "durationsMs": timing.durations_ms,
            "clockOffsetMs": clock_offset_ms,
        })
    });
    let context = serde_json::json!({
        "timing": timing,
        "projection": projection,
        "plugins": activation.extras.plugins,
        "clockOffsetMs": clock_offset_ms,
    });
    RendererActivation::new(
        RendererActivationRef { activation_id: activation.id, generation: activation.generation },
        crate::renderer_adapter::payload(activation.document.clone())?,
        activation.renderer_metadata.clone(),
        activation.content.clone(),
        activation.frames.clone(),
        Some(crate::renderer_adapter::payload(context)?),
    )
    .map_err(invalid)
}

// ---- status surfaces ----

/// A branded idle/disabled/unavailable surface without a manifest: config
/// branding, no logo.
fn branded_surface(
    state: &str,
    title: &str,
    message: &str,
    status: &str,
    config: &crate::player_config::WindowsPlayerConfig,
) -> Value {
    let branding = &config.runtime.branding;
    let mut surface = serde_json::json!({
        "state": state,
        "title": title,
        "message": message,
        "backgroundColor": branding.background(),
        "textColor": branding.text(),
        "status": status,
    });
    if let Some(footer) = branding.footer_text.as_deref() {
        surface["footerText"] = Value::String(footer.chars().take(240).collect());
    }
    surface
}

impl PresentationEngine {
    /// Whether this exact surface is already current: the offline driver
    /// re-shows gates and waiting on every tick, and re-activating would
    /// churn generations without changing the screen.
    fn showing(&self, source: ActivationSource, document: &Value) -> bool {
        self.current.as_ref().is_some_and(|current| {
            current.source == source && current.document == *document && current.content.is_empty()
        })
    }

    /// The server-address entry surface for a fresh installation.
    pub fn show_setup(&mut self, now_ms: i64) {
        let document = serde_json::json!({"state": "setup"});
        if self.showing(ActivationSource::StatusSurface, &document) {
            return;
        }
        if let Err(error) = self.activate(document, Vec::new(), None, ActivationSource::StatusSurface, now_ms) {
            tracing::warn!(component = "presentation", event = "surface_rejected", error = %error);
        }
    }

    /// The pairing-code surface: the code, the Studio approval URL, and the
    /// organization that is being joined.
    pub fn show_pairing(&mut self, code: &str, approval_url: &str, organization_name: Option<&str>, now_ms: i64) {
        let mut document = serde_json::json!({
            "state": "pairing",
            "code": code.chars().take(16).collect::<String>(),
            "approvalUrl": approval_url.chars().take(512).collect::<String>(),
        });
        if let Some(organization) = organization_name.filter(|name| !name.is_empty()) {
            document["organizationName"] = Value::String(organization.chars().take(120).collect());
        }
        if self.showing(ActivationSource::StatusSurface, &document) {
            return;
        }
        if let Err(error) = self.activate(document, Vec::new(), None, ActivationSource::StatusSurface, now_ms) {
            tracing::warn!(component = "presentation", event = "surface_rejected", error = %error);
        }
    }

    /// The bound-but-no-content surface (the reference player's idle with
    /// the no-content branding).
    pub fn show_waiting(&mut self, config: &crate::player_config::WindowsPlayerConfig, now_ms: i64) {
        let branding = &config.runtime.branding;
        let document = branded_surface(
            "idle",
            branding.no_content_title.as_deref().unwrap_or("No content assigned"),
            branding.no_content_message.as_deref().unwrap_or(""),
            "no_content",
            config,
        );
        if self.showing(ActivationSource::StatusSurface, &document) {
            return;
        }
        if let Err(error) = self.activate(document, Vec::new(), None, ActivationSource::StatusSurface, now_ms) {
            tracing::warn!(component = "presentation", event = "surface_rejected", error = %error);
        }
    }

    /// The outside-active-hours surface: black, the bouncing logo, or the
    /// configured custom text.
    pub fn show_gate_rest(&mut self, config: &crate::player_config::WindowsPlayerConfig, now_ms: i64) {
        let power = &config.runtime.power;
        let document = serde_json::json!({
            "state": "sleep",
            "display": power.outside_display,
            "text": power.outside_text,
            "textColor": config.runtime.branding.text(),
        });
        if self.showing(ActivationSource::Policy, &document) {
            return;
        }
        if let Err(error) = self.activate(document, Vec::new(), None, ActivationSource::Policy, now_ms) {
            tracing::warn!(component = "presentation", event = "surface_rejected", error = %error);
        }
    }

    /// The administrator-disabled surface, with the manifest's logo when a
    /// verified candidate is available.
    pub fn show_gate_disabled(
        &mut self,
        candidate: Option<&player_core::NativeManifest>,
        config: &crate::player_config::WindowsPlayerConfig,
        now_ms: i64,
    ) {
        let (document, content) = match candidate {
            Some(candidate) => match Projector::new(candidate).disabled_surface(now_ms, config) {
                Ok(surface) => surface,
                Err(error) => {
                    tracing::warn!(component = "presentation", event = "surface_rejected", error = %error);
                    return;
                }
            },
            None => {
                let branding = &config.runtime.branding;
                (
                    branded_surface(
                        "disabled",
                        branding.disabled_title.as_deref().unwrap_or("Screen disabled"),
                        branding.disabled_message.as_deref().unwrap_or(""),
                        "disabled",
                        config,
                    ),
                    Vec::new(),
                )
            }
        };
        if self.showing(ActivationSource::Policy, &document) {
            return;
        }
        if let Err(error) = self.activate(document, content, None, ActivationSource::Policy, now_ms) {
            tracing::warn!(component = "presentation", event = "surface_rejected", error = %error);
        }
    }
}

fn presented(activation: &Activation) -> Option<player_core::ActivityPresented> {
    use player_core::ActivityPresented as Presented;
    use player_core::activity_reason as reason;
    match (activation.source, &activation.document) {
        // Development fixtures are not player activity. Windows has no
        // fixture source; the arm stays for Core's vocabulary.
        (ActivationSource::Fixture, _) => None,
        (ActivationSource::SafeMode, _) => Some(Presented::Stopped { reason: reason::RECOVERY_ACTION, failed: true }),
        (ActivationSource::ServerManifest, document)
            if document.get("state").and_then(Value::as_str) == Some("playing")
                && document.get("items").and_then(Value::as_array).is_some_and(|items| !items.is_empty()) =>
        {
            let identity = activation.identity.as_ref()?;
            let items = document.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
            let presentation_id =
                identity.layout_id.or(identity.playlist_id).map(|id| id.to_string()).unwrap_or_else(|| {
                    items.first().and_then(|item| item.get("id")).and_then(Value::as_str).unwrap_or("").to_owned()
                });
            let source = identity.selection_source;
            let replaced = if identity.takeover_id.is_some() {
                reason::TAKEOVER
            } else if identity.schedule_id.is_some() {
                reason::SCHEDULE_TRANSITION
            } else if source == "direct" {
                reason::DIRECT_ASSIGNMENT_CHANGE
            } else {
                reason::MANIFEST_REPLACEMENT
            };
            Some(Presented::Playing {
                context: player_core::ActivityPresentationContext {
                    key: format!("{source}:{presentation_id}:{}", identity.manifest_version),
                    presentation_type: if identity.layout_id.is_some() { "layout" } else { "playlist" }.into(),
                    presentation_id,
                    trigger: Some(source.to_owned()),
                    schedule_id: identity.schedule_id.map(|id| id.to_string()),
                    takeover_id: identity.takeover_id.map(|id| id.to_string()),
                    manifest_version: Some(identity.manifest_version),
                },
                replaced,
                items: items
                    .iter()
                    .map(|item| player_core::ActivityItem {
                        id: item.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                        kind: item.get("kind").and_then(Value::as_str).unwrap_or("").to_owned(),
                        duration_ms: item.get("durationMs").and_then(Value::as_u64),
                    })
                    .collect(),
            })
        }
        _ => Some(Presented::Stopped { reason: reason::SCHEDULE_TRANSITION, failed: false }),
    }
}

// ---- presentation task ----

use crate::daemon::DaemonContext;

/// The host capabilities the Runtime reads before its first frame: setup
/// entry is available, synchronized timelines are anchored by the host,
/// remote web renders in host views, and `discovery.list` browses the LAN.
/// Verified sandbox frames are served from the `tcwidget://` scheme handler,
/// which sees every subframe navigation, so the Runtime keeps its default
/// iframe-sandbox attribute on top of the served response policy.
fn host_capabilities() -> Value {
    serde_json::json!({
        "remoteWeb": "host-view",
        "synchronizedPlayback": true,
        "setup": true,
        "discovery": true,
        "externalFrames": true,
    })
}

fn host_info() -> Value {
    serde_json::json!({
        "host": "tilecast-windows",
        "hostVersion": crate::RELEASE_VERSION,
        "engine": "webview2",
        "engineVersion": crate::ui::engine_version(),
    })
}

fn lock(context: &DaemonContext) -> std::sync::MutexGuard<'_, PresentationEngine> {
    context.presentation.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Shows the setup or pairing surface for an unbound screen. Bound screens
/// belong to the offline driver; this only fills the gap before pairing.
async fn refresh_unbound_surface(context: &DaemonContext, now_ms: i64) {
    let bound =
        context.db().map(|db| async move { db.run(|c| player_state::repo::binding::get(c)).await.ok().flatten() });
    if let Some(bound) = bound
        && bound.await.is_some()
    {
        return;
    }
    let view = crate::pairing::view(context);
    let mut engine = lock(context);
    match (view.state, view.code) {
        ("waiting", Some(code)) => {
            engine.show_pairing(&code, &view.approval_url, view.organization_name.as_deref(), now_ms)
        }
        _ => engine.show_setup(now_ms),
    }
}

async fn handle_request(context: &DaemonContext, ui: &UiHandle, request: bridge::HostRequest, now_ms: i64) {
    match request.method {
        bridge::HostMethod::SubmitServerUrl { url } => {
            let result = match crate::pairing::begin(context, &url).await {
                Ok(()) => Ok(serde_json::json!({"ok": true})),
                Err(message) => Ok(serde_json::json!({"ok": false, "error": message})),
            };
            let _ = ui.post(bridge::response_message(&request.id, result));
        }
        bridge::HostMethod::ListDiscoveredServers => {
            // A browse that finds nothing (or a multicast stack that does
            // not work) is an empty list; manual entry always works and
            // the Runtime hides discovery when it lists nothing.
            let servers = crate::discovery::browse().await;
            let _ = ui.post(bridge::response_message(
                &request.id,
                Ok(serde_json::to_value(&servers).unwrap_or_else(|_| serde_json::json!([]))),
            ));
        }
        bridge::HostMethod::RemoteWebCreate { params } => {
            if !context.remote_web_available.load(std::sync::atomic::Ordering::Acquire) {
                let _ = ui.post(bridge::response_message(
                    &request.id,
                    Ok(serde_json::json!({"ok": false, "code": crate::remote_web::UNAVAILABLE})),
                ));
                return;
            }
            let answer = match crate::remote_web::parse_create(&params) {
                Ok(spec) => {
                    let surface_id = spec.surface_id.clone();
                    match lock(context).remote_create(spec.clone(), now_ms) {
                        Ok(()) => {
                            if ui.remote(crate::ui::UiCommand::RemoteCreate { spec }).is_err() {
                                lock(context).remote_destroy(&surface_id);
                                serde_json::json!({"ok": false, "code": "renderer_unavailable"})
                            } else {
                                serde_json::json!({"ok": true, "target": "host-layer"})
                            }
                        }
                        Err(code) => serde_json::json!({"ok": false, "code": code}),
                    }
                }
                Err(code) => serde_json::json!({"ok": false, "code": code}),
            };
            let _ = ui.post(bridge::response_message(&request.id, Ok(answer)));
        }
        bridge::HostMethod::RemoteWebViewport { surface_id, viewport } => {
            let Some(mapped) = crate::remote_web::map_viewport(&viewport) else { return };
            let mut engine = lock(context);
            let Some(tracked) = engine.remote.get_mut(&surface_id) else { return };
            tracked.spec.viewport = mapped;
            let _ = ui.remote(crate::ui::UiCommand::RemoteViewport { surface_id, viewport: mapped });
        }
        bridge::HostMethod::RemoteWebVisible { surface_id, visible } => {
            let mut engine = lock(context);
            let Some(tracked) = engine.remote.get_mut(&surface_id) else { return };
            tracked.spec.visible = visible;
            let _ = ui.remote(crate::ui::UiCommand::RemoteVisible { surface_id, visible });
        }
        bridge::HostMethod::RemoteWebMuted { surface_id, muted } => {
            let mut engine = lock(context);
            let Some(tracked) = engine.remote.get_mut(&surface_id) else { return };
            tracked.spec.muted = muted;
            let _ = ui.remote(crate::ui::UiCommand::RemoteMuted { surface_id, muted });
        }
        bridge::HostMethod::RemoteWebReload { surface_id } => {
            if lock(context).remote.get(&surface_id).is_none() {
                return;
            }
            let _ = ui.remote(crate::ui::UiCommand::RemoteReload { surface_id });
        }
        bridge::HostMethod::RemoteWebDestroy { surface_id } => {
            lock(context).remote_destroy(&surface_id);
            let _ = ui.remote(crate::ui::UiCommand::RemoteDestroy { surface_id });
        }
        bridge::HostMethod::RemoteWebRecovered => {
            // The Runtime proved content after the remote process ended;
            // the UI thread rebuilds the remote environment if it is gone
            // and answers `recovered` when it serves again.
            let _ = ui.remote(crate::ui::UiCommand::RemoteRecovered);
        }
    }
}

/// The presentation task: owns the UI thread, feeds its events into the
/// shared engine, and supervises recovery on a five-second tick. Without a
/// content store, a runtime artifact, or WebView2, it parks: the daemon
/// runs headless. `--headless` parks deliberately.
pub async fn run(context: Arc<DaemonContext>) {
    if context.headless.load(std::sync::atomic::Ordering::Acquire) {
        tracing::info!(component = "presentation", event = "headless_mode");
        context.shutdown.cancelled().await;
        return;
    }
    let Some(cas) = context.cas.clone() else {
        context.shutdown.cancelled().await;
        return;
    };
    // The Runtime artifact ships beside the executable (or in
    // `TILECAST_RUNTIME_DIR` for development); `paths.runtime_dir` is only
    // the per-start scratch directory under %TEMP%.
    let Some(runtime_dir) = crate::runtime_files::runtime_dir() else {
        tracing::warn!(component = "presentation", event = "runtime_unavailable", error = "no runtime artifact found");
        context.shutdown.cancelled().await;
        return;
    };
    let runtime = match crate::runtime_files::RuntimeFiles::load(&runtime_dir) {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::warn!(component = "presentation", event = "runtime_unavailable", error = %error);
            context.shutdown.cancelled().await;
            return;
        }
    };
    let media = lock(&context).media();
    let user_data_dir = context.paths.webview_data_dir();
    if let Err(error) = std::fs::create_dir_all(&user_data_dir) {
        tracing::warn!(component = "presentation", event = "webview_data_unavailable", error = %error);
        context.shutdown.cancelled().await;
        return;
    }
    let services = crate::ui::UiServices {
        runtime,
        media,
        cas,
        session: uuid::Uuid::new_v4(),
        user_data_dir,
        capabilities: host_capabilities(),
        info: host_info(),
        conformance: None,
        main_window: Arc::clone(&context.main_window),
    };
    let (ui, mut events) = match crate::ui::spawn_ui(services).await {
        Ok(started) => started,
        Err(error) => {
            tracing::warn!(component = "presentation", event = "renderer_unavailable", error = %error);
            context.shutdown.cancelled().await;
            return;
        }
    };
    // Remote availability arrives as a host-wide `recovered` event once
    // the UI thread's remote environment serves; `process-terminated`
    // clears it. Creates before that are refused, never queued.
    let now_ms = context.now().unix_millis();
    refresh_unbound_surface(&context, now_ms).await;
    // The renderer is new: the offline driver re-evaluates immediately
    // rather than waiting for its next wake.
    context.manifest_wake.notify_one();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = context.shutdown.cancelled() => {
                ui.shutdown();
                return;
            }
            event = events.recv() => {
                let Some(event) = event else { return };
                if handle_event(&context, &ui, event).await {
                    return;
                }
            }
            _ = tick.tick() => {
                let now_ms = context.now().unix_millis();
                lock(&context).tick(now_ms);
                // A stuck create must not hold a child view forever.
                for surface_id in lock(&context).take_expired_remote(now_ms) {
                    let _ = ui.remote(crate::ui::UiCommand::RemoteDestroy { surface_id: surface_id.clone() });
                    let _ = ui.post(bridge::remote_web_message(&bridge::RemoteWebEvent {
                        surface_id: Some(surface_id),
                        kind: "failed".to_string(),
                        code: Some("create_timeout".to_string()),
                    }));
                }
            }
            _ = context.pairing_wake.notified() => {
                let now_ms = context.now().unix_millis();
                refresh_unbound_surface(&context, now_ms).await;
            }
        }
    }
}

/// Handles one UI event. Returns whether the task should stop.
async fn handle_event(context: &Arc<DaemonContext>, ui: &UiHandle, event: UiEvent) -> bool {
    let now_ms = context.now().unix_millis();
    match event {
        UiEvent::Session { session } => {
            lock(context).renderer_connected(session, ui.clone(), now_ms);
            maybe_clear_at_start(context, ui);
            context.manifest_wake.notify_one();
            false
        }
        UiEvent::Runtime(message) => {
            handle_runtime_message(context, ui, message, now_ms).await;
            false
        }
        UiEvent::Remote { event } => {
            handle_remote_event(context, ui, &event);
            false
        }
        UiEvent::ConformanceMessage { .. } => {
            // The product bridge never emits harness messages; the
            // conformance runner owns its own UI thread.
            tracing::warn!(component = "presentation", event = "unexpected_conformance_message");
            false
        }
        UiEvent::ProcessFailed { kind } => {
            let mut engine = lock(context);
            if let Some(session) = engine.renderer_session() {
                engine.renderer_process_failed(session, &kind);
            }
            false
        }
        UiEvent::Fatal { reason } => {
            if reason == crate::ui::WINDOW_CLOSED {
                tracing::info!(component = "presentation", event = "window_closed");
                if let Some(session) = lock(context).renderer_session() {
                    lock(context).renderer_disconnected(session);
                }
                return true;
            }
            let mut engine = lock(context);
            match engine.renderer_session() {
                Some(session) if engine.renderer_fatal(session, &reason, now_ms) => false,
                _ => {
                    tracing::error!(component = "presentation", event = "renderer_unrecoverable");
                    true
                }
            }
        }
    }
}

/// Records a remote web event in the tracker and forwards it to the
/// Runtime's remote web port. Events for unknown surfaces are dropped,
/// mirroring the Runtime's own rule.
fn handle_remote_event(context: &DaemonContext, ui: &UiHandle, event: &bridge::RemoteWebEvent) {
    let mut engine = lock(context);
    match (event.surface_id.as_deref(), event.kind.as_str()) {
        (Some(id), "loaded") => {
            if engine.remote.mark_loaded(id) {
                let _ = ui.post(bridge::remote_web_message(event));
            }
        }
        (Some(id), "failed") => {
            // The view stays until the Runtime destroys it, but the
            // failure is recorded so a later load cannot revive it.
            if engine.remote.get(id).is_some() {
                engine.remote.fail(id);
                let _ = ui.post(bridge::remote_web_message(event));
            }
        }
        (Some(id), _) => {
            if engine.remote.get(id).is_some() {
                let _ = ui.post(bridge::remote_web_message(event));
            }
        }
        (None, "process-terminated") => {
            // The remote views are dead; the Runtime fails every live
            // surface and re-creates what it still shows after recovery.
            engine.remote.reset();
            context.remote_web_available.store(false, std::sync::atomic::Ordering::Release);
            let _ = ui.post(bridge::remote_web_message(event));
        }
        (None, "recovered") => {
            context.remote_web_available.store(true, std::sync::atomic::Ordering::Release);
            let _ = ui.post(bridge::remote_web_message(event));
        }
        (None, _) => {}
    }
}

/// Starts the once-per-process website-data clear when the accepted
/// configuration asks for it. Only a successful answer completes the
/// state; a later readiness event retries.
fn maybe_clear_at_start(context: &Arc<DaemonContext>, ui: &UiHandle) {
    let enabled = crate::config_sync::effective(context).runtime.website.clear_on_restart;
    let available = context.remote_web_available.load(std::sync::atomic::Ordering::Acquire);
    if !lock(context).begin_startup_clear(available, enabled) {
        return;
    }
    let task_context = Arc::clone(context);
    let task_ui = ui.clone();
    tokio::spawn(async move {
        let (reply, pending) = tokio::sync::oneshot::channel();
        let sent = task_ui.remote(crate::ui::UiCommand::RemoteClearData { reply: Some(reply) }).is_ok();
        let cleared = if sent {
            tokio::time::timeout(player_core::WEBSITE_DATA_CLEAR_TIMEOUT, pending)
                .await
                .ok()
                .and_then(|result| result.ok())
                .unwrap_or(false)
        } else {
            false
        };
        lock(&task_context).finish_startup_clear(cleared);
        tracing::info!(component = "presentation", event = "startup_website_clear", cleared);
    });
}

async fn handle_runtime_message(context: &DaemonContext, ui: &UiHandle, message: bridge::RuntimeMessage, now_ms: i64) {
    // Every Runtime message belongs to the live session: the coordinator
    // binds evidence to its connection, so a stale report from a dead
    // controller can never revive it.
    let session = lock(context).renderer_session();
    let Some(session) = session else {
        return;
    };
    // Requests carry no activation and need no session beyond liveness.
    if let bridge::RuntimeMessage::Request(request) = message {
        handle_request(context, ui, request, now_ms).await;
        return;
    }
    let mut engine = lock(context);
    match message {
        bridge::RuntimeMessage::Ready(ready) => engine.renderer_ready(session, ready),
        bridge::RuntimeMessage::PresentationResult(result) => {
            let Some(activation) = result.activation.as_ref() else {
                return;
            };
            if result.accepted {
                engine.accepted(session, activation);
            } else {
                engine.rejected(session, activation, result.code.as_deref().unwrap_or("rejected"));
            }
        }
        bridge::RuntimeMessage::Evidence(report) => {
            engine.progress(session, &report, now_ms);
        }
        bridge::RuntimeMessage::PlaybackError(report) => {
            engine.item_error(session, &report);
        }
        bridge::RuntimeMessage::Request(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_types::bounded::SafeText;

    #[test]
    fn host_grants_verified_frames_to_the_runtime() {
        let capabilities = host_capabilities();
        assert_eq!(capabilities["externalFrames"], serde_json::json!(true));
        // Attribute sandboxing is the contract default; the host only
        // names it when the serving layer needs bare navigations.
        assert!(capabilities.get("externalFrameSandbox").is_none());
    }

    fn test_engine() -> (PresentationEngine, tokio::sync::mpsc::Receiver<crate::ui::UiCommand>, uuid::Uuid) {
        let media = Arc::new(Mutex::new(MediaRegistry::new()));
        let engine = PresentationEngine::new(Arc::clone(&media), SupervisorConfig::default(), 1_000);
        let (commands, commands_rx) = tokio::sync::mpsc::channel(32);
        let ui = UiHandle::new(commands, Arc::new(|| {}));
        let session = uuid::Uuid::new_v4();
        // The UI thread binds the session before it emits it.
        media.lock().expect("test fixture").bind_renderer(crate::media::RendererInstance { session });
        let mut engine = engine;
        engine.renderer_connected(session, ui, 1_000);
        (engine, commands_rx, session)
    }

    fn image_document(digest: &Sha256Digest) -> Value {
        serde_json::json!({
            "state": "playing",
            "items": [{
                "id": "item-1",
                "kind": "image",
                "src": crate::projection::content_uri(digest),
                "durationMs": 10_000,
            }],
            "generation": 1,
        })
    }

    fn image_content(digest: Sha256Digest) -> Vec<VerifiedContentRef> {
        vec![VerifiedContentRef {
            sha256: digest,
            size_bytes: 128,
            mime_type: SafeText::new("image/png").expect("test fixture"),
        }]
    }

    fn ready() -> bridge::RuntimeReady {
        bridge::RuntimeReady { contract_version: 1, runtime_version: "0.1.0".into(), support: None }
    }

    fn next_post(commands: &mut tokio::sync::mpsc::Receiver<crate::ui::UiCommand>) -> Value {
        match commands.try_recv().expect("a posted message") {
            crate::ui::UiCommand::Post { message } => message,
            other => panic!("expected a post, got {other:?}"),
        }
    }

    #[test]
    fn a_session_activates_accepts_and_proves_content() {
        let (mut engine, mut commands, session) = test_engine();
        let digest = Sha256Digest::of(b"pixels");
        let reference = engine
            .activate(image_document(&digest), image_content(digest), None, ActivationSource::ServerManifest, 1_000)
            .expect("activate");
        // Nothing is sent before the Runtime reports ready.
        assert!(commands.try_recv().is_err());
        engine.renderer_ready(session, ready());
        // The presentation carries a grant URI, not the content URI; the
        // plugins message always follows, even when empty.
        let posted = next_post(&mut commands);
        assert_eq!(posted.get("type").and_then(Value::as_str), Some("presentation"));
        assert_eq!(
            posted.get("activation").and_then(|a| a.get("generation")).and_then(Value::as_u64),
            Some(reference.generation)
        );
        let src = posted
            .get("presentation")
            .and_then(|p| p.get("items"))
            .and_then(|items| items.get(0))
            .and_then(|item| item.get("src"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(src.starts_with("tcmedia://cap/"), "{src}");
        assert!(!src.contains(&digest.to_hex()));
        let plugins = next_post(&mut commands);
        assert_eq!(plugins.get("type").and_then(Value::as_str), Some("plugins"));
        assert_eq!(plugins.get("plugins").and_then(Value::as_array).map(Vec::len), Some(0));
        assert!(commands.try_recv().is_err());

        engine.accepted(session, &reference);
        assert!(engine.current_is_accepted());
        let shown = engine.progress(
            session,
            &bridge::EvidenceReport {
                activation: Some(reference.clone()),
                item_id: Some("item-1".to_string()),
                kind: "image-shown".to_string(),
                zone_id: None,
            },
            2_000,
        );
        assert!(shown, "a shown image is meaningful content evidence");
        assert!(engine.content_evidence_items().contains("item-1"));
        assert!(engine.current_has_activation_evidence());
    }

    #[test]
    fn unknown_sessions_and_generations_cannot_activate_or_attest() {
        let (mut engine, mut commands, session) = test_engine();
        let digest = Sha256Digest::of(b"pixels");
        let reference = engine
            .activate(image_document(&digest), image_content(digest), None, ActivationSource::ServerManifest, 1_000)
            .expect("activate");
        // Ready from a session the engine never bound is ignored.
        engine.renderer_ready(uuid::Uuid::new_v4(), ready());
        assert!(commands.try_recv().is_err());
        engine.renderer_ready(session, ready());
        assert!(commands.try_recv().is_ok());
        let _ = commands.try_recv();
        // Evidence for another generation is meaningless.
        let other = bridge::ActivationRef { activation_id: reference.activation_id, generation: 99 };
        let shown = engine.progress(
            session,
            &bridge::EvidenceReport {
                activation: Some(other),
                item_id: Some("item-1".to_string()),
                kind: "image-shown".to_string(),
                zone_id: None,
            },
            2_000,
        );
        assert!(!shown);
        assert!(!engine.current_has_activation_evidence());
    }

    #[test]
    fn a_restart_binds_a_fresh_session_and_restores_the_activation() {
        let (mut engine, mut commands, session) = test_engine();
        let digest = Sha256Digest::of(b"pixels");
        engine
            .activate(image_document(&digest), image_content(digest), None, ActivationSource::ServerManifest, 1_000)
            .expect("activate");
        engine.renderer_ready(session, ready());
        let _ = commands.try_recv();
        let _ = commands.try_recv();
        let ui = engine.renderer.as_ref().expect("link").port.ui();
        let next = uuid::Uuid::new_v4();
        engine.media.lock().expect("test fixture").bind_renderer(crate::media::RendererInstance { session: next });
        engine.renderer_connected(next, ui, 2_000);
        assert!(commands.try_recv().is_err(), "nothing sent before ready");
        engine.renderer_ready(next, ready());
        let posted = next_post(&mut commands);
        assert_eq!(posted.get("type").and_then(Value::as_str), Some("presentation"));
    }

    fn remote_spec(surface_id: &str) -> crate::remote_web::SurfaceSpec {
        crate::remote_web::parse_create(&serde_json::json!({
            "surfaceId": surface_id,
            "content": {
                "kind": "page",
                "url": "https://example.com/",
                "allowedHosts": ["example.com"],
                "javascriptEnabled": true,
                "domStorageEnabled": true,
                "cookiePolicy": "first_party",
                "userAgent": "",
                "zoomPercent": 100,
                "scrollX": 0,
                "scrollY": 0,
                "backgroundColor": "#000000",
            },
            "viewport": { "x": 0, "y": 0, "width": 640, "height": 360, "deviceScale": 1 },
            "muted": true,
            "visible": true,
        }))
        .expect("test fixture")
    }

    #[test]
    fn remote_surfaces_track_refuse_and_expire() {
        let (mut engine, _, _) = test_engine();
        engine.remote_create(remote_spec("rw-1"), 1_000).expect("creates");
        assert_eq!(engine.remote_create(remote_spec("rw-1"), 1_000).err(), Some("invalid_request"));
        assert!(engine.remote_destroy("rw-1"));
        assert!(!engine.remote_destroy("rw-1"));
        engine.remote_create(remote_spec("rw-2"), 1_000).expect("creates");
        let timeout_ms = i64::try_from(crate::remote_web::CREATE_TIMEOUT.as_millis()).expect("fits");
        assert!(engine.take_expired_remote(1_000 + timeout_ms).is_empty());
        assert_eq!(engine.take_expired_remote(1_001 + timeout_ms), vec!["rw-2".to_string()]);
    }

    #[test]
    fn startup_clear_runs_once_per_process() {
        let (mut engine, _, _) = test_engine();
        assert!(!engine.begin_startup_clear(false, true));
        assert!(!engine.begin_startup_clear(true, false));
        assert!(engine.begin_startup_clear(true, true));
        assert!(!engine.begin_startup_clear(true, true));
        engine.finish_startup_clear(false);
        assert!(engine.begin_startup_clear(true, true));
        engine.finish_startup_clear(true);
        assert!(!engine.begin_startup_clear(true, true));
    }

    #[test]
    fn surfaces_dedupe_and_carry_no_content() {
        let (mut engine, _, _) = test_engine();
        let config = crate::player_config::WindowsPlayerConfig::default();
        engine.show_setup(1_000);
        let first = engine.current().expect("setup current").clone();
        engine.show_setup(2_000);
        assert_eq!(engine.current().expect("still setup").generation, first.generation);
        engine.show_pairing("ABCDEF", "https://signs.example.org/s/1", Some("Library"), 3_000);
        let pairing = engine.current().expect("pairing current").clone();
        assert_eq!(pairing.document.get("state").and_then(Value::as_str), Some("pairing"));
        assert!(pairing.content.is_empty());
        engine.show_waiting(&config, 4_000);
        assert_eq!(
            engine.current().expect("waiting current").document.get("state").and_then(Value::as_str),
            Some("idle")
        );
    }
}
