//! Bounded Unix media reads backed by daemon-owned capabilities and CAS.
//!
//! Each connection handles one HEAD or READ request. The peer PID must be
//! the current renderer or one of its children; the capability alone is not
//! sufficient. No CAS path or file descriptor crosses this channel.

use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use edge_cas::ContentStore;
use edge_protocol::ids::SessionId;
use edge_protocol::time::SharedClock;
use edge_server::AuthenticatedServer;
use player_core::{OriginBlobSource, StreamReadError, StreamSource};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, watch};
use tokio_util::sync::CancellationToken;

use crate::media::{MediaGrant, MediaRegistry, ReadMode, RendererInstance};

const MAX_FRAME: usize = 512;
const MAX_READ: u32 = 1024 * 1024;
const MAX_CONNECTIONS: usize = 32;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// One bounded origin range read. Longer than the request timeout: a 1 MiB
/// GStreamer chunk over a slow link still answers, or fails typed.
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Backstop for one connection; request and stream reads time out sooner.
const SERVE_TIMEOUT: Duration = Duration::from_secs(60);
/// Concurrent origin range reads across all connections.
const MAX_STREAM_READS: usize = 4;

/// The network backend for stream-backed grants: the verified server
/// relationship (only `Some` while Core holds a verified link) plus a
/// bound on concurrent origin reads.
#[derive(Debug, Clone)]
pub struct StreamBackend {
    server: watch::Receiver<Option<AuthenticatedServer>>,
    reads: Arc<Semaphore>,
}

impl StreamBackend {
    pub fn new(server: watch::Receiver<Option<AuthenticatedServer>>) -> Self {
        Self { server, reads: Arc::new(Semaphore::new(MAX_STREAM_READS)) }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Head {
        capability: String,
        #[serde(default)]
        expect: ReadExpect,
    },
    Read {
        capability: String,
        offset: u64,
        length: u32,
        #[serde(default)]
        expect: ReadExpect,
    },
}

/// Which grant usage a channel read expects. Absent means media: renderers
/// older than frames never send the field and never hold frame tokens, so
/// the default keeps them working. Frame reads always name `frame`
/// explicitly; the daemon resolves with the matching registry method and
/// a media capability presented for a frame read is denied like an
/// unknown token.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReadExpect {
    #[default]
    Media,
    Frame,
}

impl Request {
    fn capability(&self) -> &str {
        match self {
            Self::Head { capability, .. } | Self::Read { capability, .. } => capability,
        }
    }

    fn expect(&self) -> ReadExpect {
        match self {
            Self::Head { expect, .. } | Self::Read { expect, .. } => *expect,
        }
    }
}

pub trait ProcessLineage: std::fmt::Debug + Send + Sync {
    fn belongs_to(&self, renderer: RendererInstance, peer_pid: i32) -> bool;
}

#[derive(Debug)]
pub struct ProcLineage;

#[cfg(target_os = "linux")]
fn proc_stat(pid: i32) -> Option<(i32, u64)> {
    if pid <= 0 {
        return None;
    }
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, tail) = text.rsplit_once(") ")?;
    let fields: Vec<_> = tail.split_whitespace().collect();
    // After `)`, field 3 is state, 4 is PPID, and 22 is start time.
    Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}

#[cfg(not(target_os = "linux"))]
fn proc_stat(_pid: i32) -> Option<(i32, u64)> {
    None
}

pub fn process_start_ticks(pid: i32) -> Option<u64> {
    proc_stat(pid).map(|(_, start)| start)
}

impl ProcessLineage for ProcLineage {
    fn belongs_to(&self, renderer: RendererInstance, peer_pid: i32) -> bool {
        let mut current = peer_pid;
        for _ in 0..32 {
            let Some((parent, start)) = proc_stat(current) else { return false };
            if current == renderer.pid {
                return start == renderer.start_ticks;
            }
            if parent <= 1 || parent == current {
                return false;
            }
            current = parent;
        }
        false
    }
}

