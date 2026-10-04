//! Native server socket ownership, fallback contact, and reconciliation cadence.
use crate::{
    ActivityEvent, ConfigurationCoordinator, ConfigurationHost, Dependencies, LiveFrame, ManifestCoordinator,
    ManifestPreparationCoordinator, ManifestPreparationStatus, ManifestSyncError, ManifestWorkerHost,
    NativeConfiguration, ServerBackoff as Backoff, ServerLinkState as LinkState, ServerLinkState, ServerRelationship,
    SharedManifestPreparationStatus,
};
use player_client::client::{PLAYER_SOCKET_ACTIVITY_TIMEOUT, PlayerSocket, PlayerSocketEvent};
use player_client::{AuthenticatedServer, ServerError};
use player_state::repo::manifests::{Binding as ManifestBinding, Target};
use player_types::{Sha256Digest, Timestamp};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

pub const SERVER_CONTACT_INTERVAL: Duration = Duration::from_secs(60);
pub const SERVER_MANIFEST_INTERVAL: Duration = Duration::from_secs(300);
pub const SERVER_IDLE_INTERVAL: Duration = Duration::from_secs(300);
pub const SERVER_SOCKET_LIVENESS_TIMEOUT: Duration = PLAYER_SOCKET_ACTIVITY_TIMEOUT;
const IDLE_INTERVAL: Duration = SERVER_IDLE_INTERVAL;
const SOCKET_LIVENESS_TIMEOUT: Duration = SERVER_SOCKET_LIVENESS_TIMEOUT;

#[async_trait::async_trait]
pub trait ServerLinkHost: ConfigurationHost {
    type Preparation: ManifestWorkerHost;
    fn preparation_host(&self, server: &AuthenticatedServer) -> Arc<Self::Preparation>;
    fn native_configuration(&self) -> NativeConfiguration;
    fn jitter_unit(&self) -> f64;
    fn record_activity(&self, event: ActivityEvent);
    async fn heartbeat(&self) -> serde_json::Value;
    async fn presentation_protected(&self) -> bool;
}

/// Signals shared with commands, activation, status, and Watch Live coordinators.
/// The host owns their storage; Core owns when they are read or signalled.
#[derive(Debug)]
pub struct ServerLinkSignals<'a> {
    pub server_wake: &'a Notify,
    pub manifest_wake: &'a Notify,
    pub preparation: &'a SharedManifestPreparationStatus,
    pub link_state: &'a Mutex<LinkState>,
    pub last_server_contact: &'a Mutex<Option<Timestamp>>,
    pub command_wake: &'a Notify,
    pub command_server: &'a watch::Sender<Option<AuthenticatedServer>>,
    pub sync_request: &'a AtomicU64,
    pub sync_done: &'a watch::Sender<(u64, bool)>,
    pub live_stream_wake: &'a Notify,
    pub live_frames: &'a watch::Sender<Option<LiveFrame>>,
    pub status_due: &'a AtomicBool,
}

#[derive(Debug)]
pub struct ServerLinkServices<'a, H> {
    pub dependencies: Dependencies,
    pub relationship: &'a ServerRelationship,
    pub host: &'a H,
    pub signals: ServerLinkSignals<'a>,
    pub user_agent: &'a str,
    pub player_version: &'a str,
    pub shutdown: &'a CancellationToken,
}

#[derive(Debug, Default)]
struct Link {
    backoff: Backoff,
    next_heartbeat: Option<Instant>,
    socket: Option<PlayerSocket>,
    /// Socket attempts that failed since the last open (Activity's
    /// `connection.restored`).
    socket_failures: u32,
    socket_backoff: Backoff,
    next_socket_attempt: Option<Instant>,
    last_socket_activity: Option<Instant>,
    next_manifest_sync: Option<Instant>,
    manifest_dirty: bool,
    next_config_sync: Option<Instant>,
    config_dirty: bool,
    /// The binding whose cached configuration is in force.
    config_binding: Option<ManifestBinding>,
    /// The one preparation in flight and the manifest it prepares.
    preparation: Option<ManifestPreparationCoordinator>,
}

impl Link {
    fn socket_activity(&mut self) {
        self.last_socket_activity = Some(Instant::now());
    }

