//! Loopback HTTP media for opaque sandbox frames.
//!
//! Some engines refuse subresource loads from opaque origins to capability
//! schemes before dispatch, so sandbox frames cannot use `tcmedia:` URLs
//! directly. The daemon serves the same granted bytes over loopback HTTP:
//! the token in the path is the same bearer capability the media socket
//! resolves, grants stay generation-scoped, and every denial is a bare
//! 404 that names nothing. Only media grants resolve here; a frame token
//! answers 404 exactly as a media socket read with the wrong usage would.
//!
//! The listener binds 127.0.0.1 on an ephemeral port. TCP has no peer
//! credentials, so unlike the Unix socket this channel cannot check
//! renderer lineage: token secrecy (256-bit, per activation, never
//! logged) plus the loopback bind is the whole authentication story.
//!
//! Routes: `GET /media/<64hex>` and `HEAD`. Single `Range` requests
//! answer 206; unsatisfiable ranges answer 416; anything else answers
//! 404. No CORS headers: frames embed bytes, never read them.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use edge_cas::ContentStore;
use edge_protocol::time::SharedClock;
use futures_util::stream;
use http_body_util::BodyExt as _;
use http_body_util::combinators::BoxBody;
use hyper::{Method, Request, Response, StatusCode, body::Incoming, header};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::media::{MediaCapability, MediaRegistry, ReadMode};
use crate::media_channel::{ReadExpect, StreamBackend, grant_live, network_read};

pub const LOOPBACK: Ipv4Addr = Ipv4Addr::new(127, 0, 0, 1);
const MAX_CONNECTIONS: usize = 32;
/// Backstop for one connection; chunk and origin reads time out sooner.
const SERVE_TIMEOUT: Duration = Duration::from_secs(60);
const CAS_CHUNK: u64 = 64 * 1024;
const STREAM_CHUNK: u32 = 1024 * 1024;

/// The frame-loadable URL for a granted media token.
pub fn media_url(port: u16, token: &str) -> String {
    format!("http://{LOOPBACK}:{port}/media/{token}")
}

/// The bearer token of an exact `/media/<64hex>` path, else `None`.
/// Query strings never reach here: hyper splits them off the path.
pub fn parse_media_token(path: &str) -> Option<&str> {
    let token = path.strip_prefix("/media/")?;
    if token.contains('/') {
        return None;
    }
    MediaCapability::parse(token).map(|_| token)
}

/// How a `Range` header applies to an object of `size` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeDecision {
    Full,
    Partial { offset: u64, length: u64 },
    Unsatisfiable,
}

/// Interprets one `Range` header. Unknown units, multi-range sets, and
/// malformed values are ignored (RFC 9110: answer 200), because the
/// token already authorizes the bytes. A start past the end is
/// unsatisfiable (416).
pub fn decide_range(value: Option<&str>, size: u64) -> RangeDecision {
    let set = match value.and_then(|header| header.trim().strip_prefix("bytes=")) {
        Some(set) => set.trim(),
        None => return RangeDecision::Full,
    };
    if set.is_empty() || set.contains(',') {
        return RangeDecision::Full;
    }
    let (start, end) = match set.split_once('-') {
        Some(pair) => pair,
        None => return RangeDecision::Full,
    };
    if start.trim().is_empty() {
        let suffix: u64 = match end.trim().parse() {
            Ok(0) | Err(_) => return RangeDecision::Full,
            Ok(suffix) => suffix,
        };
        if size == 0 {
            return RangeDecision::Unsatisfiable;
        }
        let length = suffix.min(size);
        return RangeDecision::Partial { offset: size - length, length };
    }
    let start: u64 = match start.trim().parse() {
        Ok(start) => start,
        Err(_) => return RangeDecision::Full,
    };
    if start >= size {
        return RangeDecision::Unsatisfiable;
    }
    let end = if end.trim().is_empty() {
        size - 1
    } else {
        match end.trim().parse::<u64>() {
            Ok(end) => end.min(size - 1),
            Err(_) => return RangeDecision::Full,
        }
    };
    if end < start {
        return RangeDecision::Full;
    }
    RangeDecision::Partial { offset: start, length: end - start + 1 }
}

#[derive(Debug)]
pub struct LoopbackMedia {
    listener: TcpListener,
    registry: Arc<Mutex<MediaRegistry>>,
    cas: ContentStore,
    clock: SharedClock,
    stream: Option<StreamBackend>,
}

#[derive(Debug, Clone)]
struct State {
    registry: Arc<Mutex<MediaRegistry>>,
    cas: ContentStore,
    clock: SharedClock,
    stream: Option<StreamBackend>,
}

type Body = BoxBody<Bytes, std::convert::Infallible>;