#[derive(Debug)]
pub struct MediaChannel {
    listener: UnixListener,
    path: PathBuf,
    /// Set when this process created the socket file and so removes it.
    /// A socket inherited from its systemd unit is never unlinked here.
    socket_identity: Option<(u64, u64)>,
    registry: Arc<Mutex<MediaRegistry>>,
    cas: ContentStore,
    clock: SharedClock,
    lineage: Arc<dyn ProcessLineage>,
    stream: Option<StreamBackend>,
}

impl MediaChannel {
    pub fn bind(
        path: &Path,
        registry: Arc<Mutex<MediaRegistry>>,
        cas: ContentStore,
        clock: SharedClock,
        lineage: Arc<dyn ProcessLineage>,
        stream: Option<StreamBackend>,
    ) -> std::io::Result<Self> {
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            let uid = rustix::process::geteuid().as_raw();
            if !metadata.file_type().is_socket() || metadata.uid() != uid || StdUnixStream::connect(path).is_ok() {
                return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "media socket is occupied"));
            }
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let metadata = std::fs::symlink_metadata(path)?;
        Ok(Self {
            listener,
            path: path.to_path_buf(),
            socket_identity: Some((metadata.dev(), metadata.ino())),
            registry,
            cas,
            clock,
            lineage,
            stream,
        })
    }

    /// Serves the renderer media socket inherited from its systemd unit.
    pub fn from_inherited(
        listener: std::os::unix::net::UnixListener,
        path: &Path,
        registry: Arc<Mutex<MediaRegistry>>,
        cas: ContentStore,
        clock: SharedClock,
        lineage: Arc<dyn ProcessLineage>,
        stream: Option<StreamBackend>,
    ) -> std::io::Result<Self> {
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener: UnixListener::from_std(listener)?,
            path: path.to_path_buf(),
            socket_identity: None,
            registry,
            cas,
            clock,
            lineage,
            stream,
        })
    }

    pub async fn run(self, shutdown: CancellationToken) -> std::io::Result<()> {
        let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                accepted = self.listener.accept() => {
                    let (stream, _) = match accepted {
                        Ok(value) => value,
                        Err(error) => {
                            tracing::warn!(component = "media", event = "accept_failed", error = %error);
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                    };
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                    let registry = self.registry.clone();
                    let cas = self.cas.clone();
                    let clock = self.clock.clone();
                    let lineage = self.lineage.clone();
                    let backend = self.stream.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let _ =
                            tokio::time::timeout(SERVE_TIMEOUT, serve(stream, registry, cas, clock, lineage, backend))
                                .await;
                    });
                }
            }
        }
    }
}

impl Drop for MediaChannel {
    fn drop(&mut self) {
        if let Some(identity) = self.socket_identity
            && let Ok(metadata) = std::fs::symlink_metadata(&self.path)
            && metadata.file_type().is_socket()
            && (metadata.dev(), metadata.ino()) == identity
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

async fn read_request(stream: &mut UnixStream) -> std::io::Result<Request> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid media frame length"));
    }
    let mut body = vec![0u8; size];
    stream.read_exact(&mut body).await?;
    serde_json::from_slice(&body)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid media request"))
}

async fn write_reply(stream: &mut UnixStream, reply: serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(&reply).map_err(std::io::Error::other)?;
    if body.len() > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "media reply is too large"));
    }
    stream.write_all(&(body.len() as u32).to_be_bytes()).await?;
    stream.write_all(&body).await
}

async fn deny(stream: &mut UnixStream) -> std::io::Result<()> {
    write_reply(stream, json!({"status": "denied"})).await
}

/// A refusal that names its typed stream failure. Only sent after a
/// grant was resolved, so unauthenticated peers learn nothing new; the C
/// client treats any non-`ok` status as denied.
async fn deny_reason(stream: &mut UnixStream, reason: &str) -> std::io::Result<()> {
    write_reply(stream, json!({"status": "denied", "reason": reason})).await
}

