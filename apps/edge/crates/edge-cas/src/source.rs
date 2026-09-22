//! Where bytes come from.
//!
//! A [`BlobSource`] opens a byte stream for one object, optionally resuming
//! at an offset. Implementations today: the Tilecast Server origin
//! (`edge-server`), authenticated peers (`edge-cdn`), and local files
//! (legacy import, fixtures). A release-artifact source implements the same
//! trait later.
//!
//! Sources never decide integrity: the store verifies every byte before
//! promotion. A source's only obligations are to report honestly where its
//! stream starts and to classify failures.

use async_trait::async_trait;
use bytes::Bytes;
use edge_protocol::Sha256Digest;
use futures_util::stream::BoxStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Origin,
    Peer,
    Local,
}

impl SourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Origin => "origin",
            Self::Peer => "peer",
            Self::Local => "local",
        }
    }
}

/// An open response body.
pub struct SourceStream {
    /// Offset of the first byte in `body`. Equal to the requested offset when
    /// the source resumed, or 0 when it sent the whole object (for example an
    /// HTTP 200 answering a Range request). The fetcher restarts the partial
    /// in the second case.
    pub start: u64,
    /// Total object length the source claims, if it said.
    pub total_length: Option<u64>,
    pub body: BoxStream<'static, Result<Bytes, SourceError>>,
}

impl std::fmt::Debug for SourceStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceStream").field("start", &self.start).field("total_length", &self.total_length).finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SourceError {
    /// The source does not have this object. Try the next source.
    #[error("object not available from this source")]
    NotFound,
    /// The source refused this node. Try the next source; do not retry soon.
    #[error("source refused the request")]
    Unauthorized,
    /// Transient failure (network, timeout, 5xx). A partial is kept.
    #[error("transient source failure: {0}")]
    Retryable(String),
    /// The source answered in a way that can never succeed (protocol
    /// violation, wrong length). Try the next source.
    #[error("source failure: {0}")]
    Fatal(String),
}

#[async_trait]
pub trait BlobSource: Send + Sync + std::fmt::Debug {
    fn kind(&self) -> SourceKind;
    /// A short identifier for logs and scoring: `origin`, a peer node ID…
    fn label(&self) -> String;
    /// Opens `digest` (of `size` bytes) starting at `offset`.
    async fn open(&self, digest: &Sha256Digest, size: u64, offset: u64) -> Result<SourceStream, SourceError>;
}
