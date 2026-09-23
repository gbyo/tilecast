//! The daemon's link to the Tilecast Server.
//!
//! One task, one owner of the device credential. Each pass:
//!
//! 1. Requires a server binding and the stored credential (from pairing or
//!    the one-time legacy import). Without them the node is idle: nothing is
//!    sent anywhere.
//! 2. Reads public installation identity and requires the bound
//!    installation ID before the credential is sent (the identity gate is a
//!    type in `edge_server::client`). A mismatch stops the link until an
//!    explicit reset; the credential is never sent to the other server.
//! 3. Opens the ordinary player WebSocket, sends status, and falls back to
//!    HTTP heartbeat if the socket is unavailable. A server ping samples the
//!    clock and receives a pong; unknown push types are ignored.
//! 4. Enrolls, or renews when fewer than 30 days remain, with a key this
//!    daemon generates. The Edge private key never leaves this process.
//! 5. Reconciles the signed change feed.
//! 6. Posts the bounded Edge status on a low cadence.
//!
//! The credential is deleted only when the server says it is invalid or
//! revoked (the legacy player's rule); network errors, 5xx and disabled
//! screens retry with backoff. Playback never waits for this task.

use std::sync::Arc;
use std::time::{Duration, Instant};

use edge_identity::renewal::{self, RenewalDecision};
use edge_protocol::Timestamp;
use edge_protocol::signed::change::AuthorityTrust;
use edge_server::client::{
    ManifestFetch, PLAYER_SOCKET_ACTIVITY_TIMEOUT, PlayerSocket, PlayerSocketEvent, ServerClient, ServerError,
};
use edge_server::enrollment::{EnrollError, enroll};
use edge_server::feed::{FeedApplier, FeedError, Wake};
use edge_server::{AuthenticatedServer, DeviceCredential};
use edge_state::repo::binding::{self, CredentialState};
use edge_state::repo::cas::PinReason;
use edge_state::repo::manifests::{self, Binding as ManifestBinding, Stage, StoredManifest};
use edge_state::repo::{capabilities, identity, playback};

use crate::daemon::{DaemonContext, VERSION};
use crate::manifest::{self, Candidate};

/// Feed reconciliation cadence without a mesh wake-up (RFC §12.3).
pub const RECONCILE_INTERVAL: Duration = Duration::from_secs(60);
pub const STATUS_INTERVAL: Duration = Duration::from_secs(300);
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
pub const MANIFEST_INTERVAL: Duration = Duration::from_secs(300);
pub const SOCKET_LIVENESS_TIMEOUT: Duration = PLAYER_SOCKET_ACTIVITY_TIMEOUT;
/// Re-check cadence while there is nothing to do (unbound, rejected).
pub const IDLE_INTERVAL: Duration = Duration::from_secs(300);

/// Why a pass stopped early; recorded for `tilecastctl status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    Unbound,
    CredentialMissing,
    CredentialRejected,
    IdentityMismatch,
    Connected,
    ConnectedWithoutEdgeTrust,
    Retrying(&'static str),
}

impl LinkState {
    pub fn reason_code(&self) -> Option<&'static str> {
        match self {
            Self::Unbound => Some("not_bound"),
            Self::CredentialMissing => Some("device_credential_missing"),
            Self::CredentialRejected => Some("device_credential_rejected"),
            Self::IdentityMismatch => Some("installation_identity_mismatch"),
            Self::Connected => None,
            Self::ConnectedWithoutEdgeTrust => Some("edge_secure_bootstrap_required"),
            Self::Retrying(code) => Some(code),
        }
    }
}

#[derive(Debug, Default)]
struct Link {
    next_status_ms: i64,
    next_heartbeat_ms: i64,
    failures: u32,
    socket: Option<PlayerSocket>,
    socket_failures: u32,
    next_socket_attempt: Option<Instant>,
    last_socket_activity: Option<Instant>,
    next_manifest_attempt: Option<Instant>,
    manifest_dirty: bool,
    manifest_task: Option<tokio::task::JoinHandle<()>>,
}

impl Link {
    fn socket_activity(&mut self) {
        self.last_socket_activity = Some(Instant::now());
    }