/// One bounded origin range read for a stream-backed grant. The server
/// handle is cloned up front and no registry lock is held across I/O;
/// after the bytes arrive the relationship is re-checked, so a
/// revocation, mismatch, or re-pair mid-read never releases another
/// installation's bytes.
pub(crate) async fn network_read(
    backend: &StreamBackend,
    grant: &MediaGrant,
    source: &StreamSource,
    offset: u64,
    length: u32,
) -> Result<Vec<u8>, StreamReadError> {
    // The watch holds a handle only while Core's link is verified; `None`
    // is offline, revoked, or mismatched, all answered identically.
    let server = backend.server.borrow().clone().ok_or(StreamReadError::Network)?;
    let installation = server.installation_id();
    let origin = OriginBlobSource::new(server, &source.download_path).map_err(|_| StreamReadError::RangeRejected)?;
    let _permit = tokio::time::timeout(REQUEST_TIMEOUT, backend.reads.acquire())
        .await
        .map_err(|_| StreamReadError::Network)?
        .map_err(|_| StreamReadError::Network)?;
    let bytes = tokio::time::timeout(
        STREAM_READ_TIMEOUT,
        origin.read_exact(&grant.sha256, grant.size_bytes, offset, u64::from(length)),
    )
    .await
    .map_err(|_| StreamReadError::Network)??;
    match backend.server.borrow().clone() {
        None => Err(StreamReadError::Network),
        Some(current) if current.installation_id() != installation => Err(StreamReadError::Unauthorized),
        Some(_) => Ok(bytes),
    }
}

/// Whether a capability is still live for the usage the peer named.
/// Media and frame grants share the registry but resolve from disjoint
/// tables; every liveness check funnels through here so the two can
/// never drift apart again.
pub(crate) fn grant_live(registry: &MediaRegistry, session: SessionId, capability: &str, expect: ReadExpect, now_ms: i64) -> bool {
    match expect {
        ReadExpect::Media => registry.resolve(session, capability, now_ms),
        ReadExpect::Frame => registry.resolve_frame(session, capability, now_ms),
    }
    .is_some()
}

