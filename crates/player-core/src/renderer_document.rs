//! Semantic metadata for opaque Runtime-owned presentations.
use crate::{CaptureState, Expectation, RendererRequirement};
use player_types::{Sha256Digest, bounded::SafeText};
use std::collections::HashMap;

pub const MAX_CONTENT_REFS: usize = 1024;
pub const MAX_EVIDENCE_ITEMS: usize = 500;
pub const MAX_RENDERER_REQUIREMENTS: usize = 256;

/// The network backend for one stream-backed object: the manifest's
/// authenticated player download path. The renderer never sees it; the
/// host resolves it to bounded range fetches behind the same capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamSource {
    pub download_path: String,
}

impl StreamSource {
    /// The path comes from a validated manifest; re-validation keeps a
    /// corrupted activation from turning into a network request.
    pub fn new(download_path: String) -> Result<Self, crate::InvalidDownloadPath> {
        crate::OriginBlobSource::validate_path(&download_path)?;
        Ok(Self { download_path })
    }
}

/// One immutable object authorized for an activation generation: a
/// verified CAS object, or (for eligible video) a stream-backed object
/// the host serves through authenticated range fetches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentRef {
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: SafeText<127>,
    pub stream: Option<StreamSource>,
}

/// One verified Widget frame authorized for an activation generation.
/// The digest selects bytes from the frame domain; the package pair
/// identifies the frame table entry the Runtime joins. Frames are
/// always documents; the serving layer names `text/html` itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameRef {
    pub package_id: SafeText<128>,
    pub package_digest: Sha256Digest,
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
}

/// Projection-supplied native semantics. Core never infers these from JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendererMetadata {
    pub requirements: Vec<RendererRequirement>,
    pub expectations: HashMap<SafeText<160>, Expectation>,
    pub requires_content_evidence: bool,
    pub capture_state: CaptureState,
}

impl RendererMetadata {
    pub fn expectation_for(&self, item_id: Option<&str>) -> Expectation {
        item_id
            .and_then(|id| self.expectations.iter().find(|(item, _)| item.as_str() == id))
            .map_or(Expectation::Indefinite, |(_, expectation)| *expectation)
    }

    pub(crate) fn validate(&self) -> Result<(), PreparedActivationError> {
        if self.requirements.len() > MAX_RENDERER_REQUIREMENTS || self.expectations.len() > MAX_EVIDENCE_ITEMS {
            return Err(PreparedActivationError::TooLarge);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PreparedActivationError {
    #[error("prepared activation exceeds its bound")]
    TooLarge,
    #[error("prepared activation references an unlisted object")]
    UnlistedObject,
}
