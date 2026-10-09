//! The Tilecast Server as a CAS source.
//!
//! Resume semantics are the Linux player's (`core/download.ts`): resume with
//! `Range` guarded by `If-Range: <strong validator>`; a `200` answer to a
//! range request restarts from zero; `401/403` and `404/410` are final for
//! this source; everything else is transient. The store verifies every byte.

use async_trait::async_trait;
use futures_util::StreamExt as _;
use player_cas::{BlobSource, SourceError, SourceKind, SourceStream};
pub use player_client::download::InvalidDownloadPath;
use player_client::download::PlayerDownloadPath;
use player_types::Sha256Digest;

use player_client::AuthenticatedServer;

/// One object at an authenticated player download path, such as a manifest
/// asset variant (`/api/v1/player/assets/<asset>/variants/<variant>`).
#[derive(Debug, Clone)]
pub struct OriginBlobSource {
    server: AuthenticatedServer,
    path: PlayerDownloadPath,
}

impl OriginBlobSource {
    /// `path` comes from a server manifest; it must stay inside the player
    /// API and carry no query, fragment or dot segments.
    pub fn new(server: AuthenticatedServer, path: &str) -> Result<Self, InvalidDownloadPath> {
        Ok(Self { server, path: PlayerDownloadPath::parse(path)? })
    }

    /// Validates an origin path before a manifest is accepted or persisted.
    pub fn validate_path(path: &str) -> Result<(), InvalidDownloadPath> {
        PlayerDownloadPath::parse(path).map(|_| ())
    }

    /// Reads exactly `length` bytes at `offset` for one bounded media
    /// request. Only an exact `206` whose Content-Range start, end, and
    /// total match the manifest claim is accepted; a `200` (Range
    /// ignored), `416`, wrong range, wrong total, or a changed ETag
    /// fails closed. The caller bounds `length` and times the read out.
    pub async fn read_exact(
        &self,
        digest: &Sha256Digest,
        size: u64,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, StreamReadError> {
        let end = offset
            .checked_add(length)
            .and_then(|past| past.checked_sub(1))
            .filter(|_| length > 0)
            .ok_or(StreamReadError::RangeRejected)?;
        if end >= size {
            return Err(StreamReadError::RangeRejected);
        }
        let tag = validator(digest);
        let response =
            self.server.get_bounded_range(&self.path, offset, end, &tag).await.map_err(|_| StreamReadError::Network)?;
        match response.status().as_u16() {
            206 => {}
            401 | 403 => return Err(StreamReadError::Unauthorized),
            404 | 410 => return Err(StreamReadError::NotFound),
            // 200, 301 (redirects are never followed), 416, 5xx: any
            // answer that is not an exact 206 is unusable as evidence.
            _ => return Err(StreamReadError::RangeRejected),
        }
        let range = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(content_range_exact)
            .ok_or(StreamReadError::RangeRejected)?;
        if range != (offset, end, size) {
            return Err(StreamReadError::RangeRejected);
        }
        if let Some(etag) = response.headers().get(reqwest::header::ETAG).and_then(|value| value.to_str().ok())
            && etag != tag
        {
            return Err(StreamReadError::RangeRejected);
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| StreamReadError::Network)?;
            if body.len() as u64 + chunk.len() as u64 > length {
                return Err(StreamReadError::RangeRejected);
            }
            body.extend_from_slice(&chunk);
        }
        if body.len() as u64 != length {
            return Err(StreamReadError::Truncated);
        }
        Ok(body)
    }
}

/// The server's media ETag for a variant (`media.ETag`).
fn validator(digest: &Sha256Digest) -> String {
    format!("\"sha256-{}\"", digest.to_hex())
}

fn content_range_start(value: &str) -> Option<u64> {
    value.strip_prefix("bytes ")?.split('-').next()?.parse().ok()
}