async fn serve(
    mut stream: UnixStream,
    registry: Arc<Mutex<MediaRegistry>>,
    cas: ContentStore,
    clock: SharedClock,
    lineage: Arc<dyn ProcessLineage>,
    backend: Option<StreamBackend>,
) -> std::io::Result<()> {
    let credentials = stream.peer_cred()?;
    let Some(pid) = credentials.pid() else { return deny(&mut stream).await };
    let request = match tokio::time::timeout(REQUEST_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        _ => return deny(&mut stream).await,
    };
    let expect = request.expect();
    let grant = {
        let Ok(registry) = registry.lock() else { return deny(&mut stream).await };
        registry.renderer().and_then(|renderer| {
            (renderer.uid == credentials.uid() && lineage.belongs_to(renderer, pid))
                .then(|| {
                    let now = clock.now().unix_millis();
                    match expect {
                        ReadExpect::Media => registry.resolve(renderer.session, request.capability(), now),
                        ReadExpect::Frame => registry.resolve_frame(renderer.session, request.capability(), now),
                    }
                    .cloned()
                })
                .flatten()
        })
    };
    let Some(grant) = grant else {
        // Daemon-side attribution only: the socket answer stays bare so
        // unknown and retired tokens are indistinguishable on the wire.
        let retired = registry.lock().is_ok_and(|registry| registry.retired_token(request.capability()));
        tracing::warn!(
            component = "media",
            event = "grant_denied",
            reason = if retired {
                match expect {
                    ReadExpect::Frame => "widget_grant_revoked",
                    ReadExpect::Media => "media_grant_revoked",
                }
            } else {
                match expect {
                    ReadExpect::Frame => "widget_grant_unknown",
                    ReadExpect::Media => "media_grant_unknown",
                }
            },
        );
        return deny(&mut stream).await;
    };
    if grant.read_mode != ReadMode::Seekable {
        return deny(&mut stream).await;
    }
    // Verified CAS bytes first, even for stream-backed grants: a video
    // downloaded since preparation plays from disk, including offline.
    // The grant pins the size; a mismatched record is not this object.
    let cached = match cas.open_verified(&grant.sha256).await {
        Ok(Some((file, record))) if record.size_bytes == grant.size_bytes => Some(file),
        _ => None,
    };
    let capability = request.capability().to_owned();
    let still_valid = registry.lock().is_ok_and(|registry| {
        grant_live(&registry, grant.renderer_session, &capability, expect, clock.now().unix_millis())
    });
    if !still_valid {
        return deny(&mut stream).await;
    }
    match request {
        Request::Head { .. } => {
            // A grant without bytes and without a network backend stays
            // denied, exactly as before streaming existed.
            if cached.is_none() && grant.stream.is_none() {
                return deny(&mut stream).await;
            }
            write_reply(
                &mut stream,
                json!({"status": "ok", "sizeBytes": grant.size_bytes, "mimeType": grant.mime_type}),
            )
            .await
        }
        Request::Read { offset, length, .. } => {
            if length == 0
                || length > MAX_READ
                || offset.checked_add(u64::from(length)).is_none_or(|end| end > grant.size_bytes)
            {
                return deny(&mut stream).await;
            }
            if let Some(file) = cached {
                let bytes = tokio::task::spawn_blocking(move || {
                    use std::os::unix::fs::FileExt as _;
                    let mut bytes = vec![0u8; length as usize];
                    let mut done = 0;
                    while done < bytes.len() {
                        let n = file.read_at(&mut bytes[done..], offset + done as u64)?;
                        if n == 0 {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "media object was truncated",
                            ));
                        }
                        done += n;
                    }
                    Ok::<_, std::io::Error>(bytes)
                })
                .await;
                let Ok(Ok(bytes)) = bytes else { return deny(&mut stream).await };
                let still_valid = registry.lock().is_ok_and(|registry| {
                    grant_live(&registry, grant.renderer_session, &capability, expect, clock.now().unix_millis())
                });
                if !still_valid {
                    return deny(&mut stream).await;
                }
                write_reply(&mut stream, json!({"status": "ok", "length": bytes.len()})).await?;
                return stream.write_all(&bytes).await;
            }
            let (Some(source), Some(backend)) = (grant.stream.clone(), backend) else {
                return deny(&mut stream).await;
            };
            let bytes = match network_read(&backend, &grant, &source, offset, length).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    tracing::warn!(
                        component = "media",
                        event = "stream_read_failed",
                        reason = error.reason_code(),
                        offset,
                        length
                    );
                    return deny_reason(&mut stream, error.reason_code()).await;
                }
            };
            let still_valid = registry.lock().is_ok_and(|registry| {
                grant_live(&registry, grant.renderer_session, &capability, expect, clock.now().unix_millis())
            });
            if !still_valid {
                return deny(&mut stream).await;
            }
            write_reply(&mut stream, json!({"status": "ok", "length": bytes.len()})).await?;
            stream.write_all(&bytes).await
        }
    }
}

/// Fixed media-channel location. The directory is daemon-owned; the renderer
/// receives this path, never the CAS root.
pub fn socket_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("media.sock")
}

#[cfg(test)]
mod fixture_tests {
    use super::*;

