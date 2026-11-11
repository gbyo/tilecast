//! Edge services consumed by the shared Watch Live coordinator.
use crate::daemon::DaemonContext;
use std::sync::Arc;

#[async_trait::async_trait]
impl player_core::LiveStreamHost for DaemonContext {
    async fn capture_live_frame(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<player_core::CapturedFrame, player_core::CaptureError> {
        self.capture.capture_frame(self, max_width, max_height, max_bytes).await
    }
    async fn presentation_protected(&self) -> bool {
        presentation_protected(self).await
    }
    fn watch_live_capabilities(&self) -> player_core::WatchLiveCapabilities {
        // Edge captures the presented WPE buffer, which is large enough for
        // the 960x540 MJPEG profile on every supported renderer.
        player_core::WatchLiveCapabilities::new([player_core::WatchLiveProfile::Mjpeg540p10])
    }
    fn now(&self) -> edge_protocol::Timestamp {
        DaemonContext::now(self)
    }
    fn live_outbox(&self) -> &player_core::LiveOutbox {
        &self.live_outbox
    }
}

/// The Edge activation adapter also checks privacy at the actual socket send.
pub(crate) async fn presentation_protected(context: &DaemonContext) -> bool {
    let engine = context.presentation.lock().await;
    engine.current().is_some_and(|active| active.renderer_metadata.capture_state.check(false).is_err())
}

pub async fn run(context: Arc<DaemonContext>) {
    player_core::drive_live_stream(
        Arc::clone(&context),
        context.command_server.subscribe(),
        &context.live_stream_wake,
        &context.shutdown,
    )
    .await;
}
