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
//! 3. Holds the ordinary player WebSocket and sends status on it, falling
//!    back to `POST /player/heartbeat` while the socket is unavailable. A
//!    server ping samples the clock and is answered; pushes only wake the
//!    next reconciliation.
//! 4. Reconciles the manifest through the ordinary manifest endpoint
//!    (`manifest_sync`) and keeps one abortable preparation on its target.
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
use std::time::{Duration, Instant};

use edge_protocol::Timestamp;
use edge_server::client::{PLAYER_SOCKET_ACTIVITY_TIMEOUT, PlayerSocket, PlayerSocketEvent, ServerClient, ServerError};
use edge_server::{AuthenticatedServer, DeviceCredential};
use edge_state::repo::binding::{self, CredentialState};
use edge_state::repo::manifests::{self, Binding as ManifestBinding, Stage, Target};
use edge_state::repo::playback;

use crate::daemon::{DaemonContext, VERSION};
use crate::manifest::OriginSources;
use crate::manifest_sync::{self, PreparationStatus, Prepared};

/// Contact and reconciliation cadence while connected (the reference
/// player's heartbeat interval).
pub const CONTACT_INTERVAL: Duration = Duration::from_secs(60);
/// Manifest reconciliation without a push (the reference player's
/// `RECONCILE_INTERVAL_MS`).
pub const MANIFEST_INTERVAL: Duration = Duration::from_secs(300);
/// Re-check cadence while there is nothing to do (unbound, rejected).
pub const IDLE_INTERVAL: Duration = Duration::from_secs(300);
/// Retry delays grow to this ceiling while the server is unreachable.
pub const MAX_RETRY_INTERVAL: Duration = Duration::from_secs(300);
pub const SOCKET_LIVENESS_TIMEOUT: Duration = PLAYER_SOCKET_ACTIVITY_TIMEOUT;

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
    next_heartbeat: Option<Instant>,
    socket: Option<PlayerSocket>,
    socket_failures: u32,
    next_socket_attempt: Option<Instant>,
    last_socket_activity: Option<Instant>,
    next_manifest_sync: Option<Instant>,
    manifest_dirty: bool,
    /// The one preparation in flight and the manifest it prepares.
    preparation: Option<(edge_protocol::Sha256Digest, tokio::task::JoinHandle<()>)>,
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

    fn abort_preparation(&mut self) {
        if let Some((_, task)) = self.preparation.take() {
            task.abort();
        }
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    let mut link = Link::default();
    loop {
        if link.preparation.as_ref().is_some_and(|(_, task)| task.is_finished())
            && let Some((_, task)) = link.preparation.take()
        {
            let _ = task.await;
        }
        let state = pass(&context, &mut link).await;
        let mut delay = match &state {
            LinkState::Connected => {
                link.failures = 0;
                CONTACT_INTERVAL
            }
            LinkState::Retrying(_) => {
                link.failures = link.failures.saturating_add(1);
                retry_delay(link.failures)
            }
            _ => {
                link.abort_preparation();
                IDLE_INTERVAL
            }
        };
        if state == LinkState::Connected
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
            let Some(socket) = link.socket.as_mut() else {
                tokio::select! {
                    () = context.shutdown.cancelled() => return,
                    () = &mut deadline => break,
                    () = context.server_wake.notified() => {
                        link.manifest_dirty = true;
                        break;
                    }
                }
            };
            tokio::select! {
                () = context.shutdown.cancelled() => return,
                () = &mut deadline => break,
                () = context.server_wake.notified() => {
                    link.manifest_dirty = true;
                    break;
                }
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
        }
    }
}

/// Stores the server clock offset from a socket ping, as the reference
/// player's `core/clock.ts` does, so a restart without the server still
/// schedules at the corrected time.
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

fn set_preparation(
    context: &DaemonContext,
    target: Option<edge_protocol::Sha256Digest>,
    state: &'static str,
    reason: Option<String>,
) {
    *context.preparation.lock().unwrap_or_else(|e| e.into_inner()) = PreparationStatus { target, state, reason };
}

