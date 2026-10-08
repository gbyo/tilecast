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
//! stalled) suspends previews for ten minutes, doubling on each
//! repeat up to six hours; Studio sees `unavailable` meanwhile, and
//! the `renderer.preview` capability says why. A failed Watch Live capture
//! only drops its frame and never engages this suspension.

use std::sync::Arc;

use edge_protocol::Timestamp;
use edge_protocol::bounded::ShortToken;
use edge_protocol::capability::Capability;

use crate::daemon::DaemonContext;

/// Edge supplies the provider identity for shared preview capability policy.
pub fn capability(health: &player_core::PreviewHealth, observed_at: Timestamp) -> Option<Capability> {
    let mut capability = health.capability(observed_at)?;
    capability.provider = ShortToken::new("tilecast-renderer-wpe").ok();
    Some(capability)
}

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
        crate::daemon::VERSION
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

/// Preview health state, shared with the capability report.
pub type PreviewHealth = std::sync::Mutex<player_core::PreviewHealth>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_preview_capability_keeps_the_edge_provider() {
        let health = player_core::PreviewHealth::default();
        let capability = capability(&health, Timestamp::from_unix_millis(0).unwrap()).unwrap();
        assert_eq!(capability.provider.unwrap().as_str(), "tilecast-renderer-wpe");
        assert_eq!(capability.reason_code.unwrap().as_str(), "preview_not_requested");
    }
}
