//! Windows services consumed by the shared Watch Live coordinator: live
//! frames are final-output captures through the shared broker, so Watch
//! Live sees exactly what the compositor shows. A failed capture drops
//! its frame and never suspends anything; only preview engages the
//! suspension policy.

use std::sync::Arc;

use player_types::Timestamp;

use crate::daemon::DaemonContext;

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
        crate::capture::presentation_protected(self)
    }
    fn now(&self) -> Timestamp {
        DaemonContext::now(self)
    }
    fn live_frames(&self) -> &tokio::sync::watch::Sender<Option<LiveFrame>> {
        &self.live_frames
    }
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
