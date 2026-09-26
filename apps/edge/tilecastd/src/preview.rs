//! Studio live preview (M8): the Electron player's `LivePreview`, with the
//! renderer taking the picture.
//!
//! Studio holds a short lease while a screen page is open. The daemon polls
//! it every 15 s and, while it is active, asks the renderer for a bounded
//! JPEG every 20 s (at once on `captureNow`) and uploads it through the
//! ordinary preview endpoint. A preview is not a command and leaves no
//! history.
//!
//! Protected states never produce an image: while the screen shows setup,
//! a pairing code or safe mode, the daemon reports `unavailable` without
//! asking the renderer. The renderer answers only a request the daemon sent,
//! and the daemon checks the answer (size, JPEG signature, dimensions)
//! before anything is uploaded.
//!
//! A preview must never cost playback. A renderer that does not answer a
//! capture in time (it crashed or its main loop stalled) suspends previews
//! for [`FIRST_SUSPENSION`], doubling on each repeat up to
//! [`MAX_SUSPENSION`]; Studio sees `unavailable` meanwhile, and the
//! `renderer.preview` capability says why.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortToken};
use edge_protocol::capability::{Capability, CapabilityId, CapabilityState, ids};
use edge_protocol::ipc::event::PreviewOutcome;
use edge_protocol::ipc::presentation::PresentationDocument;
use edge_server::player_api::{MAX_PREVIEW_BYTES, PreviewUpload};
use tokio::sync::oneshot;

use crate::daemon::DaemonContext;
use crate::presentation::ActivationSource;

const IDLE_POLL: Duration = Duration::from_secs(15);
const ACTIVE_CAPTURE: Duration = Duration::from_secs(20);
const RENDERER_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_WIDTH: u32 = 960;
pub const MAX_HEIGHT: u32 = 540;
pub const FIRST_SUSPENSION: Duration = Duration::from_secs(10 * 60);
pub const MAX_SUSPENSION: Duration = Duration::from_secs(6 * 60 * 60);

/// How the last captures went, for suspension and the capability.
#[derive(Debug, Default)]
struct Health {
    /// The last capture's outcome; `None` before the first.
    last: Option<Result<(), &'static str>>,
    /// Consecutive captures the renderer did not answer.
    faults: u32,
    suspended_until: Option<Instant>,
}

impl Health {
    fn suspended(&self, now: Instant) -> bool {
        self.suspended_until.is_some_and(|until| now < until)
    }

    /// Records a capture; returns the suspension it started, if any.
    fn record(&mut self, outcome: Result<(), &'static str>, now: Instant) -> Option<Duration> {
        self.last = Some(outcome);
        match outcome {
            Ok(()) => {
                self.faults = 0;
                None
            }
            Err("renderer_timeout" | "renderer_disconnected") => {
                self.faults = self.faults.saturating_add(1);
                let doubling = 2_u32.saturating_pow(self.faults - 1);
                let pause = FIRST_SUSPENSION.saturating_mul(doubling).min(MAX_SUSPENSION);
                self.suspended_until = Some(now + pause);
                Some(pause)
            }
            Err(_) => None,
        }
    }

    fn capability(&self, now: Instant, observed_at: Timestamp) -> Option<Capability> {
        let (state, reason, detail) = if self.suspended(now) {
            (
                CapabilityState::Blocked,
                Some("preview_suspended_after_renderer_fault"),
                Some(
                    "The renderer did not answer a preview capture; previews are paused so playback is not disturbed.",
                ),
            )
        } else {
            match self.last {
                None => (CapabilityState::Supported, Some("preview_not_requested"), None),
                Some(Ok(())) => (CapabilityState::Available, None, None),
                Some(Err("renderer_unavailable" | "capture_invalid" | "capture_out_of_bounds")) => (
                    CapabilityState::Degraded,
                    Some("renderer_capture_unavailable"),
                    Some("The renderer could not produce a preview image."),
                ),
                Some(Err(reason)) => (CapabilityState::Supported, Some(reason), None),
            }
        };
        let mut capability = Capability::new(CapabilityId::new(ids::RENDERER_PREVIEW).ok()?, state, observed_at);
        capability.provider = ShortToken::new("tilecast-renderer-wpe").ok();
        capability.reason_code = reason.and_then(|r| ShortToken::new(r).ok());
        capability.detail = detail.map(DetailText::lossy);
        Some(capability)
    }
}

