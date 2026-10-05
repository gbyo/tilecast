//! Android services consumed by the shared Watch Live coordinator.
//!
//! The coordinator reconciles the Studio lease, captures the visible
//! output at the leased cadence through the shared capture broker,
//! and hands TCLS-encoded frames to the socket owner. This host owns
//! renderer transport only: the pre-checks match the preview host so
//! a protected screen refuses before any capture is queued.

use std::sync::Arc;

use player_core::{CaptureBroker, CaptureError, CapturedFrame, RendererPort, RendererPortError};
use player_types::Timestamp;
use player_types::time::SharedClock;
use tokio::sync::{Mutex, watch};

use crate::renderer::PresentationEngine;

pub struct AndroidLiveStreamHost {
    engine: Arc<Mutex<PresentationEngine>>,
    broker: Arc<CaptureBroker>,
    clock: SharedClock,
    live_frames: watch::Sender<Option<player_core::LiveFrame>>,
}

impl std::fmt::Debug for AndroidLiveStreamHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("AndroidLiveStreamHost").finish_non_exhaustive()
    }
}

impl AndroidLiveStreamHost {
    pub fn new(
        engine: Arc<Mutex<PresentationEngine>>,
        broker: Arc<CaptureBroker>,
        clock: SharedClock,
        live_frames: watch::Sender<Option<player_core::LiveFrame>>,
    ) -> Self {
        Self { engine, broker, clock, live_frames }
    }
}

#[async_trait::async_trait]
impl player_core::LiveStreamHost for AndroidLiveStreamHost {
    async fn capture_live_frame(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<CapturedFrame, CaptureError> {
        let port = {
            let engine = self.engine.lock().await;
            engine.capture_state().ok_or(CaptureError::NothingShown)?.check(false)?;
            if !engine.renderer_is_ready() {
                return Err(CaptureError::RendererNotReady);
            }
            engine.port().clone()
        };
        self.broker
            .capture(uuid::Uuid::new_v4(), max_width, max_height, max_bytes, |request| async move {
                port.request_capture(request).map_err(|error| match error {
                    RendererPortError::NotReady => CaptureError::RendererNotReady,
                    RendererPortError::QueueUnavailable => CaptureError::RendererUnavailable,
                    _ => CaptureError::Invalid,
                })
            })
            .await
    }

    async fn presentation_protected(&self) -> bool {
        self.engine.lock().await.capture_state().is_some_and(|state| state.check(false).is_err())
    }

    fn now(&self) -> Timestamp {
        self.clock.now()
    }

    fn live_frames(&self) -> &watch::Sender<Option<player_core::LiveFrame>> {
        &self.live_frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::{LruByDomain, StorePolicy};
    use player_core::LiveStreamHost as _;
    use player_state::{OpenOptions, StateDb};

    use crate::renderer::{AndroidRendererPort, MemRendererPlatform, RendererSnapshot};

    async fn host() -> (AndroidLiveStreamHost, Arc<Mutex<PresentationEngine>>) {
        let dir = tempfile::tempdir().expect("tempdir");
        // The store borrows nothing from the directory handle after open;
        // leaking keeps the paths alive for the engine's lifetime.
        let dir = Box::leak(Box::new(dir));
        let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).expect("state");
        let clock: SharedClock = Arc::new(crate::host::SystemClock);
        let store = player_cas::ContentStore::open(
            dir.path().join("cas"),
            dir.path().join("partial"),
            db,
            clock.clone(),
            Arc::new(crate::host::StatvfsProbe),
            Arc::new(crate::host::AndroidSecureOpener),
            StorePolicy { limit_bytes: 8 * 1024 * 1024, reserved_free_bytes: 0 },
            Arc::new(LruByDomain),
        )
        .await
        .expect("store open");
        let platform = Arc::new(MemRendererPlatform::default());
        let snapshot = Arc::new(std::sync::Mutex::new(RendererSnapshot::default()));
        let engine = Arc::new(Mutex::new(PresentationEngine::new(
            AndroidRendererPort::new(platform, store),
            clock.clone(),
            snapshot,
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Timestamp::from_unix_millis(1_700_000_000_000).expect("time"),
        )));
        let broker = Arc::new(CaptureBroker::default());
        let (frames, _) = watch::channel(None);
        let host = AndroidLiveStreamHost::new(engine.clone(), broker, clock, frames);
        (host, engine)
    }

    #[tokio::test]
    async fn live_capture_refuses_without_a_shown_presentation() {
        let (host, _) = host().await;
        // Nothing is shown yet, so there is nothing to photograph.
        assert_eq!(host.capture_live_frame(320, 180, 100_000).await.expect_err("refused"), CaptureError::NothingShown);
        assert!(!host.presentation_protected().await);
    }

    #[tokio::test]
    async fn live_capture_refuses_while_the_renderer_is_not_ready() {
        let (host, engine) = host().await;
        {
            let mut locked = engine.lock().await;
            locked.renderer_connected(1, Timestamp::from_unix_millis(1_700_000_000_000).expect("time"));
            // Connected but never ready: the page cannot take pictures.
            locked
                .activate_request(
                    crate::renderer::ActivateRequest {
                        envelope: serde_json::json!({
                            "presentation": {"state": "playing", "items": [{"id": "item-1", "kind": "image", "src": ""}]},
                        }),
                        content: Vec::new(),
                        source: player_core::ActivationSource::ServerManifest,
                        identity: None,
                        clock_offset_ms: 0,
                    },
                    Timestamp::from_unix_millis(1_700_000_000_000).expect("time"),
                )
                .await
                .expect("stored");
        }
        assert_eq!(
            host.capture_live_frame(320, 180, 100_000).await.expect_err("refused"),
            CaptureError::RendererNotReady
        );
        // A playing presentation is photographable, just not yet.
        assert!(!host.presentation_protected().await);
    }
}
