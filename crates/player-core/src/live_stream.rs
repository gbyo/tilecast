//! Studio Watch Live: the Electron player's ephemeral live stream, with the
//! renderer taking the pictures.
//!
//! While Studio holds a live-stream lease, the daemon reconciles
//! `GET /api/v1/player/live-stream-session` (every 15 s idle, every 5 s
//! active, at once on the `live_stream.session_changed` push) and captures
//! the visible Tilecast output at the leased cadence. Each capture is
//! TCLS-encoded and handed to the authenticated WebSocket owner through
//! the bounded latest-frame channel, and
//! the server relays it to Studio's existing MJPEG endpoint. Frames and
//! sessions are memory-only and never touch SQLite, the content store,
//! Activity, logs, or proof-of-play.
//!
//! Captures go through the shared [`crate::CaptureBroker`] broker (one
//! snapshot/encode in flight with periodic Live Preview), but the product
//! policy is separate: a failed capture only drops its frame and never
//! engages the preview's long suspension. A finished capture is re-checked
//! before handoff: if the session was replaced, expired, or the screen
//! entered a protected state while the frame was being produced, the result
//! is discarded.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::{CaptureError, CapturedFrame};
use player_client::live_stream::{LiveStreamSession, MIN_CAPTURE_PAUSE_MILLIS};
use player_client::{AuthenticatedServer, ServerError};
use player_types::Timestamp;

/// Services required by Watch Live; the host owns renderer transport and the socket.
#[async_trait::async_trait]
pub trait LiveStreamHost: Send + Sync {
    async fn capture_live_frame(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<CapturedFrame, CaptureError>;
    async fn presentation_protected(&self) -> bool;
    fn now(&self) -> Timestamp;
    fn live_frames(&self) -> &tokio::sync::watch::Sender<Option<LiveFrame>>;
}

#[async_trait::async_trait]
pub trait LiveStreamApi: Send + Sync {
    async fn live_stream_session(&self) -> Result<LiveStreamSession, ServerError>;
}

#[async_trait::async_trait]
impl LiveStreamApi for AuthenticatedServer {
    async fn live_stream_session(&self) -> Result<LiveStreamSession, ServerError> {
        AuthenticatedServer::live_stream_session(self).await
    }
}

const IDLE_RECONCILE: Duration = Duration::from_secs(15);
const ACTIVE_RECONCILE: Duration = Duration::from_secs(5);

/// One TCLS-encoded Watch Live frame for the WebSocket owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveFrame {
    pub session_id: uuid::Uuid,
    /// The complete TCLS version 1 message: 33-byte header plus JPEG.
    pub frame: Vec<u8>,
}

/// Delay before the next capture: the monotonic capture time counts toward
/// the target interval, floored so a zero elapsed time cannot busy-loop.
fn capture_delay(interval: Duration, elapsed: Duration) -> Duration {
    interval.saturating_sub(elapsed).max(Duration::from_millis(MIN_CAPTURE_PAUSE_MILLIS))
}

/// Whether a finished capture may be handed to the WebSocket owner: the same
/// session is still active, so a frame from a replaced or expired session is
/// never sent merely because its capture started in an allowed state.
fn should_send(captured_id: uuid::Uuid, current: Option<&LiveStreamSession>, now_unix_millis: i64) -> bool {
    current.is_some_and(|session| session.id == Some(captured_id) && session.is_active_at(now_unix_millis))
}

/// Removes a queued frame only if it still belongs to this session. This is
/// safe across replacement: an old capture can never clear a newer session's
/// pending frame.
pub fn clear_live_frame(frames: &tokio::sync::watch::Sender<Option<LiveFrame>>, session_id: uuid::Uuid) {
    frames.send_if_modified(|pending| {
        if pending.as_ref().is_some_and(|frame| frame.session_id == session_id) {
            *pending = None;
            true
        } else {
            false
        }
    });
}