    fn socket_liveness_remaining(&self) -> Duration {
        self.last_socket_activity
            .map_or(SOCKET_LIVENESS_TIMEOUT, |last| SOCKET_LIVENESS_TIMEOUT.saturating_sub(last.elapsed()))
    }

    fn socket_lost(&mut self) {
        self.socket = None;
        self.last_socket_activity = None;
        let exponent = self.socket_failures.min(5);
        self.socket_failures = self.socket_failures.saturating_add(1);
        self.next_socket_attempt = Some(Instant::now() + Duration::from_secs((5_u64 << exponent).min(60)));
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    let mut link = Link::default();
    loop {
        if link.manifest_task.as_ref().is_some_and(tokio::task::JoinHandle::is_finished)
            && let Some(task) = link.manifest_task.take()
        {
            let _ = task.await;
        }
        let state = pass(&context, &mut link).await;
        if matches!(
            state,
            LinkState::Unbound
                | LinkState::CredentialMissing
                | LinkState::CredentialRejected
                | LinkState::IdentityMismatch
        ) && let Some(task) = link.manifest_task.take()
        {
            task.abort();
        }
        let mut delay = match &state {
            LinkState::Connected | LinkState::ConnectedWithoutEdgeTrust => {
                link.failures = 0;
                RECONCILE_INTERVAL
            }
            LinkState::Retrying(_) => {
                let delay = renewal::retry_delay(link.failures).unsigned_abs();
                link.failures = link.failures.saturating_add(1);
                // The first retries are quick; the renewal schedule's floor
                // (5 minutes) is for certificate issuance, not reachability.
                if link.failures <= 3 { Duration::from_secs(15 * u64::from(link.failures)) } else { delay }
            }
            _ => IDLE_INTERVAL,
        };
        if matches!(state, LinkState::Connected | LinkState::ConnectedWithoutEdgeTrust)
            && link.socket.is_none()
            && let Some(next) = link.next_socket_attempt
        {
            delay = delay.min(next.saturating_duration_since(Instant::now()));
        }
        *context.link_state.lock().unwrap_or_else(|e| e.into_inner()) = state;
        let deadline = tokio::time::sleep(delay);
        tokio::pin!(deadline);
        loop {
            let remaining = link.socket_liveness_remaining();
            if let Some(socket) = link.socket.as_mut() {
                tokio::select! {
                    () = context.shutdown.cancelled() => return,
                    () = &mut deadline => break,
                    () = context.server_wake.notified() => break,
                    received = tokio::time::timeout(remaining, socket.next_event()) => {
                        match received {
                            Ok(Ok(PlayerSocketEvent::Closed)) | Ok(Err(_)) | Err(_) => {
                                link.socket_lost();
                                break;
                            }
                            Ok(Ok(event)) => {
                                link.last_socket_activity = Some(Instant::now());
                                match event {
                                    PlayerSocketEvent::Ping(timestamp) => {
                                        sample_server_clock(&context, &timestamp).await;
                                        if socket.send_pong(&context.now().to_string()).await.is_err() {
                                            link.socket_lost();
                                            break;
                                        }
                                    }
                                    PlayerSocketEvent::ManifestChanged => {
                                        link.manifest_dirty = true;
                                        break;
                                    }
                                    PlayerSocketEvent::ConfigChanged | PlayerSocketEvent::CommandsAvailable => break,
                                    PlayerSocketEvent::Hello | PlayerSocketEvent::Other => {}
                                    PlayerSocketEvent::Closed => unreachable!("closed events are handled above"),
                                }
                            }
                        }
                    }
                }
            } else {
                tokio::select! {
                    () = context.shutdown.cancelled() => return,
                    () = &mut deadline => break,
                    () = context.server_wake.notified() => break,
                }
            }
        }
    }
}

async fn sample_server_clock(context: &DaemonContext, timestamp: &str) {
    let Ok(server_time) = Timestamp::parse(timestamp) else { return };
    let Some(db) = context.db() else { return };
    let received_at = context.now();
    let offset = server_time.unix_millis().saturating_sub(received_at.unix_millis());
    let _ = db
        .run(move |c| {
            let mut state = playback::get(c)?;
            let old = state.server_clock_offset_ms.unwrap_or_default();
            let stale = state
                .server_clock_synchronized_at
                .is_none_or(|at| received_at.unix_millis() - at.unix_millis() > 300_000);
            if state.server_clock_offset_ms.is_none() || old.abs_diff(offset) >= 250 || stale {
                state.server_clock_offset_ms = Some(offset);
                state.server_clock_synchronized_at = Some(received_at);
                playback::put(c, &state, received_at)?;
            }
            Ok(())
        })
        .await;
}

fn server_retry(error: &ServerError) -> LinkState {
    match error {
        ServerError::IdentityMismatch { .. } => LinkState::IdentityMismatch,
        ServerError::CredentialRejected => LinkState::CredentialRejected,
        other => LinkState::Retrying(other.reason_code()),
    }
}

async fn reject_credential(context: &DaemonContext) {
    tracing::warn!(component = "server", event = "credential_rejected");
    if let Some(db) = context.db() {
        let now = context.now();
        let _ = db.run(move |c| binding::set_credential_state(c, CredentialState::Rejected, now)).await;
    }
    let _ = DeviceCredential::remove(&context.paths.identity_dir());
}

/// Manifest work runs off the server-link socket loop so a large download
/// cannot delay ping/pong, contact, or revocation handling.
async fn sync_manifest(context: &DaemonContext, server: &AuthenticatedServer, binding: ManifestBinding) {
    let (Some(db), Some(cas)) = (context.db(), context.cas.as_ref()) else { return };
    let pending_binding = binding.clone();
    let pending = db.run(move |c| manifests::get_for(c, Stage::Pending, &pending_binding)).await;
    let active_binding = binding.clone();
    let active = db.run(move |c| manifests::get_for(c, Stage::Active, &active_binding)).await;
    let (Ok(pending), Ok(active)) = (pending, active) else {
        tracing::warn!(component = "manifest", event = "cached_state_unavailable");
        return;
    };
    let mut etag = active.as_ref().map(|stored| stored.etag.as_str());
    if let Some(stored) = &pending {
        match Candidate::parse(stored.document.clone(), binding.screen_id) {
            Ok(candidate) => match manifest::prepare(context, server, &candidate).await {
                Ok(digests) => {
                    if cas.replace_pins(PinReason::PendingPresentation, "server-manifest", digests).await.is_ok() {
                        etag = Some(&stored.etag);
                    }
                }
                Err(error) => {
                    tracing::warn!(component = "manifest", event = "pending_repair_failed", error = %error);
                }
            },
            Err(error) => tracing::warn!(component = "manifest", event = "pending_invalid", error = %error),
        }
    }
    let fetched = match server.player_manifest(etag).await {
        Ok(result) => result,
        Err(ServerError::CredentialRejected) => {
            reject_credential(context).await;
            return;
        }
        Err(error) => {
            tracing::warn!(component = "manifest", event = "fetch_failed", reason = error.reason_code());
            return;
        }
    };
    let ManifestFetch::Modified { document, etag } = fetched else { return };
    let candidate = match Candidate::parse(document, binding.screen_id) {
        Ok(candidate) => candidate,
        Err(error) => {
            tracing::warn!(component = "manifest", event = "candidate_invalid", error = %error);
            return;
        }
    };
    let digests = match manifest::prepare(context, server, &candidate).await {
        Ok(digests) => digests,
        Err(error) => {
            tracing::warn!(component = "manifest", event = "preparation_failed", error = %error);
            return;
        }
    };
    let stored = StoredManifest {
        binding,
        version: candidate.version,
        etag,
        document: candidate.document,
        stored_at: context.now(),
    };
    let expected_binding = stored.binding.clone();
    let still_bound = db
        .run(move |c| {
            Ok(binding::get(c)?.is_some_and(|current| {
                current.credential_state == CredentialState::Stored
                    && current.installation_id == expected_binding.installation_id
                    && current.screen_id == Some(expected_binding.screen_id)
                    && current.server_url == expected_binding.server_url
            }))
        })
        .await
        .unwrap_or(false);
    if !still_bound {
        return;
    }
    if let Err(error) = db.run(move |c| manifests::put_pending(c, &stored)).await {
        tracing::warn!(component = "manifest", event = "pending_persist_failed", reason = error.reason_code());
        return;
    }
    if let Err(error) = cas.replace_pins(PinReason::PendingPresentation, "server-manifest", digests).await {
        tracing::warn!(component = "manifest", event = "pending_pin_failed", error = %error);
        return;
    }
    tracing::info!(component = "manifest", event = "prepared", version = candidate.version);
}

async fn pass(context: &Arc<DaemonContext>, link: &mut Link) -> LinkState {
    let (Some(db), Some(node_id)) = (context.db(), context.node_id) else {
        return LinkState::Unbound;
    };
    let Ok(Some(bound)) = db.run(|c| binding::get(c)).await else {
        return LinkState::Unbound;
    };
    if bound.credential_state == CredentialState::Rejected {
        return LinkState::CredentialRejected;
    }
    let credential = match DeviceCredential::load(&context.paths.identity_dir()) {
        Ok(Some(credential)) => credential,
        Ok(None) => return LinkState::CredentialMissing,
        Err(error) => {
            tracing::error!(component = "server", event = "credential_unreadable", error = %error);
            return LinkState::CredentialMissing;
        }
    };
    let server = match ServerClient::new(&bound.server_url) {
        Ok(client) => match client.verify_installation(bound.installation_id, credential).await {
            Ok(server) => server,
            Err(error) => {
                if matches!(error, ServerError::IdentityMismatch { .. }) {
                    tracing::error!(component = "server", event = "identity_mismatch", error = %error);
                }
                return server_retry(&error);
            }
        },
        Err(error) => return server_retry(&error),
    };
    let now = context.now();
    let _ = db.run(move |c| binding::mark_identity_verified(c, now)).await;

    if link.socket.is_none() && link.next_socket_attempt.is_none_or(|next| Instant::now() >= next) {
        match server.player_socket(VERSION).await {
            Ok(socket) => {
                link.socket = Some(socket);
                link.socket_activity();
                link.socket_failures = 0;
                link.next_socket_attempt = None;
            }
            Err(error) => {
                tracing::warn!(component = "server", event = "player_socket_failed", reason = error.reason_code());
                link.socket_lost();
            }
        }
    }
    if now.unix_millis() >= link.next_heartbeat_ms {
        let heartbeat = build_heartbeat(context).await;
        let socket_sent = if let Some(socket) = link.socket.as_mut() {
            socket.send_status(&heartbeat, VERSION).await.is_ok()
        } else {
            false
        };
        if !socket_sent && link.socket.is_some() {
            link.socket_lost();
        }
        let sent = if socket_sent { Ok(()) } else { server.player_heartbeat(&heartbeat).await };
        match sent {
            Ok(()) => link.next_heartbeat_ms = now.unix_millis() + HEARTBEAT_INTERVAL.as_millis() as i64,
            Err(ServerError::CredentialRejected) => {
                reject_credential(context).await;
                return LinkState::CredentialRejected;
            }
            Err(error) => return server_retry(&error),
        }
    }
    if server.has_secure_edge_bootstrap() {
        if let Err(state) = ensure_certificate(context, &server, node_id).await {
            return state;
        }
        match reconcile(context, &server).await {
            Ok(changed) => link.manifest_dirty |= changed,
            Err(state) => return state,
        }
    }
    if let Some(screen_id) = bound.screen_id
        && link.manifest_task.is_none()
        && (link.manifest_dirty || link.next_manifest_attempt.is_none_or(|next| Instant::now() >= next))
    {
        link.manifest_dirty = false;
        link.next_manifest_attempt = Some(Instant::now() + MANIFEST_INTERVAL);
        let binding =
            ManifestBinding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url };
        let worker_context = Arc::clone(context);
        let worker_server = server.clone();
        link.manifest_task = Some(tokio::spawn(async move {
            tokio::select! {
                () = worker_context.shutdown.cancelled() => {},
                () = sync_manifest(&worker_context, &worker_server, binding) => {},
            }
        }));
    }
    if now.unix_millis() >= link.next_status_ms {
        match report_status(context, &server).await {
            Ok(()) => link.next_status_ms = now.unix_millis() + STATUS_INTERVAL.as_millis() as i64,
            Err(ServerError::CredentialRejected) => {
                reject_credential(context).await;
                return LinkState::CredentialRejected;
            }
            Err(error) => {
                tracing::warn!(component = "server", event = "status_report_failed", reason = error.reason_code());
            }
        }
    }
    if server.has_secure_edge_bootstrap() { LinkState::Connected } else { LinkState::ConnectedWithoutEdgeTrust }
}

