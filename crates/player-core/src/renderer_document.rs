//! Semantic metadata for opaque Runtime-owned presentations.
use crate::{CaptureState, Expectation, RendererRequirement};
use player_types::{Sha256Digest, bounded::SafeText};
use std::collections::HashMap;

pub const MAX_CONTENT_REFS: usize = 1024;
pub const MAX_EVIDENCE_ITEMS: usize = 500;
pub const MAX_RENDERER_REQUIREMENTS: usize = 256;

/// One immutable verified object authorized for an activation generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentRef {
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: SafeText<127>,
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
