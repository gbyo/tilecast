//! Peer blob service and source over real mTLS sockets.
#![allow(clippy::unwrap_used)]

use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt as _;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use edge_cas::fetch::LocalFileSource;
use edge_cas::{BlobSource, ContentStore, FetchRequest, Fetcher, IngestMeta, LruByDomain, SourceError, StorePolicy};
use edge_cdn::{BlobServerLimits, PeerBlobServer, PeerBlobSource, PeerCandidate, PeerEndpoint, PeerSelector};
use edge_identity::testing::TestCa;
use edge_identity::tls::{NodeCredentials, client_config, server_config};
use edge_identity::{RevocationSet, TrustAnchor};
use edge_platform::disk::FixedSpace;
use edge_protocol::time::system_clock;
use edge_protocol::{InstallationId, NodeId, Sha256Digest};
use edge_state::repo::cas::{Domain, SourceKind as RecordSource};
use edge_state::{OpenOptions, StateDb};
use futures_util::StreamExt as _;
use http_body_util::{BodyExt as _, Empty};
use tokio_util::sync::CancellationToken;

struct Node {
    _dir: tempfile::TempDir,
    id: NodeId,
    credentials: NodeCredentials,
    store: ContentStore,
    cas_dir: std::path::PathBuf,
}

async fn node(ca: &TestCa) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
    let cas_dir = dir.path().join("cas");
    let store = ContentStore::open(
        cas_dir.clone(),
        dir.path().join("partial"),
        db,
        system_clock(),
        Arc::new(FixedSpace(1 << 40)),
        StorePolicy { limit_bytes: 1 << 30, reserved_free_bytes: 0 },
        Arc::new(LruByDomain),
    )
    .await
    .unwrap();
    let (id, _key, credentials) = ca.node();
    Node { _dir: dir, id, credentials, store, cas_dir }
}

fn meta(peerable: bool) -> IngestMeta {
    IngestMeta { domain: Domain::Media, content_type: None, peerable, source: RecordSource::Origin }
}

async fn put(node: &Node, bytes: &[u8], peerable: bool) -> Sha256Digest {
    let digest = Sha256Digest::of(bytes);
    let mut session = node.store.begin_write(digest, bytes.len() as u64, meta(peerable)).await.unwrap().unwrap();
    session.write(bytes).unwrap();
    session.commit().await.unwrap();
    digest
}

