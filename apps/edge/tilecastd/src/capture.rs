//! Edge request and decode adapter for the shared semantic capture broker.
use base64::Engine as _;
use edge_protocol::ipc::event::PreviewOutcome;
use player_core::{CaptureError, CaptureState, CapturedFrame, RendererCaptureRequest, RendererPortError};

use crate::daemon::DaemonContext;

#[derive(Debug, Default)]
pub struct CaptureBroker(player_core::CaptureBroker);

impl CaptureBroker {
    /// Wire decoding stays in Edge and runs only for a pending capture.
    pub fn complete(&self, id: uuid::Uuid, outcome: PreviewOutcome) {
        self.0.complete_with(id, move |request| decode(request, outcome));
    }

    pub(crate) async fn capture_frame(
        &self,
        context: &DaemonContext,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<CapturedFrame, CaptureError> {
        let frame = self
            .0
            .capture(uuid::Uuid::new_v4(), max_width, max_height, max_bytes, |request| async move {
                let engine = context.presentation.lock().await;
                let current = engine.current().ok_or(CaptureError::NothingShown)?;
                current.renderer_metadata.capture_state.check(false)?;
                if !engine.request_preview(request.request_id, request.max_width, request.max_height, request.max_bytes)
                {
                    return Err(CaptureError::RendererNotReady);
                }
                Ok(())
            })
            .await?;
        // The screen can change to setup, pairing, or safe mode while the
        // renderer produces the frame. Check again before the pixels leave
        // this function so no caller can upload a protected surface.
        let state = context.presentation.lock().await.current().map(|active| active.renderer_metadata.capture_state);
        recheck_after_capture(state, frame)
    }
}

/// Discards a captured frame when the active presentation, as it is now, must
/// not be captured.
fn recheck_after_capture(state: Option<CaptureState>, frame: CapturedFrame) -> Result<CapturedFrame, CaptureError> {
    state.ok_or(CaptureError::NothingShown)?.check(false)?;
    Ok(frame)
}

fn decode(request: RendererCaptureRequest, outcome: PreviewOutcome) -> Result<CapturedFrame, CaptureError> {
    let (jpeg_base64, width, height) = match outcome {
        PreviewOutcome::Captured { jpeg_base64, width, height } => (jpeg_base64, width, height),
        PreviewOutcome::Unavailable { code } => {
            tracing::info!(component = "capture", event = "renderer_unavailable", code = code.as_str());
            return Err(CaptureError::RendererUnavailable);
        }
    };
    request.check_dimensions(width, height).map_err(capture_error)?;
    let jpeg = base64::engine::general_purpose::STANDARD.decode(jpeg_base64).map_err(|_| CaptureError::Invalid)?;
    CapturedFrame::new(request, jpeg, width, height).map_err(capture_error)
}

fn capture_error(error: RendererPortError) -> CaptureError {
    match error {
        RendererPortError::CaptureOutOfBounds => CaptureError::OutOfBounds,
        _ => CaptureError::Invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> CapturedFrame {
        let request =
            RendererCaptureRequest { request_id: uuid::Uuid::nil(), max_width: 640, max_height: 360, max_bytes: 4 };
        CapturedFrame::new(request, vec![0xff, 0xd8, 0xff, 0xd9], 640, 360).unwrap()
    }

    #[test]
    fn a_frame_is_discarded_when_the_screen_became_protected_during_capture() {
        assert!(recheck_after_capture(Some(CaptureState::Presentation), frame()).is_ok());
        for protected in [CaptureState::Setup, CaptureState::Pairing, CaptureState::SafeMode] {
            assert_eq!(recheck_after_capture(Some(protected), frame()), Err(CaptureError::ProtectedState));
        }
        assert_eq!(recheck_after_capture(Some(CaptureState::NothingShown), frame()), Err(CaptureError::NothingShown));
        assert_eq!(recheck_after_capture(None, frame()), Err(CaptureError::NothingShown));
    }

    #[test]
    fn dimensions_are_checked_before_decoding_and_valid_frames_keep_the_wire_shape() {
        let request =
            RendererCaptureRequest { request_id: uuid::Uuid::nil(), max_width: 640, max_height: 360, max_bytes: 4 };
        let malformed = PreviewOutcome::Captured { jpeg_base64: "invalid!".into(), width: 641, height: 360 };
        assert_eq!(decode(request, malformed), Err(CaptureError::OutOfBounds));
        let malformed = PreviewOutcome::Captured { jpeg_base64: "invalid!".into(), width: 640, height: 360 };
        assert_eq!(decode(request, malformed), Err(CaptureError::Invalid));
        let jpeg = vec![0xff, 0xd8, 0xff, 0xd9];
        let valid = PreviewOutcome::Captured {
            jpeg_base64: base64::engine::general_purpose::STANDARD.encode(&jpeg),
            width: 640,
            height: 360,
        };
        let frame = decode(request, valid).unwrap();
        assert_eq!(frame.dimensions(), (640, 360));
        assert_eq!(frame.into_jpeg(), jpeg);
    }
}
