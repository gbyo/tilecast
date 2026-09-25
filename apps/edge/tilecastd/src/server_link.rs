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
//! 4. Reconciles player configuration (`config_sync`) on connection, on a
//!    `config.changed` push and at the manifest interval, and the manifest
//!    through the ordinary manifest endpoint (`manifest_sync`), keeping one
//!    abortable preparation on its target.
//! 5. Publishes the verified server to the command task (`commands`), which
//!    polls on its own cadence; a `commands.available` push wakes that task.
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

/// Contact cadence while connected without configuration (the reference
/// player's heartbeat interval); configuration's `statusReportSeconds`
/// replaces it.
pub const CONTACT_INTERVAL: Duration = Duration::from_secs(60);
/// Manifest and configuration reconciliation without a push (the reference
/// player's `RECONCILE_INTERVAL_MS`); configuration's
/// `manifestReconciliationSeconds` replaces it.
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

/// The reference player's reconnect backoff
/// (`apps/player-linux/src/core/backoff.ts`): the first retry after about
/// 2 s, doubling to [`MAX_RETRY_INTERVAL`], with full jitter above half the
/// base delay so a fleet does not retry in step. `unit` is a random number
/// in `[0, 1)`.
pub const RETRY_BASE: Duration = Duration::from_secs(2);

pub fn retry_delay(failures: u32, unit: f64) -> Duration {
    let base = RETRY_BASE.as_millis() as u64;
    let exponent = failures.max(1).saturating_sub(1).min(16);
    let ceiling = base.saturating_mul(1 << exponent).min(MAX_RETRY_INTERVAL.as_millis() as u64);
    let floor = (base / 2).min(ceiling);
    let jitter = ((ceiling - floor) as f64 * unit.clamp(0.0, 1.0)) as u64;
    Duration::from_millis(floor + jitter.min(ceiling - floor))
}

/// A random number in `[0, 1)` for retry jitter.
fn jitter_unit() -> f64 {
    use ring::rand::SecureRandom as _;
    let mut bytes = [0_u8; 4];
    if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
        return 0.5;
    }
    f64::from(u32::from_le_bytes(bytes)) / (f64::from(u32::MAX) + 1.0)
}

/// A connection must stay up this long before its next failure counts as a
/// fresh outage rather than a continuation (the reference player's
/// `healthyResetMs`), so a flapping server is not retried every 2 s.
pub const HEALTHY_RESET: Duration = Duration::from_secs(120);

/// The failure streak of one kind of connection.
#[derive(Debug, Default)]
struct Backoff {
    failures: u32,
    connected_at: Option<Instant>,
}

impl Backoff {
    fn connected(&mut self, now: Instant) {
        self.connected_at.get_or_insert(now);
    }

