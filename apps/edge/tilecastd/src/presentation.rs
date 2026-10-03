//! The presentation engine: what the renderer should show, and whether it is.
//!
//! Ownership (docs/tilecast-edge.md §4): selection, scheduling, preparation and
//! health are daemon concerns. The renderer receives a complete, validated,
//! prepared [`PresentationActivate`] and reports evidence. This module:
//!
//! * holds the current activation and issues new ones
//!   ([`PresentationEngine::activate`]);
//! * validates every activation's content references before it can be sent
//!   (all referenced objects must be listed, and the caller guarantees they
//!   are verified and pinned in the CAS);
//! * sends `renderer.configure` when a renderer connects and the current
//!   activation once it reports `renderer.ready`, only if the renderer
//!   advertises every feature the presentation requires. Otherwise the screen
//!   shows an explicit "unavailable" surface and status reports the reason,
//!   rather than silently dropping content;
//! * feeds meaningful evidence into the recovery ladder
//!   ([`crate::supervisor`]) and performs its actions.
//!
//! Where activations come from is the caller's concern: today daemon status
//! surfaces ([`crate::daemon::status_surface`]) and the development fixture
//! source ([`crate::fixture`]). The server manifest source (the port of
//! `apps/player-linux/src/core/manifest.ts`, `schedule.ts` and
//! `player.ts#buildPresentation`) calls [`PresentationEngine::activate`] the
//! same way, after its content is verified and pinned in the CAS.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use edge_ipc::SessionHandle;
use edge_protocol::Timestamp;
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ids::{ActivationId, SessionId};
#[cfg(test)]
use edge_protocol::ipc::event::EvidenceKind;
use edge_protocol::ipc::event::{
    ActivationRef, Event, KioskPolicy, MediaAlias, MediaChannelDescriptor, PresentationActivate, ProjectionContext,
    RendererCommandKind, RendererConfigure, RendererMediaRef, RendererProgress, RendererReady, SyncTiming,
};
use edge_protocol::ipc::presentation::{
    ContentRef, PresentationDocument, PresentationError, StatusSurface, validate_content_references,
};
use edge_protocol::ipc::status::RendererStatus;
use player_core::RendererPort;

use crate::media::MediaRegistry;
use crate::supervisor::{Expectation, HealAction, SupervisorConfig, SupervisorState};

fn semantic_ref(reference: ActivationRef) -> player_core::RendererActivationRef {
    player_core::RendererActivationRef { activation_id: reference.activation_id, generation: reference.generation }
}

/// Where an activation came from, for status and logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationSource {
    StatusSurface,
    Fixture,
    ServerManifest,
    SafeMode,
    /// A surface the accepted configuration or an administrator selected
    /// instead of content: outside active hours, or playback disabled.
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

/// Which verified presentation an activation shows and what selected it:
/// the same identifiers the reference player reports in its heartbeat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybackIdentity {
    /// The prepared manifest this activation shows.
    pub manifest: edge_protocol::Sha256Digest,
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
    pub timing: Option<SyncTiming>,
    pub projection: Option<ProjectionContext>,
    pub plugins: Vec<serde_json::Value>,
    pub plugin_aliases: Vec<MediaAlias>,
}

#[derive(Debug, Clone)]
pub struct Activation {
    pub id: ActivationId,
    pub generation: u64,
    /// The prepared manifest and selection for server-presentation
    /// activations.
    pub identity: Option<PlaybackIdentity>,
    pub document: PresentationDocument,
    pub renderer_metadata: player_core::RendererMetadata,
    pub content: Vec<ContentRef>,
    pub timing: Option<SyncTiming>,
    pub source: ActivationSource,
    pub extras: ServerExtras,
}

impl Activation {
    fn reference(&self) -> ActivationRef {
        ActivationRef { activation_id: self.id, generation: self.generation }
    }