/// Normal player presence is reported independently of Edge operational status.
async fn build_heartbeat(context: &DaemonContext) -> serde_json::Value {
    let (renderer, current) = {
        let presentation = context.presentation.lock().await;
        (presentation.status(), presentation.current().cloned())
    };
    let healthy = renderer.state.as_str() == "healthy"
        && current.as_ref().is_some_and(|active| active.source != crate::presentation::ActivationSource::StatusSurface);
    let uptime = ((context.now().unix_millis() - context.started_at.unix_millis()).max(0) / 1000) as u64;
    let mut heartbeat = serde_json::json!({
        "screenWidth": 0,
        "screenHeight": 0,
        "playerVersion": VERSION,
        "uptimeSeconds": uptime,
        "playbackState": if healthy { "playing" } else { "idle" },
        "safeMode": renderer.state.as_str() == "safe_mode",
        "presentationSchemaVersions": [1],
    });
    if healthy && let Some(progress_at) = renderer.last_progress_at {
        heartbeat["lastHealthyPlaybackAt"] = serde_json::Value::String(progress_at.to_string());
    }
    if let Ok(available) = edge_platform::disk::available_bytes(&context.paths.state_dir) {
        heartbeat["availableStorageBytes"] = serde_json::json!(available);
    }
    if let Some(cas) = &context.cas
        && let Ok(usage) = cas.usage().await
    {
        heartbeat["cacheUsedBytes"] = serde_json::json!(usage.used_bytes);
        heartbeat["cacheLimitBytes"] = serde_json::json!(cas.policy().limit_bytes);
    }
    if let Some(db) = context.db()
        && let Ok(state) = db.run(|c| playback::get(c)).await
    {
        heartbeat["playbackDisabled"] = serde_json::json!(state.playback_disabled);
        if let Some(offset) = state.server_clock_offset_ms {
            heartbeat["deviceClockOffsetSeconds"] = serde_json::json!(offset / 1000);
        }
    }
    heartbeat
}

