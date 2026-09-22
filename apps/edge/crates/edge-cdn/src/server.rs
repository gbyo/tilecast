//! The peer blob service (RFC §14.3–14.4).
//!
//! HTTPS over mutual TLS 1.3 on the Edge interface. Before any byte is
//! served:
//!
//! 1. the client certificate chains to the pinned installation CA, names
//!    this installation and the node purpose, and its node is not revoked
//!    (the TLS verifier, `edge_identity::tls`);
//! 2. revocation is checked again on every request, so a revocation that
//!    lands during a keep-alive connection applies to the next request;
//! 3. the path is exactly `/v1/blobs/sha256/<64 lowercase hex>` with no
//!    query, and the method is `GET` or `HEAD`;
//! 4. the object exists, is verified, and is marked `peerable`. A missing and
//!    a non-peerable object both answer 404, so peers cannot probe what else
//!    is stored.
//!
//! There is no upload, no listing and no other path. Transfers are bounded
//! by a semaphore (503 with `Retry-After` when saturated) and connections by
//! a second one.

use std::io::SeekFrom;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use edge_cas::ContentStore;
use edge_identity::RevocationSet;
use edge_identity::certificate::parse_identity;
use edge_protocol::{NodeId, Sha256Digest};
use futures_util::TryStreamExt as _;
use http::{HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt as _, Empty, StreamBody, combinators::BoxBody};
use hyper::body::{Frame, Incoming};
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
use tokio::net::TcpListener;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;

use crate::range::{self, RangeRequest};

pub const BLOB_PREFIX: &str = "/v1/blobs/sha256/";
const READ_CHUNK: usize = 64 * 1024;

type Body = BoxBody<Bytes, std::io::Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobServerLimits {
    pub max_connections: usize,
    pub max_transfers: usize,
    pub handshake_timeout: Duration,
    pub header_timeout: Duration,
}

impl Default for BlobServerLimits {
    fn default() -> Self {
        Self {
            max_connections: 64,
            max_transfers: 4,
            handshake_timeout: Duration::from_secs(10),
            header_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TransferGauge {
    transfers: Arc<Semaphore>,
    max: usize,
}

impl TransferGauge {
    pub fn active(&self) -> u32 {
        self.max.saturating_sub(self.transfers.available_permits()) as u32
    }
}

#[derive(Debug)]
struct Shared {
    store: ContentStore,
    revocations: RevocationSet,
    transfers: Arc<Semaphore>,
}

pub struct PeerBlobServer {
    listener: TcpListener,
    acceptor: TlsAcceptor,
    shared: Arc<Shared>,
    limits: BlobServerLimits,
}

impl std::fmt::Debug for PeerBlobServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerBlobServer").field("listener", &self.listener).field("limits", &self.limits).finish()
    }
}

impl PeerBlobServer {
    /// Binds `address`. The caller chooses the Edge interface's address;
    /// Presentation Network interfaces must never be passed here.
    pub async fn bind(
        address: SocketAddr,
        tls: rustls::ServerConfig,
        store: ContentStore,
        revocations: RevocationSet,
        limits: BlobServerLimits,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind(address).await?;
        let shared =
            Arc::new(Shared { store, revocations, transfers: Arc::new(Semaphore::new(limits.max_transfers.max(1))) });
        Ok(Self { listener, acceptor: TlsAcceptor::from(Arc::new(tls)), shared, limits })
    }

    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Transfers in progress, for load reported in availability replies.
    pub fn gauge(&self) -> TransferGauge {
        TransferGauge { transfers: Arc::clone(&self.shared.transfers), max: self.limits.max_transfers.max(1) }
    }