/// Keeps exactly one preparation running, on the target. A newer target
/// aborts an obsolete preparation; its CAS partials stay resumable and the
/// pending write re-checks the target.
async fn ensure_preparation(
    context: &Arc<DaemonContext>,
    link: &mut Link,
    server: &AuthenticatedServer,
    target: Option<Target>,
) {
    let Some(target) = target else {
        link.abort_preparation();
        return;
    };
    let digest = target.digest;
    if link.preparation.as_ref().is_some_and(|(running, _)| *running == digest) {
        return;
    }
    link.abort_preparation();
    let Some(db) = context.db() else { return };
    for stage in [Stage::Active, Stage::Pending] {
        let stage_binding = target.binding.clone();
        if db
            .run(move |c| manifests::get_for(c, stage, &stage_binding))
            .await
            .ok()
            .flatten()
            .is_some_and(|stored| stored.digest == digest)
        {
            return;
        }
    }
    // A deterministic rejection of this exact manifest is not retried.
    let known_final = {
        let status = context.preparation.lock().unwrap_or_else(|e| e.into_inner());
        status.target == Some(digest) && matches!(status.state, "incompatible" | "invalid")
    };
    if known_final {
        return;
    }
    set_preparation(context, Some(digest), "preparing", None);
    let worker_context = Arc::clone(context);
    let worker_server = server.clone();
    let task = tokio::spawn(async move {
        let plan = OriginSources { server: &worker_server };
        let result = tokio::select! {
            () = worker_context.shutdown.cancelled() => return,
            result = manifest_sync::prepare_target(&worker_context, &plan, &target) => result,
        };
        match result {
            Ok(Prepared::Current) => set_preparation(&worker_context, Some(digest), "current", None),
            Ok(Prepared::Pending) => set_preparation(&worker_context, Some(digest), "pending", None),
            Ok(Prepared::Superseded) => set_preparation(&worker_context, Some(digest), "superseded", None),
            Err(error) => {
                let state = match &error {
                    manifest_sync::PrepareError::Manifest(crate::manifest::ManifestError::Incompatible(_)) => {
                        "incompatible"
                    }
                    error if error.is_final() => "invalid",
                    _ => "failed",
                };
                tracing::warn!(
                    component = "manifest",
                    event = "preparation_failed",
                    manifest = %digest.short(),
                    state,
                    reason = error.reason_code(),
                    error = %error
                );
                set_preparation(&worker_context, Some(digest), state, Some(error.reason_code().to_owned()));
            }
        }
    });
    link.preparation = Some((digest, task));
}

async fn sync_manifest(
    context: &Arc<DaemonContext>,
    link: &mut Link,
    server: &AuthenticatedServer,
    binding: ManifestBinding,
) -> Result<(), LinkState> {
    match manifest_sync::reconcile(context, server, &binding).await {
        Ok(target) => {
            ensure_preparation(context, link, server, target).await;
            context.manifest_wake.notify_one();
            Ok(())
        }
        Err(manifest_sync::SyncError::Server(ServerError::CredentialRejected)) => {
            reject_credential(context).await;
            Err(LinkState::CredentialRejected)
        }
        Err(error) => {
            // Nothing already accepted is lost; the player keeps its committed
            // presentation. A preparation for the persisted target continues.
            tracing::warn!(component = "manifest", event = "reconcile_failed", reason = error.reason_code(), error = %error);
            if !matches!(error, manifest_sync::SyncError::Server(_)) {
                set_preparation(context, None, "invalid", Some(error.reason_code().to_owned()));
            }
            let persisted = manifest_sync::persisted_target(context, &binding).await;
            ensure_preparation(context, link, server, persisted).await;
            Ok(())
        }
    }
}

async fn pass(context: &Arc<DaemonContext>, link: &mut Link) -> LinkState {
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
                link.socket = None;
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
    if link.next_heartbeat.is_none_or(|next| Instant::now() >= next) {
        let heartbeat = build_heartbeat(context).await;
        let socket_sent = match link.socket.as_mut() {
            Some(socket) => socket.send_status(&heartbeat, VERSION).await.is_ok(),
            None => false,
        };
        if !socket_sent && link.socket.is_some() {
            link.socket_lost();
        }
        let sent = if socket_sent { Ok(()) } else { server.player_heartbeat(&heartbeat).await };
        match sent {
            Ok(()) => {
                link.next_heartbeat = Some(Instant::now() + CONTACT_INTERVAL);
                *context.last_server_contact.lock().unwrap_or_else(|e| e.into_inner()) = Some(context.now());
            }
            Err(ServerError::CredentialRejected) => {
                reject_credential(context).await;
                return LinkState::CredentialRejected;
            }
            Err(error) => return server_retry(&error),
        }
    }
    if let Some(screen_id) = bound.screen_id
        && (link.manifest_dirty || link.next_manifest_sync.is_none_or(|next| Instant::now() >= next))
    {
        link.manifest_dirty = false;
        link.next_manifest_sync = Some(Instant::now() + MANIFEST_INTERVAL);
        let binding =
            ManifestBinding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url.clone() };
        if let Err(state) = sync_manifest(context, link, &server, binding).await {
            return state;
        }
    }
    LinkState::Connected
}

/// The heartbeat `currentItemId` for a renderer item key: playlist items
/// carry their manifest UUID, a directly shown Layout's key is translated back
/// to the Layout UUID, and anything else is omitted rather than sent, because
/// the server rejects a whole heartbeat over one malformed identifier
/// (reference: `core/identifiers.ts`).
pub fn heartbeat_item_id(key: &str) -> Option<String> {
    let candidate = key.strip_prefix("layout-").unwrap_or(key);
    edge_protocol::ids::parse_canonical_uuid(candidate).ok().map(|id| id.to_string())
}