/// Preview requests waiting for the renderer's answer, and how captures went.
#[derive(Debug, Default)]
pub struct Waiters {
    pending: std::sync::Mutex<HashMap<uuid::Uuid, oneshot::Sender<PreviewOutcome>>>,
    health: std::sync::Mutex<Health>,
}

impl Waiters {
    fn health(&self) -> std::sync::MutexGuard<'_, Health> {
        self.health.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `renderer.preview`.
    pub fn capability(&self, observed_at: Timestamp) -> Option<Capability> {
        self.health().capability(Instant::now(), observed_at)
    }

    fn register(&self, id: uuid::Uuid) -> oneshot::Receiver<PreviewOutcome> {
        let (tx, rx) = oneshot::channel();
        let mut waiters = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        // Bounded: at most one capture is in flight; stale entries are dropped.
        waiters.retain(|_, sender| !sender.is_closed());
        waiters.insert(id, tx);
        rx
    }

    /// The renderer's answer. An answer nobody asked for is ignored.
    pub fn complete(&self, id: uuid::Uuid, outcome: PreviewOutcome) {
        if let Some(sender) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            let _ = sender.send(outcome);
        }
    }
}

/// A protected state never uploads an image.
fn protected(source: ActivationSource, document: &PresentationDocument) -> bool {
    source == ActivationSource::SafeMode
        || matches!(
            document,
            PresentationDocument::Setup {}
                | PresentationDocument::Pairing { .. }
                | PresentationDocument::SafeMode { .. }
        )
}