    const CAP: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn c_client_media_frames_match_daemon_contract() {
        let head: Request =
            serde_json::from_str(include_str!("../../../../packages/edge-protocol/fixtures/media/head-request.json"))
                .unwrap();
        assert!(matches!(&head, Request::Head { capability, .. } if capability == CAP));
        assert_eq!(head.expect(), ReadExpect::Media);
        let read: Request =
            serde_json::from_str(include_str!("../../../../packages/edge-protocol/fixtures/media/read-request.json"))
                .unwrap();
        assert!(matches!(&read, Request::Read { capability, offset: 2, length: 3, .. } if capability == CAP));
        assert_eq!(read.expect(), ReadExpect::Media);
        // Frame reads name their usage explicitly; anything else is denied.
        let head: Request = serde_json::from_str(include_str!(
            "../../../../packages/edge-protocol/fixtures/media/head-frame-request.json"
        ))
        .unwrap();
        assert_eq!(head.expect(), ReadExpect::Frame);
        let read: Request = serde_json::from_str(include_str!(
            "../../../../packages/edge-protocol/fixtures/media/read-frame-request.json"
        ))
        .unwrap();
        assert_eq!(read.expect(), ReadExpect::Frame);
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"head","capability":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","expect":"video"}"#
        )
        .is_err());
        for (fixture, expected) in [
            (
                include_str!("../../../../packages/edge-protocol/fixtures/media/head-response.json"),
                json!({"status": "ok", "sizeBytes": 5, "mimeType": "image/png"}),
            ),
            (
                include_str!("../../../../packages/edge-protocol/fixtures/media/read-response.json"),
                json!({"status": "ok", "length": 3}),
            ),
            (
                include_str!("../../../../packages/edge-protocol/fixtures/media/denied-response.json"),
                json!({"status": "denied"}),
            ),
        ] {
            assert_eq!(serde_json::from_str::<serde_json::Value>(fixture).unwrap(), expected);
        }
    }
}

#[cfg(test)]
mod grant_tests {
    use super::*;
    use std::collections::HashMap;

    use edge_protocol::Sha256Digest;
    use edge_protocol::bounded::SafeText;
    use edge_protocol::ipc::presentation::{ContentRef, FrameRef};