impl LoopbackMedia {
    pub fn bind(
        registry: Arc<Mutex<MediaRegistry>>,
        cas: ContentStore,
        clock: SharedClock,
        stream: Option<StreamBackend>,
    ) -> std::io::Result<Self> {
        let std = std::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(LOOPBACK), 0))?;
        std.set_nonblocking(true)?;
        Ok(Self { listener: TcpListener::from_std(std)?, registry, cas, clock, stream })
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|address| address.port()).unwrap_or(0)
    }

    pub async fn run(self, shutdown: CancellationToken) -> std::io::Result<()> {
        let state = Arc::new(State { registry: self.registry, cas: self.cas, clock: self.clock, stream: self.stream });
        let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                accepted = self.listener.accept() => {
                    let (stream, peer) = match accepted {
                        Ok(value) => value,
                        Err(error) => {
                            tracing::warn!(component = "media", event = "loopback_accept_failed", error = %error);
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                    };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                    let state = state.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let result = tokio::time::timeout(
                            SERVE_TIMEOUT,
                            hyper::server::conn::http1::Builder::new().serve_connection(
                                TokioIo::new(stream),
                                hyper::service::service_fn(|request| handle(state.clone(), request)),
                            ),
                        )
                        .await;
                        if let Ok(Err(error)) = result {
                            tracing::warn!(component = "media", event = "loopback_serve_failed", error = %error);
                        }
                    });
                }
            }
        }
    }
}

async fn handle(state: Arc<State>, request: Request<Incoming>) -> Result<Response<Body>, hyper::Error> {
    Ok(answer(&state, &request).await)
}

fn bare(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, 0)
        .body(http_body_util::Full::new(Bytes::new()).boxed())
        .expect("static response")
}

fn unsatisfied(size: u64) -> Response<Body> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{size}"))
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, 0)
        .body(http_body_util::Full::new(Bytes::new()).boxed())
        .expect("static response")
}

/// One resolved byte source: verified CAS bytes or a live origin read.
enum Source {
    Cached { file: tokio::fs::File },
    Network { backend: StreamBackend, source: player_core::StreamSource },
}

