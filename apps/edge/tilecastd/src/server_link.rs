//! The daemon's link to the Tilecast Server.
//!
//! One task, one owner of the device credential. Each pass:
//!
//! 1. Requires a server binding and the stored credential (from pairing or
//!    the one-time legacy import). Without them the player is idle: nothing
//!    is sent anywhere.
//! 2. Reads public installation identity and requires the bound
//!    installation ID before the credential is sent (the identity gate is a
//!    type in `edge_server::client`). A mismatch stops the link until an
//!    explicit reset; the credential is never sent to the other server.
//! 3. Makes ordinary player contact (`POST /player/heartbeat`), the same
//!    authenticated path every Tilecast player uses. The server computes
//!    screen status from it; nothing Edge-specific is reported.
//!
//! The server is the only authority, and this task is the only way its
//! state reaches the player. Playback never waits for it: while the server
//! is unreachable the player keeps showing already-reconciled local state
//! from SQLite and the content store.
//!
//! The credential is deleted only when the server says it is invalid or
//! revoked (the legacy player's rule); network errors, 5xx and disabled
//! screens retry with backoff.

use std::sync::Arc;
use std::time::Duration;

use edge_server::client::{ServerClient, ServerError};
use edge_server::{AuthenticatedServer, DeviceCredential};
use edge_state::repo::binding::{self, CredentialState};

use crate::daemon::{DaemonContext, VERSION};

/// Contact cadence while connected.
pub const CONTACT_INTERVAL: Duration = Duration::from_secs(60);
/// Re-check cadence while there is nothing to do (unbound, rejected).
pub const IDLE_INTERVAL: Duration = Duration::from_secs(300);
/// Retry delays grow to this ceiling while the server is unreachable.
pub const MAX_RETRY_INTERVAL: Duration = Duration::from_secs(300);

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
    /// `unbound`, `connected`, `retrying` or `stopped` (needs an operator).
    pub fn state_token(&self) -> &'static str {
        match self {
            Self::Unbound => "unbound",
            Self::Connected => "connected",
            Self::Retrying(_) => "retrying",
            Self::CredentialMissing | Self::CredentialRejected | Self::IdentityMismatch => "stopped",
        }
    }

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

/// 15 s, 30 s, 45 s, then doubling from one minute up to the ceiling.
pub fn retry_delay(failures: u32) -> Duration {
    if failures <= 3 {
        return Duration::from_secs(15 * u64::from(failures.max(1)));
    }
    let doubled = 60u64.saturating_mul(1u64 << (failures - 4).min(8));
    Duration::from_secs(doubled).min(MAX_RETRY_INTERVAL)
}

#[derive(Debug, Default)]
struct Link {
    failures: u32,
}

pub async fn run(context: Arc<DaemonContext>) {
    let mut link = Link::default();
    loop {
        let state = pass(&context).await;
        let delay = match &state {
            LinkState::Connected => {
                link.failures = 0;
                CONTACT_INTERVAL
            }
            LinkState::Retrying(_) => {
                link.failures = link.failures.saturating_add(1);
                retry_delay(link.failures)
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

async fn pass(context: &DaemonContext) -> LinkState {
    let Some(db) = context.db() else {
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

    match contact(context, &server).await {
        Ok(()) => {
            *context.last_server_contact.lock().unwrap_or_else(|e| e.into_inner()) = Some(context.now());
            LinkState::Connected
        }
        Err(ServerError::CredentialRejected) => {
            reject_credential(context).await;
            LinkState::CredentialRejected
        }
        Err(error) => server_retry(&error),
    }
}

/// The minimal bounded heartbeat. It carries only facts this daemon knows
/// directly; playback fields join as tilecastd takes over manifests.
async fn contact(context: &DaemonContext, server: &AuthenticatedServer) -> Result<(), ServerError> {
    let uptime = (context.now().unix_millis() - context.started_at.unix_millis()).max(0) / 1000;
    let mut heartbeat = serde_json::json!({
        "screenWidth": 0,
        "screenHeight": 0,
        "playerVersion": VERSION,
        "uptimeSeconds": uptime,
    });
    if let Ok(available) = edge_platform::disk::available_bytes(&context.paths.state_dir) {
        heartbeat["availableStorageBytes"] = serde_json::json!(available);
    }
    if let Some(cas) = &context.cas
        && let Ok(usage) = cas.usage().await
    {
        heartbeat["cacheUsedBytes"] = serde_json::json!(usage.used_bytes);
        heartbeat["cacheLimitBytes"] = serde_json::json!(cas.policy().limit_bytes);
    }
    server.player_heartbeat(&heartbeat).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_grows_to_the_ceiling() {
        assert_eq!(retry_delay(1), Duration::from_secs(15));
        assert_eq!(retry_delay(3), Duration::from_secs(45));
        assert_eq!(retry_delay(4), Duration::from_secs(60));
        assert_eq!(retry_delay(5), Duration::from_secs(120));
        assert_eq!(retry_delay(40), MAX_RETRY_INTERVAL);
    }

    #[test]
    fn stopped_states_name_their_reason() {
        assert_eq!(LinkState::Connected.state_token(), "connected");
        assert_eq!(LinkState::Connected.reason_code(), None);
        assert_eq!(LinkState::IdentityMismatch.state_token(), "stopped");
        assert_eq!(LinkState::Retrying("server_unreachable").reason_code(), Some("server_unreachable"));
    }
}
