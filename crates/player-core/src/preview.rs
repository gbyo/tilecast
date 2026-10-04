//! Periodic preview fault suspension and capability policy, separate from Watch Live.
use std::time::{Duration, Instant};

use player_types::Timestamp;
use player_types::bounded::{DetailText, ShortToken};
use player_types::capability::{Capability, CapabilityId, CapabilityState, ids};

pub const PREVIEW_FIRST_SUSPENSION: Duration = Duration::from_secs(10 * 60);
pub const PREVIEW_MAX_SUSPENSION: Duration = Duration::from_secs(6 * 60 * 60);

/// How the last preview captures went, for suspension and the capability.
/// Preview-only: Watch Live never reads or writes this.
#[derive(Debug, Default)]
pub struct PreviewHealth {
    /// The last capture's outcome; `None` before the first.
    last: Option<Result<(), &'static str>>,
    /// Consecutive captures the renderer did not answer.
    faults: u32,
    suspended_until: Option<Instant>,
}

impl PreviewHealth {
    pub fn suspended(&self, now: Instant) -> bool {
        self.suspended_until.is_some_and(|until| now < until)
    }

    /// Records a capture; returns the suspension it started, if any.
    pub fn record(&mut self, outcome: Result<(), &'static str>, now: Instant) -> Option<Duration> {
        self.last = Some(outcome);
        match outcome {
            Ok(()) => {
                self.faults = 0;
                None
            }
            Err("renderer_timeout" | "renderer_disconnected") => {
                self.faults = self.faults.saturating_add(1);
                let doubling = 2_u32.saturating_pow(self.faults - 1);
                let pause = PREVIEW_FIRST_SUSPENSION.saturating_mul(doubling).min(PREVIEW_MAX_SUSPENSION);
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

    pub fn capability_at(&self, now: Instant, observed_at: Timestamp) -> Option<Capability> {
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
        capability.reason_code = reason.and_then(|r| ShortToken::new(r).ok());
        capability.detail = detail.map(DetailText::lossy);
        Some(capability)
    }
}

use std::sync::{Arc, Mutex};

use player_client::player_api::{MAX_PREVIEW_BYTES, PreviewSession, PreviewUpload};
use player_client::{AuthenticatedServer, ServerError};

use crate::{CaptureError, CapturedFrame};

const IDLE_POLL: Duration = Duration::from_secs(15);
const ACTIVE_CAPTURE: Duration = Duration::from_secs(20);
pub const PREVIEW_MAX_WIDTH: u32 = 960;
pub const PREVIEW_MAX_HEIGHT: u32 = 540;

/// Services consumed by periodic preview; renderer transport remains host-owned.
#[async_trait::async_trait]
pub trait PreviewHost: Send + Sync {
    async fn capture_preview(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<CapturedFrame, CaptureError>;
    fn preview_health(&self) -> &Mutex<PreviewHealth>;
    fn now(&self) -> Timestamp;
    fn player_version(&self) -> &str;
}

#[async_trait::async_trait]
pub trait PreviewApi: Send + Sync {
    async fn preview_session(&self) -> Result<PreviewSession, ServerError>;
    async fn post_preview(&self, upload: &PreviewUpload<'_>) -> Result<(), ServerError>;
}

#[async_trait::async_trait]
impl PreviewApi for AuthenticatedServer {
    async fn preview_session(&self) -> Result<PreviewSession, ServerError> {
        AuthenticatedServer::preview_session(self).await
    }
    async fn post_preview(&self, upload: &PreviewUpload<'_>) -> Result<(), ServerError> {
        AuthenticatedServer::post_preview(self, upload).await
    }
}

pub async fn drive_preview<H, A>(
    host: Arc<H>,
    mut server: tokio::sync::watch::Receiver<Option<A>>,
    shutdown: &tokio_util::sync::CancellationToken,
) where
    H: PreviewHost + 'static,
    A: PreviewApi + Clone,
{
    let mut ticker = tokio::time::interval(IDLE_POLL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_capture: Option<Instant> = None;
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
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
        let version = host.player_version();
        let captured_at = serde_json::to_value(host.now()).ok().and_then(|v| v.as_str().map(str::to_owned));
        let started = Instant::now();
        let captured = if host.preview_health().lock().unwrap_or_else(|e| e.into_inner()).suspended(Instant::now()) {
            Err("preview_suspended")
        } else {
            host.capture_preview(PREVIEW_MAX_WIDTH, PREVIEW_MAX_HEIGHT, MAX_PREVIEW_BYTES as u32)
                .await
                .map(|frame| {
                    let (width, height) = frame.dimensions();
                    (frame.into_jpeg(), width, height)
                })
                .map_err(CaptureError::reason_code)
        };
        let outcome = captured.as_ref().map(|_| ()).map_err(|reason| *reason);
        if outcome != Err("preview_suspended")
            && let Some(pause) =
                host.preview_health().lock().unwrap_or_else(|e| e.into_inner()).record(outcome, Instant::now())
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Host {
        health: Mutex<PreviewHealth>,
        captures: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl PreviewHost for Host {
        async fn capture_preview(&self, width: u32, height: u32, bytes: u32) -> Result<CapturedFrame, CaptureError> {
            assert_eq!((width, height, bytes), (960, 540, MAX_PREVIEW_BYTES as u32));
            self.captures.fetch_add(1, Ordering::SeqCst);
            Err(CaptureError::RendererTimeout)
        }
        fn preview_health(&self) -> &Mutex<PreviewHealth> {
            &self.health
        }
        fn now(&self) -> Timestamp {
            Timestamp::from_unix_millis(0).unwrap()
        }
        fn player_version(&self) -> &str {
            "test-player"
        }
    }

    #[derive(Clone)]
    struct Api(tokio::sync::mpsc::Sender<bool>);

    #[async_trait::async_trait]
    impl PreviewApi for Api {
        async fn preview_session(&self) -> Result<PreviewSession, ServerError> {
            Ok(PreviewSession { active: true, capture_now: true, capture_interval_seconds: 20 })
        }
        async fn post_preview(&self, upload: &PreviewUpload<'_>) -> Result<(), ServerError> {
            match upload {
                PreviewUpload::Unavailable { player_version } => assert_eq!(*player_version, "test-player"),
                _ => panic!("failed and suspended captures report unavailable"),
            }
            self.0.send(true).await.unwrap();
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn active_preview_lease_reports_faults_and_suspended_requests_without_recapturing() {
        let host = Arc::new(Host { health: Mutex::new(PreviewHealth::default()), captures: AtomicUsize::new(0) });
        let (uploads, mut results) = tokio::sync::mpsc::channel(2);
        let (server, receiver) = tokio::sync::watch::channel(Some(Api(uploads)));
        let shutdown = tokio_util::sync::CancellationToken::new();
        let worker_host = Arc::clone(&host);
        let worker_shutdown = shutdown.clone();
        let worker = tokio::spawn(async move { drive_preview(worker_host, receiver, &worker_shutdown).await });
        results.recv().await.unwrap();
        assert_eq!(host.captures.load(Ordering::SeqCst), 1);
        assert_eq!(host.health.lock().unwrap().faults, 1);
        tokio::time::advance(IDLE_POLL).await;
        results.recv().await.unwrap();
        assert_eq!(host.captures.load(Ordering::SeqCst), 1, "suspension protects playback");
        assert_eq!(host.health.lock().unwrap().faults, 1, "suspension is not another renderer fault");
        shutdown.cancel();
        worker.await.unwrap();
        drop(server);
    }

    #[test]
    fn an_unanswered_capture_suspends_previews_with_a_growing_pause() {
        let mut health = PreviewHealth::default();
        let start = Instant::now();
        let observed = Timestamp::from_unix_millis(0).unwrap();
        assert_eq!(health.capability_at(start, observed).unwrap().state, CapabilityState::Supported);
        assert_eq!(health.record(Ok(()), start), None);
        assert_eq!(health.capability_at(start, observed).unwrap().state, CapabilityState::Available);
        assert_eq!(health.record(Err("renderer_timeout"), start), Some(PREVIEW_FIRST_SUSPENSION));
        assert!(health.suspended(start + PREVIEW_FIRST_SUSPENSION - Duration::from_secs(1)));
        let blocked = health.capability_at(start, observed).unwrap();
        assert_eq!(blocked.state, CapabilityState::Blocked);
        assert_eq!(blocked.reason_code.unwrap().as_str(), "preview_suspended_after_renderer_fault");
        let later = start + PREVIEW_FIRST_SUSPENSION;
        assert!(!health.suspended(later));
        assert_eq!(health.record(Err("renderer_disconnected"), later), Some(PREVIEW_FIRST_SUSPENSION * 2));
        for _ in 0..20 {
            health.record(Err("renderer_timeout"), later);
        }
        assert_eq!(health.record(Err("renderer_timeout"), later), Some(PREVIEW_MAX_SUSPENSION));
        assert_eq!(health.record(Ok(()), later), None, "a good capture resets the count");
        assert_eq!(health.faults, 0);
    }

    #[test]
    fn a_renderer_that_answers_unavailable_degrades_preview_without_suspending_it() {
        let mut health = PreviewHealth::default();
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