async fn answer(state: &State, request: &Request<Incoming>) -> Response<Body> {
    if *request.method() != Method::GET && *request.method() != Method::HEAD {
        return bare(StatusCode::NOT_FOUND);
    }
    let token = match parse_media_token(request.uri().path()) {
        Some(token) => token.to_owned(),
        None => return bare(StatusCode::NOT_FOUND),
    };
    // Loopback serves media only, against the bound renderer session:
    // a frame token resolves to nothing here, exactly as on the
    // socket, and an unbound renderer denies every token.
    let grant = {
        let registry = match state.registry.lock() {
            Ok(registry) => registry,
            Err(_) => return bare(StatusCode::NOT_FOUND),
        };
        let session = match registry.renderer() {
            Some(renderer) => renderer.session,
            None => return bare(StatusCode::NOT_FOUND),
        };
        match registry.resolve(session, &token, state.clock.now().unix_millis()) {
            Some(grant) if grant.read_mode == ReadMode::Seekable => grant.clone(),
            _ => return bare(StatusCode::NOT_FOUND),
        }
    };
    let session = grant.renderer_session;
    let size = grant.size_bytes;
    let mime = grant.mime_type.clone();
    let cached =
        state.cas.open_verified(&grant.sha256).await.ok().flatten().filter(|(_, record)| record.size_bytes == size);
    let source = match (cached, grant.stream.clone(), state.stream.clone()) {
        (Some((file, _)), _, _) => Source::Cached { file: tokio::fs::File::from_std(file) },
        (None, Some(source), Some(backend)) => Source::Network { backend, source },
        // A grant without bytes and without a network backend stays
        // denied, exactly as on the media socket.
        _ => return bare(StatusCode::NOT_FOUND),
    };
    let range = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
    let (offset, length, partial) = match decide_range(range, size) {
        RangeDecision::Full => (0, size, false),
        RangeDecision::Partial { offset, length } => (offset, length, true),
        RangeDecision::Unsatisfiable => return unsatisfied(size),
    };
    let mut response = Response::builder()
        .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff");
    if partial {
        response = response.header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", offset, offset + length - 1, size));
    }
    if *request.method() == Method::HEAD {
        return response.body(http_body_util::Full::new(Bytes::new()).boxed()).expect("static response");
    }
    let body = match source {
        Source::Cached { mut file } => {
            if offset > 0 && file.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
                return bare(StatusCode::NOT_FOUND);
            }
            let state = state.clone();
            let stream = stream::unfold((file, offset, length), move |(mut file, mut at, mut left)| {
                let state = state.clone();
                let token = token.clone();
                async move {
                    if left == 0 {
                        return None;
                    }
                    // A retirement mid-stream truncates the body rather
                    // than serving bytes the new generation revoked.
                    let live = state.registry.lock().is_ok_and(|registry| {
                        grant_live(&registry, session, &token, ReadExpect::Media, state.clock.now().unix_millis())
                    });
                    if !live {
                        tracing::warn!(component = "media", event = "loopback_grant_retired_mid_stream");
                        return None;
                    }
                    let want = left.min(CAS_CHUNK) as usize;
                    let mut chunk = bytes::BytesMut::zeroed(want);
                    let read = match file.read(&mut chunk).await {
                        Ok(read) => read,
                        Err(error) => {
                            tracing::warn!(component = "media", event = "loopback_read_failed", error = %error);
                            return None;
                        }
                    };
                    if read == 0 {
                        tracing::warn!(component = "media", event = "loopback_object_truncated");
                        return None;
                    }
                    chunk.truncate(read);
                    at += read as u64;
                    left -= read as u64;
                    Some((
                        Ok::<_, std::convert::Infallible>(hyper::body::Frame::data(chunk.freeze())),
                        (file, at, left),
                    ))
                }
            });
            http_body_util::BodyExt::boxed(http_body_util::StreamBody::new(stream))
        }
        Source::Network { backend, source } => {
            let state = state.clone();
            let stream = stream::unfold((offset, length), move |(mut at, mut left)| {
                let state = state.clone();
                let backend = backend.clone();
                let source = source.clone();
                let token = token.clone();
                async move {
                    if left == 0 {
                        return None;
                    }
                    let live = state.registry.lock().is_ok_and(|registry| {
                        grant_live(&registry, session, &token, ReadExpect::Media, state.clock.now().unix_millis())
                    });
                    if !live {
                        tracing::warn!(component = "media", event = "loopback_grant_retired_mid_stream");
                        return None;
                    }
                    let want = left.min(u64::from(STREAM_CHUNK)) as u32;
                    // Re-resolve the grant for the backend call: cheap,
                    // and a concurrent retire ends the stream below.
                    let grant = state.registry.lock().ok().and_then(|registry| {
                        registry.resolve(session, &token, state.clock.now().unix_millis()).cloned()
                    });
                    let grant = match grant {
                        Some(grant) => grant,
                        None => return None,
                    };
                    match network_read(&backend, &grant, &source, at, want).await {
                        Ok(bytes) => {
                            if bytes.is_empty() {
                                return None;
                            }
                            at += bytes.len() as u64;
                            left = left.saturating_sub(bytes.len() as u64);
                            Some((
                                Ok::<_, std::convert::Infallible>(hyper::body::Frame::data(Bytes::from(bytes))),
                                (at, left),
                            ))
                        }
                        Err(error) => {
                            tracing::warn!(component = "media", event = "loopback_origin_read_failed", error = %error);
                            None
                        }
                    }
                }
            });
            http_body_util::BodyExt::boxed(http_body_util::StreamBody::new(stream))
        }
    };
    response.body(body).expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_paths_are_exact_capability_references() {
        let token = "d".repeat(64);
        assert_eq!(parse_media_token(&format!("/media/{token}")), Some(token.as_str()));
        for bad in [
            "/media/short".to_string(),
            format!("/media/{}/extra", "d".repeat(64)),
            format!("/media/{}", "D".repeat(64)),
            "/media/".to_string(),
            "/other".to_string(),
            format!("/media/{token}?x=1"),
        ] {
            assert_eq!(parse_media_token(&bad), None, "{bad}");
        }
        assert!(media_url(8471, &token).starts_with("http://127.0.0.1:8471/media/"));
    }

    #[test]
    fn ranges_follow_rfc_9110() {
        let full = |size| decide_range(None, size);
        assert!(matches!(full(100), RangeDecision::Full));
        let partial = |header: &str, size| match decide_range(Some(header), size) {
            RangeDecision::Partial { offset, length } => (offset, length),
            decision => panic!("{header} on {size}: {decision:?}"),
        };
        assert_eq!(partial("bytes=0-99", 100), (0, 100));
        assert_eq!(partial("bytes=10-19", 100), (10, 10));
        assert_eq!(partial("bytes=90-", 100), (90, 10));
        assert_eq!(partial("bytes=0-", 100), (0, 100));
        assert_eq!(partial("bytes=10-999", 100), (10, 90));
        assert_eq!(partial("bytes=-10", 100), (90, 10));
        assert_eq!(partial("bytes=-200", 100), (0, 100));
        // Malformed and multi-range sets are ignored: the full object.
        for ignored in ["items=0-9", "bytes=0-9,20-29", "bytes=abc", "bytes=5", "bytes=-0", "bytes=20-10"] {
            assert!(matches!(decide_range(Some(ignored), 100), RangeDecision::Full), "{ignored}");
        }
        // A start past the end is unsatisfiable.
        assert!(matches!(decide_range(Some("bytes=100-"), 100), RangeDecision::Unsatisfiable));
        assert!(matches!(decide_range(Some("bytes=0-"), 0), RangeDecision::Unsatisfiable));
        assert!(matches!(decide_range(Some("bytes=-5"), 0), RangeDecision::Unsatisfiable));
    }
}