/// Parses `bytes <start>-<end>/<total>` exactly. Anything else (unit
/// changes, `*` lengths, suffix ranges) is unusable as evidence.
fn content_range_exact(value: &str) -> Option<(u64, u64, u64)> {
    let rest = value.strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    if start.is_empty() || end.is_empty() || total.is_empty() {
        return None;
    }
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

/// A typed stream-backed media failure. Every variant fails closed: the
/// renderer sees a read error and its normal skip/fallback policy answers.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum StreamReadError {
    /// The server rejected the device credential mid-read.
    #[error("the server rejected the device credential")]
    Unauthorized,
    /// The variant is gone from the origin.
    #[error("the origin no longer has the media")]
    NotFound,
    /// Anything but an exact 206: 200 (Range ignored), 416, a wrong
    /// Content-Range, a wrong total, or a changed validator.
    #[error("the origin range answer did not match the manifest claim")]
    RangeRejected,
    /// Fewer bytes than the accepted range promised.
    #[error("the origin stream ended early")]
    Truncated,
    /// Transport failure or timeout.
    #[error("the origin could not be reached")]
    Network,
}

impl StreamReadError {
    /// Bounded machine-readable reason for the media-channel reply and logs.
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Unauthorized => "credential_rejected",
            Self::NotFound => "origin_not_found",
            Self::RangeRejected => "range_rejected",
            Self::Truncated => "stream_truncated",
            Self::Network => "origin_unreachable",
        }
    }
}

