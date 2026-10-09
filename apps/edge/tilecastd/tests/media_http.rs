//! Real loopback HTTP reads through the renderer media boundary.
//!
//! No Linux gate: unlike the Unix socket, loopback authentication is the
//! bearer token alone, so this exercises the full dispatch on any host.
#![allow(clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::Arc;

use edge_cas::space::FixedSpace;
use edge_cas::{ContentStore, IngestMeta, LruByDomain, StorePolicy, UnixSecureOpener};
use edge_platform::clock::system_clock;
use edge_protocol::Sha256Digest;
use edge_protocol::bounded::SafeText;
use edge_protocol::ids::SessionId;
use edge_protocol::ipc::presentation::{ContentRef, FrameRef};
use edge_state::repo::cas::{Domain, SourceKind};
use edge_state::{OpenOptions, StateDb};
use http_body_util::BodyExt as _;
use tilecastd::media::{MediaRegistry, RendererInstance};
use tilecastd::media_http::{LoopbackMedia, media_url};
use tokio_util::sync::CancellationToken;

async fn get(port: u16, path: &str, range: Option<&str>) -> (hyper::StatusCode, hyper::HeaderMap, Vec<u8>) {
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await.unwrap();
    tokio::spawn(conn);
    let mut request = hyper::Request::builder().uri(format!("http://127.0.0.1:{port}{path}"));
    if let Some(range) = range {
        request = request.header(hyper::header::RANGE, range);
    }
    let response =
        sender.send_request(request.body(http_body_util::Empty::<bytes::Bytes>::new()).unwrap()).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, body)
}

async fn head(port: u16, path: &str) -> (hyper::StatusCode, hyper::HeaderMap, Vec<u8>) {
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await.unwrap();
    tokio::spawn(conn);
    let request = hyper::Request::builder()
        .method(hyper::Method::HEAD)
        .uri(format!("http://127.0.0.1:{port}{path}"))
        .body(http_body_util::Empty::<bytes::Bytes>::new())
        .unwrap();
    let response = sender.send_request(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, body)
}

#[tokio::test]
async fn loopback_serves_granted_bytes_and_denies_barely() {
    let dir = tempfile::tempdir().unwrap();
    let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
    let clock = system_clock();
    let cas = ContentStore::open(
        dir.path().join("cas"),
        dir.path().join("partial"),
        db,
        clock.clone(),
        Arc::new(FixedSpace(1 << 30)),
        Arc::new(UnixSecureOpener),
        StorePolicy { limit_bytes: 1 << 28, reserved_free_bytes: 0 },
        Arc::new(LruByDomain),
    )
    .await
    .unwrap();
    let bytes = b"verified image bytes through daemon loopback media";
    let source = dir.path().join("source.png");
    std::fs::write(&source, bytes).unwrap();
    let digest = Sha256Digest::of(bytes);
    cas.import_file(
        &source,
        digest,
        bytes.len() as u64,
        IngestMeta { domain: Domain::Media, content_type: Some("image/png".into()), source: SourceKind::Origin },
    )
    .await
    .unwrap();

    let session = SessionId::from_uuid(uuid::Uuid::new_v4());
    let pid = std::process::id() as i32;
    let mut registry = MediaRegistry::new();
    registry.bind_renderer(RendererInstance {
        session,
        uid: rustix::process::geteuid().as_raw(),
        pid,
        start_ticks: tilecastd::media_channel::process_start_ticks(pid).unwrap_or(0),
    });
    let content =
        ContentRef { sha256: digest, size_bytes: bytes.len() as u64, mime_type: SafeText::new("image/png").unwrap() };
    let now = clock.now().unix_millis();
    let token = registry.prepare(session, 7, now, &[content], &HashMap::new()).unwrap().remove(&digest).unwrap();
    let frame = FrameRef {
        package_id: SafeText::new("acme.athletics").unwrap(),
        package_digest: Sha256Digest::of(b"package"),
        sha256: Sha256Digest::of(b"frame"),
        size_bytes: 5,
    };
    let frame_token =
        registry.prepare_frames(session, 7, now, std::slice::from_ref(&frame)).unwrap().remove(&frame.sha256).unwrap();
    registry.activate(session, 7, now).unwrap();
    let registry = Arc::new(std::sync::Mutex::new(registry));
    let server = LoopbackMedia::bind(registry.clone(), cas.clone(), clock, None).unwrap();
    let port = server.port();
    assert_ne!(port, 0);
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run(stop.clone()));
    let path = format!("/media/{}", token.as_str());
    assert_eq!(media_url(port, token.as_str()), format!("http://127.0.0.1:{port}{path}"));

    let (status, headers, body) = get(port, &path, None).await;
    assert_eq!(status, hyper::StatusCode::OK);
    assert_eq!(body, bytes);
    assert_eq!(headers.get(hyper::header::CONTENT_TYPE).unwrap(), "image/png");
    assert_eq!(headers.get(hyper::header::CONTENT_LENGTH).unwrap().to_str().unwrap(), bytes.len().to_string());
    assert_eq!(headers.get(hyper::header::ACCEPT_RANGES).unwrap(), "bytes");
    assert_eq!(headers.get(hyper::header::CACHE_CONTROL).unwrap(), "no-store");
    assert!(headers.get(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());

    let (status, headers, body) = get(port, &path, Some("bytes=9-13")).await;
    assert_eq!(status, hyper::StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, &bytes[9..14]);
    assert_eq!(
        headers.get(hyper::header::CONTENT_RANGE).unwrap().to_str().unwrap(),
        format!("bytes 9-13/{}", bytes.len()).as_str()
    );

    let (status, _, body) = get(port, &path, Some("bytes=-5")).await;
    assert_eq!(status, hyper::StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, &bytes[bytes.len() - 5..]);

    let (status, headers, body) = head(port, &path).await;
    assert_eq!(status, hyper::StatusCode::OK);
    assert!(body.is_empty());
    assert_eq!(headers.get(hyper::header::CONTENT_LENGTH).unwrap().to_str().unwrap(), bytes.len().to_string());

    let (status, headers, body) = get(port, &path, Some(&format!("bytes={}-", bytes.len()))).await;
    assert_eq!(status, hyper::StatusCode::RANGE_NOT_SATISFIABLE);
    assert!(body.is_empty());
    assert_eq!(
        headers.get(hyper::header::CONTENT_RANGE).unwrap().to_str().unwrap(),
        format!("bytes */{}", bytes.len()).as_str()
    );

    // Unknown tokens, frame tokens, malformed paths, and a retired
    // renderer all answer the same bare 404.
    for denied in [
        format!("/media/{}", "0".repeat(64)),
        format!("/media/{}", frame_token.as_str()),
        "/media/short".to_string(),
        "/other".to_string(),
    ] {
        let (status, _, body) = get(port, &denied, None).await;
        assert_eq!(status, hyper::StatusCode::NOT_FOUND, "{denied}");
        assert!(body.is_empty());
    }
    registry.lock().unwrap().unbind_renderer(session);
    let (status, _, body) = get(port, &path, None).await;
    assert_eq!(status, hyper::StatusCode::NOT_FOUND);
    assert!(body.is_empty());
    stop.cancel();
    task.await.unwrap().unwrap();
}
