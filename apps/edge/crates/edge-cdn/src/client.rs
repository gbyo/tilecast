//! A peer as a CAS source (RFC §14.5).
//!
//! Each open dials the peer's blob endpoint with mutual TLS, accepting only
//! the node it expects (the address came from a mesh hint and proves
//! nothing). Resume uses `Range` with `If-Range: "sha256:<hex>"`; a `200`
//! makes the fetcher restart from zero. The store verifies every byte, so a
//! peer can waste time but never corrupt the cache.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use edge_cas::{BlobSource, SourceError, SourceKind, SourceStream};
use edge_protocol::{NodeId, Sha256Digest};
use futures_util::StreamExt as _;
use http::{Request, StatusCode, header};
use http_body_util::{BodyStream, Empty};
use rustls::pki_types::ServerName;
use tokio_rustls::TlsConnector;

use crate::range::parse_content_range;
use crate::server::BLOB_PREFIX;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

/// Where a peer claims to serve blobs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PeerEndpoint {
    pub node_id: NodeId,
    pub address: SocketAddr,
}

#[derive(Clone)]
pub struct PeerBlobSource {
    endpoint: PeerEndpoint,
    connector: TlsConnector,
}

impl std::fmt::Debug for PeerBlobSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerBlobSource").field("endpoint", &self.endpoint).finish_non_exhaustive()
    }
}

impl PeerBlobSource {
    /// `tls` must come from `edge_identity::tls::client_config` with
    /// `expected = Some(endpoint.node_id)`.
    pub fn new(endpoint: PeerEndpoint, tls: rustls::ClientConfig) -> Self {
        Self { endpoint, connector: TlsConnector::from(Arc::new(tls)) }
    }

    pub fn endpoint(&self) -> PeerEndpoint {
        self.endpoint
    }

    async fn request(
        &self,
        digest: &Sha256Digest,
        offset: u64,
    ) -> Result<http::Response<hyper::body::Incoming>, SourceError> {
        let retry = |what: &str| SourceError::Retryable(format!("peer {what}"));
        let tcp = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(self.endpoint.address))
            .await
            .map_err(|_| retry("connect timeout"))?
            .map_err(|_| retry("unreachable"))?;
        // The name is not checked: the verifier checks the node identity.
        let name = ServerName::IpAddress(self.endpoint.address.ip().into());
        let tls = tokio::time::timeout(CONNECT_TIMEOUT, self.connector.connect(name, tcp))
            .await
            .map_err(|_| retry("handshake timeout"))?
            // An identity failure is final for this peer, not transient.
            .map_err(|_| SourceError::Unauthorized)?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls))
            .await
            .map_err(|_| retry("protocol"))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut builder = Request::get(format!("{BLOB_PREFIX}{}", digest.to_hex()))
            .header(header::HOST, self.endpoint.address.to_string())
            .header(header::USER_AGENT, concat!("tilecastd/", env!("CARGO_PKG_VERSION")));
        if offset > 0 {
            builder = builder.header(header::RANGE, format!("bytes={offset}-")).header(header::IF_RANGE, digest.etag());
        }
        let request = builder.body(Empty::<Bytes>::new()).map_err(|_| SourceError::Fatal("request".into()))?;
        tokio::time::timeout(RESPONSE_TIMEOUT, sender.send_request(request))
            .await
            .map_err(|_| retry("response timeout"))?
            .map_err(|error| if tls_alert(&error) { SourceError::Unauthorized } else { retry("response") })
    }
}

/// With TLS 1.3 the server verifies the client certificate after the
/// client considers the handshake complete, so a refusal of *this* node
/// (revoked, foreign CA) arrives as an alert on the first read.
fn tls_alert(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if let Some(io) = error.downcast_ref::<std::io::Error>()
            && let Some(inner) = io.get_ref()
            && let Some(rustls::Error::AlertReceived(_)) = inner.downcast_ref::<rustls::Error>()
        {
            return true;
        }
        if let Some(rustls::Error::AlertReceived(_)) = error.downcast_ref::<rustls::Error>() {
            return true;
        }
        current = error.source();
    }
    false
}

#[async_trait]
impl BlobSource for PeerBlobSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Peer
    }

    fn label(&self) -> String {
        self.endpoint.node_id.to_string()
    }

    async fn open(&self, digest: &Sha256Digest, size: u64, offset: u64) -> Result<SourceStream, SourceError> {
        let response = self.request(digest, offset).await?;
        let start = match response.status() {
            StatusCode::OK => 0,
            StatusCode::PARTIAL_CONTENT => {
                let (start, _, total) = response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range)
                    .ok_or_else(|| SourceError::Fatal("206 without a valid Content-Range".into()))?;
                if start != offset || total != size {
                    return Err(SourceError::Fatal("peer range does not match the request".into()));
                }
                start
            }
            StatusCode::NOT_FOUND => return Err(SourceError::NotFound),
            StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED => return Err(SourceError::Unauthorized),
            StatusCode::SERVICE_UNAVAILABLE => return Err(SourceError::Retryable("peer busy".into())),
            status => return Err(SourceError::Fatal(format!("peer answered {}", status.as_u16()))),
        };
        let total = if start == 0 {
            response
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
        } else {
            Some(size)
        };
        let body = BodyStream::new(response.into_body()).filter_map(|frame| async move {
            match frame {
                Ok(frame) => frame.into_data().ok().map(Ok),
                Err(_) => Some(Err(SourceError::Retryable("peer read failed".into()))),
            }
        });
        Ok(SourceStream { start, total_length: total, body: body.boxed() })
    }
}
