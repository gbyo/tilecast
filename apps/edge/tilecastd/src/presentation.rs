//! The presentation engine: what the renderer should show, and whether it is.
//!
//! Ownership (RFC Amendment A1): selection, scheduling, preparation and
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

use edge_ipc::SessionHandle;
use edge_protocol::Timestamp;
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ids::{ActivationId, SessionId};
use edge_protocol::ipc::event::{
    ActivationRef, ContentStoreDescriptor, Event, KioskPolicy, PresentationActivate, PresentationClear,
    RendererCommand, RendererCommandKind, RendererConfigure, RendererProgress, RendererReady, RendererShutdown,
    SyncTiming,
};
use edge_protocol::ipc::presentation::{
    ContentRef, PresentationDocument, PresentationError, StatusSurface, validate_content_references,
};
use edge_protocol::ipc::status::RendererStatus;

use crate::supervisor::{Expectation, HealAction, SupervisorConfig, SupervisorState, is_meaningful};

/// Where an activation came from, for status and logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationSource {
    StatusSurface,
    Fixture,
    SafeMode,
}

#[derive(Debug, Clone)]
pub struct Activation {
    pub id: ActivationId,
    pub generation: u64,
    pub document: PresentationDocument,
    pub content: Vec<ContentRef>,
    pub timing: Option<SyncTiming>,
    pub source: ActivationSource,
}

impl Activation {
    fn reference(&self) -> ActivationRef {
        ActivationRef { activation_id: self.id, generation: self.generation }
    }

    fn event(&self) -> Event {
        Event::PresentationActivate(Box::new(PresentationActivate {
            activation_id: self.id,
            generation: self.generation,
            presentation: self.document.clone(),
            content: self.content.clone(),
            timing: self.timing.clone(),
        }))
    }

    fn expectation_for(&self, item_id: Option<&str>) -> Expectation {
        match &self.document {
            PresentationDocument::Playing { items, .. } => item_id
                .and_then(|id| items.iter().find(|item| item.id.as_str() == id))
                .map_or(Expectation::Indefinite, |item| Expectation::for_item(item.kind)),
            _ => Expectation::Indefinite,
        }
    }
}

#[derive(Debug)]
struct RendererLink {
    session: SessionHandle,
    ready: Option<RendererReady>,
    accepted: Option<ActivationRef>,
    last_progress_at: Option<Timestamp>,
    last_error_code: Option<String>,
}

#[derive(Debug)]
pub struct PresentationEngine {
    configure: RendererConfigure,
    next_generation: u64,
    current: Option<Activation>,
    renderer: Option<RendererLink>,
    incompatible_reason: Option<String>,
    supervisor: SupervisorState,
    supervisor_config: SupervisorConfig,
    restart_count: u64,
}

impl PresentationEngine {
    pub fn new(cas_root: &std::path::Path, kiosk: KioskPolicy, supervisor_config: SupervisorConfig, now_ms: i64) -> Self {
        let configure = RendererConfigure {
            content_store: ContentStoreDescriptor {
                layout: ShortToken::new("cas-sha256-v1").expect("literal token"),
                root: SafeText::lossy(&cas_root.to_string_lossy()),
            },
            kiosk,
        };
        Self {
            configure,
            next_generation: 1,
            current: None,
            renderer: None,
            incompatible_reason: None,
            supervisor: SupervisorState::new(now_ms),
            supervisor_config,
            restart_count: 0,
        }
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
        validate_content_references(&document, &content)?;
        let activation = Activation {
            id: ActivationId::new_random(),
            generation: self.next_generation,
            document,
            content,
            timing,
            source,
        };
        self.next_generation += 1;
        let reference = activation.reference();
        tracing::info!(
            component = "presentation",
            event = "activation_issued",
            generation = activation.generation,
            state = activation.document.state_name(),
            content = activation.content.len()
        );
        self.current = Some(activation);
        self.supervisor.reset_clock(now_ms);
        self.push_current();
        Ok(reference)
    }

    pub fn current(&self) -> Option<&Activation> {
        self.current.as_ref()
    }

    /// Digests the current activation needs pinned.
    pub fn pinned_content(&self) -> BTreeSet<edge_protocol::Sha256Digest> {
        self.current.iter().flat_map(|a| a.content.iter().map(|c| c.sha256)).collect()
    }

    pub fn renderer_connected(&mut self, session: SessionHandle, now_ms: i64) {
        let _ = session.send_event(Event::RendererConfigure(self.configure.clone()));
        self.renderer =
            Some(RendererLink { session, ready: None, accepted: None, last_progress_at: None, last_error_code: None });
        self.supervisor.reset_clock(now_ms);
    }

    pub fn renderer_disconnected(&mut self, session: SessionId) {
        if self.renderer.as_ref().is_some_and(|link| link.session.id() == session) {
            self.renderer = None;
        }
    }

    fn link_for(&mut self, session: &SessionHandle) -> Option<&mut RendererLink> {
        self.renderer.as_mut().filter(|link| link.session.id() == session.id())
    }