    #[test]
    fn liveness_checks_follow_the_named_usage() {
        let session = SessionId::from_uuid(uuid::Uuid::new_v4());
        let mut registry = MediaRegistry::new();
        registry.bind_renderer(RendererInstance { session, uid: 1000, pid: 1234, start_ticks: 1 });
        let content = ContentRef {
            sha256: Sha256Digest::parse(&"a".repeat(64)).unwrap(),
            size_bytes: 42,
            mime_type: SafeText::new("image/png").unwrap(),
        };
        let streams: HashMap<Sha256Digest, player_core::StreamSource> = HashMap::new();
        let media = registry.prepare(session, 1, 0, std::slice::from_ref(&content), &streams).unwrap();
        let media_token = media[&content.sha256].as_str().to_owned();
        let frame = FrameRef {
            package_id: SafeText::new("acme.athletics").unwrap(),
            package_digest: Sha256Digest::parse(&"e".repeat(64)).unwrap(),
            sha256: Sha256Digest::parse(&"f".repeat(64)).unwrap(),
            size_bytes: 42,
        };
        let frames = registry.prepare_frames(session, 1, 0, std::slice::from_ref(&frame)).unwrap();
        let frame_token = frames[&frame.sha256].as_str().to_owned();
        // A cached frame read revalidates in the frame table: resolving
        // it as media denies bytes head just approved.
        assert!(grant_live(&registry, session, &media_token, ReadExpect::Media, 0));
        assert!(!grant_live(&registry, session, &media_token, ReadExpect::Frame, 0));
        assert!(grant_live(&registry, session, &frame_token, ReadExpect::Frame, 0));
        assert!(!grant_live(&registry, session, &frame_token, ReadExpect::Media, 0));
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use crate::media::{GenerationState, MediaGrantKind};
    use edge_protocol::ids::SessionId;
    use http_body_util::Full;
    use hyper::body::Incoming;
    use hyper::{Request, Response, StatusCode};

    const PATH: &str =
        "/api/v1/player/assets/844f4a48-a47c-4fbd-8a84-f8d61cc64b6a/variants/46784d73-3daf-45cf-8ff0-7cb4a3d12852";
    const CREDENTIAL: &str = "tc_device_abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz0123456789ABCD";

    struct Mock {
        installation: edge_protocol::InstallationId,
        status: Mutex<StatusCode>,
        body: Mutex<Vec<u8>>,
        seen: Mutex<Vec<(String, String)>>,
        gate: Option<tokio::sync::Notify>,
    }

    async fn handle(
        mock: Arc<Mock>,
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
        let range = request.headers().get(hyper::header::RANGE).and_then(|v| v.to_str().ok()).unwrap_or("").into();
        let if_range =
            request.headers().get(hyper::header::IF_RANGE).and_then(|v| v.to_str().ok()).unwrap_or("").into();
        mock.seen.lock().unwrap().push((range, if_range));
        if let Some(gate) = &mock.gate {
            gate.notified().await;
        }
        let body = mock.body.lock().unwrap().clone();
        let mut response = Response::new(Full::new(bytes::Bytes::from(body.clone())));
        *response.status_mut() = *mock.status.lock().unwrap();
        if response.status() == StatusCode::PARTIAL_CONTENT {
            response.headers_mut().insert(
                hyper::header::CONTENT_RANGE,
                format!("bytes 0-{}/{}", body.len().saturating_sub(1), body.len()).parse().unwrap(),
            );
        }
        Ok(response)
    }

    async fn serving(installation: u128, status: StatusCode, body: &[u8]) -> (String, Arc<Mock>) {
        serving_gated(installation, status, body, None).await
    }

    async fn serving_gated(
        installation: u128,
        status: StatusCode,
        body: &[u8],
        gate: Option<tokio::sync::Notify>,
    ) -> (String, Arc<Mock>) {
        let mock = Arc::new(Mock {
            installation: edge_protocol::InstallationId::from_uuid(uuid::Uuid::from_u128(installation)),
            status: Mutex::new(status),
            body: Mutex::new(body.to_vec()),
            seen: Mutex::new(Vec::new()),
            gate,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let serving = Arc::clone(&mock);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let serving = Arc::clone(&serving);
                let service = hyper::service::service_fn(move |request| handle(Arc::clone(&serving), request));
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            }
        });
        (format!("http://{address}"), mock)
    }

    async fn verified(url: &str, installation: u128) -> AuthenticatedServer {
        let id = edge_protocol::InstallationId::from_uuid(uuid::Uuid::from_u128(installation));
        let client = edge_server::ServerClient::new(url, "test").unwrap();
        let credential = edge_server::DeviceCredential::parse(CREDENTIAL).unwrap();
        client.verify_installation(id, credential).await.unwrap()
    }

    fn grant_for(digest: edge_protocol::Sha256Digest, size: u64, stream: Option<StreamSource>) -> MediaGrant {
        MediaGrant {
            renderer_session: SessionId::from_uuid(uuid::Uuid::nil()),
            generation: 1,
            kind: MediaGrantKind::Media,
            sha256: digest,
            size_bytes: size,
            mime_type: "video/mp4".into(),
            read_mode: ReadMode::Seekable,
            state: GenerationState::Active,
            expires_at_ms: None,
            stream,
        }
    }

    fn source() -> StreamSource {
        StreamSource::new(PATH.to_owned()).unwrap()
    }