    fn socket_liveness_remaining(&self) -> Duration {
        self.last_socket_activity
            .map_or(SOCKET_LIVENESS_TIMEOUT, |last| SOCKET_LIVENESS_TIMEOUT.saturating_sub(last.elapsed()))
    }

    fn socket_lost(&mut self, jitter: f64) -> Option<ActivityEvent> {
        let event = if self.socket.is_some() {
            let mut event = ActivityEvent::new("connection.lost", "connectivity");
            event.severity = Some("warning".into());
            event.failure_message = Some("player socket closed".into());
            Some(event)
        } else {
            None
        };
        self.socket = None;
        self.last_socket_activity = None;
        self.socket_failures = self.socket_failures.saturating_add(1);
        let now = Instant::now();
        self.next_socket_attempt = Some(now + self.socket_backoff.failed(now, jitter));
        event
    }

    fn abort_preparation(&mut self) {
        if let Some(preparation) = &mut self.preparation {
            preparation.abort();
        }
    }
}

pub async fn drive_server_link<H: ServerLinkHost>(context: ServerLinkServices<'_, H>) {
    let preparation =
        Some(ManifestPreparationCoordinator::new(context.dependencies.clone(), context.signals.preparation.clone()));
    let shutdown = context.shutdown;
    let mut link = Link { preparation, ..Link::default() };
    let mut live_frames = context.signals.live_frames.subscribe();
    loop {
        if let Some(preparation) = &mut link.preparation {
            preparation.reap().await;
        }
        let requested = context.signals.sync_request.load(std::sync::atomic::Ordering::Acquire);
        if requested > context.signals.sync_done.borrow().0 {
            link.manifest_dirty = true;
            link.config_dirty = true;
        }
        let state = pass(&context, &mut link).await;
        if requested > context.signals.sync_done.borrow().0 {
            context.signals.sync_done.send_replace((requested, state == LinkState::Connected));
        }
        if !matches!(state, LinkState::Connected | LinkState::Retrying(_)) {
            context.signals.command_server.send_replace(None);
            // A stopped relationship retires the socket with it; a transient
            // failure keeps a working socket while it retries.
            link.socket = None;
            link.last_socket_activity = None;
        }
        let contact_interval = context.host.native_configuration().sync.status_report;
        let mut delay = match &state {
            LinkState::Connected => {
                link.backoff.connected(Instant::now());
                contact_interval
            }
            LinkState::Retrying(_) => link.backoff.failed(Instant::now(), context.host.jitter_unit()),
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
        *context.signals.link_state.lock().unwrap_or_else(|e| e.into_inner()) = state;
        let deadline = tokio::time::sleep(delay);
        tokio::pin!(deadline);
        loop {
            let remaining = link.socket_liveness_remaining();
            let Some(socket) = link.socket.as_mut() else {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = &mut deadline => break,
                    () = context.signals.server_wake.notified() => {
                        link.manifest_dirty = true;
                        link.config_dirty = true;
                        break;
                    }
                }
            };
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = &mut deadline => break,
                () = context.signals.server_wake.notified() => {
                    link.manifest_dirty = true;
                    link.config_dirty = true;
                    break;
                }
                changed = live_frames.changed() => {
                    // The latest Watch Live frame, if any. A newer frame
                    // supersedes an unsent older one: a slow network drops
                    // frames instead of queueing video. The socket stays
                    // owned here; the producer never touches it.
                    if changed.is_err() {
                        // The frame source is gone for good: retire this arm
                        // instead of polling the closed channel. (Unreachable
                        // in practice; the sender lives in the shared daemon
                        // context this task itself holds.)
                        std::future::pending::<()>().await;
                        continue;
                    }
                    let frame: Option<LiveFrame> =
                        live_frames.borrow_and_update().as_ref().cloned();
                    if let Some(frame) = frame {
                        // Re-check the privacy boundary at the actual send
                        // point. A frame may have been queued before setup,
                        // pairing, or safe mode became active while the
                        // socket was disconnected or backpressured.
                        if context.host.presentation_protected().await {
                            crate::clear_live_frame(context.signals.live_frames, frame.session_id);
                            continue;
                        }
                        if socket.send_live_stream_frame(frame.frame).await.is_err() {
                            socket_lost(&context, &mut link);
                            break;
                        }
                    }
                }
                received = tokio::time::timeout(remaining, socket.next_event()) => {
                    match received {
                        Ok(Ok(PlayerSocketEvent::Closed)) | Ok(Err(_)) | Err(_) => {
                            socket_lost(&context, &mut link);
                            break;
                        }
                        Ok(Ok(event)) => {
                            link.last_socket_activity = Some(Instant::now());
                            match event {
                                PlayerSocketEvent::Ping(timestamp) => {
                                    context.relationship.sample_clock(&timestamp).await;
                                    if socket.send_pong(&context.dependencies.clock.now().to_string()).await.is_err() {
                                        socket_lost(&context, &mut link);
                                        break;
                                    }
                                }
                                PlayerSocketEvent::ManifestChanged => {
                                    link.manifest_dirty = true;
                                    break;
                                }
                                PlayerSocketEvent::ConfigChanged => {
                                    link.config_dirty = true;
                                    break;
                                }
                                // Commands have their own task and cadence.
                                PlayerSocketEvent::CommandsAvailable => context.signals.command_wake.notify_one(),
                                // A lease change only wakes the Watch Live
                                // reconciler; the HTTP session endpoint stays
                                // authoritative.
                                PlayerSocketEvent::LiveStreamSessionChanged => {
                                    context.signals.live_stream_wake.notify_one();
                                }
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

fn socket_lost<H: ServerLinkHost>(context: &ServerLinkServices<'_, H>, link: &mut Link) {
    if let Some(event) = link.socket_lost(context.host.jitter_unit()) {
        context.host.record_activity(event);
    }
}

async fn ensure_preparation<H: ServerLinkHost>(
    context: &ServerLinkServices<'_, H>,
    link: &mut Link,
    server: &AuthenticatedServer,
    target: Option<Target>,
) {
    if let Some(preparation) = &mut link.preparation {
        preparation.ensure(target, context.host.preparation_host(server), context.shutdown).await;
    }
}

fn set_preparation<H: ServerLinkHost>(
    context: &ServerLinkServices<'_, H>,
    target: Option<Sha256Digest>,
    state: &'static str,
    reason: Option<String>,
) {
    *context.signals.preparation.lock().unwrap_or_else(|error| error.into_inner()) =
        ManifestPreparationStatus { target, state, reason };
}

async fn reject_credential<H: ServerLinkHost>(context: &ServerLinkServices<'_, H>) {
    context.relationship.reject_credential().await;
    context.signals.command_server.send_replace(None);
}

async fn sync_manifest<H: ServerLinkHost>(
    context: &ServerLinkServices<'_, H>,
    link: &mut Link,
    server: &AuthenticatedServer,
    binding: ManifestBinding,
) -> Result<(), LinkState> {
    match ManifestCoordinator::new(context.dependencies.clone()).reconcile(server, &binding).await {
        Ok(target) => {
            ensure_preparation(context, link, server, target).await;
            context.signals.manifest_wake.notify_one();
            Ok(())
        }
        Err(ManifestSyncError::Server(ServerError::CredentialRejected)) => {
            reject_credential(context).await;
            Err(LinkState::CredentialRejected)
        }
        Err(error) => {
            // Nothing already accepted is lost; the player keeps its committed
            // presentation. A preparation for the persisted target continues.
            tracing::warn!(component = "manifest", event = "reconcile_failed", reason = error.reason_code(), error = %error);
            if !matches!(error, ManifestSyncError::Server(_)) {
                set_preparation(context, None, "invalid", Some(error.reason_code().to_owned()));
            }
            let persisted = ManifestCoordinator::new(context.dependencies.clone()).persisted_target(&binding).await;
            ensure_preparation(context, link, server, persisted).await;
            Ok(())
        }
    }
}

async fn pass<H: ServerLinkHost>(context: &ServerLinkServices<'_, H>, link: &mut Link) -> LinkState {
    let relationship = context.relationship;
    let (bound, server) = match relationship.verify(context.user_agent).await {
        Ok(verified) => verified,
        Err(error) => return error.state(),
    };
    // A new relationship (or a changed server) polls commands at once; a
    // continuing one only refreshes the handle.
    let published = server.clone();
    context.signals.command_server.send_if_modified(move |current| {
        let changed = current.as_ref().is_none_or(|existing| existing.base_url() != published.base_url());
        *current = Some(published);
        changed
    });

    if link.socket.is_none() && link.next_socket_attempt.is_none_or(|next| Instant::now() >= next) {
        match server.player_socket(context.player_version).await {
            Ok(socket) => {
                if link.socket_failures > 0 {
                    let mut event = ActivityEvent::new("connection.restored", "connectivity");
                    event.result = Some("recovered".into());
                    context.host.record_activity(event);
                }
                link.socket = Some(socket);
                link.socket_activity();
                link.socket_backoff.connected(Instant::now());
                link.socket_failures = 0;
                link.next_socket_attempt = None;
                // As the reference player does on every socket open: report
                // status and reconcile now, so any push lost while the socket
                // was down is recovered at once.
                link.next_heartbeat = None;
                link.manifest_dirty = true;
                link.config_dirty = true;
                context.signals.command_wake.notify_one();
                context.signals.live_stream_wake.notify_one();
            }
            Err(error) => {
                tracing::warn!(component = "server", event = "player_socket_failed", reason = error.reason_code());
                socket_lost(context, link);
            }
        }
    }
    let status_due = context.signals.status_due.swap(false, std::sync::atomic::Ordering::AcqRel);
    if status_due || link.next_heartbeat.is_none_or(|next| Instant::now() >= next) {
        let heartbeat = context.host.heartbeat().await;
        let socket_sent = match link.socket.as_mut() {
            Some(socket) => socket.send_status(&heartbeat, context.player_version).await.is_ok(),
            None => false,
        };
        if !socket_sent && link.socket.is_some() {
            socket_lost(context, link);
        }
        let sent = if socket_sent { Ok(()) } else { server.player_heartbeat(&heartbeat).await };
        match sent {
            Ok(()) => {
                link.next_heartbeat = Some(Instant::now() + context.host.native_configuration().sync.status_report);
                *context.signals.last_server_contact.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(context.dependencies.clock.now());
            }
            Err(ServerError::CredentialRejected) => {
                reject_credential(context).await;
                return LinkState::CredentialRejected;
            }
            Err(error) => return ServerLinkState::from_error(&error),
        }
    }
    let reconcile_interval = context.host.native_configuration().sync.manifest_reconciliation;
    if let Some(screen_id) = bound.screen_id {
        let binding =
            ManifestBinding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url.clone() };
        if link.config_binding.as_ref() != Some(&binding) {
            ConfigurationCoordinator::new(context.dependencies.clone()).load_cached(&binding, context.host).await;
            link.config_binding = Some(binding.clone());
            link.config_dirty = true;
        }
        if link.config_dirty || link.next_config_sync.is_none_or(|next| Instant::now() >= next) {
            link.config_dirty = false;
            link.next_config_sync = Some(Instant::now() + reconcile_interval);
            match ConfigurationCoordinator::new(context.dependencies.clone())
                .reconcile(&server, &binding, context.host)
                .await
            {
                Err(ServerError::CredentialRejected) => {
                    reject_credential(context).await;
                    return LinkState::CredentialRejected;
                }
                Err(error) => {
                    tracing::warn!(
                        component = "config",
                        event = "config_reconcile_failed",
                        reason = error.reason_code()
                    );
                }
                Ok(_) => {}
            }
        }
        if link.manifest_dirty || link.next_manifest_sync.is_none_or(|next| Instant::now() >= next) {
            link.manifest_dirty = false;
            link.next_manifest_sync = Some(Instant::now() + reconcile_interval);
            if let Err(state) = sync_manifest(context, link, &server, binding).await {
                return state;
            }
        }
    }
    LinkState::Connected
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
        assert!(link.socket_lost(0.5).is_none(), "an unopened socket emits no connection-lost event");
        assert_eq!(link.last_socket_activity, None);
        assert_eq!(link.socket_liveness_remaining(), SOCKET_LIVENESS_TIMEOUT);
        assert_eq!(link.socket_failures, 1);
        assert!(link.next_socket_attempt.is_some());
    }
}
