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
        // MJPEG 960x540 from the presented WPE buffer, plus whatever H.264
        // profiles the renderer's encoder probe actually negotiated.
        self.live_encoders.capabilities()
    }
    async fn start_live_encoder(
        &self,
        config: player_core::EncoderConfig,
        sink: player_core::EncodedChunkSink,
    ) -> Result<Box<dyn player_core::LiveEncoder>, player_core::CaptureError> {
        let session = {
            let engine = self.presentation.lock().await;
            let current = engine.current().ok_or(player_core::CaptureError::NothingShown)?;
            current.renderer_metadata.capture_state.check(false)?;
            engine.ready_session().ok_or(player_core::CaptureError::RendererNotReady)?
        };
        self.live_encoders.start(session, config, sink)
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
