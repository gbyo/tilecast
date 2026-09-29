//! Studio live preview (M8): the Electron player's `LivePreview`, with the
//! renderer taking the picture.
//!
//! Studio holds a short lease while a screen page is open. The daemon polls
//! it every 15 s and, while it is active, asks the renderer for a bounded
//! JPEG every 20 s (at once on `captureNow`) and uploads it through the
//! ordinary preview endpoint. A preview is not a command and leaves no
//! history.
//!
//! Captures go through the shared [`crate::capture`] broker: one
//! snapshot/encode operation is in flight across preview and Watch Live, and
//! protected states never produce an image. What stays preview-specific is
//! the health policy below: a preview must never cost playback, so a renderer
//! that does not answer a capture in time (it crashed or its main loop
//! stalled) suspends previews for [`FIRST_SUSPENSION`], doubling on each
//! repeat up to [`MAX_SUSPENSION`]; Studio sees `unavailable` meanwhile, and
//! the `renderer.preview` capability says why. A failed Watch Live capture
//! only drops its frame and never engages this suspension.

use std::sync::Arc;
use std::time::{Duration, Instant};

use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortToken};
use edge_protocol::capability::{Capability, CapabilityId, CapabilityState, ids};
use edge_server::player_api::{MAX_PREVIEW_BYTES, PreviewUpload};

use crate::daemon::DaemonContext;

const IDLE_POLL: Duration = Duration::from_secs(15);
const ACTIVE_CAPTURE: Duration = Duration::from_secs(20);
pub const MAX_WIDTH: u32 = 960;
pub const MAX_HEIGHT: u32 = 540;
pub const FIRST_SUSPENSION: Duration = Duration::from_secs(10 * 60);
pub const MAX_SUSPENSION: Duration = Duration::from_secs(6 * 60 * 60);

/// How the last preview captures went, for suspension and the capability.
/// Preview-only: Watch Live never reads or writes this.
#[derive(Debug, Default)]
pub struct Health {
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

    /// `renderer.preview`.
    pub fn capability(&self, observed_at: Timestamp) -> Option<Capability> {
        self.capability_at(Instant::now(), observed_at)
    }

    fn capability_at(&self, now: Instant, observed_at: Timestamp) -> Option<Capability> {
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

/// A checked preview JPEG from the renderer, or why there is none.
async fn capture(context: &DaemonContext) -> Result<(Vec<u8>, u32, u32), &'static str> {
    if context.preview_health.lock().unwrap_or_else(|e| e.into_inner()).suspended(Instant::now()) {
        return Err("preview_suspended");
    }
    context.capture.capture(context, MAX_WIDTH, MAX_HEIGHT, MAX_PREVIEW_BYTES as u32).await
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
        let version = crate::daemon::VERSION;
        let captured_at = serde_json::to_value(context.now()).ok().and_then(|v| v.as_str().map(str::to_owned));
        let started = Instant::now();
        let captured = capture(&context).await;
        let outcome = captured.as_ref().map(|_| ()).map_err(|reason| *reason);
        if outcome != Err("preview_suspended")
            && let Some(pause) =
                context.preview_health.lock().unwrap_or_else(|e| e.into_inner()).record(outcome, Instant::now())
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

/// Preview health state, shared with the capability report.
pub type PreviewHealth = std::sync::Mutex<Health>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unanswered_capture_suspends_previews_with_a_growing_pause() {
        let mut health = Health::default();
        let start = Instant::now();
        let observed = Timestamp::from_unix_millis(0).unwrap();
        assert_eq!(health.capability_at(start, observed).unwrap().state, CapabilityState::Supported);
        assert_eq!(health.record(Ok(()), start), None);
        assert_eq!(health.capability_at(start, observed).unwrap().state, CapabilityState::Available);
        assert_eq!(health.record(Err("renderer_timeout"), start), Some(FIRST_SUSPENSION));
        assert!(health.suspended(start + FIRST_SUSPENSION - Duration::from_secs(1)));
        let blocked = health.capability_at(start, observed).unwrap();
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
        let capability = health.capability_at(now, Timestamp::from_unix_millis(0).unwrap()).unwrap();
        assert_eq!(capability.state, CapabilityState::Degraded);
        assert_eq!(health.record(Err("protected_state"), now), None);
        let capability = health.capability_at(now, Timestamp::from_unix_millis(0).unwrap()).unwrap();
        assert_eq!(
            (capability.state, capability.reason_code.unwrap().as_str()),
            (CapabilityState::Supported, "protected_state")
        );
    }
}