    fn event(
        &self,
        document: PresentationDocument,
        content: Vec<RendererMediaRef>,
        timing: Option<SyncTiming>,
        projection: Option<ProjectionContext>,
    ) -> Event {
        Event::PresentationActivate(Box::new(PresentationActivate {
            activation_id: self.id,
            generation: self.generation,
            presentation: document,
            content,
            timing,
            projection,
        }))
    }

    pub fn manifest(&self) -> Option<edge_protocol::Sha256Digest> {
        self.identity.as_ref().map(|identity| identity.manifest)
    }

    fn expectation_for(&self, item_id: Option<&str>) -> Expectation {
        self.renderer_metadata.expectation_for(item_id)
    }
}

#[cfg(test)]
fn is_content_evidence(kind: EvidenceKind, expectation: Expectation) -> bool {
    player_core::is_content_evidence(crate::supervisor::evidence(kind), expectation)
}

fn validate_media_aliases(aliases: &[MediaAlias], content: &[ContentRef]) -> Result<(), PresentationError> {
    for alias in aliases {
        let digest = edge_protocol::ipc::presentation::parse_content_uri(alias.uri.as_str())
            .ok_or_else(|| PresentationError::MalformedContentUri(alias.uri.as_str().chars().take(48).collect()))?;
        if !content.iter().any(|reference| reference.sha256 == digest) {
            return Err(PresentationError::UnlistedContent(digest.short()));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct RendererLink {
    session: SessionHandle,
    ready: Option<RendererReady>,
    port: crate::renderer_adapter::EdgeRendererPort,
    /// The renderer's remote web helper is restarting (its health reason).
    remote_web_restarting: bool,
}

impl RendererLink {
    fn port(&self) -> &crate::renderer_adapter::EdgeRendererPort {
        &self.port
    }
}

#[derive(Debug)]
pub struct PresentationEngine {
    configure: RendererConfigure,
    media_registry: Arc<Mutex<MediaRegistry>>,
    clock: edge_protocol::time::SharedClock,
    next_generation: u64,
    current: Option<Activation>,
    renderer: Option<RendererLink>,
    incompatible_reason: Option<String>,
    supervisor: SupervisorState,
    supervisor_config: SupervisorConfig,
    restart_count: u64,
    tracking: player_core::RendererTracker,
    /// Proof-of-play signals for the activity task.
    activity: Option<crate::activity::Handle>,
    /// Corrected-minus-local wall offset handed to the runtime for
    /// time-dependent projection (countdowns, date-selected records).
    clock_offset_ms: i64,
}

impl PresentationEngine {
    pub fn new(
        media_socket: &Path,
        media_registry: Arc<Mutex<MediaRegistry>>,
        kiosk: KioskPolicy,
        supervisor_config: SupervisorConfig,
        clock: edge_protocol::time::SharedClock,
        now_ms: i64,
    ) -> Self {
        let configure = RendererConfigure {
            media_channel: MediaChannelDescriptor {
                protocol: ShortToken::new("daemon-cap-v1").expect("literal token"),
                socket: SafeText::lossy(&media_socket.to_string_lossy()),
            },
            kiosk,
        };
        Self {
            configure,
            media_registry,
            clock,
            next_generation: 1,
            current: None,
            renderer: None,
            incompatible_reason: None,
            supervisor: SupervisorState::new(now_ms),
            supervisor_config,
            restart_count: 0,
            tracking: player_core::RendererTracker::default(),
            activity: None,
            clock_offset_ms: 0,
        }
    }

    pub fn set_clock_offset(&mut self, offset_ms: i64) {
        self.clock_offset_ms = offset_ms;
    }

    /// Issues a new activation and sends it if a ready renderer is connected.
    pub fn activate(
        &mut self,
        document: PresentationDocument,
        content: Vec<ContentRef>,
        timing: Option<SyncTiming>,
        source: ActivationSource,
        now_ms: i64,
    ) -> Result<ActivationRef, PresentationError> {
        self.activate_revision(document, content, timing, source, None, ServerExtras::default(), now_ms)
    }

    /// Activates a prepared server presentation. The identity binds renderer
    /// acceptance and evidence to exactly this manifest.
    pub fn activate_server_presentation(
        &mut self,
        identity: PlaybackIdentity,
        document: PresentationDocument,
        content: Vec<ContentRef>,
        extras: ServerExtras,
        now_ms: i64,
    ) -> Result<ActivationRef, PresentationError> {
        if let Some(projection) = &extras.projection {
            validate_media_aliases(&projection.media, &content)?;
            edge_protocol::ipc::presentation::validate_value(&projection.manifest, &content)?;
        }
        validate_media_aliases(&extras.plugin_aliases, &content)?;
        for plugin in &extras.plugins {
            edge_protocol::ipc::presentation::validate_value(plugin, &content)?;
        }
        let timing = extras.timing.clone();
        self.activate_revision(
            document,
            content,
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
        document: PresentationDocument,
        content: Vec<ContentRef>,
        timing: Option<SyncTiming>,
        source: ActivationSource,
        identity: Option<PlaybackIdentity>,
        extras: ServerExtras,
        now_ms: i64,
    ) -> Result<ActivationRef, PresentationError> {
        validate_content_references(&document, &content)?;
        let renderer_metadata = crate::renderer_adapter::metadata(&document, source, extras.projection.as_ref())?;
        let activation = Activation {
            id: ActivationId::from_uuid(uuid::Uuid::new_v4()),
            generation: self.next_generation,
            identity,
            document,
            renderer_metadata,
            content,
            timing,
            source,
            extras,
        };
        self.next_generation += 1;
        self.tracking.activate(semantic_ref(activation.reference()));
        let reference = activation.reference();
        tracing::info!(
            component = "presentation",
            event = "activation_issued",
            generation = activation.generation,
            state = activation.document.state_name(),
            content = activation.content.len()
        );
        if let Some(presented) =
            crate::activity::presented(activation.source, activation.identity.as_ref(), &activation.document)
        {
            self.signal(crate::activity::Signal::Presented(presented));
        }
        self.current = Some(activation);
        self.supervisor.reset_clock(now_ms);
        self.push_current();
        Ok(reference)
    }

    pub fn current(&self) -> Option<&Activation> {
        self.current.as_ref()
    }

    pub fn current_manifest(&self) -> Option<edge_protocol::Sha256Digest> {
        self.current.as_ref().and_then(Activation::manifest)
    }

    /// The item the renderer last reported starting for the current
    /// activation, with when it started.
    pub fn current_item(&self) -> Option<(String, Timestamp)> {
        self.tracking.current_item()
    }

    pub fn current_is_server_manifest(&self) -> bool {
        self.current.as_ref().is_some_and(|activation| activation.source == ActivationSource::ServerManifest)
    }

    pub fn current_has_meaningful_progress(&self) -> bool {
        self.tracking.meaningful()
    }

    pub fn current_has_activation_evidence(&self) -> bool {
        let Some(current) = self.current.as_ref() else { return false };
        if current.renderer_metadata.requires_content_evidence {
            self.tracking.content_progress()
        } else {
            self.tracking.meaningful()
        }
    }

    /// Items of the current activation that the renderer proved with
    /// content evidence (an image shown, video progress, a layout rendered).
    pub fn content_evidence_items(&self) -> &BTreeSet<String> {
        self.tracking.content_items()
    }

    pub fn current_is_accepted(&self) -> bool {
        self.tracking.accepted_current()
    }

    pub fn current_has_renderer_error(&self) -> bool {
        self.tracking.has_error()
    }

    /// Digests the current activation needs pinned.
    pub fn pinned_content(&self) -> BTreeSet<edge_protocol::Sha256Digest> {
        self.current.iter().flat_map(|a| a.content.iter().map(|c| c.sha256)).collect()
    }

    pub fn renderer_connected(&mut self, session: SessionHandle, now_ms: i64) {
        let connection = *session.id().as_uuid();
        let port = crate::renderer_adapter::EdgeRendererPort::new(
            session.clone(),
            self.configure.media_channel.clone(),
            self.media_registry.clone(),
            self.clock.clone(),
        );
        let _ = port.configure(&self.configure.kiosk);
        self.renderer = Some(RendererLink { session, ready: None, port, remote_web_restarting: false });
        self.tracking.connected(connection);
        self.supervisor.reset_clock(now_ms);
    }

    pub fn renderer_disconnected(&mut self, session: SessionId) {
        self.tracking.disconnected(*session.as_uuid());
        if self.renderer.as_ref().is_some_and(|link| link.session.id() == session) {
            self.renderer = None;
        }
    }

    fn link_for(&mut self, session: &SessionHandle) -> Option<&mut RendererLink> {
        self.renderer.as_mut().filter(|link| link.session.id() == session.id())
    }

    pub fn renderer_ready(&mut self, session: &SessionHandle, ready: RendererReady, _now_ms: i64) {
        let Some(link) = self.link_for(session) else {
            return;
        };
        tracing::info!(
            component = "presentation",
            event = "renderer_ready",
            engine = ready.renderer.engine_version.as_str(),
            features = ready.features.len()
        );
        link.ready = Some(ready);
        self.push_current();
    }

    pub fn accepted(&mut self, session: &SessionHandle, activation: ActivationRef) {
        self.tracking.accept(*session.id().as_uuid(), semantic_ref(activation));
    }

    pub fn rejected(&mut self, session: &SessionHandle, activation: ActivationRef, code: &str) {
        if self.tracking.reject(*session.id().as_uuid(), semantic_ref(activation), ShortToken::new(code).ok()) {
            tracing::warn!(component = "presentation", event = "activation_rejected", code);
        }
    }

    pub fn progress(&mut self, session: &SessionHandle, report: &RendererProgress, now: Timestamp) -> bool {
        let Some(current) = self.current.as_ref() else { return false };
        let expectation = current.expectation_for(report.item_id.as_ref().map(SafeText::as_str));
        let semantic = player_core::SemanticRendererProgress {
            activation: semantic_ref(report.activation),
            kind: crate::supervisor::evidence(report.kind),
            item_id: report.item_id.clone(),
            zone_id: report.zone_id.clone(),
        };
        let decision = self.tracking.progress(*session.id().as_uuid(), &semantic, expectation, now);
        if let Some(kind) = decision.activity_signal {
            self.signal(crate::activity::Signal::Renderer {
                kind,
                item_id: report.item_id.as_ref().map(|id| id.as_str().to_owned()),
            });
        }
        if !decision.meaningful {
            return false;
        }
        if decision.log_evidence {
            tracing::info!(
                component = "presentation",
                event = "evidence_accepted",
                generation = report.activation.generation,
                item = report.item_id.as_ref().map(SafeText::as_str).unwrap_or(""),
                zone = report.zone_id.as_ref().map(SafeText::as_str).unwrap_or(""),
                kind = report.kind.as_str()
            );
        }
        self.supervisor.on_progress(now.unix_millis(), &self.supervisor_config);
        true
    }

    pub fn item_error(
        &mut self,
        session: &SessionHandle,
        activation: ActivationRef,
        code: &str,
        item_id: Option<&str>,
        message: &str,
    ) {
        if self.tracking.reject(*session.id().as_uuid(), semantic_ref(activation), ShortToken::new(code).ok()) {
            self.signal(crate::activity::Signal::PlaybackError {
                item_id: item_id.map(str::to_owned),
                message: message.to_owned(),
            });
        }
    }

    /// Periodic supervision. Returns the action taken, for logging/tests.
    pub fn tick(&mut self, now_ms: i64) -> HealAction {
        // Nothing to judge until a renderer is ready and showing something.
        if !self.renderer.as_ref().is_some_and(|link| link.ready.is_some()) || self.current.is_none() {
            self.supervisor.reset_clock(now_ms);
            return HealAction::None;
        }
        let action = self.supervisor.evaluate(now_ms, &self.supervisor_config);
        match action {
            HealAction::None => {}
            HealAction::Reactivate => {
                if let Some(current) = self.current.take() {
                    let _ = self.activate_revision(
                        current.document,
                        current.content,
                        current.timing,
                        current.source,
                        current.identity,
                        current.extras,
                        now_ms,
                    );
                }
            }
            HealAction::ReloadRenderer => self.command(RendererCommandKind::Reload),
            HealAction::RestartRenderer => {
                self.restart_count += 1;
                if let Some(link) = &self.renderer {
                    let _ = link.port().request_restart(&ShortToken::new("recovery").expect("literal token"), 5_000);
                }
            }
            HealAction::EnterSafeMode => {
                let reason = SafeText::lossy(self.supervisor.safe_mode_reason.as_deref().unwrap_or("recovery"));
                let _ = self.activate(
                    PresentationDocument::SafeMode { reason },
                    Vec::new(),
                    None,
                    ActivationSource::SafeMode,
                    now_ms,
                );
            }
        }
        if action != HealAction::None {
            tracing::warn!(component = "presentation", event = "heal_action", action = ?action);
            // The Electron player's report of a self-heal decision.
            let (event_type, severity, code) = match action {
                HealAction::EnterSafeMode => ("safe_mode.entered", "critical", "enter_safe_mode"),
                HealAction::Reactivate => ("self_heal.attempted", "warning", "reactivate_content"),
                HealAction::ReloadRenderer => ("self_heal.attempted", "warning", "recreate_renderer"),
                HealAction::RestartRenderer => ("self_heal.attempted", "warning", "restart_renderer_process"),
                HealAction::None => unreachable!("checked above"),
            };
            let mut event = crate::activity::Event::new(event_type, "reliability");
            event.severity = Some(severity.into());
            event.failure_code = Some(code.into());
            event.metadata = Some(serde_json::json!({ "escalationStep": self.supervisor.escalation_step }));
            self.signal(crate::activity::Signal::Event(Box::new(event)));
        }
        action
    }

    fn command(&self, command: RendererCommandKind) {
        if let Some(link) = &self.renderer {
            let _ = link.port().send_command(uuid::Uuid::new_v4(), &crate::renderer_adapter::command(command));
        }
    }

    pub fn clear(&mut self, reason: &str) {
        self.current = None;
        self.tracking.clear();
        if let Some(link) = &self.renderer {
            let reason = ShortToken::new(reason).unwrap_or_else(|_| ShortToken::new("cleared").expect("literal"));
            let _ = link.port().clear(&reason);
        }
    }

    fn push_current(&mut self) {
        let Some((session, ready)) = self
            .renderer
            .as_ref()
            .and_then(|link| link.ready.as_ref().map(|ready| (link.session.clone(), ready.clone())))
        else {
            return;
        };
        let Some(current) = self.current.clone() else { return };
        let semantic = match crate::renderer_adapter::prepare(&current, self.clock_offset_ms) {
            Ok(semantic) => semantic,
            Err(error) => {
                tracing::error!(component = "media", event = "invalid_prepared_activation", error = %error);
                return;
            }
        };
        let packaged = crate::renderer_adapter::packaged_profile();
        let connected = crate::renderer_adapter::connected_profile(&ready);
        let incompatible = semantic.incompatibilities(&packaged, &connected);
        let missing: Vec<String> = incompatible
            .iter()
            .map(|(requirement, _)| match requirement {
                player_core::RendererRequirement::Feature(name) => name.as_str().to_owned(),
                player_core::RendererRequirement::PresentationSchema(version) => {
                    format!("presentation schema {version}")
                }
                player_core::RendererRequirement::Declarative { name, version }
                | player_core::RendererRequirement::WidgetComponent { name, version } => {
                    format!("{name} version {version}")
                }
            })
            .collect();
        if !missing.is_empty() {
            let reason =
                if incompatible.iter().any(|(_, source)| *source == player_core::RendererProfileMismatch::Packaged) {
                    format!("This Player release does not support: {}.", missing.join(", "))
                } else {
                    format!("This display engine does not support: {}.", missing.join(", "))
                };
            tracing::warn!(component = "presentation", event = "presentation_incompatible", missing = %missing.join(","));
            self.incompatible_reason = Some(reason);
            let fallback = PresentationDocument::Unavailable(StatusSurface {
                title: SafeText::lossy("Presentation unavailable"),
                message: SafeText::lossy("This screen's display engine cannot show the assigned presentation yet."),
                background_color: None,
                text_color: None,
                logo_src: None,
                footer_text: None,
                status: None,
            });
            let event = current.event(fallback, Vec::new(), None, None);
            let _ = session.send_event(event);
            return;
        }
        self.incompatible_reason = None;

        if let Some(link) = self.renderer.as_ref().filter(|link| link.session.id() == session.id())
            && let Err(error) = link.port().activate(&semantic)
        {
            tracing::error!(component = "media", event = "renderer_activation_failed", error = %error);
        }
    }

    pub fn status(&self) -> RendererStatus {
        let link = self.renderer.as_ref();
        let ready = link.and_then(|l| l.ready.as_ref());
        let current_item = self.tracking.current_item();
        let state = match (link, ready, self.supervisor.safe_mode) {
            (_, _, true) => "safe_mode",
            (None, _, _) => "disconnected",
            (Some(_), None, _) => "starting",
            (Some(_), Some(_), _) if self.incompatible_reason.is_some() => "incompatible",
            (Some(_), Some(_), _) if self.tracking.last_progress().is_some() => "healthy",
            _ => "waiting_for_progress",
        };
        RendererStatus {
            connected: link.is_some(),
            state: ShortToken::new(state).expect("literal token"),
            kind: ready.and_then(|_| ShortToken::new("wpe").ok()),
            version: ready.map(|r| r.renderer.version.clone()),
            platform: ready.and_then(|r| {
                ShortToken::new(match r.renderer.platform {
                    edge_protocol::ipc::event::RendererPlatform::Drm => "drm",
                    edge_protocol::ipc::event::RendererPlatform::Wayland => "wayland",
                    edge_protocol::ipc::event::RendererPlatform::Headless => "headless",
                })
                .ok()
            }),
            current_activation_generation: self.current.as_ref().map(|a| a.generation),
            last_progress_at: self.tracking.last_progress(),
            last_error_code: self.tracking.last_error().cloned(),
            incompatible_reason: self.incompatible_reason.as_deref().map(SafeText::lossy),
            current_item_id: current_item.as_ref().map(|(id, _)| ShortText::lossy(id)),
            current_item_started_at: current_item.as_ref().map(|(_, at)| *at),
            engine_version: ready.map(|r| r.renderer.engine_version.clone()),
            gstreamer_version: ready.and_then(|r| r.renderer.gstreamer_version.clone()),
        }
    }

    /// The current activation for status, without the server target, which
    /// the caller reads from state.
    pub fn presentation_status(&self) -> Option<edge_protocol::ipc::status::PresentationStatus> {
        let current = self.current.as_ref()?;
        Some(edge_protocol::ipc::status::PresentationStatus {
            source: ShortToken::new(current.source.as_token()).expect("literal token"),
            generation: current.generation,
            manifest_sha256: current.manifest(),
            target_manifest_sha256: None,
            accepted: self.current_is_accepted(),
            evidence: self.current_has_activation_evidence(),
        })
    }

    pub fn set_activity(&mut self, activity: crate::activity::Handle) {
        self.activity = Some(activity);
    }

    fn signal(&self, signal: crate::activity::Signal) {
        if let Some(activity) = &self.activity {
            activity.send(signal);
        }
    }

    /// Asks the connected renderer for a preview. False without a renderer.
    pub fn request_preview(&self, request_id: uuid::Uuid, max_width: u32, max_height: u32, max_bytes: u32) -> bool {
        let Some(link) = self.renderer.as_ref().filter(|link| link.ready.is_some()) else { return false };
        link.port()
            .request_capture(player_core::RendererCaptureRequest { request_id, max_width, max_height, max_bytes })
            .is_ok()
    }

    pub fn ready_info(&self) -> Option<&RendererReady> {
        self.renderer.as_ref().and_then(|link| link.ready.as_ref())
    }

    pub fn renderer_version(&self) -> Option<ShortText> {
        self.renderer.as_ref().and_then(|l| l.ready.as_ref()).map(|r| r.renderer.version.clone())
    }

    /// The connected renderer's remote web status: its `renderer.ready`
    /// report, whether a renderer is connected, and whether its helper is
    /// restarting.
    pub fn remote_web(&self) -> (Option<edge_protocol::ipc::event::RemoteWebStatus>, bool, bool) {
        match &self.renderer {
            Some(link) => (
                link.ready.as_ref().and_then(|ready| ready.remote_web.clone()),
                link.ready.is_some(),
                link.remote_web_restarting,
            ),
            None => (None, false, false),
        }
    }

    /// Records the renderer's health reason that concerns remote web.
    pub fn renderer_health(
        &mut self,
        session: &SessionHandle,
        health: &edge_protocol::ipc::event::RendererHealth,
    ) -> bool {
        if let Some(link) = self.link_for(session) {
            let before = link.remote_web_restarting;
            match health.reason_code.as_ref().map(ShortToken::as_str) {
                Some("remote_web_helper_restarting") => link.remote_web_restarting = true,
                _ if health.state == edge_protocol::ipc::event::HealthState::Healthy => {
                    link.remote_web_restarting = false
                }
                _ => {}
            }
            return before != link.remote_web_restarting;
        }
        false
    }

    pub fn renderer_ready_features(&self) -> Option<Vec<ShortToken>> {
        self.renderer.as_ref().and_then(|l| l.ready.as_ref()).map(|r| r.features.clone())
    }

    pub fn restart_count(&self) -> u64 {
        self.restart_count
    }

    pub fn is_safe_mode(&self) -> bool {
        self.supervisor.safe_mode
    }

    /// Applies the accepted player configuration: the recovery ladder from
    /// its `reliability` section (the operator's stall threshold when the
    /// section is absent) and the renderer kiosk policy, which prevents
    /// display sleep only while both the operator and the server want it.
    /// The kiosk policy reaches a renderer in its next `renderer.configure`.
    pub fn apply_player_config(
        &mut self,
        operator: &crate::config::EdgeConfig,
        config: &crate::player_config::PlayerConfig,
    ) {
        let mut supervisor = SupervisorConfig {
            stall_threshold_ms: operator.renderer.stall_threshold_seconds as i64 * 1_000,
            ..SupervisorConfig::default()
        };
        if let Some(reliability) = config.reliability {
            supervisor.stall_threshold_ms = reliability.stall_threshold_ms;
            supervisor.ladder_run_window_ms = reliability.ladder_run_window_ms;
            supervisor.max_ladder_runs_before_safe_mode = reliability.max_ladder_runs_before_safe_mode;
            supervisor.safe_mode_enabled = reliability.safe_mode_enabled;
        }
        self.supervisor_config = supervisor;
        self.configure.kiosk.prevent_display_sleep =
            operator.renderer.prevent_display_sleep && config.linux_kiosk.prevent_display_sleep;
    }

    pub fn supervisor_config(&self) -> SupervisorConfig {
        self.supervisor_config
    }

    pub fn kiosk_policy(&self) -> KioskPolicy {
        self.configure.kiosk.clone()
    }

    /// The display the ready renderer reported, if any.
    pub fn renderer_display(&self) -> Option<edge_protocol::ipc::event::DisplayInfo> {
        self.renderer.as_ref().and_then(|link| link.ready.as_ref()).and_then(|ready| ready.display.clone())
    }

    /// Whether a renderer is connected and has reported ready.
    pub fn renderer_is_ready(&self) -> bool {
        self.renderer.as_ref().is_some_and(|link| link.ready.is_some())
    }

    /// Issues the current activation again under a new generation: the
    /// runtime starts the presentation from the beginning (the reference
    /// player's `reload_playback`).
    pub fn reload_current(&mut self, now_ms: i64) -> bool {
        let Some(current) = self.current.take() else { return false };
        self.activate_revision(
            current.document,
            current.content,
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
        let Some(link) = self.renderer.as_ref().filter(|link| link.ready.is_some()) else { return false };
        link.port()
            .send_command(
                uuid::Uuid::new_v4(),
                &player_core::SemanticRendererCommand::Identify { name: SafeText::lossy(name), duration_seconds },
            )
            .is_ok()
    }

    /// Sends a playback command to a ready renderer. Returns whether it was
    /// delivered; the renderer's evidence, not this, shows its effect.
    pub fn renderer_command(&self, command: RendererCommandKind) -> bool {
        self.renderer_command_with_id(uuid::Uuid::new_v4(), command)
    }

    /// As [`Self::renderer_command`], with the identifier the renderer's
    /// `renderer.command_result` will carry.
    pub fn renderer_command_with_id(&self, command_id: uuid::Uuid, command: RendererCommandKind) -> bool {
        let Some(link) = self.renderer.as_ref().filter(|link| link.ready.is_some()) else { return false };
        link.port().send_command(command_id, &crate::renderer_adapter::command(command)).is_ok()
    }

    /// Asks the connected renderer to exit so systemd starts a fresh one; the
    /// current activation is restored when it reconnects.
    pub fn restart_renderer(&mut self, reason: &str) -> bool {
        let Some(link) = self.renderer.as_ref() else { return false };
        let reason = ShortToken::new(reason).unwrap_or_else(|_| ShortToken::new("command").expect("literal token"));
        let sent = link.port().request_restart(&reason, 5_000).is_ok();
        if sent {
            self.restart_count += 1;
        }
        sent
    }

    /// Leaves safe mode and restarts the ladder. Returns whether safe mode
    /// was active. Activation shows the right presentation again.
    pub fn clear_safe_mode(&mut self, now_ms: i64) -> bool {
        let was = self.supervisor.safe_mode;
        self.supervisor.clear_safe_mode(now_ms);
        was
    }

    /// Allows the next recovery rung at once and evaluates it (the reference
    /// player's `retry_player_recovery`).
    pub fn retry_recovery(&mut self, now_ms: i64) -> HealAction {
        self.supervisor.last_action_at_ms = None;
        self.tick(now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn website_content_evidence_is_a_rendered_page() {
        assert!(is_content_evidence(EvidenceKind::WebsiteLoaded, Expectation::Website));
        assert!(is_content_evidence(EvidenceKind::WidgetShown, Expectation::Website));
        assert!(!is_content_evidence(EvidenceKind::WebsiteAlive, Expectation::Website));
        assert!(!is_content_evidence(EvidenceKind::ItemStarted, Expectation::Website));
        // A Layout zone that shows a remote page reports its zone render.
        assert!(is_content_evidence(EvidenceKind::LayoutZoneRendered, Expectation::Layout));
        assert!(!is_content_evidence(EvidenceKind::WebsiteLoaded, Expectation::Still));
    }
}