async fn capture_loop<H: LiveStreamHost>(
    host: Arc<H>,
    current: Arc<tokio::sync::Mutex<Option<LiveStreamSession>>>,
    shutdown: tokio_util::sync::CancellationToken,
) {
    loop {
        let snapshot = current.lock().await.clone();
        let Some(session) = snapshot else { return };
        let Some(id) = session.id else { return };
        if !session.is_active_at(host.now().unix_millis()) {
            clear_live_frame(host.live_frames(), id);
            return;
        }
        let interval = Duration::from_millis(session.frame_interval_millis);
        let started = Instant::now();
        match host.capture_live_frame(session.max_width, session.max_height, session.max_frame_bytes as u32).await {
            Ok(captured) => {
                let (width, height) = captured.dimensions();
                let jpeg = captured.into_jpeg();
                let fresh = current.lock().await.clone();
                let now = host.now().unix_millis();
                if should_send(id, fresh.as_ref(), now) {
                    if host.presentation_protected().await {
                        clear_live_frame(host.live_frames(), id);
                    } else if player_client::live_stream::is_complete_jpeg(&jpeg)
                        && let Some(frame) =
                            player_client::live_stream::encode_live_stream_frame(&id, now, width, height, &jpeg)
                    {
                        host.live_frames().send_replace(Some(LiveFrame { session_id: id, frame }));
                    }
                }
            }
            Err(error) => {
                let reason = error.reason_code();
                if error == CaptureError::ProtectedState {
                    clear_live_frame(host.live_frames(), id);
                }
                tracing::debug!(component = "live_stream", event = "capture_dropped", reason);
            }
        }
        if !current.lock().await.clone().is_some_and(|session| session.id == Some(id)) {
            clear_live_frame(host.live_frames(), id);
            return;
        }
        let delay = capture_delay(interval, started.elapsed());
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = tokio::time::sleep(delay) => {}
        }
    }
}

fn abort(task: &mut Option<tokio::task::JoinHandle<()>>) {
    if let Some(handle) = task.take() {
        handle.abort();
    }
}

/// What a reconciled session means for the capture loop: an inactive,
/// expired, or incomplete lease stops it; an unchanged session ID only
/// refreshes expiry and limits; a new ID restarts capture.
#[derive(Debug, PartialEq, Eq)]
enum ReconcileAction {
    Keep,
    Restart,
    Stop,
}

fn reconcile_action(
    existing: Option<&LiveStreamSession>,
    next: &LiveStreamSession,
    now_unix_millis: i64,
    capture_running: bool,
) -> ReconcileAction {
    if !next.is_active_at(now_unix_millis) {
        return ReconcileAction::Stop;
    }
    match existing {
        Some(session) if session.id == next.id && capture_running => ReconcileAction::Keep,
        _ => ReconcileAction::Restart,
    }
}

