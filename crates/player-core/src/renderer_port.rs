//! Semantic renderer operations. Hosts own queues, encoding and resource grants.
use player_types::{
    bounded::{SafeText, ShortToken},
    ids::ActivationId,
};

use crate::renderer_document::MAX_CONTENT_REFS;
use crate::renderer_resources::{MAX_RESOURCE_BINDINGS, MAX_RUNTIME_PAYLOAD_BYTES};
use crate::{PreparedActivationError, RendererMetadata, RuntimePayload, VerifiedContentRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RendererActivationRef {
    pub activation_id: ActivationId,
    pub generation: u64,
}

/// Immutable prepared data. The host must authorize these verified objects for
/// this generation before exposing them to its renderer, and retire old grants.
#[derive(Debug, Clone, PartialEq)]
pub struct RendererActivation {
    reference: RendererActivationRef,
    document: RuntimePayload,
    metadata: RendererMetadata,
    content: Vec<VerifiedContentRef>,
    runtime_context: Option<RuntimePayload>,
}

impl RendererActivation {
    pub fn new(
        reference: RendererActivationRef,
        document: RuntimePayload,
        metadata: RendererMetadata,
        content: Vec<VerifiedContentRef>,
        runtime_context: Option<RuntimePayload>,
    ) -> Result<Self, PreparedActivationError> {
        metadata.validate()?;
        let payloads = std::iter::once(&document).chain(runtime_context.iter());
        if content.len() > MAX_CONTENT_REFS
            || payloads.clone().map(RuntimePayload::encoded_len).fold(0usize, usize::saturating_add)
                > MAX_RUNTIME_PAYLOAD_BYTES
            || payloads.clone().map(|payload| payload.bindings().len()).sum::<usize>() > MAX_RESOURCE_BINDINGS
        {
            return Err(PreparedActivationError::TooLarge);
        }
        for payload in payloads {
            for binding in payload.bindings() {
                if !content.iter().any(|object| object.sha256 == binding.object) {
                    return Err(PreparedActivationError::UnlistedObject);
                }
            }
        }
        Ok(Self { reference, document, metadata, content, runtime_context })
    }

    pub fn reference(&self) -> RendererActivationRef {
        self.reference
    }

    pub fn document(&self) -> &RuntimePayload {
        &self.document
    }

    pub fn metadata(&self) -> &RendererMetadata {
        &self.metadata
    }

    pub fn incompatibilities(
        &self,
        packaged: &crate::PackagedRendererProfile,
        connected: &crate::ConnectedRendererProfile,
    ) -> Vec<(crate::RendererRequirement, crate::RendererProfileMismatch)> {
        self.metadata
            .requirements
            .iter()
            .filter_map(|requirement| {
                packaged.check_connected(connected, requirement).err().map(|source| (requirement.clone(), source))
            })
            .collect()
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
    #[error("renderer resources could not be authorized")]
    ResourceUnavailable,
    #[error("renderer activation is invalid or no longer authorized")]
    InvalidActivation,
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
    /// Authorize immutable objects for this generation. The host owns resource
    /// transport, expiry clocks, and platform lifecycle configuration.
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

    fn metadata() -> RendererMetadata {
        RendererMetadata {
            requirements: vec![],
            expectations: Default::default(),
            requires_content_evidence: true,
            capture_state: crate::CaptureState::Presentation,
        }
    }

    fn reference() -> RendererActivationRef {
        RendererActivationRef { activation_id: ActivationId::from_uuid(uuid::Uuid::nil()), generation: 1 }
    }

    #[test]
    fn runtime_fields_are_opaque_and_evidence_is_explicit() {
        let object = Sha256Digest::of(b"verified");
        let input = json!({"unknownTransition": {"newVisualOption": 17},
            "website": {"futureOption": true}, "layout": {"futureProperty": "untouched", "media": ""}});
        let payload = RuntimePayload::new(
            input.clone(),
            vec![ObjectBinding { pointer: SafeText::new("/layout/media").unwrap(), object }],
        )
        .unwrap();
        let mut native = metadata();
        native.expectations.insert(SafeText::new("item").unwrap(), crate::Expectation::Still);
        let activation = RendererActivation::new(
            reference(),
            payload,
            native,
            vec![VerifiedContentRef {
                sha256: object,
                size_bytes: 8,
                mime_type: SafeText::new("image/png").unwrap(),
                stream: None,
            }],
            None,
        )
        .unwrap();
        let mut expected = input;
        expected["layout"]["media"] = json!("authorized host resource");
        assert_eq!(activation.document().resolve(|_| Some("authorized host resource".into())).unwrap(), expected);
        assert_eq!(activation.metadata().expectation_for(Some("item")), crate::Expectation::Still);
        assert_eq!(activation.metadata().expectation_for(Some("unknown")), crate::Expectation::Indefinite);
        assert!(activation.document().resolve(|_| None).is_err());
    }

    #[test]
    fn document_and_context_share_total_payload_and_binding_bounds() {
        let object = Sha256Digest::of(b"verified");
        let content = vec![VerifiedContentRef {
            sha256: object,
            size_bytes: 8,
            mime_type: SafeText::new("image/png").unwrap(),
            stream: None,
        }];
        let half = RuntimePayload::new(json!("x".repeat(MAX_RUNTIME_PAYLOAD_BYTES / 2)), vec![]).unwrap();
        assert_eq!(
            RendererActivation::new(reference(), half.clone(), metadata(), content.clone(), Some(half)),
            Err(PreparedActivationError::TooLarge)
        );
        let payload = |count| {
            RuntimePayload::new(
                json!({"resources": vec![""; count]}),
                (0..count)
                    .map(|i| ObjectBinding { pointer: SafeText::new(format!("/resources/{i}")).unwrap(), object })
                    .collect(),
            )
            .unwrap()
        };
        assert_eq!(
            RendererActivation::new(reference(), payload(600), metadata(), content, Some(payload(500))),
            Err(PreparedActivationError::TooLarge)
        );
    }

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
            RendererActivation::new(
                reference,
                RuntimePayload::new(json!({"state": "setup"}), vec![]).unwrap(),
                crate::RendererMetadata {
                    requirements: vec![],
                    expectations: Default::default(),
                    requires_content_evidence: false,
                    capture_state: crate::CaptureState::Setup
                },
                vec![],
                Some(context)
            ),
            Err(PreparedActivationError::UnlistedObject)
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