    pub fn renderer_ready(&mut self, session: &SessionHandle, ready: RendererReady) {
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
        let current = self.current.as_ref().map(Activation::reference);
        if let Some(link) = self.link_for(session)
            && current == Some(activation)
        {
            link.accepted = Some(activation);
        }
    }

    pub fn rejected(&mut self, session: &SessionHandle, activation: ActivationRef, code: &str) {
        let current = self.current.as_ref().map(Activation::reference);
        if let Some(link) = self.link_for(session)
            && current == Some(activation)
        {
            tracing::warn!(component = "presentation", event = "activation_rejected", code);
            link.last_error_code = Some(code.to_owned());
        }
    }

    pub fn progress(&mut self, session: &SessionHandle, report: &RendererProgress, now: Timestamp) {
        let Some(current) = self.current.as_ref() else {
            return;
        };
        // Evidence for a replaced activation must never count as progress.
        if report.activation != current.reference() {
            return;
        }
        let expectation = current.expectation_for(report.item_id.as_ref().map(SafeText::as_str));
        if !is_meaningful(report.kind, expectation) {
            return;
        }
        if let Some(link) = self.link_for(session) {
            link.last_progress_at = Some(now);
        }
        self.supervisor.on_progress(now.unix_millis(), &self.supervisor_config);
    }

    pub fn item_error(&mut self, session: &SessionHandle, activation: ActivationRef, code: &str) {
        let current = self.current.as_ref().map(Activation::reference);
        if let Some(link) = self.link_for(session)
            && current == Some(activation)
        {
            link.last_error_code = Some(code.to_owned());
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
                    let _ = self.activate(current.document, current.content, current.timing, current.source, now_ms);
                }
            }
            HealAction::ReloadRenderer => self.command(RendererCommandKind::Reload),
            HealAction::RestartRenderer => {
                self.restart_count += 1;
                if let Some(link) = &self.renderer {
                    let _ = link.session.send_event(Event::RendererShutdown(RendererShutdown {
                        reason: ShortToken::new("recovery").expect("literal token"),
                        deadline_ms: 5_000,
                    }));
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
        }
        action
    }

    fn command(&self, command: RendererCommandKind) {
        if let Some(link) = &self.renderer {
            let _ = link.session.send_event(Event::RendererCommand(RendererCommand {
                command_id: uuid::Uuid::new_v4(),
                command,
            }));
        }
    }

    pub fn clear(&mut self, reason: &str) {
        self.current = None;
        if let Some(link) = &self.renderer {
            let _ = link.session.send_event(Event::PresentationClear(PresentationClear {
                reason: ShortToken::new(reason).unwrap_or_else(|_| ShortToken::new("cleared").expect("literal")),
            }));
        }
    }

    fn push_current(&mut self) {
        let Some(link) = &self.renderer else {
            return;
        };
        let Some(ready) = &link.ready else {
            return;
        };
        let Some(current) = &self.current else {
            return;
        };
        let offered: BTreeSet<&str> = ready.features.iter().map(ShortToken::as_str).collect();
        let missing: Vec<&str> =
            current.document.required_features().into_iter().filter(|f| !offered.contains(f)).collect();
        if missing.is_empty() {
            self.incompatible_reason = None;
            let _ = link.session.send_event(current.event());
            return;
        }
        let reason = format!("This display engine does not support: {}.", missing.join(", "));
        tracing::warn!(component = "presentation", event = "presentation_incompatible", missing = %missing.join(","));
        self.incompatible_reason = Some(reason);
        // Show an explicit surface instead of dropping part of the content.
        let fallback = Activation {
            id: ActivationId::new_random(),
            generation: current.generation,
            document: PresentationDocument::Unavailable(StatusSurface {
                title: SafeText::lossy("Presentation unavailable"),
                message: SafeText::lossy("This screen's display engine cannot show the assigned presentation yet."),
                background_color: None,
                text_color: None,
                logo_src: None,
                footer_text: None,
                status: None,
            }),
            content: Vec::new(),
            timing: None,
            source: current.source,
        };
        let _ = link.session.send_event(fallback.event());
    }

    pub fn status(&self) -> RendererStatus {
        let link = self.renderer.as_ref();
        let ready = link.and_then(|l| l.ready.as_ref());
        let state = match (link, ready, self.supervisor.safe_mode) {
            (_, _, true) => "safe_mode",
            (None, _, _) => "disconnected",
            (Some(_), None, _) => "starting",
            (Some(_), Some(_), _) if self.incompatible_reason.is_some() => "incompatible",
            (Some(l), Some(_), _) if l.last_progress_at.is_some() => "healthy",
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
            last_progress_at: link.and_then(|l| l.last_progress_at),
            last_error_code: link.and_then(|l| l.last_error_code.as_deref()).and_then(|c| ShortToken::new(c).ok()),
            incompatible_reason: self.incompatible_reason.as_deref().map(SafeText::lossy),
        }
    }

    pub fn renderer_version(&self) -> Option<ShortText> {
        self.renderer.as_ref().and_then(|l| l.ready.as_ref()).map(|r| r.renderer.version.clone())
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
}