    pub async fn run(self, shutdown: CancellationToken) {
        let connections = Arc::new(Semaphore::new(self.limits.max_connections.max(1)));
        loop {
            let accepted = tokio::select! {
                () = shutdown.cancelled() => return,
                accepted = self.listener.accept() => accepted,
            };
            let Ok((stream, remote)) = accepted else { continue };
            let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else {
                // Over the connection bound: drop without a handshake.
                continue;
            };
            let (acceptor, shared, limits, shutdown) =
                (self.acceptor.clone(), Arc::clone(&self.shared), self.limits, shutdown.clone());
            tokio::spawn(async move {
                let _permit = permit;
                let Ok(Ok(tls)) = tokio::time::timeout(limits.handshake_timeout, acceptor.accept(stream)).await else {
                    return;
                };
                // The verifier already accepted this certificate; parsing it
                // again only extracts the node ID for per-request checks.
                let peer = tls
                    .get_ref()
                    .1
                    .peer_certificates()
                    .and_then(|certificates| certificates.first())
                    .and_then(|certificate| parse_identity(certificate).ok())
                    .map(|identity| identity.node_id);
                let Some(peer) = peer else { return };
                tracing::debug!(component = "cdn", event = "peer_connected", peer = %peer, remote = %remote);
                let service = hyper::service::service_fn(move |request| {
                    let shared = Arc::clone(&shared);
                    async move { Ok::<_, std::convert::Infallible>(handle(&shared, peer, request).await) }
                });
                let connection = hyper::server::conn::http1::Builder::new()
                    .timer(hyper_util::rt::TokioTimer::new())
                    .header_read_timeout(limits.header_timeout)
                    .serve_connection(hyper_util::rt::TokioIo::new(tls), service);
                tokio::pin!(connection);
                tokio::select! {
                    _ = connection.as_mut() => {}
                    () = shutdown.cancelled() => connection.as_mut().graceful_shutdown(),
                }
            });
        }
    }
}

fn empty(status: StatusCode) -> Response<Body> {
    let mut response = Response::new(Empty::new().map_err(|never| match never {}).boxed());
    *response.status_mut() = status;
    response
}

fn digest_from_path(path: &str) -> Option<Sha256Digest> {
    let hex = path.strip_prefix(BLOB_PREFIX)?;
    if hex.len() != 64 || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    Sha256Digest::parse(hex).ok()
}

async fn handle(shared: &Shared, peer: NodeId, request: Request<Incoming>) -> Response<Body> {
    if shared.revocations.is_revoked(&peer) {
        let mut response = empty(StatusCode::FORBIDDEN);
        response.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
        return response;
    }
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        let mut response = empty(StatusCode::METHOD_NOT_ALLOWED);
        response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let digest = match (request.uri().query(), digest_from_path(request.uri().path())) {
        (None, Some(digest)) => digest,
        _ => return empty(StatusCode::NOT_FOUND),
    };
    match shared.store.stat(&digest).await {
        Ok(Some(record)) if record.peerable => {}
        Ok(_) => return empty(StatusCode::NOT_FOUND),
        Err(_) => return empty(StatusCode::SERVICE_UNAVAILABLE),
    }
    let Ok(transfer) = Arc::clone(&shared.transfers).try_acquire_owned() else {
        let mut response = empty(StatusCode::SERVICE_UNAVAILABLE);
        response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
        return response;
    };
    // Re-verifies suspect objects; corrupt bytes are removed, never served.
    let (file, record) = match shared.store.open_verified(&digest).await {
        Ok(Some(opened)) if opened.1.peerable => opened,
        Ok(_) => return empty(StatusCode::NOT_FOUND),
        Err(_) => return empty(StatusCode::SERVICE_UNAVAILABLE),
    };
    let size = record.size_bytes;
    let etag = digest.etag();
    let range_header = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let if_range_matches = request.headers().get(header::IF_RANGE).map(|value| value.to_str().is_ok_and(|v| v == etag));
    // An If-Range that does not match this object means "send it all".
    let requested = match if_range_matches {
        Some(false) => RangeRequest::Full,
        _ => range::parse(range_header, size),
    };
    let (status, start, length) = match requested {
        RangeRequest::Full => (StatusCode::OK, 0, size),
        RangeRequest::Partial { start, end } => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        RangeRequest::Unsatisfiable => {
            let mut response = empty(StatusCode::RANGE_NOT_SATISFIABLE);
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            return response;
        }
        RangeRequest::Invalid => return empty(StatusCode::BAD_REQUEST),
    };

    let mut response = if head {
        empty(status)
    } else {
        match body(file, start, length, transfer).await {
            Ok(body) => {
                let mut response = Response::new(body);
                *response.status_mut() = status;
                response
            }
            Err(_) => return empty(StatusCode::SERVICE_UNAVAILABLE),
        }
    };
    let headers = response.headers_mut();
    let mut set = |name: header::HeaderName, value: String| {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(name, value);
        }
    };
    set(header::ETAG, etag);
    set(header::ACCEPT_RANGES, "bytes".into());
    set(header::CACHE_CONTROL, "public, immutable".into());
    set(header::CONTENT_TYPE, "application/octet-stream".into());
    set(header::CONTENT_LENGTH, length.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        set(header::CONTENT_RANGE, format!("bytes {start}-{}/{size}", start + length - 1));
    }
    tracing::debug!(component = "cdn", event = "serve", peer = %peer, sha256 = %digest.short(), start, length);
    response
}

/// Streams `length` bytes from `start`, holding the transfer permit until
/// the body is dropped.
async fn body(file: std::fs::File, start: u64, length: u64, permit: OwnedSemaphorePermit) -> std::io::Result<Body> {
    let mut file = tokio::fs::File::from_std(file);
    file.seek(SeekFrom::Start(start)).await?;
    let reader = file.take(length);
    let stream = tokio_util::io::ReaderStream::with_capacity(reader, READ_CHUNK).map_ok(move |chunk| {
        let _held = &permit;
        Frame::data(chunk)
    });
    Ok(StreamBody::new(stream).boxed())
}
