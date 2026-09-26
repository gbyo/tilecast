//! Fetching an object from an ordered list of sources (docs/tilecast-edge.md §9.2).
//!
//! For each source in order: open at the partial's offset; if the source
//! answered with the whole object, restart the partial from zero; stream into
//! the partial; commit (full verification). On a transient failure the
//! partial is kept and the next source resumes it, because the identity is
//! the digest, not the source. On an integrity failure the partial is
//! deleted, the source is reported, and the next source starts from zero.
//! The caller decides source order.

use std::sync::Arc;
use std::time::{Duration, Instant};

use edge_protocol::Sha256Digest;
use edge_state::repo::cas::ObjectRecord;
use futures_util::StreamExt as _;
use tokio::sync::Semaphore;

use crate::source::{BlobSource, SourceError, SourceKind};
use crate::store::{CasError, ContentStore, IngestMeta};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchRequest {
    pub digest: Sha256Digest,
    pub size_bytes: u64,
    pub meta: IngestMeta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptOutcome {
    Completed,
    NotFound,
    Unauthorized,
    Transient,
    /// The source's bytes failed verification (wrong size or digest).
    IntegrityFailure,
    ProtocolFailure,
}

/// Per-attempt results, for byte counters and diagnostics. Never used to
/// decide integrity.
pub trait FetchObserver: Send + Sync {
    fn attempt(&self, source: &dyn BlobSource, outcome: AttemptOutcome, bytes: u64, elapsed: Duration);
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("no source could provide the object")]
    Exhausted,
    #[error(transparent)]
    Store(#[from] CasError),
}

/// Bounded-concurrency fetcher over one store.
#[derive(Debug, Clone)]
pub struct Fetcher {
    store: ContentStore,
    permits: Arc<Semaphore>,
    /// Bound on how long a source may go without delivering a byte.
    idle_timeout: Duration,
}

impl Fetcher {
    pub fn new(store: ContentStore, max_concurrent: usize) -> Self {
        Self { store, permits: Arc::new(Semaphore::new(max_concurrent.max(1))), idle_timeout: Duration::from_secs(30) }
    }

    pub fn with_idle_timeout(mut self, timeout: Duration) -> Self {
        self.idle_timeout = timeout;
        self
    }

    pub fn store(&self) -> &ContentStore {
        &self.store
    }

    /// Ensures the object is present and verified, trying `sources` in order.
    pub async fn fetch(
        &self,
        request: &FetchRequest,
        sources: &[Arc<dyn BlobSource>],
        observer: Option<&dyn FetchObserver>,
    ) -> Result<ObjectRecord, FetchError> {
        let _permit = self.permits.acquire().await.map_err(|_| FetchError::Exhausted)?;
        let Some(mut session) =
            self.store.begin_write(request.digest, request.size_bytes, request.meta.clone()).await?
        else {
            return self.store.stat(&request.digest).await?.ok_or(FetchError::Exhausted);
        };
        let mut last_source = String::from("none");
        for source in sources {
            let started = Instant::now();
            let offset = session.offset();
            last_source = source.label();
            let (outcome, bytes) = match source.open(&request.digest, request.size_bytes, offset).await {
                Err(error) => (classify(&error), 0),
                Ok(stream) => {
                    if stream.start != offset {
                        if stream.start != 0 {
                            report(observer, source.as_ref(), AttemptOutcome::ProtocolFailure, 0, started);
                            continue;
                        }
                        session.restart()?;
                    }
                    if stream.total_length.is_some_and(|total| total != request.size_bytes) {
                        report(observer, source.as_ref(), AttemptOutcome::ProtocolFailure, 0, started);
                        continue;
                    }
                    let received = self.pump(&mut session, stream.body).await;
                    let bytes = session.offset().saturating_sub(stream.start);
                    match received {
                        Err(PumpError::Source(error)) => (classify(&error), bytes),
                        Err(PumpError::Store(CasError::TooLarge { .. })) => {
                            session.restart()?;
                            (AttemptOutcome::IntegrityFailure, bytes)
                        }
                        Err(PumpError::Store(error)) => return Err(error.into()),
                        Ok(()) if session.offset() < request.size_bytes => (AttemptOutcome::Transient, bytes),
                        Ok(()) => match session.commit().await {
                            Ok(record) => {
                                report(observer, source.as_ref(), AttemptOutcome::Completed, bytes, started);
                                return Ok(record);
                            }
                            Err(CasError::SizeMismatch { .. } | CasError::DigestMismatch { .. }) => {
                                report(observer, source.as_ref(), AttemptOutcome::IntegrityFailure, bytes, started);
                                tracing::warn!(
                                    component = "cas",
                                    event = "integrity_failure",
                                    sha256 = %request.digest.short(),
                                    source_kind = source.kind().as_str(),
                                    source = %source.label()
                                );
                                // The partial is gone; start over with the next source.
                                session = match self
                                    .store
                                    .begin_write(request.digest, request.size_bytes, request.meta.clone())
                                    .await?
                                {
                                    Some(session) => session,
                                    None => {
                                        return self.store.stat(&request.digest).await?.ok_or(FetchError::Exhausted);
                                    }
                                };
                                continue;
                            }
                            Err(error) => return Err(error.into()),
                        },
                    }
                }
            };
            report(observer, source.as_ref(), outcome, bytes, started);
            tracing::info!(
                component = "cas",
                event = "source_failed",
                sha256 = %request.digest.short(),
                source_kind = source.kind().as_str(),
                outcome = ?outcome
            );
        }
        session.suspend(&last_source).await?;
        Err(FetchError::Exhausted)
    }

    async fn pump(
        &self,
        session: &mut crate::store::WriteSession,
        mut body: futures_util::stream::BoxStream<'static, Result<bytes::Bytes, SourceError>>,
    ) -> Result<(), PumpError> {
        loop {
            match tokio::time::timeout(self.idle_timeout, body.next()).await {
                Err(_) => return Err(PumpError::Source(SourceError::Retryable("source stalled".into()))),
                Ok(None) => return Ok(()),
                Ok(Some(Err(error))) => return Err(PumpError::Source(error)),
                Ok(Some(Ok(chunk))) => session.write(&chunk).map_err(PumpError::Store)?,
            }
        }
    }
}

enum PumpError {
    Source(SourceError),
    Store(CasError),
}

fn classify(error: &SourceError) -> AttemptOutcome {
    match error {
        SourceError::NotFound => AttemptOutcome::NotFound,
        SourceError::Unauthorized => AttemptOutcome::Unauthorized,
        SourceError::Retryable(_) => AttemptOutcome::Transient,
        SourceError::Fatal(_) => AttemptOutcome::ProtocolFailure,
    }
}

fn report(
    observer: Option<&dyn FetchObserver>,
    source: &dyn BlobSource,
    outcome: AttemptOutcome,
    bytes: u64,
    started: Instant,
) {
    if let Some(observer) = observer {
        observer.attempt(source, outcome, bytes, started.elapsed());
    }
}

/// A source that serves a local file. Used for imports and tests.
#[derive(Debug, Clone)]
pub struct LocalFileSource {
    pub path: std::path::PathBuf,
}

#[async_trait::async_trait]
impl BlobSource for LocalFileSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Local
    }

    fn label(&self) -> String {
        "local".into()
    }

    async fn open(&self, _digest: &Sha256Digest, _size: u64, offset: u64) -> Result<crate::SourceStream, SourceError> {
        use tokio::io::AsyncSeekExt as _;
        let mut file = tokio::fs::File::open(&self.path).await.map_err(|_| SourceError::NotFound)?;
        file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| SourceError::Retryable(e.to_string()))?;
        let length = file.metadata().await.map_err(|e| SourceError::Retryable(e.to_string()))?.len();
        let body = futures_util::stream::unfold(file, |mut file| async move {
            use tokio::io::AsyncReadExt as _;
            let mut buffer = vec![0u8; 64 * 1024];
            match file.read(&mut buffer).await {
                Ok(0) => None,
                Ok(n) => {
                    buffer.truncate(n);
                    Some((Ok(bytes::Bytes::from(buffer)), file))
                }
                Err(error) => Some((Err(SourceError::Retryable(error.to_string())), file)),
            }
        });
        Ok(crate::SourceStream { start: offset, total_length: Some(length), body: body.boxed() })
    }
}
