//! Real Unix socket and CAS reads through the renderer media boundary.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt as _;
use std::sync::Arc;

use edge_cas::space::FixedSpace;
use edge_cas::{ContentStore, IngestMeta, LruByDomain, StorePolicy, UnixSecureOpener};
use edge_platform::clock::system_clock;
use edge_protocol::Sha256Digest;
use edge_protocol::bounded::SafeText;
use edge_protocol::ids::SessionId;
use edge_protocol::ipc::presentation::ContentRef;
use edge_state::repo::cas::{Domain, SourceKind};
use edge_state::{OpenOptions, StateDb};
use serde_json::{Value, json};
use tilecastd::media::{MediaRegistry, RendererInstance};
use tilecastd::media_channel::{MediaChannel, ProcLineage, ProcessLineage, process_start_ticks};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::UnixStream;
use tokio_util::sync::CancellationToken;

async fn ask(path: &std::path::Path, request: Value) -> (Value, Vec<u8>) {
    let mut stream = UnixStream::connect(path).await.unwrap();
    let body = serde_json::to_vec(&request).unwrap();
    stream.write_all(&(body.len() as u32).to_be_bytes()).await.unwrap();
    stream.write_all(&body).await.unwrap();
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await.unwrap();
    let mut body = vec![0u8; u32::from_be_bytes(header) as usize];
    stream.read_exact(&mut body).await.unwrap();
    let response: Value = serde_json::from_slice(&body).unwrap();
    let mut payload = Vec::new();
    stream.read_to_end(&mut payload).await.unwrap();
    (response, payload)
}

#[tokio::test]
async fn authorized_range_reads_and_denials_use_only_verified_cas() {
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
    let bytes = b"verified image bytes through daemon media channel";
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
    let renderer = RendererInstance {
        session,
        uid: rustix::process::geteuid().as_raw(),
        pid,
        start_ticks: process_start_ticks(pid).unwrap(),
    };
    assert!(ProcLineage.belongs_to(renderer, pid));
    assert!(!ProcLineage.belongs_to(RendererInstance { start_ticks: renderer.start_ticks + 1, ..renderer }, pid));
    registry.bind_renderer(renderer);
    let content =
        ContentRef { sha256: digest, size_bytes: bytes.len() as u64, mime_type: SafeText::new("image/png").unwrap() };
    let now = clock.now().unix_millis();
    let token = registry.prepare(session, 7, now, &[content], &HashMap::new()).unwrap().remove(&digest).unwrap();
    registry.activate(session, 7, now).unwrap();
    let registry = Arc::new(std::sync::Mutex::new(registry));
    let path = dir.path().join("media.sock");
    let channel = MediaChannel::bind(&path, registry.clone(), cas.clone(), clock, Arc::new(ProcLineage), None).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    let stop = CancellationToken::new();
    let task = tokio::spawn(channel.run(stop.clone()));

    let (head, payload) = ask(&path, json!({"op": "head", "capability": token.as_str()})).await;
    assert_eq!(head, json!({"status": "ok", "sizeBytes": bytes.len(), "mimeType": "image/png"}));
    assert!(payload.is_empty());
    let (read, payload) =
        ask(&path, json!({"op": "read", "capability": token.as_str(), "offset": 9, "length": 5})).await;
    assert_eq!(read, json!({"status": "ok", "length": 5}));
    assert_eq!(payload, &bytes[9..14]);

    for request in [
        json!({"op": "head", "capability": digest.to_hex()}),
        json!({"op": "head", "capability": token.as_str(), "extra": true}),
        json!({"op": "read", "capability": token.as_str(), "offset": 0, "length": 1024 * 1024 + 1}),
        json!({"op": "read", "capability": token.as_str(), "offset": bytes.len(), "length": 1}),
    ] {
        let (response, payload) = ask(&path, request).await;
        assert_eq!(response, json!({"status": "denied"}));
        assert!(payload.is_empty());
    }
    registry.lock().unwrap().unbind_renderer(session);
    let (response, _) = ask(&path, json!({"op": "head", "capability": token.as_str()})).await;
    assert_eq!(response, json!({"status": "denied"}));
    stop.cancel();
    task.await.unwrap().unwrap();
    assert!(!path.exists());
}

// ------------------------------------------------------------ PR4: stream-backed grants

use edge_protocol::InstallationId;
use edge_server::{AuthenticatedServer, DeviceCredential, ServerClient};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use player_core::StreamSource;
use tilecastd::media_channel::StreamBackend;
use tokio::sync::watch;