#[async_trait]
impl BlobSource for OriginBlobSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Origin
    }

    fn label(&self) -> String {
        "origin".into()
    }

    async fn open(&self, digest: &Sha256Digest, size: u64, offset: u64) -> Result<SourceStream, SourceError> {
        let tag = validator(digest);
        let response = self
            .server
            .get_range(&self.path, offset, Some(&tag))
            .await
            .map_err(|e| SourceError::Retryable(e.reason_code().into()))?;
        let status = response.status().as_u16();
        let start = match status {
            200 => 0,
            206 => {
                let start = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(content_range_start)
                    .ok_or_else(|| SourceError::Fatal("206 without a usable Content-Range".into()))?;
                if start != offset {
                    return Err(SourceError::Fatal("range started at the wrong offset".into()));
                }
                start
            }
            401 | 403 => return Err(SourceError::Unauthorized),
            404 | 410 => return Err(SourceError::NotFound),
            _ => return Err(SourceError::Retryable(format!("http_{status}"))),
        };
        let total = if status == 200 { response.content_length() } else { Some(size) };
        let body = response.bytes_stream().map(|chunk| chunk.map_err(|_| SourceError::Retryable("read failed".into())));
        Ok(SourceStream { start, total_length: total, body: body.boxed() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::{BodyExt, Full, StreamBody};
    use hyper::body::Incoming;
    use hyper::{Request, Response, StatusCode};
    use std::convert::Infallible;
    use std::sync::Mutex;

    #[test]
    fn content_range_parsing() {
        assert_eq!(content_range_start("bytes 100-199/200"), Some(100));
        assert_eq!(content_range_start("items 1-2/3"), None);
        assert_eq!(content_range_exact("bytes 2-5/100"), Some((2, 5, 100)));
        assert_eq!(content_range_exact("bytes 2-/100"), None);
        assert_eq!(content_range_exact("bytes 2-5/*"), None);
        assert_eq!(content_range_exact("bytes */100"), None);
        assert_eq!(content_range_exact("items 2-5/100"), None);
    }

    type BoxBody = http_body_util::combinators::BoxBody<bytes::Bytes, std::io::Error>;

    fn boxed(body: Full<bytes::Bytes>) -> BoxBody {
        body.map_err(std::io::Error::other).boxed()
    }

    struct Script {
        status: StatusCode,
        content_range: Option<String>,
        etag: Option<String>,
        body: Vec<u8>,
        /// End the body cleanly short (truncation) or with a transport
        /// error (connection lost) instead of sending it whole.
        short: bool,
        error_after: bool,
    }

    impl Script {
        fn ok(content_range: &str, etag: &str, body: &[u8]) -> Self {
            Self {
                status: StatusCode::PARTIAL_CONTENT,
                content_range: Some(content_range.to_owned()),
                etag: Some(etag.to_owned()),
                body: body.to_vec(),
                short: false,
                error_after: false,
            }
        }

        fn status(status: StatusCode) -> Self {
            Self { status, content_range: None, etag: None, body: Vec::new(), short: false, error_after: false }
        }
    }

    struct Mock {
        installation: String,
        script: Mutex<Script>,
        seen: Mutex<Vec<(Option<String>, Option<String>)>>,
    }

    async fn handle(mock: std::sync::Arc<Mock>, request: Request<Incoming>) -> Result<Response<BoxBody>, Infallible> {
        if request.uri().path() == "/api/v1/system/identity" {
            let body = serde_json::json!({"data": {
                "product": "Tilecast", "installationId": mock.installation,
                "organizationName": "Test", "apiVersion": "v1", "pairingEnabled": false,
            }})
            .to_string();
            return Ok(Response::new(boxed(Full::new(bytes::Bytes::from(body)))));
        }
        let range = request.headers().get(hyper::header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let if_range = request.headers().get(hyper::header::IF_RANGE).and_then(|v| v.to_str().ok()).map(str::to_owned);
        mock.seen.lock().unwrap().push((range, if_range));
        let script = mock.script.lock().unwrap();
        let mut response = if script.error_after {
            let half = bytes::Bytes::from(script.body[..script.body.len() / 2].to_vec());
            let frames = futures_util::stream::iter([Ok(hyper::body::Frame::data(half))])
                .chain(futures_util::stream::once(async { Err(std::io::Error::other("connection lost")) }));
            Response::new(BodyExt::boxed(StreamBody::new(frames)))
        } else if script.short {
            let frames =
                futures_util::stream::iter([Ok(hyper::body::Frame::data(bytes::Bytes::from(script.body.clone())))]);
            Response::new(BodyExt::boxed(StreamBody::new(frames)))
        } else {
            Response::new(boxed(Full::new(bytes::Bytes::from(script.body.clone()))))
        };
        *response.status_mut() = script.status;
        if let Some(range) = &script.content_range {
            response.headers_mut().insert(hyper::header::CONTENT_RANGE, range.parse().unwrap());
        }
        if let Some(etag) = &script.etag {
            response.headers_mut().insert(hyper::header::ETAG, etag.parse().unwrap());
        }
        Ok(response)
    }

    async fn serving(script: Script) -> (String, std::sync::Arc<Mock>, tokio::task::JoinHandle<()>) {
        let installation = player_types::InstallationId::from_uuid(uuid::Uuid::from_u128(7));
        let mock = std::sync::Arc::new(Mock {
            installation: installation.to_string(),
            script: Mutex::new(script),
            seen: Mutex::new(Vec::new()),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let serving = std::sync::Arc::clone(&mock);
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let serving = std::sync::Arc::clone(&serving);
                let service =
                    hyper::service::service_fn(move |request| handle(std::sync::Arc::clone(&serving), request));
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            }
        });
        let url = format!("http://{address}");
        let client = player_client::ServerClient::new(&url, "test").unwrap();
        let credential = player_client::DeviceCredential::parse(
            "tc_device_abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        )
        .unwrap();
        client.verify_installation(installation, credential).await.unwrap();
        (url, mock, task)
    }

    async fn source_for(url: &str) -> OriginBlobSource {
        let installation = player_types::InstallationId::from_uuid(uuid::Uuid::from_u128(7));
        let client = player_client::ServerClient::new(url, "test").unwrap();
        let credential = player_client::DeviceCredential::parse(
            "tc_device_abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        )
        .unwrap();
        let server = client.verify_installation(installation, credential).await.unwrap();
        OriginBlobSource::new(
            server,
            "/api/v1/player/assets/844f4a48-a47c-4fbd-8a84-f8d61cc64b6a/variants/46784d73-3daf-45cf-8ff0-7cb4a3d12852",
        )
        .unwrap()
    }

    fn digest() -> Sha256Digest {
        Sha256Digest::of(b"stream bytes 0123456789")
    }

    fn tag() -> String {
        format!("\"sha256-{}\"", digest().to_hex())
    }

    #[tokio::test]
    async fn exact_206_returns_bytes_and_always_sends_range() {
        let (url, mock, _) = serving(Script::ok("bytes 2-5/22", &tag(), b"eams")).await;
        let source = source_for(&url).await;
        let bytes = source.read_exact(&digest(), 22, 2, 4).await.unwrap();
        assert_eq!(bytes, b"eams");
        // Offset zero still sends an exact range guarded by If-Range.
        mock.seen.lock().unwrap().clear();
        let (url, mock, _) = serving(Script::ok("bytes 0-3/22", &tag(), b"stre")).await;
        let source = source_for(&url).await;
        let bytes = source.read_exact(&digest(), 22, 0, 4).await.unwrap();
        assert_eq!(bytes, b"stre");
        let seen = mock.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0.as_deref(), Some("bytes=0-3"));
        assert_eq!(seen[0].1.as_deref(), Some(tag().as_str()));
    }

    #[tokio::test]
    async fn statuses_map_to_typed_failures() {
        for (status, expected) in [
            (StatusCode::OK, StreamReadError::RangeRejected),
            (StatusCode::UNAUTHORIZED, StreamReadError::Unauthorized),
            (StatusCode::FORBIDDEN, StreamReadError::Unauthorized),
            (StatusCode::NOT_FOUND, StreamReadError::NotFound),
            (StatusCode::GONE, StreamReadError::NotFound),
            (StatusCode::RANGE_NOT_SATISFIABLE, StreamReadError::RangeRejected),
            (StatusCode::INTERNAL_SERVER_ERROR, StreamReadError::RangeRejected),
        ] {
            let (url, _, _) = serving(Script::status(status)).await;
            let source = source_for(&url).await;
            assert_eq!(source.read_exact(&digest(), 22, 0, 4).await, Err(expected), "status {status}");
        }
    }

    #[tokio::test]
    async fn inexact_ranges_and_changed_validators_are_rejected() {
        for range in [
            None,
            Some("bytes 3-6/22"),
            Some("bytes 2-6/22"),
            Some("bytes 2-5/23"),
            Some("bytes 2-5/*"),
            Some("items 2-5/22"),
        ] {
            let mut script = Script::ok("bytes 2-5/22", &tag(), b"eams");
            script.content_range = range.map(str::to_owned);
            let (url, _, _) = serving(script).await;
            let source = source_for(&url).await;
            assert_eq!(
                source.read_exact(&digest(), 22, 2, 4).await,
                Err(StreamReadError::RangeRejected),
                "range {range:?}"
            );
        }
        // A changed ETag fails; an absent one trusts the If-Range answer.
        let mut script = Script::ok("bytes 2-5/22", &tag(), b"eams");
        script.etag = Some("\"sha256-0000000000000000000000000000000000000000000000000000000000000000\"".into());
        let (url, _, _) = serving(script).await;
        assert_eq!(source_for(&url).await.read_exact(&digest(), 22, 2, 4).await, Err(StreamReadError::RangeRejected));
        let mut script = Script::ok("bytes 2-5/22", &tag(), b"eams");
        script.etag = None;
        let (url, _, _) = serving(script).await;
        assert_eq!(source_for(&url).await.read_exact(&digest(), 22, 2, 4).await.unwrap(), b"eams");
    }

    #[tokio::test]
    async fn short_and_long_bodies_fail_closed() {
        let mut script = Script::ok("bytes 2-5/22", &tag(), b"ea");
        script.short = true;
        let (url, _, _) = serving(script).await;
        assert_eq!(source_for(&url).await.read_exact(&digest(), 22, 2, 4).await, Err(StreamReadError::Truncated));
        let script = Script::ok("bytes 2-5/22", &tag(), b"eamsXX");
        let (url, _, _) = serving(script).await;
        assert_eq!(source_for(&url).await.read_exact(&digest(), 22, 2, 4).await, Err(StreamReadError::RangeRejected));
        // A break mid-body is a transport failure, not a short read.
        let mut script = Script::ok("bytes 0-7/22", &tag(), b"stream b");
        script.error_after = true;
        let (url, _, _) = serving(script).await;
        assert_eq!(source_for(&url).await.read_exact(&digest(), 22, 0, 8).await, Err(StreamReadError::Network));
    }

    #[tokio::test]
    async fn out_of_bounds_reads_never_reach_the_network() {
        let (url, mock, _) = serving(Script::ok("bytes 0-3/22", &tag(), b"stre")).await;
        let source = source_for(&url).await;
        for (offset, length) in [(0, 0), (22, 1), (20, 3), (u64::MAX, 1), (20, u64::MAX)] {
            assert_eq!(
                source.read_exact(&digest(), 22, offset, length).await,
                Err(StreamReadError::RangeRejected),
                "offset {offset} length {length}"
            );
        }
        assert!(mock.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unreachable_origin_is_a_network_failure() {
        let (url, _, task) = serving(Script::ok("bytes 0-3/22", &tag(), b"stre")).await;
        let source = source_for(&url).await;
        // The link drops after verification: the read fails typed.
        task.abort();
        let _ = task.await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(source.read_exact(&digest(), 22, 0, 4).await, Err(StreamReadError::Network));
    }
}