pub async fn drive_live_stream<H, A>(
    host: Arc<H>,
    mut server: tokio::sync::watch::Receiver<Option<A>>,
    wake: &tokio::sync::Notify,
    shutdown: &tokio_util::sync::CancellationToken,
) where
    H: LiveStreamHost + 'static,
    A: LiveStreamApi + Clone,
{
    let current: Arc<tokio::sync::Mutex<Option<LiveStreamSession>>> = Arc::new(tokio::sync::Mutex::new(None));
    let mut capture_task: Option<tokio::task::JoinHandle<()>> = None;

    loop {
        // Reconcile before sleeping. This guarantees an immediate first poll
        // once an authenticated server handle exists, and every wake leads to
        // a fresh authoritative GET.
        let api = { server.borrow().clone() };
        let delay = match api {
            None => {
                abort(&mut capture_task);
                *current.lock().await = None;
                host.live_frames().send_replace(None);
                IDLE_RECONCILE
            }
            Some(api) => match api.live_stream_session().await {
                Err(error) => {
                    tracing::debug!(
                        component = "live_stream",
                        event = "reconcile_failed",
                        reason = error.reason_code()
                    );
                    if current
                        .lock()
                        .await
                        .as_ref()
                        .is_some_and(|session| session.is_active_at(host.now().unix_millis()))
                    {
                        ACTIVE_RECONCILE
                    } else {
                        IDLE_RECONCILE
                    }
                }
                Ok(session) => {
                    let capture_running = capture_task.as_ref().is_some_and(|task| !task.is_finished());
                    // Snapshot without holding the guard: the match arms below
                    // relock `current`, and temporaries in a match scrutinee
                    // would keep the guard alive until the end of the match
                    // (a self-deadlock on this non-reentrant mutex).
                    let existing = current.lock().await.clone();
                    match reconcile_action(existing.as_ref(), &session, host.now().unix_millis(), capture_running) {
                        ReconcileAction::Stop => {
                            abort(&mut capture_task);
                            *current.lock().await = None;
                            host.live_frames().send_replace(None);
                            IDLE_RECONCILE
                        }
                        ReconcileAction::Keep => {
                            *current.lock().await = Some(session);
                            ACTIVE_RECONCILE
                        }
                        ReconcileAction::Restart => {
                            *current.lock().await = Some(session);
                            abort(&mut capture_task);
                            let worker_host = Arc::clone(&host);
                            let worker_shutdown = shutdown.clone();
                            let worker_current = Arc::clone(&current);
                            capture_task = Some(tokio::spawn(async move {
                                capture_loop(worker_host, worker_current, worker_shutdown).await
                            }));
                            ACTIVE_RECONCILE
                        }
                    }
                }
            },
        };

        tokio::select! {
            () = shutdown.cancelled() => {
                abort(&mut capture_task);
                return;
            }
            () = tokio::time::sleep(delay) => {}
            changed = server.changed() => if changed.is_err() {
                abort(&mut capture_task);
                return;
            },
            () = wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RendererCaptureRequest;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    struct Ticket {
        request: RendererCaptureRequest,
        answer: tokio::sync::oneshot::Sender<Result<CapturedFrame, CaptureError>>,
    }

    struct Host {
        requests: tokio::sync::mpsc::Sender<Ticket>,
        frames: tokio::sync::watch::Sender<Option<LiveFrame>>,
        clock: AtomicI64,
        protected: AtomicBool,
    }

    #[async_trait::async_trait]
    impl LiveStreamHost for Host {
        async fn capture_live_frame(
            &self,
            max_width: u32,
            max_height: u32,
            max_bytes: u32,
        ) -> Result<CapturedFrame, CaptureError> {
            let request = RendererCaptureRequest { request_id: uuid::Uuid::new_v4(), max_width, max_height, max_bytes };
            let (answer, receiver) = tokio::sync::oneshot::channel();
            self.requests.send(Ticket { request, answer }).await.map_err(|_| CaptureError::RendererDisconnected)?;
            receiver.await.map_err(|_| CaptureError::RendererDisconnected)?
        }
        async fn presentation_protected(&self) -> bool {
            self.protected.load(Ordering::SeqCst)
        }
        fn now(&self) -> Timestamp {
            Timestamp::from_unix_millis(self.clock.load(Ordering::SeqCst)).unwrap()
        }
        fn live_frames(&self) -> &tokio::sync::watch::Sender<Option<LiveFrame>> {
            &self.frames
        }
    }

    fn host(now: i64) -> (Arc<Host>, tokio::sync::mpsc::Receiver<Ticket>) {
        let (requests, receiver) = tokio::sync::mpsc::channel(2);
        (
            Arc::new(Host {
                requests,
                frames: tokio::sync::watch::Sender::new(None),
                clock: AtomicI64::new(now),
                protected: AtomicBool::new(false),
            }),
            receiver,
        )
    }

    fn answer(ticket: Ticket) {
        let request = ticket.request;
        assert_eq!((request.max_width, request.max_height, request.max_bytes), (640, 360, 102_400));
        let frame = CapturedFrame::new(request, vec![0xff, 0xd8, 0xff, 0xd9], 640, 360).unwrap();
        let _ = ticket.answer.send(Ok(frame));
    }

    #[tokio::test(start_paused = true)]
    async fn protection_entered_during_capture_discards_the_image_and_queued_frame() {
        let lease = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", true);
        let expiry = Timestamp::parse(lease.expires_at.as_deref().unwrap()).unwrap().unix_millis();
        let (host, mut requests) = host(expiry - 1_000);
        host.frames.send_replace(Some(LiveFrame { session_id: lease.id.unwrap(), frame: vec![1] }));
        let current = Arc::new(tokio::sync::Mutex::new(Some(lease)));
        let worker_host = Arc::clone(&host);
        let worker = tokio::spawn(capture_loop(worker_host, current, tokio_util::sync::CancellationToken::new()));
        let ticket = requests.recv().await.unwrap();
        host.protected.store(true, Ordering::SeqCst);
        answer(ticket);
        let _next_capture = requests.recv().await.unwrap();
        assert!(host.frames.borrow().is_none(), "protected capture cannot expose or retain an image");
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn replaced_lease_discards_old_capture_without_clearing_a_newer_frame() {
        let lease = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", true);
        let expiry = Timestamp::parse(lease.expires_at.as_deref().unwrap()).unwrap().unix_millis();
        let (host, mut requests) = host(expiry - 1_000);
        let current = Arc::new(tokio::sync::Mutex::new(Some(lease)));
        let worker = tokio::spawn(capture_loop(
            Arc::clone(&host),
            Arc::clone(&current),
            tokio_util::sync::CancellationToken::new(),
        ));
        let ticket = requests.recv().await.unwrap();
        let replacement = session("0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa", true);
        let frame = LiveFrame { session_id: replacement.id.unwrap(), frame: vec![2] };
        *current.lock().await = Some(replacement);
        host.frames.send_replace(Some(frame.clone()));
        answer(ticket);
        worker.await.unwrap();
        assert_eq!(*host.frames.borrow(), Some(frame));
    }

    #[tokio::test(start_paused = true)]
    async fn expired_lease_discards_capture_and_clears_its_pending_frame() {
        let lease = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", true);
        let expiry = Timestamp::parse(lease.expires_at.as_deref().unwrap()).unwrap().unix_millis();
        let (host, mut requests) = host(expiry - 1_000);
        host.frames.send_replace(Some(LiveFrame { session_id: lease.id.unwrap(), frame: vec![1] }));
        let current = Arc::new(tokio::sync::Mutex::new(Some(lease)));
        let worker = tokio::spawn(capture_loop(Arc::clone(&host), current, tokio_util::sync::CancellationToken::new()));
        let ticket = requests.recv().await.unwrap();
        host.clock.store(expiry, Ordering::SeqCst);
        answer(ticket);
        worker.await.unwrap();
        assert!(host.frames.borrow().is_none());
    }

    #[derive(Clone)]
    struct Api {
        session: Arc<std::sync::Mutex<LiveStreamSession>>,
        fetched: tokio::sync::mpsc::Sender<()>,
    }

    #[async_trait::async_trait]
    impl LiveStreamApi for Api {
        async fn live_stream_session(&self) -> Result<LiveStreamSession, ServerError> {
            let session = self.session.lock().unwrap().clone();
            self.fetched.send(()).await.unwrap();
            Ok(session)
        }
    }

    #[tokio::test(start_paused = true)]
    async fn lease_wakes_start_capture_and_stop_clears_the_frame() {
        let lease = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", true);
        let expiry = Timestamp::parse(lease.expires_at.as_deref().unwrap()).unwrap().unix_millis();
        let (host, mut requests) = host(expiry - 1_000);
        let mut frames = host.frames.subscribe();
        let (fetched, mut fetches) = tokio::sync::mpsc::channel(2);
        let session = Arc::new(std::sync::Mutex::new(LiveStreamSession::default()));
        let api = Api { session: Arc::clone(&session), fetched };
        let (_server, receiver) = tokio::sync::watch::channel(Some(api));
        let wake = Arc::new(tokio::sync::Notify::new());
        let shutdown = tokio_util::sync::CancellationToken::new();
        let worker_host = Arc::clone(&host);
        let worker_wake = Arc::clone(&wake);
        let worker_shutdown = shutdown.clone();
        let worker =
            tokio::spawn(async move { drive_live_stream(worker_host, receiver, &worker_wake, &worker_shutdown).await });
        fetches.recv().await.unwrap();
        assert!(requests.try_recv().is_err(), "inactive lease never requests a capture");
        *session.lock().unwrap() = lease.clone();
        wake.notify_one();
        fetches.recv().await.unwrap();
        answer(requests.recv().await.unwrap());
        loop {
            frames.changed().await.unwrap();
            if frames.borrow_and_update().is_some() {
                break;
            }
        }
        assert_eq!(frames.borrow_and_update().as_ref().unwrap().session_id, lease.id.unwrap());
        *session.lock().unwrap() = LiveStreamSession::default();
        wake.notify_one();
        fetches.recv().await.unwrap();
        frames.changed().await.unwrap();
        assert!(frames.borrow_and_update().is_none());
        shutdown.cancel();
        worker.await.unwrap();
    }

    fn session(id: &str, active: bool) -> LiveStreamSession {
        LiveStreamSession {
            id: Some(id.parse().unwrap()),
            active,
            expires_at: Some("2026-07-30T12:00:15Z".to_owned()),
            frame_interval_millis: 125,
            max_width: 640,
            max_height: 360,
            max_frame_bytes: 102_400,
        }
    }

    #[test]
    fn capture_time_counts_toward_the_target_interval_with_a_floor() {
        assert_eq!(capture_delay(Duration::from_millis(125), Duration::from_millis(100)), Duration::from_millis(25));
        assert_eq!(
            capture_delay(Duration::from_millis(125), Duration::from_millis(200)),
            Duration::from_millis(MIN_CAPTURE_PAUSE_MILLIS)
        );
        assert_eq!(capture_delay(Duration::from_millis(125), Duration::ZERO), Duration::from_millis(125));
    }

    #[tokio::test]
    async fn a_newer_frame_supersedes_an_unsent_older_frame() {
        let (tx, mut rx) = tokio::sync::watch::channel(None);
        let first = LiveFrame { session_id: uuid::Uuid::new_v4(), frame: vec![1] };
        let second = LiveFrame { session_id: first.session_id, frame: vec![2] };
        tx.send_replace(Some(first));
        tx.send_replace(Some(second.clone()));
        assert!(rx.has_changed().unwrap(), "one notification for the latest frame");
        assert_eq!(*rx.borrow_and_update(), Some(second));
        assert!(!rx.has_changed().unwrap(), "nothing queued behind the latest frame");
    }

    #[test]
    fn reconcile_updates_limits_while_running_and_restarts_a_finished_worker() {
        let expiry = player_types::Timestamp::parse("2026-07-30T12:00:15Z").unwrap().unix_millis();
        let first = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", true);
        let same_id = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", true);
        let other_id = session("0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa", true);
        let inactive = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", false);
        assert_eq!(reconcile_action(None, &first, expiry - 1_000, false), ReconcileAction::Restart);
        assert_eq!(reconcile_action(Some(&first), &same_id, expiry - 1_000, true), ReconcileAction::Keep);
        assert_eq!(
            reconcile_action(Some(&first), &same_id, expiry - 1_000, false),
            ReconcileAction::Restart,
            "a same-ID renewal must restart a capture task that already exited"
        );
        assert_eq!(reconcile_action(Some(&first), &other_id, expiry - 1_000, true), ReconcileAction::Restart);
        assert_eq!(reconcile_action(Some(&first), &inactive, expiry - 1_000, true), ReconcileAction::Stop);
        assert_eq!(reconcile_action(Some(&first), &first, expiry, true), ReconcileAction::Stop);
        assert_eq!(reconcile_action(None, &inactive, expiry - 1_000, false), ReconcileAction::Stop);
    }

    #[test]
    fn only_the_still_active_session_may_send() {
        let id = "bffef4b1-f9b5-4b25-9d4f-864fba88d86d";
        let expiry = player_types::Timestamp::parse("2026-07-30T12:00:15Z").unwrap().unix_millis();
        let active = session(id, true);
        assert!(should_send(active.id.unwrap(), Some(&active), expiry - 1_000));
        assert!(!should_send(active.id.unwrap(), Some(&active), expiry));
        let other = session("0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa", true);
        assert!(!should_send(active.id.unwrap(), Some(&other), expiry - 1_000));
        assert!(!should_send(active.id.unwrap(), None, expiry - 1_000));
        let inactive = session(id, false);
        assert!(!should_send(inactive.id.unwrap(), Some(&inactive), expiry - 1_000));
    }
}
