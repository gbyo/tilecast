//! The daemon's IPC behavior: what each validated event and request does.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use edge_ipc::{IpcHandler, SessionHandle};
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::event::Event;
use edge_protocol::ipc::message::ErrorBody;
use edge_protocol::ipc::method::{Method, PingResult, ShowDiagnosticResult, SubmitServerUrlResult, error_codes};
use edge_protocol::ipc::status::{
    CasStatus, CasVerifyResult, DaemonMode, DaemonStatus, MeshStatus, PeerSummary, ServerBindingStatus, VerifyOutcome,
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
        if session.role() == Role::Renderer {
            let peer = session.peer();
            if let Some(pid) = peer.pid
                && let Some(start_ticks) = process_start_ticks(pid)
            {
                self.context.media_registry.lock().await.bind_renderer(RendererInstance {
                    session: session.id(),
                    uid: peer.uid,
                    pid,
                    start_ticks,
                });
            } else {
                tracing::warn!(component = "media", event = "renderer_process_unavailable");
            }
            let now = self.context.now().unix_millis();
            self.context.presentation.lock().await.renderer_connected(session, now);
        }
    }

    async fn event(&self, session: &SessionHandle, event: Event) {
        let now = self.context.now();
        let mut engine = self.context.presentation.lock().await;
        match event {
            Event::RendererReady(ready) => engine.renderer_ready(session, ready),
            Event::PresentationAccepted(accepted) => engine.accepted(session, accepted.activation),
            Event::PresentationRejected(rejected) => {
                engine.rejected(session, rejected.activation, rejected.code.as_str());
            }
            Event::RendererProgress(progress) => engine.progress(session, &progress, now),
            Event::ItemError(item) => {
                tracing::warn!(
                    component = "renderer",
                    event = "item_error",
                    code = item.code.as_str(),
                    item = item.item_id.as_ref().map(SafeText::as_str).unwrap_or(""),
                    message = item.message.as_str()
                );
                engine.item_error(session, item.activation, item.code.as_str());
            }
            Event::RendererHealth(health) => {
                tracing::debug!(component = "renderer", event = "health", state = ?health.state, terminations = health.web_process_terminations);
            }
            Event::PreviewResult(_) | Event::ShutdownAck(_) => {}
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
            Method::PeersList(_) => {
                let db = context.db().ok_or_else(|| error(error_codes::UNAVAILABLE, "State is unavailable."))?;
                let peers = db
                    .run(|c| edge_state::repo::peers::list(c))
                    .await
                    .map_err(|_| error(error_codes::INTERNAL, "Peers could not be read."))?;
                let summaries: Vec<PeerSummary> = peers
                    .into_iter()
                    .map(|peer| PeerSummary {
                        node_id: peer.node_id,
                        screen_id: peer.screen_id,
                        edge_version: peer.edge_version.as_deref().map(ShortText::lossy),
                        blob_endpoint: peer.blob_endpoint.as_deref().map(ShortText::lossy),
                        last_seen_at: peer.last_seen_at,
                        present: false,
                    })
                    .collect();
                to_value(&summaries)
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
            Method::SetupSubmitServerUrl(params) => {
                // Server URL setup on the TV belongs to the pairing port
                // (edge-server::url_policy + pairing client). Until then the
                // renderer's setup surface gets an honest answer.
                let _ = params;
                to_value(&SubmitServerUrlResult {
                    ok: false,
                    error: Some(SafeText::lossy("Configure this screen with the Tilecast Edge installer.")),
                })
            }
        }
    }

    async fn session_closed(&self, session: &SessionHandle, _reason: &str) {
        if session.role() == Role::Renderer {
            self.context.media_registry.lock().await.unbind_renderer(session.id());
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
            filesystem_available_bytes: edge_platform::disk::available_bytes(&self.context.paths.state_dir).ok(),
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
        let renderer = context.presentation.lock().await.status();
        DaemonStatus {
            daemon_version: ShortText::lossy(VERSION),
            mode,
            recovery_reason,
            started_at: context.started_at,
            node_id: context.node_id,
            server: binding.map(|b| ServerBindingStatus {
                server_url: ShortText::lossy(&b.server_url),
                installation_id: b.installation_id,
                screen_id: b.screen_id,
                screen_name: b.screen_name.as_deref().map(ShortText::lossy),
                identity_verified_at: b.identity_verified_at,
                has_device_credential: b.credential_state == edge_state::repo::binding::CredentialState::Stored,
            }),
            identity: crate::identity_status::current_with_link(context).await,
            cas: self.cas_status().await.ok(),
            mesh: {
                let mesh = context.mesh_state.lock().unwrap_or_else(|e| e.into_inner()).clone();
                MeshStatus {
                    state: ShortToken::new(mesh.state).expect("literal"),
                    peer_count: mesh.peers as u32,
                    last_peer_change_at: mesh.last_peer_change_at,
                    reason_code: mesh.reason.and_then(|r| ShortToken::new(r).ok()),
                }
            },
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
        }
    }
}