    /// Records a failure and returns the delay before the next attempt.
    fn failed(&mut self, now: Instant) -> Duration {
        if self.connected_at.take().is_some_and(|at| now.duration_since(at) >= HEALTHY_RESET) {
            self.failures = 0;
        }
        self.failures = self.failures.saturating_add(1);
        retry_delay(self.failures, jitter_unit())
    }
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
    preparation: Option<(edge_protocol::Sha256Digest, tokio::task::JoinHandle<()>)>,
    /// Connection events for Activity, as the Electron player reports them.
    activity: Option<crate::activity::Handle>,
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
        if self.socket.is_some()
            && let Some(activity) = &self.activity
        {
            let mut event = crate::activity::Event::new("connection.lost", "connectivity");
            event.severity = Some("warning".into());
            event.failure_message = Some("player socket closed".into());
            activity.record(event);
        }
        self.socket = None;
        self.last_socket_activity = None;
        self.socket_failures = self.socket_failures.saturating_add(1);
        let now = Instant::now();
        self.next_socket_attempt = Some(now + self.socket_backoff.failed(now));
    }

    fn abort_preparation(&mut self) {
        if let Some((_, task)) = self.preparation.take() {
            task.abort();
        }
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    let mut link = Link { activity: Some(context.activity.clone()), ..Link::default() };
    loop {
        if link.preparation.as_ref().is_some_and(|(_, task)| task.is_finished())
            && let Some((_, task)) = link.preparation.take()
        {
            let _ = task.await;
        }
        let requested = context.sync_request.load(std::sync::atomic::Ordering::Acquire);
        if requested > context.sync_done.borrow().0 {
            link.manifest_dirty = true;
            link.config_dirty = true;
        }
        let state = pass(&context, &mut link).await;
        if requested > context.sync_done.borrow().0 {
            context.sync_done.send_replace((requested, state == LinkState::Connected));
        }
        if !matches!(state, LinkState::Connected | LinkState::Retrying(_)) {
            context.command_server.send_replace(None);
        }
        let contact_interval = crate::config_sync::effective(&context).sync.status_report;
        let mut delay = match &state {
            LinkState::Connected => {
                link.backoff.connected(Instant::now());
                contact_interval
            }
            LinkState::Retrying(_) => link.backoff.failed(Instant::now()),
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
                        link.config_dirty = true;
                        break;
                    }
                }
            };
            tokio::select! {
                () = context.shutdown.cancelled() => return,
                () = &mut deadline => break,
                () = context.server_wake.notified() => {
                    link.manifest_dirty = true;
                    link.config_dirty = true;
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
                                PlayerSocketEvent::ConfigChanged => {
                                    link.config_dirty = true;
                                    break;
                                }
                                // Commands have their own task and cadence.
                                PlayerSocketEvent::CommandsAvailable => context.command_wake.notify_one(),
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

/// Stores the server clock offset from a server timestamp (a socket ping, or
/// a manifest's `serverTime` as the reference player's `core/clock.ts`
/// samples it), so a restart without the server still schedules at the
/// corrected time.
pub(crate) async fn sample_server_clock(context: &DaemonContext, timestamp: &str) {
    let Ok(server_time) = Timestamp::parse(timestamp) else { return };
    let Some(db) = context.db() else { return };
    let received_at = context.now();
    let sample = server_time.unix_millis().saturating_sub(received_at.unix_millis());
    // Older servers send whole-second pings: such a sample only says the
    // offset lies in [sample, sample + 1 s).
    let coarse = !timestamp.contains('.');
    let _ = db
        .run(move |c| {
            let mut state = playback::get(c)?;
            let stale = state
                .server_clock_synchronized_at
                .is_none_or(|at| received_at.unix_millis() - at.unix_millis() > 300_000);
            if let Some(offset) = refined_offset(state.server_clock_offset_ms, sample, coarse, stale) {
                state.server_clock_offset_ms = Some(offset);
                state.server_clock_synchronized_at = Some(received_at);
                playback::put(c, &state, received_at)?;
            }
            Ok(())
        })
        .await;
}

/// The offset to store after a sample, or `None` to keep the current one. A
/// precise sample replaces an offset it moves by 250 ms or more, or a stale
/// one. A whole-second sample replaces only an offset outside its interval,
/// with the interval's middle.
pub(crate) fn refined_offset(current: Option<i64>, sample: i64, coarse: bool, stale: bool) -> Option<i64> {
    if coarse {
        return match current {
            Some(old) if (sample..=sample.saturating_add(1_000)).contains(&old) => None,
            _ => Some(sample.saturating_add(500)),
        };
    }
    match current {
        Some(old) if old.abs_diff(sample) < 250 && !stale => None,
        _ => Some(sample),
    }
}

fn server_retry(error: &ServerError) -> LinkState {
    match error {
        ServerError::IdentityMismatch { .. } => LinkState::IdentityMismatch,
        ServerError::CredentialRejected => LinkState::CredentialRejected,
        other => LinkState::Retrying(other.reason_code()),
    }
}

pub async fn reject_credential(context: &DaemonContext) {
    tracing::warn!(component = "server", event = "credential_rejected");
    if let Some(db) = context.db() {
        let now = context.now();
        let _ = db.run(move |c| binding::set_credential_state(c, CredentialState::Rejected, now)).await;
    }
    let _ = DeviceCredential::remove(&context.paths.identity_dir());
    context.command_server.send_replace(None);
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
            // Nothing to do while its content is whole; otherwise the
            // preparation below repairs it in place.
            let intact = match crate::manifest::Candidate::prepare_candidate(
                target.document.clone(),
                target.binding.screen_id,
            ) {
                Ok(candidate) => crate::manifest::verify_cached(context, &candidate).await.is_ok(),
                Err(_) => true,
            };
            if intact {
                return;
            }
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
            Ok(Prepared::Repaired) => set_preparation(&worker_context, Some(digest), "repaired", None),
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
    // A new relationship (or a changed server) polls commands at once; a
    // continuing one only refreshes the handle.
    let published = server.clone();
    context.command_server.send_if_modified(move |current| {
        let changed = current.as_ref().is_none_or(|existing| existing.base_url() != published.base_url());
        *current = Some(published);
        changed
    });

    if link.socket.is_none() && link.next_socket_attempt.is_none_or(|next| Instant::now() >= next) {
        match server.player_socket(VERSION).await {
            Ok(socket) => {
                if link.socket_failures > 0
                    && let Some(activity) = &link.activity
                {
                    let mut event = crate::activity::Event::new("connection.restored", "connectivity");
                    event.result = Some("recovered".into());
                    activity.record(event);
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
                context.command_wake.notify_one();
            }
            Err(error) => {
                tracing::warn!(component = "server", event = "player_socket_failed", reason = error.reason_code());
                link.socket_lost();
            }
        }
    }
    let status_due = context.status_due.swap(false, std::sync::atomic::Ordering::AcqRel);
    if status_due || link.next_heartbeat.is_none_or(|next| Instant::now() >= next) {
        // Queued Noise Meter history takes the HTTP heartbeat, because only
        // its answer acknowledges what the server stored (the reference
        // player's rule); the cadence does not change.
        let draining = crate::audio::history_pending(context).await;
        let mut heartbeat = build_heartbeat(context).await;
        let history = crate::audio::heartbeat(context, &mut heartbeat, draining).await;
        let socket_sent = match link.socket.as_mut().filter(|_| !draining) {
            Some(socket) => socket.send_status(&heartbeat, VERSION).await.is_ok(),
            None => false,
        };
        if !socket_sent && !draining && link.socket.is_some() {
            link.socket_lost();
        }
        let sent = if socket_sent {
            Ok(())
        } else {
            match server.player_heartbeat(&heartbeat).await {
                Ok(ack) => {
                    crate::audio::acknowledge(context, history, ack.noise_history_accepted).await;
                    Ok(())
                }
                Err(error) => Err(error),
            }
        };
        match sent {
            Ok(()) => {
                link.next_heartbeat = Some(Instant::now() + crate::config_sync::effective(context).sync.status_report);
                *context.last_server_contact.lock().unwrap_or_else(|e| e.into_inner()) = Some(context.now());
            }
            Err(ServerError::CredentialRejected) => {
                reject_credential(context).await;
                return LinkState::CredentialRejected;
            }
            Err(error) => return server_retry(&error),
        }
    }
    let reconcile_interval = crate::config_sync::effective(context).sync.manifest_reconciliation;
    if let Some(screen_id) = bound.screen_id {
        let binding =
            ManifestBinding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url.clone() };
        if link.config_binding.as_ref() != Some(&binding) {
            crate::config_sync::load_cached(context, &binding).await;
            link.config_binding = Some(binding.clone());
            link.config_dirty = true;
        }
        if link.config_dirty || link.next_config_sync.is_none_or(|next| Instant::now() >= next) {
            link.config_dirty = false;
            link.next_config_sync = Some(Instant::now() + reconcile_interval);
            match crate::config_sync::reconcile(context, &server, &binding).await {
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

/// The heartbeat `currentItemId` for a renderer item key: playlist items
/// carry their manifest UUID, a directly shown Layout's key is translated back
/// to the Layout UUID, and anything else is omitted rather than sent, because
/// the server rejects a whole heartbeat over one malformed identifier
/// (reference: `core/identifiers.ts`).
pub fn heartbeat_item_id(key: &str) -> Option<String> {
    let candidate = key.strip_prefix("layout-").unwrap_or(key);
    edge_protocol::ids::parse_canonical_uuid(candidate).ok().map(|id| id.to_string())
}

/// The heartbeat `selectionSource` for a selection, in the server's shared
/// status vocabulary (`takeover`, `quick_present`, `schedule`,
/// `direct_fallback`, `none`); the server discards a whole status with any
/// other value. A direct assignment is reported as `direct_fallback`, as the
/// Android player does.
pub fn heartbeat_selection_source(source: &str) -> Option<&'static str> {
    match source {
        "takeover" => Some("takeover"),
        "quick_present" => Some("quick_present"),
        "schedule" => Some("schedule"),
        "direct" => Some("direct_fallback"),
        "none" => Some("none"),
        _ => None,
    }
}

fn iso(ms: i64) -> Option<String> {
    Timestamp::from_unix_millis(ms).map(|at| at.to_string())
}

/// Ordinary player status, sent on the socket or as the fallback heartbeat.
/// Playback identifiers have the reference Linux player's meaning: the
/// committed and pending manifest versions, and what the renderer is actually
/// showing and why.
pub async fn build_heartbeat(context: &DaemonContext) -> serde_json::Value {
    let (renderer, current, current_item) = {
        let presentation = context.presentation.lock().await;
        (presentation.status(), presentation.current().cloned(), presentation.current_item())
    };
    let healthy = renderer.state.as_str() == "healthy"
        && current
            .as_ref()
            .is_some_and(|active| active.source == crate::presentation::ActivationSource::ServerManifest)
        && current.as_ref().is_some_and(|active| {
            matches!(active.document, edge_protocol::ipc::presentation::PresentationDocument::Playing { .. })
        });
    // The reference player reports what is on screen: `playing`, or the
    // surface's state (`sleep`, `disabled`, `safe-mode`, `idle`, ...).
    let playback_state = if healthy {
        "playing"
    } else {
        current.as_ref().map_or("idle", |active| match active.document.state_name() {
            "playing" => "starting",
            other => other,
        })
    };
    let uptime = ((context.now().unix_millis() - context.started_at.unix_millis()).max(0) / 1000) as u64;
    let native: serde_json::Map<String, serde_json::Value> = crate::manifest::profile::NATIVE_CAPABILITIES
        .iter()
        .map(|(name, version)| ((*name).to_owned(), serde_json::json!(version)))
        .collect();
    let mut heartbeat = serde_json::json!({
        "screenWidth": 0,
        "screenHeight": 0,
        "playerVersion": VERSION,
        "playerVersionCode": crate::update::own_version_code(),
        // The Player release family: Edge releases reach only Edge screens
        // of this architecture (docs/tilecast-edge.md §15).
        "playerFamily": edge_release::envelope::PLAYER_FAMILY,
        "playerArchitecture": std::env::consts::ARCH,
        "uptimeSeconds": uptime,
        "playbackState": playback_state,
        "safeMode": renderer.state.as_str() == "safe_mode",
        "presentationSchemaVersions": [1],
        "nativePresentationCapabilities": native,
        "webRuntimeVersion": crate::manifest::profile::WEB_RUNTIME_VERSION,
    });
    // `lastMeaningfulProgressAt` is a telemetry field, not a heartbeat one:
    // the server's strict HTTP heartbeat decoding refuses the whole message
    // for it (gbyo/tilecast#674).
    if let Some(progress_at) = renderer.last_progress_at
        && healthy
    {
        heartbeat["lastHealthyPlaybackAt"] = serde_json::Value::String(progress_at.to_string());
    }
    if let Some(identity) = current.as_ref().and_then(|activation| activation.identity.as_ref()) {
        if let Some(source) = heartbeat_selection_source(identity.selection_source) {
            heartbeat["selectionSource"] = serde_json::json!(source);
        }
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
        if let Some((item, _)) = current_item.as_ref()
            && let Some(item) = heartbeat_item_id(item)
        {
            // The item's start time is not a heartbeat field: the server's
            // strict HTTP heartbeat decoding refuses the whole message for
            // it. It travels in the telemetry sample (`itemStartedAt`).
            heartbeat["currentItemId"] = serde_json::json!(item);
        }
    }
    if let Ok(available) = context.space.available_bytes(&context.paths.state_dir) {
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
    if let Some(revision) = crate::config_sync::accepted_revision(context) {
        heartbeat["activeConfigRevision"] = serde_json::json!(revision);
    }
    if let Some(db) = context.db()
        && let Ok(status) = db.run(|c| edge_state::repo::config::status(c)).await
        && let Some(code) = status.last_error_code
    {
        heartbeat["configurationError"] = serde_json::json!(code);
    }
    let preparation = context.preparation.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(reason) =
        preparation.reason.filter(|_| matches!(preparation.state, "failed" | "incompatible" | "invalid"))
    {
        heartbeat["lastSynchronizationError"] = serde_json::json!(reason.chars().take(240).collect::<String>());
    }
    context.display.heartbeat(&mut heartbeat);
    let (helper, network) = context.network.status();
    let helper_ok = helper.as_ref().is_some_and(|h| h.helper_state == "ok");
    let wired = (!helper_ok).then(|| {
        let sys = context.config.dev.hardware_sys_dir.clone().unwrap_or_else(|| std::path::PathBuf::from("/sys"));
        crate::presentation_network::wired_interface_up(&sys)
    });
    crate::presentation_network::heartbeat(&mut heartbeat, helper.as_ref(), &network, wired);
    heartbeat
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_second_sample_corrects_only_what_it_can_resolve() {
        // Precise samples: 250 ms or more, or a stale offset, replace it.
        assert_eq!(refined_offset(None, -40, false, false), Some(-40));
        assert_eq!(refined_offset(Some(-40), 100, false, false), None);
        assert_eq!(refined_offset(Some(-40), 300, false, false), Some(300));
        assert_eq!(refined_offset(Some(-40), 100, false, true), Some(100));
        // A whole-second ping 797 ms "behind" agrees with a precise -40 ms
        // offset and must not replace it (the real-server two-player case).
        assert_eq!(refined_offset(Some(-40), -837, true, true), None);
        // Nothing better known: the interval's middle.
        assert_eq!(refined_offset(None, -837, true, false), Some(-337));
        // Outside its interval: a whole-second sample still fixes a large error.
        assert_eq!(refined_offset(Some(90_000), -837, true, false), Some(-337));
    }

    #[test]
    fn retry_delay_matches_the_reference_player_backoff() {
        // backoff.ts: floor = base / 2, ceiling = base * 2^(failures - 1).
        assert_eq!(retry_delay(1, 0.0), Duration::from_secs(1));
        assert_eq!(retry_delay(1, 0.999_999), Duration::from_millis(1_999));
        assert_eq!(retry_delay(3, 0.0), Duration::from_secs(1));
        assert_eq!(retry_delay(3, 0.5), Duration::from_millis(4_500));
        assert_eq!(retry_delay(9, 1.0), MAX_RETRY_INTERVAL);
        assert_eq!(retry_delay(40, 1.0), MAX_RETRY_INTERVAL);
        assert!(retry_delay(u32::MAX, 0.3) <= MAX_RETRY_INTERVAL);
        for _ in 0..100 {
            let unit = jitter_unit();
            assert!((0.0..1.0).contains(&unit), "{unit}");
        }
    }

    #[test]
    fn a_streak_resets_only_after_a_healthy_connection() {
        let start = Instant::now();
        let mut backoff = Backoff::default();
        for _ in 0..5 {
            backoff.failed(start);
        }
        assert_eq!(backoff.failures, 5);
        // A brief success does not forgive a flapping server.
        backoff.connected(start);
        backoff.failed(start + Duration::from_secs(10));
        assert_eq!(backoff.failures, 6);
        // Two healthy minutes do.
        backoff.connected(start + Duration::from_secs(10));
        backoff.connected(start + Duration::from_secs(60));
        backoff.failed(start + Duration::from_secs(10) + HEALTHY_RESET);
        assert_eq!(backoff.failures, 1);
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
    fn selection_source_uses_the_server_status_vocabulary() {
        assert_eq!(heartbeat_selection_source("direct"), Some("direct_fallback"));
        assert_eq!(heartbeat_selection_source("schedule"), Some("schedule"));
        assert_eq!(heartbeat_selection_source("takeover"), Some("takeover"));
        assert_eq!(heartbeat_selection_source("none"), Some("none"));
        assert_eq!(heartbeat_selection_source("quick_present"), Some("quick_present"));
        assert_eq!(heartbeat_selection_source("emergency"), None);
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