fn payload(len: usize, seed: u8) -> Vec<u8> {
    (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

async fn serve(node: &Node, anchor: TrustAnchor, revocations: RevocationSet) -> (SocketAddr, CancellationToken) {
    let tls = server_config(&node.credentials, anchor, revocations.clone()).unwrap();
    let server = PeerBlobServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        tls,
        node.store.clone(),
        revocations,
        BlobServerLimits::default(),
    )
    .await
    .unwrap();
    let address = server.local_addr().unwrap();
    let shutdown = CancellationToken::new();
    tokio::spawn(server.run(shutdown.clone()));
    (address, shutdown)
}

fn source(client: &Node, anchor: TrustAnchor, server: NodeId, address: SocketAddr) -> PeerBlobSource {
    let tls = client_config(&client.credentials, anchor, RevocationSet::new(), Some(server)).unwrap();
    PeerBlobSource::new(PeerEndpoint { node_id: server, address }, tls)
}

/// A raw keep-alive HTTP/1.1 connection for protocol-level assertions.
struct Raw {
    sender: hyper::client::conn::http1::SendRequest<Empty<Bytes>>,
}

impl Raw {
    async fn connect(client: &Node, anchor: TrustAnchor, server: NodeId, address: SocketAddr) -> Result<Self, ()> {
        let tls = client_config(&client.credentials, anchor, RevocationSet::new(), Some(server)).unwrap();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls));
        let tcp = tokio::net::TcpStream::connect(address).await.map_err(|_| ())?;
        let name = rustls::pki_types::ServerName::IpAddress(address.ip().into());
        let stream = connector.connect(name, tcp).await.map_err(|_| ())?;
        let (sender, connection) =
            hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await.map_err(|_| ())?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(Self { sender })
    }

    async fn call(&mut self, method: &str, path: &str, headers: &[(&str, &str)]) -> (u16, http::HeaderMap, Vec<u8>) {
        let mut builder = http::Request::builder().method(method).uri(path).header("host", "peer");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let response = self.sender.send_request(builder.body(Empty::new()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        (status, headers, body)
    }
}

#[tokio::test]
async fn peer_fetch_resume_and_strict_http() {
    let ca = TestCa::new(InstallationId::new_random());
    let (server, client) = (node(&ca).await, node(&ca).await);
    let bytes = payload(300_000, 1);
    let digest = put(&server, &bytes, true).await;
    let private = put(&server, b"not eligible for peers", false).await;
    let (address, shutdown) = serve(&server, ca.anchor(), RevocationSet::new()).await;
    let peer = source(&client, ca.anchor(), server.id, address);

    // Full fetch through the fetcher, verified by the receiving store.
    let fetcher = Fetcher::new(client.store.clone(), 2);
    let request = FetchRequest { digest, size_bytes: bytes.len() as u64, meta: meta(true) };
    let sources: Vec<Arc<dyn BlobSource>> = vec![Arc::new(peer.clone())];
    let record = fetcher.fetch(&request, &sources, None).await.unwrap();
    assert_eq!(record.size_bytes, bytes.len() as u64);
    assert!(record.peerable, "a peer-fetched media object may be re-served");

    // Resume from an offset.
    let stream = peer.open(&digest, bytes.len() as u64, 100_000).await.unwrap();
    assert_eq!(stream.start, 100_000);
    let body: Vec<u8> = stream.body.map(|c| c.unwrap().to_vec()).collect::<Vec<_>>().await.concat();
    assert_eq!(body, &bytes[100_000..]);

    // Not peerable and absent objects are indistinguishable.
    assert!(matches!(peer.open(&private, 22, 0).await, Err(SourceError::NotFound)));
    assert!(matches!(peer.open(&Sha256Digest::of(b"absent"), 6, 0).await, Err(SourceError::NotFound)));

    let mut raw = Raw::connect(&client, ca.anchor(), server.id, address).await.unwrap();
    let path = format!("/v1/blobs/sha256/{}", digest.to_hex());
    let (status, headers, body) = raw.call("HEAD", &path, &[]).await;
    assert_eq!(status, 200);
    assert!(body.is_empty());
    assert_eq!(headers["etag"], digest.etag().as_str());
    assert_eq!(headers["content-length"], bytes.len().to_string().as_str());
    assert_eq!(headers["accept-ranges"], "bytes");
    assert_eq!(headers["cache-control"], "public, immutable");
    let (status, headers, body) = raw.call("GET", &path, &[("range", "bytes=10-19")]).await;
    assert_eq!((status, body.as_slice()), (206, &bytes[10..20]));
    assert_eq!(headers["content-range"], format!("bytes 10-19/{}", bytes.len()).as_str());
    let (status, _, body) = raw.call("GET", &path, &[("range", "bytes=10-19"), ("if-range", "\"sha256:00\"")]).await;
    assert_eq!((status, body.len()), (200, bytes.len()), "a stale If-Range gets the whole object");
    assert_eq!(raw.call("GET", &path, &[("range", "bytes=0-1,5-6")]).await.0, 400);
    assert_eq!(raw.call("GET", &path, &[("range", "bytes=999999999-")]).await.0, 416);
    assert_eq!(raw.call("POST", &path, &[]).await.0, 405);
    assert_eq!(raw.call("GET", &path.to_uppercase(), &[]).await.0, 404);
    assert_eq!(raw.call("GET", &format!("{path}?x=1"), &[]).await.0, 404);
    assert_eq!(raw.call("GET", "/v1/blobs/sha256/", &[]).await.0, 404);
    assert_eq!(raw.call("GET", "/", &[]).await.0, 404);
    shutdown.cancel();
}

#[tokio::test]
async fn untrusted_and_revoked_peers_are_refused() {
    let installation = InstallationId::new_random();
    let ca = TestCa::new(installation);
    let (server, client) = (node(&ca).await, node(&ca).await);
    let bytes = payload(4_096, 2);
    let digest = put(&server, &bytes, true).await;
    let revocations = RevocationSet::new();
    let (address, shutdown) = serve(&server, ca.anchor(), revocations.clone()).await;

    // A certificate from another CA, even for the same installation ID.
    let foreign_ca = TestCa::new(installation);
    let foreign = node(&foreign_ca).await;
    let impostor = source(&foreign, foreign_ca.anchor(), server.id, address);
    assert!(matches!(impostor.open(&digest, 4_096, 0).await, Err(SourceError::Unauthorized)));

    // The dialer names the node it expects; another member is refused.
    let wrong = source(&client, ca.anchor(), NodeId::new_random(), address);
    assert!(matches!(wrong.open(&digest, 4_096, 0).await, Err(SourceError::Unauthorized)));

    // Revocation during a keep-alive connection applies to the next request.
    let mut raw = Raw::connect(&client, ca.anchor(), server.id, address).await.unwrap();
    let path = format!("/v1/blobs/sha256/{}", digest.to_hex());
    assert_eq!(raw.call("HEAD", &path, &[]).await.0, 200);
    revocations.revoke(client.id, system_clock().now().saturating_add(time::Duration::days(1)), 1);
    assert_eq!(raw.call("HEAD", &path, &[]).await.0, 403);
    // And new handshakes fail.
    let revoked = source(&client, ca.anchor(), server.id, address);
    assert!(matches!(revoked.open(&digest, 4_096, 0).await, Err(SourceError::Unauthorized)));
    shutdown.cancel();
}

#[tokio::test]
async fn corrupt_peer_falls_back_and_is_suppressed() {
    let ca = TestCa::new(InstallationId::new_random());
    let (server, client) = (node(&ca).await, node(&ca).await);
    let bytes = payload(65_000, 3);
    let digest = put(&server, &bytes, true).await;
    // The peer's disk flips a byte after verification: metadata still says
    // verified, so the peer serves it. The receiver must catch it.
    let file = server.cas_dir.join("sha256").join(digest.fanout()).join(digest.to_hex());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut tampered = bytes.clone();
    tampered[40_000] ^= 0xff;
    std::fs::write(&file, &tampered).unwrap();
    let (address, shutdown) = serve(&server, ca.anchor(), RevocationSet::new()).await;

    let good = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(good.path(), &bytes).unwrap();
    let selector = PeerSelector::new();
    let candidate =
        PeerCandidate { endpoint: PeerEndpoint { node_id: server.id, address }, same_subnet: true, load: 0 };
    let ranked = selector.rank(&digest, &[candidate], Instant::now());
    let mut sources: Vec<Arc<dyn BlobSource>> = ranked
        .iter()
        .map(|c| Arc::new(source(&client, ca.anchor(), c.endpoint.node_id, c.endpoint.address)) as Arc<dyn BlobSource>)
        .collect();
    sources.push(Arc::new(LocalFileSource { path: good.path().to_path_buf() }));
    let fetcher = Fetcher::new(client.store.clone(), 1);
    let request = FetchRequest { digest, size_bytes: bytes.len() as u64, meta: meta(true) };
    let observer = selector.observer(digest);
    let record = fetcher.fetch(&request, &sources, Some(&observer)).await.unwrap();
    assert_eq!(record.size_bytes, bytes.len() as u64);
    let path = client.store.verified_path(&digest).await.unwrap().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), bytes);

    let report = selector.report(Instant::now());
    assert_eq!(report.len(), 1);
    assert_eq!(report[0].integrity_failures, 1);
    assert!(selector.rank(&digest, &[candidate], Instant::now()).is_empty(), "suppressed for this object");
    shutdown.cancel();
}
