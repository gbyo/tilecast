//! Edge services consumed by the shared Watch Live coordinator.
use crate::daemon::DaemonContext;
use std::sync::Arc;

pub use player_core::LiveFrame;

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
    fn now(&self) -> edge_protocol::Timestamp {
        DaemonContext::now(self)
    }
    fn live_frames(&self) -> &tokio::sync::watch::Sender<Option<LiveFrame>> {
        &self.live_frames
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
