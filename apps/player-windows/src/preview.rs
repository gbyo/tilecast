//! Studio live preview: while a Studio screen page holds a short lease,
//! the daemon polls it every 15 s and, while active, captures the final
//! composed window as a bounded JPEG every 20 s (at once on
//! `captureNow`) and uploads it through the ordinary preview endpoint. A
//! preview is not a command and leaves no history.
//!
//! Captures go through the shared [`crate::capture`] broker: one
//! snapshot/encode operation is in flight across preview and Watch Live,
//! and protected states never produce an image. What stays
//! preview-specific is Core's health policy: a preview must never cost
//! playback, so repeated capture failures suspend previews with growing
//! backoff while Studio sees `unavailable`.

use std::sync::Arc;

use player_types::Timestamp;

use crate::daemon::{DaemonContext, VERSION};

#[async_trait::async_trait]
impl player_core::PreviewHost for DaemonContext {
    async fn capture_preview(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<player_core::CapturedFrame, player_core::CaptureError> {
        self.capture.capture_frame(self, max_width, max_height, max_bytes).await
    }
    fn preview_health(&self) -> &std::sync::Mutex<player_core::PreviewHealth> {
        &self.preview_health
    }
    fn now(&self) -> Timestamp {
        DaemonContext::now(self)
    }
    fn player_version(&self) -> &str {
        VERSION
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    player_core::drive_preview(
        Arc::clone(&context),
        context.command_server.subscribe(),
        &context.preview_wake,
        &context.shutdown,
    )
    .await;
}
