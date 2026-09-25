//! The daemon's IPC behavior: what each validated event and request does.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use edge_ipc::{IpcHandler, SessionHandle};
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::event::{Event, EvidenceKind};
use edge_protocol::ipc::message::ErrorBody;
use edge_protocol::ipc::method::{Method, PingResult, ShowDiagnosticResult, SubmitServerUrlResult, error_codes};
use edge_protocol::ipc::status::{
    CasStatus, CasVerifyResult, DaemonMode, DaemonStatus, ServerBindingStatus, ServerLinkStatus, VerifyOutcome,
};
use serde_json::Value;

use crate::daemon::{DaemonContext, StateMode, VERSION, status_surface};
use crate::media::RendererInstance;
use crate::media_channel::process_start_ticks;
use crate::presentation::ActivationSource;

#[derive(Debug)]
pub struct DaemonIpc {
    context: Arc<DaemonContext>,
}

impl DaemonIpc {
    pub fn new(context: Arc<DaemonContext>) -> Self {
        Self { context }
    }
}

fn error(code: &str, message: &str) -> ErrorBody {
    ErrorBody {
        code: ShortToken::new(code).unwrap_or_else(|_| ShortToken::new(error_codes::INTERNAL).expect("literal")),
        message: SafeText::lossy(message),
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, ErrorBody> {
    serde_json::to_value(value).map_err(|_| error(error_codes::INTERNAL, "The result could not be encoded."))
}

/// Renderer features this daemon understands. Unknown requested features
/// are ignored rather than rejected (see `edge_protocol::ipc`).
const RENDERER_SESSION_FEATURES: &[&str] = &[];

#[async_trait]
impl IpcHandler for DaemonIpc {
    fn session_features(&self, role: Role, requested: &[ShortToken]) -> Vec<ShortToken> {
        match role {
            Role::Renderer => requested
                .iter()
                .filter(|feature| RENDERER_SESSION_FEATURES.contains(&feature.as_str()))
                .cloned()
                .collect(),
            _ => Vec::new(),
        }
    }

    async fn session_opened(&self, session: SessionHandle) {
        if session.role() == Role::SessionBridge {
            self.context.audio.bridge_connected(session);
            self.context.audio_wake.notify_one();
            return;
        }
        if session.role() == Role::Renderer {
            self.context.audio.renderer_reset();
            let peer = session.peer();
            if let Some(pid) = peer.pid
                && let Some(start_ticks) = process_start_ticks(pid)
            {
                if let Ok(mut registry) = self.context.media_registry.lock() {
                    registry.bind_renderer(RendererInstance { session: session.id(), uid: peer.uid, pid, start_ticks });
                } else {
                    tracing::error!(component = "media", event = "registry_poisoned");
                }
            } else {
                tracing::warn!(component = "media", event = "renderer_process_unavailable");
            }
            let now = self.context.now().unix_millis();
            self.context.presentation.lock().await.renderer_connected(session, now);
        }
    }

    async fn event(&self, session: &SessionHandle, event: Event) {
        let now = self.context.now();
        match event {
            Event::AudioLevel(level) => {
                match self.context.audio.level(level, std::time::Instant::now()) {
                    crate::audio::LevelOutcome::Forward(rms) => {
                        self.context.presentation.lock().await.send_noise_level(rms);
                    }
                    crate::audio::LevelOutcome::Dropped => {}
                    crate::audio::LevelOutcome::Violation(reason) => {
                        tracing::warn!(component = "audio", event = "bridge_violation", reason);
                        session.close(reason);
                    }
                }
                return;
            }
            Event::AudioInventory(inventory) => {
                if self.context.audio.inventory(inventory) {
                    self.context.audio_wake.notify_one();
                }
                return;
            }
            Event::NoiseReport(report) => {
                if let Some(bucket) = self.context.audio.noise_report(report, std::time::Instant::now()) {
                    crate::audio::store_bucket(&self.context, bucket).await;
                }
                self.context.audio_wake.notify_one();
                return;
            }
            _ => {}
        }
        let mut engine = self.context.presentation.lock().await;
        match event {
            Event::RendererReady(ready) => engine.renderer_ready(session, ready, now.unix_millis()),
            Event::PresentationAccepted(accepted) => {
                engine.accepted(session, accepted.activation);
                self.context.manifest_wake.notify_one();
            }
            Event::PresentationRejected(rejected) => {
                engine.rejected(session, rejected.activation, rejected.code.as_str());
            }
            Event::RendererProgress(progress) => {
                let is_boundary = progress.kind == EvidenceKind::ItemTransition;
                let meaningful = engine.progress(session, &progress, now);
                if is_boundary && meaningful {
                    self.context.manifest_item_boundary.store(true, Ordering::Relaxed);
                    self.context.manifest_wake.notify_one();
                } else if meaningful {
                    self.context.manifest_wake.notify_one();
                }
            }
            Event::ItemError(item) => {
                tracing::warn!(
                    component = "renderer",
                    event = "item_error",
                    code = item.code.as_str(),
                    item = item.item_id.as_ref().map(SafeText::as_str).unwrap_or(""),
                    message = item.message.as_str()
                );
                engine.item_error(
                    session,
                    item.activation,
                    item.code.as_str(),
                    item.item_id.as_ref().map(SafeText::as_str),
                    item.message.as_str(),
                );
            }
            Event::RendererHealth(health) => {
                tracing::debug!(component = "renderer", event = "health", state = ?health.state, terminations = health.web_process_terminations);
            }
            Event::PreviewResult(result) => {
                if result.within_limits() {
                    self.context.preview_waiters.complete(result.request_id, result.result);
                }
            }
            Event::ShutdownAck(_) => {}
            // Daemon → client events never arrive here: the transport rejects
            // them by direction before dispatch.
            _ => {}
        }
    }

    async fn request(&self, session: &SessionHandle, method: Method) -> Result<Value, ErrorBody> {
        let context = &self.context;
        match method {
            Method::Ping(_) => to_value(&PingResult { daemon_time: context.now() }),
            Method::StatusGet(_) => to_value(&self.status().await),
            Method::CapabilitiesGet(_) => {
                let db = context.db().ok_or_else(|| error(error_codes::UNAVAILABLE, "State is unavailable."))?;
                let stored = db
                    .run(|c| edge_state::repo::capabilities::load(c))
                    .await
                    .map_err(|_| error(error_codes::INTERNAL, "Capabilities could not be read."))?;
                match stored {
                    Some(stored) => to_value(&stored.snapshot),
                    None => Err(error(error_codes::UNAVAILABLE, "Capabilities have not been probed yet.")),
                }
            }
            Method::CasStatus(_) => to_value(&self.cas_status().await?),
            Method::CasVerify(params) => {
                let cas = context
                    .cas
                    .as_ref()
                    .ok_or_else(|| error(error_codes::UNAVAILABLE, "The content store is unavailable."))?;
                let outcome = cas
                    .verify(&params.sha256)
                    .await
                    .map_err(|_| error(error_codes::INTERNAL, "The object could not be verified."))?;
                to_value(&CasVerifyResult {
                    sha256: params.sha256,
                    outcome: match outcome {
                        edge_cas::store::VerifyOutcome::Verified => VerifyOutcome::Verified,
                        edge_cas::store::VerifyOutcome::Missing => VerifyOutcome::Missing,
                        edge_cas::store::VerifyOutcome::Corrupt => VerifyOutcome::Corrupt,
                    },
                })
            }
            Method::DiagnosticsShowStatus(_) => {
                let bound = self.is_bound().await;
                let document = status_surface(context, bound);
                let now = context.now().unix_millis();
                let activation = context
                    .presentation
                    .lock()
                    .await
                    .activate(document, Vec::new(), None, ActivationSource::StatusSurface, now)
                    .map_err(|_| error(error_codes::INTERNAL, "The status surface could not be activated."))?;
                tracing::info!(component = "ipc", event = "diagnostic_status_shown", uid = session.peer().uid);
                to_value(&ShowDiagnosticResult { generation: activation.generation })
            }
            Method::SetupSubmitServerUrl(params) | Method::PairingStart(params) => {
                let result = crate::pairing::begin(context, params.url.as_str()).await;
                tracing::info!(component = "ipc", event = "pairing_requested", ok = result.is_ok());
                to_value(&SubmitServerUrlResult { ok: result.is_ok(), error: result.err().map(SafeText::lossy) })
            }
            Method::PairingReset(_) => {
                crate::pairing::reset(context).await;
                to_value(&serde_json::json!({}))
            }
            Method::DiscoveryList(_) => to_value(&crate::discovery::list(context).await),
        }
    }

    async fn session_closed(&self, session: &SessionHandle, _reason: &str) {
        if session.role() == Role::SessionBridge {
            self.context.audio.bridge_disconnected(session);
            self.context.audio_wake.notify_one();
            return;
        }
        if session.role() == Role::Renderer {
            self.context.audio.renderer_reset();
            self.context.audio_wake.notify_one();
            if let Ok(mut registry) = self.context.media_registry.lock() {
                registry.unbind_renderer(session.id());
            }
            self.context.presentation.lock().await.renderer_disconnected(session.id());
        }
    }
}

impl DaemonIpc {
    async fn is_bound(&self) -> bool {
        match self.context.db() {
            Some(db) => db.run(|c| edge_state::repo::binding::get(c)).await.ok().flatten().is_some(),
            None => false,
        }
    }

    async fn cas_status(&self) -> Result<CasStatus, ErrorBody> {
        let db = self.context.db().ok_or_else(|| error(error_codes::UNAVAILABLE, "State is unavailable."))?;
        let usage = db
            .run(|c| edge_state::repo::cas::usage(c))
            .await
            .map_err(|_| error(error_codes::INTERNAL, "Content usage could not be read."))?;
        Ok(CasStatus {
            object_count: usage.object_count,
            used_bytes: usage.used_bytes,
            pinned_bytes: usage.pinned_bytes,
            partial_bytes: usage.partial_bytes,
            limit_bytes: self.context.config.cas.limit_bytes,
            reserved_free_bytes: self.context.config.cas.reserved_free_bytes,
            filesystem_available_bytes: self.context.space.available_bytes(&self.context.paths.state_dir).ok(),
        })
    }

    pub async fn status(&self) -> DaemonStatus {
        let context = &self.context;
        let (mode, recovery_reason) = match &context.state {
            StateMode::Normal(_) => (DaemonMode::Normal, None),
            StateMode::Recovery { reason } => (DaemonMode::Recovery, ShortToken::new(*reason).ok()),
        };
        let binding = match context.db() {
            Some(db) => db.run(|c| edge_state::repo::binding::get(c)).await.ok().flatten(),
            None => None,
        };
        let legacy = match context.db() {
            Some(db) => db.run(|c| edge_state::repo::legacy::get(c)).await.ok().flatten(),
            None => None,
        };
        let (renderer, mut presentation) = {
            let engine = context.presentation.lock().await;
            (engine.status(), engine.presentation_status())
        };
        if let (Some(presentation), Some(db), Some(bound)) = (presentation.as_mut(), context.db(), binding.as_ref())
            && let Some(screen_id) = bound.screen_id
        {
            let target_binding = edge_state::repo::manifests::Binding {
                installation_id: bound.installation_id,
                screen_id,
                server_url: bound.server_url.clone(),
            };
            presentation.target_manifest_sha256 = db
                .run(move |c| edge_state::repo::manifests::target(c, &target_binding))
                .await
                .ok()
                .flatten()
                .map(|target| target.digest);
        }
        let player_id = match context.db() {
            Some(db) => db
                .run(|c| edge_state::repo::daemon::player_identity(c))
                .await
                .ok()
                .flatten()
                .map(|identity| identity.player_id),
            None => None,
        }
        .or(context.player_id);
        let pairing = crate::pairing::view(context);
        let outbox = match context.db() {
            Some(db) => db.run(|c| edge_state::repo::outbox::stats(c)).await.ok().map(|stats| {
                edge_protocol::ipc::status::OutboxStatus {
                    queued_activity: stats.queued_activity,
                    queued_telemetry: stats.queued_telemetry,
                    dropped_activity: stats.dropped_activity,
                    dropped_telemetry: stats.dropped_telemetry,
                    rejected: stats.rejected,
                    expired: stats.expired,
                }
            }),
            None => None,
        };
        DaemonStatus {
            daemon_version: ShortText::lossy(VERSION),
            mode,
            recovery_reason,
            started_at: context.started_at,
            player_id,
            server: binding.map(|b| ServerBindingStatus {
                server_url: ShortText::lossy(&b.server_url),
                installation_id: b.installation_id,
                screen_id: b.screen_id,
                screen_name: b.screen_name.as_deref().map(ShortText::lossy),
                identity_verified_at: b.identity_verified_at,
                has_device_credential: b.credential_state == edge_state::repo::binding::CredentialState::Stored,
            }),
            link: {
                let link = context.link_state.lock().unwrap_or_else(|e| e.into_inner()).clone();
                ServerLinkStatus {
                    state: ShortToken::new(link.state_token()).expect("literal"),
                    reason_code: link.reason_code().and_then(|r| ShortToken::new(r).ok()),
                    last_contact_at: *context.last_server_contact.lock().unwrap_or_else(|e| e.into_inner()),
                }
            },
            cas: self.cas_status().await.ok(),
            renderer,
            capability_revision: context.capability_revision.load(Ordering::Relaxed),
            systemd_watchdog: context.notifier.watchdog_timeout().is_some(),
            last_legacy_import: legacy.map(|record| {
                ShortToken::new(match record.state {
                    edge_state::repo::legacy::ImportState::Completed => "completed",
                    edge_state::repo::legacy::ImportState::Started => "incomplete",
                    edge_state::repo::legacy::ImportState::Failed => "failed",
                })
                .expect("literal")
            }),
            pairing: (!pairing.state.is_empty()).then(|| edge_protocol::ipc::status::PairingStatus {
                state: ShortToken::new(pairing.state).expect("literal"),
                code: pairing.code.as_deref().map(ShortText::lossy),
                reason: pairing.reason.as_deref().and_then(|reason| ShortToken::new(reason).ok()),
            }),
            presentation,
            outbox,
        }
    }
}