async fn ensure_certificate(
    context: &DaemonContext,
    server: &AuthenticatedServer,
    node_id: edge_protocol::NodeId,
) -> Result<(), LinkState> {
    let db = context.db().ok_or(LinkState::Unbound)?;
    let now = context.now();
    let active = db.run(|c| identity::active_certificate(c)).await.map_err(|_| LinkState::Retrying("state_error"))?;
    let due = match &active {
        None => true,
        Some(certificate) => !matches!(renewal::decide(now, certificate.not_after), RenewalDecision::WaitUntil(_)),
    };
    if !due {
        return Ok(());
    }
    match enroll(server, db, &context.paths.identity_dir(), node_id, &context.revocations, now).await {
        Ok(enrolled) => {
            tracing::info!(
                component = "identity",
                event = if active.is_some() { "certificate_renewed" } else { "enrolled" },
                not_after = %enrolled.certificate.not_after
            );
            Ok(())
        }
        Err(EnrollError::Server(ServerError::CredentialRejected)) => {
            reject_credential(context).await;
            Err(LinkState::CredentialRejected)
        }
        Err(error) => {
            tracing::warn!(component = "identity", event = "enrollment_failed", reason = error.reason_code(), error = %error);
            // A renewal failure with a still-valid certificate is not an
            // outage: keep going with the current one.
            if active.is_some_and(|c| c.not_after > now) {
                Ok(())
            } else {
                Err(LinkState::Retrying(error.reason_code()))
            }
        }
    }
}

