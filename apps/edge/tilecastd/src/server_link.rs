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
//! 3. Enrolls, or renews when fewer than 30 days remain, with a key this
//!    daemon generates. The Edge private key never leaves this process.
//! 4. Reconciles the signed change feed.
//! 5. Posts the bounded Edge status on a low cadence.
//!
//! The credential is deleted only when the server says it is invalid or
//! revoked (the legacy player's rule); network errors, 5xx and disabled
//! screens retry with backoff. Playback never waits for this task.

use std::sync::Arc;
use std::time::Duration;

use edge_identity::renewal::{self, RenewalDecision};
use edge_protocol::Timestamp;
use edge_protocol::signed::change::AuthorityTrust;
use edge_server::client::{ServerClient, ServerError};
use edge_server::enrollment::{EnrollError, enroll};
use edge_server::feed::{FeedApplier, FeedError, Wake};
use edge_server::{AuthenticatedServer, DeviceCredential};
use edge_state::repo::binding::{self, CredentialState};
use edge_state::repo::{capabilities, identity};

use crate::daemon::{DaemonContext, VERSION};

/// Feed reconciliation cadence without a mesh wake-up (RFC §12.3).
pub const RECONCILE_INTERVAL: Duration = Duration::from_secs(60);
pub const STATUS_INTERVAL: Duration = Duration::from_secs(300);
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
            Self::Retrying(code) => Some(code),
        }
    }
}

#[derive(Debug, Default)]
struct Link {
    next_status_ms: i64,
    failures: u32,
}

pub async fn run(context: Arc<DaemonContext>) {
    let mut link = Link::default();
    loop {
        let state = pass(&context, &mut link).await;
        let delay = match &state {
            LinkState::Connected => {
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
        *context.link_state.lock().unwrap_or_else(|e| e.into_inner()) = state;
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = tokio::time::sleep(delay) => {}
            () = context.server_wake.notified() => {}
        }
    }
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

async fn pass(context: &DaemonContext, link: &mut Link) -> LinkState {
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

    if let Err(state) = ensure_certificate(context, &server, node_id).await {
        return state;
    }
    if let Err(state) = reconcile(context, &server).await {
        return state;
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
    LinkState::Connected
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

async fn reconcile(context: &DaemonContext, server: &AuthenticatedServer) -> Result<(), LinkState> {
    let db = context.db().ok_or(LinkState::Unbound)?;
    let mut feed = context.feed.lock().await;
    if feed.is_none() {
        let trust = db.run(|c| identity::get_trust(c)).await.map_err(|_| LinkState::Retrying("state_error"))?;
        let Some(trust) = trust else { return Err(LinkState::Retrying("edge_not_enrolled")) };
        let authority = AuthorityTrust { installation_id: trust.installation_id, keys: trust.authority_keys };
        *feed = Some(FeedApplier::new(db.clone(), authority, context.revocations.clone()));
    }
    let Some(applier) = feed.as_mut() else { return Ok(()) };
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
            // Subsystems that own the hinted state (manifest, commands,
            // configuration) subscribe here as they move into tilecastd.
            Ok(())
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
