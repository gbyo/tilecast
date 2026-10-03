//! Semantic renderer operations. Hosts own queues, encoding and resource grants.
use player_types::{
    bounded::{SafeText, ShortToken},
    ids::ActivationId,
};

use crate::{PreparedDocument, PreparedDocumentError, RuntimePayload, VerifiedContentRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RendererActivationRef {
    pub activation_id: ActivationId,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RendererConfiguration {
    pub prevent_display_sleep: bool,
    pub hide_cursor: bool,
}

/// Immutable prepared data. The host must authorize these verified objects for
/// this generation before exposing them to its renderer, and retire old grants.
#[derive(Debug, Clone, PartialEq)]
pub struct RendererActivation {
    reference: RendererActivationRef,
    document: PreparedDocument,
    content: Vec<VerifiedContentRef>,
    runtime_context: Option<RuntimePayload>,
}

impl RendererActivation {
    pub fn new(
        reference: RendererActivationRef,
        document: PreparedDocument,
        content: Vec<VerifiedContentRef>,
        runtime_context: Option<RuntimePayload>,
    ) -> Result<Self, PreparedDocumentError> {
        document.validate(&content)?;
        if let Some(context) = &runtime_context {
            for binding in context.bindings() {
                if !content.iter().any(|object| object.sha256 == binding.object) {
                    return Err(PreparedDocumentError::UnlistedObject);
                }
            }
        }
        Ok(Self { reference, document, content, runtime_context })
    }

    pub fn reference(&self) -> RendererActivationRef {
        self.reference
    }

    pub fn document(&self) -> &PreparedDocument {
        &self.document
    }

    pub fn content(&self) -> &[VerifiedContentRef] {
        &self.content
    }

    pub fn runtime_context(&self) -> Option<&RuntimePayload> {
        self.runtime_context.as_ref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SemanticRendererCommand {
    RetryItem,
    SkipItem,
    Reload,
    ClearWebsiteData,
    Identify { name: SafeText<120>, duration_seconds: u32 },
}

/// The request limits are semantic; the host must bound its transport reads too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RendererCaptureRequest {
    pub request_id: uuid::Uuid,
    pub max_width: u32,
    pub max_height: u32,
    pub max_bytes: u32,
}

impl RendererCaptureRequest {
    pub fn check_dimensions(self, width: u32, height: u32) -> Result<(), RendererPortError> {
        if width == 0 || height == 0 || width > self.max_width || height > self.max_height {
            Err(RendererPortError::CaptureOutOfBounds)
        } else {
            Ok(())
        }
    }
}

/// Decoded image bytes. Base64 and framing belong to the host adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedFrame {
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RendererPortError {
    #[error("renderer is not ready")]
    NotReady,
    #[error("renderer operation could not be queued")]
    QueueUnavailable,
    #[error("renderer capture exceeds requested dimensions")]
    CaptureOutOfBounds,
    #[error("renderer capture is invalid")]
    CaptureInvalid,
}

impl CapturedFrame {
    pub fn new(
        request: RendererCaptureRequest,
        jpeg: Vec<u8>,
        width: u32,
        height: u32,
    ) -> Result<Self, RendererPortError> {
        request.check_dimensions(width, height)?;
        if jpeg.len() > request.max_bytes as usize || !jpeg.starts_with(&[0xff, 0xd8]) {
            return Err(RendererPortError::CaptureInvalid);
        }
        Ok(Self { jpeg, width, height })
    }

    pub fn jpeg(&self) -> &[u8] {
        &self.jpeg
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn into_jpeg(self) -> Vec<u8> {
        self.jpeg
    }
}

/// One live renderer endpoint. Each operation queues bounded work without
/// blocking Core on renderer execution. Results arrive as semantic reports.
/// A host must reject stale endpoints and must never send Player credentials.
pub trait RendererPort: Send + Sync {
    fn configure(&self, configuration: RendererConfiguration) -> Result<(), RendererPortError>;
    fn activate(&self, activation: &RendererActivation) -> Result<(), RendererPortError>;
    fn clear(&self, reason: &ShortToken) -> Result<(), RendererPortError>;
    fn send_command(&self, command_id: uuid::Uuid, command: &SemanticRendererCommand) -> Result<(), RendererPortError>;
    fn request_capture(&self, request: RendererCaptureRequest) -> Result<(), RendererPortError>;
    fn request_restart(&self, reason: &ShortToken, deadline_ms: u32) -> Result<(), RendererPortError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ObjectBinding;
    use player_types::Sha256Digest;
    use serde_json::json;

    #[test]
    fn runtime_context_cannot_authorize_objects_outside_the_prepared_list() {
        let context = RuntimePayload::new(
            json!({"logo": ""}),
            vec![ObjectBinding { pointer: SafeText::new("/logo").unwrap(), object: Sha256Digest::of(b"unlisted") }],
        )
        .unwrap();
        let reference =
            RendererActivationRef { activation_id: ActivationId::from_uuid(uuid::Uuid::nil()), generation: 1 };
        assert_eq!(
            RendererActivation::new(reference, PreparedDocument::Setup {}, vec![], Some(context)),
            Err(PreparedDocumentError::UnlistedObject)
        );
    }

    #[test]
    fn decoded_capture_checks_dimensions_bytes_and_jpeg_signature() {
        let request =
            RendererCaptureRequest { request_id: uuid::Uuid::nil(), max_width: 640, max_height: 360, max_bytes: 4 };
        let jpeg = vec![0xff, 0xd8, 0xff, 0xd9];
        let frame = CapturedFrame::new(request, jpeg.clone(), 640, 360).unwrap();
        assert_eq!(frame.dimensions(), (640, 360));
        assert_eq!(frame.into_jpeg(), jpeg);
        assert_eq!(CapturedFrame::new(request, jpeg.clone(), 641, 360), Err(RendererPortError::CaptureOutOfBounds));
        assert_eq!(CapturedFrame::new(request, jpeg, 640, 0), Err(RendererPortError::CaptureOutOfBounds));
        assert_eq!(
            CapturedFrame::new(request, vec![0xff, 0xd8, 1, 2, 3], 1, 1),
            Err(RendererPortError::CaptureInvalid)
        );
        assert_eq!(CapturedFrame::new(request, vec![1, 2, 3], 1, 1), Err(RendererPortError::CaptureInvalid));
    }
}