fn iso(ms: i64) -> Option<String> {
    Timestamp::from_unix_millis(ms).map(|at| at.to_string())
}

/// Ordinary player status, sent on the socket or as the fallback heartbeat.
/// Playback identifiers have the reference Linux player's meaning: the
/// committed and pending manifest versions, and what the renderer is actually
/// showing and why.
async fn build_heartbeat(context: &DaemonContext) -> serde_json::Value {
    let (renderer, current, current_item) = {
        let presentation = context.presentation.lock().await;
        (presentation.status(), presentation.current().cloned(), presentation.current_item())
    };
    let healthy = renderer.state.as_str() == "healthy"
        && current.as_ref().is_some_and(|active| active.source != crate::presentation::ActivationSource::StatusSurface);
    let uptime = ((context.now().unix_millis() - context.started_at.unix_millis()).max(0) / 1000) as u64;
    let native: serde_json::Map<String, serde_json::Value> = crate::manifest::profile::NATIVE_CAPABILITIES
        .iter()
        .map(|(name, version)| ((*name).to_owned(), serde_json::json!(version)))
        .collect();
    let mut heartbeat = serde_json::json!({
        "screenWidth": 0,
        "screenHeight": 0,
        "playerVersion": VERSION,
        "uptimeSeconds": uptime,
        "playbackState": if healthy { "playing" } else { "idle" },
        "safeMode": renderer.state.as_str() == "safe_mode",
        "presentationSchemaVersions": [1],
        "nativePresentationCapabilities": native,
        "webRuntimeVersion": crate::manifest::profile::WEB_RUNTIME_VERSION,
    });
    if let Some(progress_at) = renderer.last_progress_at {
        heartbeat["lastMeaningfulProgressAt"] = serde_json::Value::String(progress_at.to_string());
        if healthy {
            heartbeat["lastHealthyPlaybackAt"] = serde_json::Value::String(progress_at.to_string());
        }
    }
    if let Some(identity) = current.as_ref().and_then(|activation| activation.identity.as_ref()) {
        heartbeat["selectionSource"] = serde_json::json!(identity.selection_source);
        if let Some(playlist) = identity.playlist_id {
            heartbeat["currentPlaylistId"] = serde_json::json!(playlist.to_string());
        }
        if let Some(schedule) = identity.schedule_id {
            heartbeat["currentScheduleId"] = serde_json::json!(schedule.to_string());
        }
        if let Some(takeover) = identity.takeover_id {
            heartbeat["activeTakeoverId"] = serde_json::json!(takeover.to_string());
            heartbeat["takeoverState"] = serde_json::json!("active");
        }
        if let Some(next) = identity.next_transition_ms.and_then(iso) {
            heartbeat["nextTransitionAt"] = serde_json::json!(next);
        }
        if let Some((item, started_at)) = current_item.as_ref()
            && let Some(item) = heartbeat_item_id(item)
        {
            heartbeat["currentItemId"] = serde_json::json!(item);
            heartbeat["currentItemStartedAt"] = serde_json::json!(started_at.to_string());
        }
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
    if let Some(db) = context.db() {
        if let Ok(state) = db.run(|c| playback::get(c)).await {
            heartbeat["playbackDisabled"] = serde_json::json!(state.playback_disabled);
            if let Some(offset) = state.server_clock_offset_ms {
                heartbeat["deviceClockOffsetSeconds"] = serde_json::json!(offset / 1000);
            }
        }
        if let Ok(Some(bound)) = db.run(|c| binding::get(c)).await
            && let Some(screen_id) = bound.screen_id
        {
            let binding =
                ManifestBinding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url };
            for (stage, field) in [(Stage::Active, "activeManifestVersion"), (Stage::Pending, "pendingManifestVersion")]
            {
                let stage_binding = binding.clone();
                if let Ok(Some(stored)) = db.run(move |c| manifests::get_for(c, stage, &stage_binding)).await {
                    heartbeat[field] = serde_json::json!(stored.version);
                }
            }
        }
    }
    let preparation = context.preparation.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(reason) =
        preparation.reason.filter(|_| matches!(preparation.state, "failed" | "incompatible" | "invalid"))
    {
        heartbeat["lastSynchronizationError"] = serde_json::json!(reason.chars().take(240).collect::<String>());
    }
    heartbeat
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

    #[test]
    fn heartbeat_item_ids_are_uuids_or_absent() {
        let item = "ca48c671-8e48-4bad-ab75-6125064d0f5c";
        assert_eq!(heartbeat_item_id(item).as_deref(), Some(item));
        assert_eq!(heartbeat_item_id(&format!("layout-{item}")).as_deref(), Some(item));
        assert_eq!(heartbeat_item_id("item-image"), None);
        assert_eq!(heartbeat_item_id("layout-not-a-uuid"), None);
        assert_eq!(heartbeat_item_id(&item.to_uppercase()), None);
    }

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