async fn reconcile(context: &DaemonContext, server: &AuthenticatedServer) -> Result<bool, LinkState> {
    let db = context.db().ok_or(LinkState::Unbound)?;
    let mut feed = context.feed.lock().await;
    if feed.is_none() {
        let trust = db.run(|c| identity::get_trust(c)).await.map_err(|_| LinkState::Retrying("state_error"))?;
        let Some(trust) = trust else { return Err(LinkState::Retrying("edge_not_enrolled")) };
        let authority = AuthorityTrust { installation_id: trust.installation_id, keys: trust.authority_keys };
        *feed = Some(FeedApplier::new(db.clone(), authority, context.revocations.clone()));
    }
    let Some(applier) = feed.as_mut() else { return Ok(false) };
    match applier.reconcile(server, context.now()).await {
        Ok(report) => {
            if report.applied > 0 || !report.wakes.is_empty() {
                tracing::info!(
                    component = "feed",
                    event = "reconciled",
                    applied = report.applied,
                    last_sequence = report.last_sequence,
                    resynced = report.wakes.contains(&Wake::Resynced)
                );
            }
            Ok(report.wakes.iter().any(|wake| {
                matches!(
                    wake,
                    Wake::Resynced | Wake::Change(edge_protocol::signed::change::ChangeType::ScreenPresentationChanged)
                )
            }))
        }
        Err(FeedError::Server(ServerError::CredentialRejected)) => {
            reject_credential(context).await;
            Err(LinkState::CredentialRejected)
        }
        Err(error @ FeedError::Conflict(_)) => {
            // An authority fault; keep the position and surface it loudly.
            tracing::error!(component = "feed", event = "authority_conflict", error = %error);
            Err(LinkState::Retrying(error.reason_code()))
        }
        Err(error) => {
            tracing::warn!(component = "feed", event = "reconcile_failed", reason = error.reason_code(), error = %error);
            Err(LinkState::Retrying(error.reason_code()))
        }
    }
}

