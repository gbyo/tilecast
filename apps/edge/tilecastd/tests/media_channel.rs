//! Real Unix socket and CAS reads through the renderer media boundary.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]

use std::os::unix::fs::PermissionsExt as _;
use std::sync::Arc;

use edge_cas::{ContentStore, IngestMeta, LruByDomain, StorePolicy};
use edge_platform::disk::FixedSpace;
use edge_protocol::Sha256Digest;
use edge_protocol::bounded::SafeText;
use edge_protocol::ids::SessionId;
use edge_protocol::ipc::presentation::ContentRef;
use edge_protocol::time::system_clock;
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
        IngestMeta {
            domain: Domain::Media,
            content_type: Some("image/png".into()),
            peerable: false,
            source: SourceKind::Origin,
        },
    )
    .await
    .unwrap();

    let session = SessionId::new_random();
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
    let token = registry.prepare(session, 7, now, &[content]).unwrap().remove(&digest).unwrap();
    registry.activate(session, 7, now).unwrap();
    let registry = Arc::new(std::sync::Mutex::new(registry));
    let path = dir.path().join("media.sock");
    let channel = MediaChannel::bind(&path, registry.clone(), cas.clone(), clock, Arc::new(ProcLineage)).unwrap();
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
