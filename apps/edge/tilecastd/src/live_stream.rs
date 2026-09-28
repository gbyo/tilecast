//! Studio Watch Live: the Electron player's ephemeral live stream, with the
//! renderer taking the pictures.
//!
//! While Studio holds a live-stream lease, the daemon reconciles
//! `GET /api/v1/player/live-stream-session` (every 15 s idle, every 5 s
//! active, at once on the `live_stream.session_changed` push) and captures
//! the visible Tilecast output at the leased cadence. Each capture is
//! TCLS-encoded and handed to `server_link.rs` — the sole owner of the
//! authenticated WebSocket — through the bounded latest-frame channel, and
//! the server relays it to Studio's existing MJPEG endpoint. Frames and
//! sessions are memory-only and never touch SQLite, the content store,
//! Activity, logs, or proof-of-play.
//!
//! Captures go through the shared [`crate::capture`] broker (one
//! snapshot/encode in flight with periodic Live Preview), but the product
//! policy is separate: a failed capture only drops its frame and never
//! engages the preview's long suspension. A finished capture is re-checked
//! before handoff: if the session was replaced, expired, or the screen
//! entered a protected state while the frame was being produced, the result
//! is discarded.

use std::sync::Arc;
use std::time::{Duration, Instant};

use edge_server::live_stream::{LiveStreamSession, MIN_CAPTURE_PAUSE_MILLIS};

use crate::daemon::DaemonContext;

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

/// Whether the presentation is in a protected state right now. Checked again
/// after each capture: entering setup, pairing, or safe mode while a frame
/// is produced discards the result.
async fn presentation_protected(context: &DaemonContext) -> bool {
    let engine = context.presentation.lock().await;
    engine.current().is_some_and(|active| crate::capture::protected(active.source, &active.document))
}

async fn capture_loop(context: Arc<DaemonContext>, current: Arc<tokio::sync::Mutex<Option<LiveStreamSession>>>) {
    loop {
        let snapshot = current.lock().await.clone();
        let Some(session) = snapshot else { return };
        let Some(id) = session.id else { return };
        if !session.is_active_at(context.now().unix_millis()) {
            return;
        }
        let interval = Duration::from_millis(session.frame_interval_millis);
        let started = Instant::now();
        match context
            .capture
            .capture(&context, session.max_width, session.max_height, session.max_frame_bytes as u32)
            .await
        {
            Ok((jpeg, width, height)) => {
                let fresh = current.lock().await.clone();
                let now = context.now().unix_millis();
                if should_send(id, fresh.as_ref(), now)
                    && !presentation_protected(&context).await
                    && edge_server::live_stream::is_complete_jpeg(&jpeg)
                    && let Some(frame) =
                        edge_server::live_stream::encode_live_stream_frame(&id, now, width, height, &jpeg)
                {
                    context.live_frames.send_replace(Some(LiveFrame { session_id: id, frame }));
                }
            }
            Err(reason) => {
                tracing::debug!(component = "live_stream", event = "capture_dropped", reason);
            }
        }
        if !current.lock().await.clone().is_some_and(|session| session.id == Some(id)) {
            return;
        }
        let delay = capture_delay(interval, started.elapsed());
        tokio::select! {
            () = context.shutdown.cancelled() => return,
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
) -> ReconcileAction {
    if !next.is_active_at(now_unix_millis) {
        return ReconcileAction::Stop;
    }
    match existing {
        Some(session) if session.id == next.id => ReconcileAction::Keep,
        _ => ReconcileAction::Restart,
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    let mut server = context.command_server.subscribe();
    let current: Arc<tokio::sync::Mutex<Option<LiveStreamSession>>> = Arc::new(tokio::sync::Mutex::new(None));
    let mut capture_task: Option<tokio::task::JoinHandle<()>> = None;
    // A fresh sleep is scheduled after every pass: 5 s while streaming, 15 s
    // idle, like the reference players. (A recreated interval would tick at
    // once and reconcile in a tight loop.)
    let mut delay = Duration::ZERO;
    loop {
        tokio::select! {
            () = context.shutdown.cancelled() => {
                abort(&mut capture_task);
                return;
            }
            () = tokio::time::sleep(delay) => {}
            changed = server.changed() => if changed.is_err() {
                abort(&mut capture_task);
                return;
            },
            () = context.live_stream_wake.notified() => {}
        }
        let Some(api) = server.borrow().clone() else {
            abort(&mut capture_task);
            *current.lock().await = None;
            context.live_frames.send_replace(None);
            delay = IDLE_RECONCILE;
            continue;
        };
        let Ok(session) = api.live_stream_session().await else {
            tracing::debug!(component = "live_stream", event = "reconcile_failed");
            delay = IDLE_RECONCILE;
            continue;
        };
        match reconcile_action(current.lock().await.clone().as_ref(), &session, context.now().unix_millis()) {
            ReconcileAction::Stop => {
                abort(&mut capture_task);
                *current.lock().await = None;
                context.live_frames.send_replace(None);
                delay = IDLE_RECONCILE;
            }
            ReconcileAction::Keep => {
                *current.lock().await = Some(session);
                delay = ACTIVE_RECONCILE;
            }
            ReconcileAction::Restart => {
                *current.lock().await = Some(session);
                abort(&mut capture_task);
                let worker_context = Arc::clone(&context);
                let worker_current = Arc::clone(&current);
                capture_task = Some(tokio::spawn(async move { capture_loop(worker_context, worker_current).await }));
                delay = ACTIVE_RECONCILE;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn reconcile_updates_limits_without_restarting_and_restarts_on_replacement() {
        let expiry = edge_protocol::Timestamp::parse("2026-07-30T12:00:15Z").unwrap().unix_millis();
        let first = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", true);
        let same_id = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", true);
        let other_id = session("0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa", true);
        let inactive = session("bffef4b1-f9b5-4b25-9d4f-864fba88d86d", false);
        assert_eq!(reconcile_action(None, &first, expiry - 1_000), ReconcileAction::Restart);
        assert_eq!(reconcile_action(Some(&first), &same_id, expiry - 1_000), ReconcileAction::Keep);
        assert_eq!(reconcile_action(Some(&first), &other_id, expiry - 1_000), ReconcileAction::Restart);
        assert_eq!(reconcile_action(Some(&first), &inactive, expiry - 1_000), ReconcileAction::Stop);
        assert_eq!(reconcile_action(Some(&first), &first, expiry), ReconcileAction::Stop);
        assert_eq!(reconcile_action(None, &inactive, expiry - 1_000), ReconcileAction::Stop);
    }

    #[test]
    fn only_the_still_active_session_may_send() {
        let id = "bffef4b1-f9b5-4b25-9d4f-864fba88d86d";
        let expiry = edge_protocol::Timestamp::parse("2026-07-30T12:00:15Z").unwrap().unix_millis();
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