/// `POST /player/edge/status`: versions, renderer and mesh state, cache
/// usage and the capability snapshot. Bounded and secret-free.
async fn report_status(context: &DaemonContext, server: &AuthenticatedServer) -> Result<(), ServerError> {
    let (Some(db), Some(node_id)) = (context.db(), context.node_id) else { return Ok(()) };
    let stored = db.run(|c| capabilities::load(c)).await.ok().flatten();
    let Some(stored) = stored else { return Ok(()) };
    let (renderer_state, renderer_version) = {
        let presentation = context.presentation.lock().await;
        (presentation.status().state.as_str().to_owned(), presentation.renderer_version())
    };
    let cache =
        match &context.cas {
            Some(cas) => cas.usage().await.ok().map(
                |usage| serde_json::json!({"usedBytes": usage.used_bytes, "limitBytes": cas.policy().limit_bytes}),
            ),
            None => None,
        };
    let (mesh_state, peer_count) = {
        let mesh = context.mesh_state.lock().unwrap_or_else(|e| e.into_inner());
        (mesh.state, mesh.peers)
    };
    let mut status = serde_json::json!({
        "schemaVersion": 1,
        "edgeVersion": VERSION,
        "nodeId": node_id.to_string(),
        "renderer": {"kind": "wpe", "state": renderer_state},
        "mesh": {"state": mesh_state, "peerCount": peer_count},
        "capabilities": serde_json::to_value(&stored.snapshot).unwrap_or_default(),
    });
    if let Some(version) = renderer_version {
        status["renderer"]["version"] = serde_json::Value::String(version.as_str().to_owned());
    }
    if let Some(cache) = cache {
        status["cache"] = cache;
    }
    server.edge_status(&status).await?;
    let revision = stored.snapshot.revision;
    let _ = db.run(move |c| capabilities::mark_reported(c, revision)).await;
    Ok(())
}

/// Rebuilds the in-memory revocation set from state at startup.
pub fn load_revocations(db: &edge_state::StateDb, now: Timestamp) -> edge_identity::RevocationSet {
    let set = edge_identity::RevocationSet::new();
    if let Ok(entries) = db.run_blocking(|c| identity::revocation_entries(c)) {
        for (node, generation, forget_after) in entries {
            if forget_after > now {
                set.revoke(node, forget_after, generation);
            }
        }
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_liveness_deadline_tracks_inbound_activity_and_clears_on_loss() {
        let mut link = Link::default();
        assert_eq!(link.socket_liveness_remaining(), SOCKET_LIVENESS_TIMEOUT);

        link.last_socket_activity = Some(Instant::now() - Duration::from_secs(30));
        let remaining = link.socket_liveness_remaining();
        assert!(remaining <= Duration::from_secs(65));
        assert!(remaining > Duration::from_secs(64));

        link.socket_lost();
        assert_eq!(link.last_socket_activity, None);
        assert_eq!(link.socket_liveness_remaining(), SOCKET_LIVENESS_TIMEOUT);
    }
}
