//! Shared renderer-capture broker for Studio still images.
//!
//! Periodic Live Preview and Watch Live both need a bounded JPEG of what the
//! WPE renderer shows. Both go through this broker with their own requested
//! dimensions and byte limits, over the unchanged `preview.request` /
//! `renderer.preview` wire contract: no second WPE capture implementation,
//! and Watch Live never touches the persisted preview upload endpoint.
//!
//! Exactly one snapshot/encode operation is in flight: callers serialize
//! fairly on the broker instead of racing the renderer into `preview_busy`
//! answers or starving each other. Product policy stays with the callers: the
//! preview's long suspension after renderer faults belongs to periodic
//! preview only, and a failed Watch Live capture only drops that frame.
//!
//! Protected states never produce an image: while the screen shows setup, a
//! pairing code or safe mode, capture is refused without asking the renderer.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use edge_protocol::ipc::event::PreviewOutcome;
use edge_protocol::ipc::presentation::PresentationDocument;
use player_core::{CapturedFrame, RendererCaptureRequest, RendererPortError};
use tokio::sync::oneshot;

use crate::daemon::DaemonContext;
use crate::presentation::ActivationSource;

/// How long a caller waits for the renderer's answer. Below the preview's
/// suspension horizon and below the renderer's own capture deadline.
pub const RENDERER_TIMEOUT: Duration = Duration::from_secs(10);

/// Renderer snapshot requests waiting for the renderer's answer. At most one
/// capture is in flight; stale entries are dropped.
#[derive(Debug, Default)]
pub struct CaptureBroker {
    /// Fair serialization: one snapshot/encode operation at a time.
    slot: tokio::sync::Mutex<()>,
    pending: std::sync::Mutex<HashMap<uuid::Uuid, oneshot::Sender<PreviewOutcome>>>,
}

impl CaptureBroker {
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

    /// A checked JPEG from the renderer, or why there is none. Serialized
    /// against every other capture; the renderer's main loop is never
    /// blocked and encoding stays on the renderer's worker thread.
    pub async fn capture(
        &self,
        context: &DaemonContext,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<(Vec<u8>, u32, u32), &'static str> {
        let _slot = self.slot.lock().await;
        let id = uuid::Uuid::new_v4();
        let answer = self.register(id);
        {
            let engine = context.presentation.lock().await;
            let current = engine.current().ok_or("nothing_shown")?;
            if protected(current.source, &current.document) {
                return Err("protected_state");
            }
            if !engine.request_preview(id, max_width, max_height, max_bytes) {
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
                tracing::info!(component = "capture", event = "renderer_unavailable", code = code.as_str());
                return Err("renderer_unavailable");
            }
        };
        let request = RendererCaptureRequest { request_id: id, max_width, max_height, max_bytes };
        request.check_dimensions(width, height).map_err(capture_error)?;
        let jpeg = base64::engine::general_purpose::STANDARD.decode(jpeg_base64).map_err(|_| "capture_invalid")?;
        let frame = CapturedFrame::new(request, jpeg, width, height).map_err(capture_error)?;
        Ok((frame.into_jpeg(), width, height))
    }
}

fn capture_error(error: RendererPortError) -> &'static str {
    match error {
        RendererPortError::CaptureOutOfBounds => "capture_out_of_bounds",
        _ => "capture_invalid",
    }
}

/// A protected state never produces an image.
pub fn protected(source: ActivationSource, document: &PresentationDocument) -> bool {
    source == ActivationSource::SafeMode
        || matches!(
            document,
            PresentationDocument::Setup {}
                | PresentationDocument::Pairing { .. }
                | PresentationDocument::SafeMode { .. }
        )
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
        let playing = PresentationDocument::Playing {
            items: vec![],
            takeover: false,
            generation: 1,
            synchronized: false,
            requires: vec![],
        };
        assert!(!protected(ActivationSource::ServerManifest, &playing));
    }

    #[test]
    fn only_a_requested_answer_is_delivered() {
        let broker = CaptureBroker::default();
        let id = uuid::Uuid::new_v4();
        let mut answer = broker.register(id);
        broker.complete(
            uuid::Uuid::new_v4(),
            PreviewOutcome::Unavailable { code: edge_protocol::bounded::ShortToken::new("x").unwrap() },
        );
        assert!(answer.try_recv().is_err(), "an unrequested answer is ignored");
        broker
            .complete(id, PreviewOutcome::Unavailable { code: edge_protocol::bounded::ShortToken::new("y").unwrap() });
        assert!(answer.try_recv().is_ok());
    }
}