    #[tokio::test]
    async fn stream_read_serves_exact_ranges_with_validator() {
        let bytes = b"0123456789abcdef";
        let (url, mock) = serving(7, StatusCode::PARTIAL_CONTENT, bytes).await;
        let server = verified(&url, 7).await;
        let (_send, receive) = watch::channel(Some(server));
        let backend = StreamBackend::new(receive);
        let digest = edge_protocol::Sha256Digest::of(b"streamed video object");
        let grant = grant_for(digest, bytes.len() as u64, Some(source()));
        let out = network_read(&backend, &grant, &source(), 0, bytes.len() as u32).await.unwrap();
        assert_eq!(out, bytes);
        let seen = mock.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, format!("bytes=0-{}", bytes.len() - 1));
        assert_eq!(seen[0].1, format!("\"sha256-{}\"", digest.to_hex()));
    }

    #[tokio::test]
    async fn stream_read_without_a_verified_link_is_unreachable() {
        let (_send, receive) = watch::channel(None);
        let backend = StreamBackend::new(receive);
        let digest = edge_protocol::Sha256Digest::of(b"offline object");
        let grant = grant_for(digest, 16, Some(source()));
        assert_eq!(network_read(&backend, &grant, &source(), 0, 4).await, Err(player_core::StreamReadError::Network));
    }

    #[tokio::test]
    async fn stream_read_maps_revocation_and_removal() {
        for (status, expected) in [
            (StatusCode::UNAUTHORIZED, player_core::StreamReadError::Unauthorized),
            (StatusCode::NOT_FOUND, player_core::StreamReadError::NotFound),
            (StatusCode::RANGE_NOT_SATISFIABLE, player_core::StreamReadError::RangeRejected),
        ] {
            let (url, _) = serving(7, status, b"").await;
            let server = verified(&url, 7).await;
            let (_send, receive) = watch::channel(Some(server));
            let backend = StreamBackend::new(receive);
            let digest = edge_protocol::Sha256Digest::of(b"gone object");
            let grant = grant_for(digest, 16, Some(source()));
            assert_eq!(network_read(&backend, &grant, &source(), 0, 4).await, Err(expected));
        }
    }

    #[tokio::test]
    async fn revocation_mid_read_withholds_the_bytes() {
        let bytes = b"0123456789abcdef";
        let (url, mock) = serving_gated(7, StatusCode::PARTIAL_CONTENT, bytes, Some(tokio::sync::Notify::new())).await;
        let server = verified(&url, 7).await;
        let (send, receive) = watch::channel(Some(server));
        let backend = StreamBackend::new(receive);
        let digest = edge_protocol::Sha256Digest::of(b"revoked mid read");
        let grant = grant_for(digest, bytes.len() as u64, Some(source()));
        let read = tokio::spawn({
            let backend = backend.clone();
            let grant = grant.clone();
            async move { network_read(&backend, &grant, &source(), 0, bytes.len() as u32).await }
        });
        // Wait until the origin request is in flight, revoke, then release.
        for _ in 0..100 {
            if !mock.seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        send.send_replace(None);
        mock.gate.as_ref().unwrap().notify_waiters();
        assert_eq!(read.await.unwrap(), Err(player_core::StreamReadError::Network));
    }

    #[tokio::test]
    async fn repair_mid_read_withholds_the_old_bytes() {
        let bytes = b"0123456789abcdef";
        let (url_a, mock) =
            serving_gated(7, StatusCode::PARTIAL_CONTENT, bytes, Some(tokio::sync::Notify::new())).await;
        let (url_b, _) = serving(8, StatusCode::PARTIAL_CONTENT, bytes).await;
        let server_a = verified(&url_a, 7).await;
        let server_b = verified(&url_b, 8).await;
        let (send, receive) = watch::channel(Some(server_a));
        let backend = StreamBackend::new(receive);
        let digest = edge_protocol::Sha256Digest::of(b"repaired mid read");
        let grant = grant_for(digest, bytes.len() as u64, Some(source()));
        let read = tokio::spawn({
            let backend = backend.clone();
            let grant = grant.clone();
            async move { network_read(&backend, &grant, &source(), 0, bytes.len() as u32).await }
        });
        // The read targets A (cloned up front); rebinding to B mid-flight
        // refuses A's clean answer afterwards.
        for _ in 0..100 {
            if !mock.seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        send.send_replace(Some(server_b));
        mock.gate.as_ref().unwrap().notify_waiters();
        assert_eq!(read.await.unwrap(), Err(player_core::StreamReadError::Unauthorized));
    }
}