const STREAM_PATH: &str =
    "/api/v1/player/assets/844f4a48-a47c-4fbd-8a84-f8d61cc64b6a/variants/46784d73-3daf-45cf-8ff0-7cb4a3d12852";
const STREAM_CREDENTIAL: &str = "tc_device_abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz0123456789ABCD";

struct OriginMock {
    installation: InstallationId,
    digest_hex: String,
    status: std::sync::Mutex<StatusCode>,
    ignore_range: std::sync::atomic::AtomicBool,
    body: Vec<u8>,
    seen: std::sync::Mutex<Vec<(String, String)>>,
}

async fn serve_origin(
    mock: Arc<OriginMock>,
    request: Request<Incoming>,
) -> Result<Response<Full<bytes::Bytes>>, std::convert::Infallible> {
    if request.uri().path() == "/api/v1/system/identity" {
        let body = serde_json::json!({"data": {
            "product": "Tilecast", "installationId": mock.installation.to_string(),
            "organizationName": "Test", "apiVersion": "v1", "pairingEnabled": false,
        }})
        .to_string();
        return Ok(Response::new(Full::new(bytes::Bytes::from(body))));
    }
    let range = request.headers().get(hyper::header::RANGE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let if_range =
        request.headers().get(hyper::header::IF_RANGE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    mock.seen.lock().unwrap().push((range.clone(), if_range));
    let status = *mock.status.lock().unwrap();
    if mock.ignore_range.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(Response::new(Full::new(bytes::Bytes::from(mock.body.clone()))));
    }
    if status != StatusCode::PARTIAL_CONTENT {
        let mut response = Response::new(Full::new(bytes::Bytes::new()));
        *response.status_mut() = status;
        return Ok(response);
    }
    let range = range.strip_prefix("bytes=").unwrap_or("");
    let (start, end) = range.split_once('-').unwrap_or(("", ""));
    let (Ok(start), Ok(end)) = (start.parse::<usize>(), end.parse::<usize>()) else {
        let mut response = Response::new(Full::new(bytes::Bytes::new()));
        *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
        return Ok(response);
    };
    let mut response = Response::new(Full::new(bytes::Bytes::from(mock.body[start..=end].to_vec())));
    *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    response
        .headers_mut()
        .insert(hyper::header::CONTENT_RANGE, format!("bytes {start}-{end}/{}", mock.body.len()).parse().unwrap());
    response.headers_mut().insert(hyper::header::ETAG, format!("\"sha256-{}\"", mock.digest_hex).parse().unwrap());
    Ok(response)
}

struct StreamHarness {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    token: String,
    mock: Arc<OriginMock>,
    link: watch::Sender<Option<AuthenticatedServer>>,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    registry: Arc<std::sync::Mutex<MediaRegistry>>,
}

impl StreamHarness {
    async fn start(body: &[u8]) -> Self {
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
        let digest = Sha256Digest::of(body);
        let mock = Arc::new(OriginMock {
            installation: InstallationId::from_uuid(uuid::Uuid::from_u128(7)),
            digest_hex: digest.to_hex(),
            status: std::sync::Mutex::new(StatusCode::PARTIAL_CONTENT),
            ignore_range: std::sync::atomic::AtomicBool::new(false),
            body: body.to_vec(),
            seen: std::sync::Mutex::new(Vec::new()),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let serving = Arc::clone(&mock);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let serving = Arc::clone(&serving);
                let service = hyper::service::service_fn(move |request| serve_origin(Arc::clone(&serving), request));
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            }
        });
        let url = format!("http://{address}");
        let server = ServerClient::new(&url, "test")
            .unwrap()
            .verify_installation(mock.installation, DeviceCredential::parse(STREAM_CREDENTIAL).unwrap())
            .await
            .unwrap();
        let (link, receive) = watch::channel(Some(server));
        let session = SessionId::from_uuid(uuid::Uuid::new_v4());
        let pid = std::process::id() as i32;
        let mut registry = MediaRegistry::new();
        registry.bind_renderer(RendererInstance {
            session,
            uid: rustix::process::geteuid().as_raw(),
            pid,
            start_ticks: process_start_ticks(pid).unwrap(),
        });
        let content = ContentRef {
            sha256: digest,
            size_bytes: body.len() as u64,
            mime_type: SafeText::new("video/mp4").unwrap(),
        };
        let streams = HashMap::from([(digest, StreamSource::new(STREAM_PATH.to_owned()).unwrap())]);
        let now = clock.now().unix_millis();
        let token = registry
            .prepare(session, 3, now, &[content], &streams)
            .unwrap()
            .remove(&digest)
            .unwrap()
            .as_str()
            .to_owned();
        registry.activate(session, 3, now).unwrap();
        let registry = Arc::new(std::sync::Mutex::new(registry));
        let path = dir.path().join("media.sock");
        let channel = MediaChannel::bind(
            &path,
            registry.clone(),
            cas,
            clock,
            Arc::new(ProcLineage),
            Some(StreamBackend::new(receive)),
        )
        .unwrap();
        let stop = CancellationToken::new();
        let task = tokio::spawn(channel.run(stop.clone()));
        Self { _dir: dir, path, token, mock, link, stop, task, registry }
    }

    async fn shutdown(self) {
        self.stop.cancel();
        self.task.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn stream_grant_reads_serve_origin_ranges_without_cas() {
    let body = b"streamed video bytes from the test origin";
    let harness = StreamHarness::start(body).await;
    // HEAD answers from the grant alone: no object is cached.
    let (head, payload) = ask(&harness.path, json!({"op": "head", "capability": harness.token.as_str()})).await;
    assert_eq!(head, json!({"status": "ok", "sizeBytes": body.len(), "mimeType": "video/mp4"}));
    assert!(payload.is_empty());
    assert!(harness.mock.seen.lock().unwrap().is_empty(), "HEAD touches no backend");
    let (reply, payload) =
        ask(&harness.path, json!({"op": "read", "capability": harness.token.as_str(), "offset": 9, "length": 6})).await;
    assert_eq!(reply, json!({"status": "ok", "length": 6}));
    assert_eq!(payload, &body[9..15]);
    // The origin saw one exact range guarded by the manifest validator;
    // the reply carries no path, URL, or credential.
    {
        let seen = harness.mock.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "bytes=9-14");
        assert_eq!(seen[0].1, format!("\"sha256-{}\"", Sha256Digest::of(body).to_hex()));
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn stream_failures_deny_with_typed_reasons() {
    let body = b"sixteen bytes....";
    let harness = StreamHarness::start(body).await;
    for (status, reason) in [
        (StatusCode::UNAUTHORIZED, "credential_rejected"),
        (StatusCode::NOT_FOUND, "origin_not_found"),
        (StatusCode::RANGE_NOT_SATISFIABLE, "range_rejected"),
    ] {
        *harness.mock.status.lock().unwrap() = status;
        let (reply, payload) =
            ask(&harness.path, json!({"op": "read", "capability": harness.token.as_str(), "offset": 0, "length": 4}))
                .await;
        assert_eq!(reply, json!({"status": "denied", "reason": reason}), "status {status}");
        assert!(payload.is_empty());
    }
    // An origin that answers 200 to a Range request is rejected, not replayed.
    *harness.mock.status.lock().unwrap() = StatusCode::PARTIAL_CONTENT;
    harness.mock.ignore_range.store(true, std::sync::atomic::Ordering::SeqCst);
    let (reply, _) =
        ask(&harness.path, json!({"op": "read", "capability": harness.token.as_str(), "offset": 0, "length": 4})).await;
    assert_eq!(reply, json!({"status": "denied", "reason": "range_rejected"}));
    harness.shutdown().await;
}

#[tokio::test]
async fn offline_stream_read_is_unreachable_and_replacement_denies_bare() {
    let body = b"offline stream bytes!";
    let harness = StreamHarness::start(body).await;
    harness.link.send_replace(None);
    let (reply, payload) =
        ask(&harness.path, json!({"op": "read", "capability": harness.token.as_str(), "offset": 0, "length": 4})).await;
    assert_eq!(reply, json!({"status": "denied", "reason": "origin_unreachable"}));
    assert!(payload.is_empty());
    assert!(harness.mock.seen.lock().unwrap().is_empty(), "no request without a verified link");
    // A replaced renderer loses the grant before any backend is reached:
    // the denial stays bare, exactly as for cached grants.
    let other = SessionId::from_uuid(uuid::Uuid::new_v4());
    let pid = std::process::id() as i32;
    harness.registry.lock().unwrap().bind_renderer(RendererInstance {
        session: other,
        uid: rustix::process::geteuid().as_raw(),
        pid,
        start_ticks: process_start_ticks(pid).unwrap(),
    });
    let (reply, _) =
        ask(&harness.path, json!({"op": "read", "capability": harness.token.as_str(), "offset": 0, "length": 4})).await;
    assert_eq!(reply, json!({"status": "denied"}));
    harness.shutdown().await;
}
