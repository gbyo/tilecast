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
use edge_protocol::time::SharedClock;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::media::{MediaRegistry, ReadMode, RendererInstance};

const MAX_FRAME: usize = 512;
const MAX_READ: u32 = 1024 * 1024;
const MAX_CONNECTIONS: usize = 32;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Head { capability: String },
    Read { capability: String, offset: u64, length: u32 },
}

impl Request {
    fn capability(&self) -> &str {
        match self {
            Self::Head { capability } | Self::Read { capability, .. } => capability,
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
    socket_identity: (u64, u64),
    registry: Arc<Mutex<MediaRegistry>>,
    cas: ContentStore,
    clock: SharedClock,
    lineage: Arc<dyn ProcessLineage>,
}

impl MediaChannel {
    pub fn bind(
        path: &Path,
        registry: Arc<Mutex<MediaRegistry>>,
        cas: ContentStore,
        clock: SharedClock,
        lineage: Arc<dyn ProcessLineage>,
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
            socket_identity: (metadata.dev(), metadata.ino()),
            registry,
            cas,
            clock,
            lineage,
        })
    }

    pub async fn run(self, shutdown: CancellationToken) -> std::io::Result<()> {
        let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted?;
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                    let registry = self.registry.clone();
                    let cas = self.cas.clone();
                    let clock = self.clock.clone();
                    let lineage = self.lineage.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let _ = tokio::time::timeout(REQUEST_TIMEOUT, serve(stream, registry, cas, clock, lineage)).await;
                    });
                }
            }
        }
    }
}

impl Drop for MediaChannel {
    fn drop(&mut self) {
        if let Ok(metadata) = std::fs::symlink_metadata(&self.path)
            && metadata.file_type().is_socket()
            && (metadata.dev(), metadata.ino()) == self.socket_identity
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

async fn serve(
    mut stream: UnixStream,
    registry: Arc<Mutex<MediaRegistry>>,
    cas: ContentStore,
    clock: SharedClock,
    lineage: Arc<dyn ProcessLineage>,
) -> std::io::Result<()> {
    let credentials = stream.peer_cred()?;
    let Some(pid) = credentials.pid() else { return deny(&mut stream).await };
    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(_) => return deny(&mut stream).await,
    };
    let grant = {
        let Ok(registry) = registry.lock() else { return deny(&mut stream).await };
        registry.renderer().and_then(|renderer| {
            (renderer.uid == credentials.uid() && lineage.belongs_to(renderer, pid))
                .then(|| registry.resolve(renderer.session, request.capability(), clock.now().unix_millis()).cloned())
                .flatten()
        })
    };
    let Some(grant) = grant else { return deny(&mut stream).await };
    if grant.read_mode != ReadMode::Seekable {
        return deny(&mut stream).await;
    }
    let (file, record) = match cas.open_verified(&grant.sha256).await {
        Ok(Some(value)) => value,
        _ => return deny(&mut stream).await,
    };
    if record.size_bytes != grant.size_bytes {
        return deny(&mut stream).await;
    }
    let capability = request.capability().to_owned();
    let still_valid = registry.lock().is_ok_and(|registry| {
        registry.resolve(grant.renderer_session, &capability, clock.now().unix_millis()).is_some()
    });
    if !still_valid {
        return deny(&mut stream).await;
    }
    match request {
        Request::Head { .. } => {
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
                registry.resolve(grant.renderer_session, &capability, clock.now().unix_millis()).is_some()
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
        assert!(matches!(head, Request::Head { capability } if capability == CAP));
        let read: Request =
            serde_json::from_str(include_str!("../../../../packages/edge-protocol/fixtures/media/read-request.json"))
                .unwrap();
        assert!(matches!(read, Request::Read { capability, offset: 2, length: 3 } if capability == CAP));
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