/// A checked JPEG from the renderer, or why there is none.
async fn capture(context: &DaemonContext) -> Result<(Vec<u8>, u32, u32), &'static str> {
    if context.preview_waiters.health().suspended(Instant::now()) {
        return Err("preview_suspended");
    }
    let id = uuid::Uuid::new_v4();
    let answer = context.preview_waiters.register(id);
    {
        let engine = context.presentation.lock().await;
        let current = engine.current().ok_or("nothing_shown")?;
        if protected(current.source, &current.document) {
            return Err("protected_state");
        }
        if !engine.request_preview(id, MAX_WIDTH, MAX_HEIGHT, MAX_PREVIEW_BYTES as u32) {
            return Err("renderer_not_ready");
        }
    }
    let outcome = match tokio::time::timeout(RENDERER_TIMEOUT, answer).await {
        Err(_) => return Err("renderer_timeout"),
        Ok(Err(_)) => return Err("renderer_disconnected"),
        Ok(Ok(outcome)) => outcome,
    };
    let (jpeg_base64, width, height) = match outcome {
        PreviewOutcome::Captured { jpeg_base64, width, height } => (jpeg_base64, width, height),
        PreviewOutcome::Unavailable { code } => {
            tracing::info!(component = "preview", event = "renderer_unavailable", code = code.as_str());
            return Err("renderer_unavailable");
        }
    };
    if width == 0 || height == 0 || width > MAX_WIDTH || height > MAX_HEIGHT {
        return Err("capture_out_of_bounds");
    }
    let jpeg = base64::engine::general_purpose::STANDARD.decode(jpeg_base64).map_err(|_| "capture_invalid")?;
    if jpeg.len() <= MAX_PREVIEW_BYTES && jpeg.starts_with(&[0xFF, 0xD8]) {
        Ok((jpeg, width, height))
    } else {
        Err("capture_invalid")
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    let mut server = context.command_server.subscribe();
    let mut ticker = tokio::time::interval(IDLE_POLL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_capture: Option<Instant> = None;
    loop {
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            _ = ticker.tick() => {}
            changed = server.changed() => if changed.is_err() { return },
        }
        let Some(api) = server.borrow().clone() else { continue };
        let Ok(session) = api.preview_session().await else { continue };
        if !session.active {
            continue;
        }
        let interval = ACTIVE_CAPTURE.max(Duration::from_secs(u64::from(session.capture_interval_seconds)));
        let due = session.capture_now || last_capture.is_none_or(|at| at.elapsed() >= interval);
        if !due {
            continue;
        }
        let version = env!("CARGO_PKG_VERSION");
        let captured_at = serde_json::to_value(context.now()).ok().and_then(|v| v.as_str().map(str::to_owned));
        let started = Instant::now();
        let captured = capture(&context).await;
        let outcome = captured.as_ref().map(|_| ()).map_err(|reason| *reason);
        if outcome != Err("preview_suspended")
            && let Some(pause) = context.preview_waiters.health().record(outcome, Instant::now())
        {
            tracing::warn!(
                component = "preview",
                event = "preview_suspended",
                reason = "renderer_fault",
                seconds = pause.as_secs()
            );
        }
        if let Err(reason) = captured {
            tracing::info!(
                component = "preview",
                event = "capture_unavailable",
                reason,
                elapsed_ms = started.elapsed().as_millis() as u64
            );
        }
        let result = match (captured, captured_at) {
            (Ok((jpeg, width, height)), Some(captured_at)) => {
                let upload = PreviewUpload::Image {
                    jpeg: &jpeg,
                    width,
                    height,
                    captured_at: &captured_at,
                    player_version: version,
                };
                api.post_preview(&upload).await
            }
            _ => api.post_preview(&PreviewUpload::Unavailable { player_version: version }).await,
        };
        match result {
            Ok(()) => last_capture = Some(Instant::now()),
            Err(error) => tracing::debug!(component = "preview", event = "upload_failed", reason = error.reason_code()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_pairing_and_safe_mode_are_protected() {
        assert!(protected(ActivationSource::StatusSurface, &PresentationDocument::Setup {}));
        assert!(protected(ActivationSource::SafeMode, &PresentationDocument::Setup {}));
        let pairing = PresentationDocument::Pairing {
            code: edge_protocol::bounded::SafeText::new("ABC123".to_owned()).unwrap(),
            approval_url: edge_protocol::bounded::SafeText::new("https://signs.example.org".to_owned()).unwrap(),
            organization_name: None,
        };
        assert!(protected(ActivationSource::StatusSurface, &pairing));
        let playing =
            PresentationDocument::Playing { items: vec![], takeover: false, generation: 1, synchronized: false };
        assert!(!protected(ActivationSource::ServerManifest, &playing));
    }

    #[test]
    fn an_unanswered_capture_suspends_previews_with_a_growing_pause() {
        let mut health = Health::default();
        let start = Instant::now();
        let observed = Timestamp::from_unix_millis(0).unwrap();
        assert_eq!(health.capability(start, observed).unwrap().state, CapabilityState::Supported);
        assert_eq!(health.record(Ok(()), start), None);
        assert_eq!(health.capability(start, observed).unwrap().state, CapabilityState::Available);
        assert_eq!(health.record(Err("renderer_timeout"), start), Some(FIRST_SUSPENSION));
        assert!(health.suspended(start + FIRST_SUSPENSION - Duration::from_secs(1)));
        let blocked = health.capability(start, observed).unwrap();
        assert_eq!(blocked.state, CapabilityState::Blocked);
        assert_eq!(blocked.reason_code.unwrap().as_str(), "preview_suspended_after_renderer_fault");
        let later = start + FIRST_SUSPENSION;
        assert!(!health.suspended(later));
        assert_eq!(health.record(Err("renderer_disconnected"), later), Some(FIRST_SUSPENSION * 2));
        for _ in 0..20 {
            health.record(Err("renderer_timeout"), later);
        }
        assert_eq!(health.record(Err("renderer_timeout"), later), Some(MAX_SUSPENSION));
        assert_eq!(health.record(Ok(()), later), None, "a good capture resets the count");
        assert_eq!(health.faults, 0);
    }

    #[test]
    fn a_renderer_that_answers_unavailable_degrades_preview_without_suspending_it() {
        let mut health = Health::default();
        let now = Instant::now();
        assert_eq!(health.record(Err("renderer_unavailable"), now), None);
        assert!(!health.suspended(now));
        let capability = health.capability(now, Timestamp::from_unix_millis(0).unwrap()).unwrap();
        assert_eq!(capability.state, CapabilityState::Degraded);
        assert_eq!(health.record(Err("protected_state"), now), None);
        let capability = health.capability(now, Timestamp::from_unix_millis(0).unwrap()).unwrap();
        assert_eq!(
            (capability.state, capability.reason_code.unwrap().as_str()),
            (CapabilityState::Supported, "protected_state")
        );
    }

    #[test]
    fn only_a_requested_answer_is_delivered() {
        let waiters = Waiters::default();
        let id = uuid::Uuid::new_v4();
        let mut answer = waiters.register(id);
        waiters.complete(
            uuid::Uuid::new_v4(),
            PreviewOutcome::Unavailable { code: edge_protocol::bounded::ShortToken::new("x").unwrap() },
        );
        assert!(answer.try_recv().is_err(), "an unrequested answer is ignored");
        waiters
            .complete(id, PreviewOutcome::Unavailable { code: edge_protocol::bounded::ShortToken::new("y").unwrap() });
        assert!(answer.try_recv().is_ok());
    }
}
