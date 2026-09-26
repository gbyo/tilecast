//! The daemon side of local IPC.
//!
//! # Session lifecycle
//!
//! 1. **Peer check.** The peer UID from `SO_PEERCRED` must be admitted by
//!    [`PeerPolicy`]. An unadmitted peer is disconnected without any reply.
//! 2. **Handshake.** The first frame must be `hello` within
//!    `HANDSHAKE_TIMEOUT_MS`. Version negotiation and role policy failures
//!    are answered with `rejected`, then the socket closes.
//! 3. **Session.** A `welcome` is queued, the handler's `session_opened` runs,
//!    and frames flow. A second `renderer` session supersedes the first: the
//!    old one receives `goodbye{reason: superseded}` and is closed.
//! 4. **Close.** Any protocol violation, a full outbound queue, a goodbye,
//!    EOF or daemon shutdown ends the session; `session_closed` always runs
//!    exactly once.
//!
//! # Backpressure
//!
//! Each session has a bounded outbound queue ([`OUTBOUND_QUEUE_FRAMES`]). A
//! client that stops reading is disconnected with reason `backpressure`
//! instead of letting the daemon buffer without limit. A renderer that
//! reconnects receives the current state again, so nothing is lost.

use std::collections::{BTreeSet, HashMap};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ids::SessionId;
use edge_protocol::ipc::event::Event;
use edge_protocol::ipc::message::{
    ErrorBody, EventFrame, Frame, Goodbye, Hello, MessageError, RejectCode, Rejected, Response, Welcome,
};
use edge_protocol::ipc::method::{Method, MethodError, error_codes};
use edge_protocol::ipc::{
    DAEMON_MAX_PROTOCOL_VERSION, DAEMON_MIN_PROTOCOL_VERSION, Direction, HANDSHAKE_TIMEOUT_MS, MAX_FRAME_BYTES, Role,
    negotiate_version,
};
use serde_json::Value;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::io::{IoError, read_frame, read_payload, write_frame};

pub const OUTBOUND_QUEUE_FRAMES: usize = 256;
pub const MAX_TILECASTCTL_SESSIONS: usize = 8;

/// Which local UIDs may connect, and in which roles.
#[derive(Debug, Clone)]
pub struct PeerPolicy {
    /// The daemon's own account (`tilecast`). Admitted for every role and
    /// the only non-root account allowed administrative methods.
    pub daemon_uid: u32,
    /// Additional accounts allowed to act as a renderer (normally empty: the
    /// renderer runs as the same `tilecast` account).
    pub renderer_uids: BTreeSet<u32>,
    /// Additional accounts allowed read-only `tilecastctl` access.
    pub observer_uids: BTreeSet<u32>,
}

impl PeerPolicy {
    pub fn for_daemon_uid(daemon_uid: u32) -> Self {
        Self { daemon_uid, renderer_uids: BTreeSet::new(), observer_uids: BTreeSet::new() }
    }

    fn admits(&self, uid: u32) -> bool {
        uid == 0 || uid == self.daemon_uid || self.renderer_uids.contains(&uid) || self.observer_uids.contains(&uid)
    }

    fn permits_role(&self, uid: u32, role: Role) -> bool {
        match role {
            Role::Renderer => uid == self.daemon_uid || self.renderer_uids.contains(&uid),
            Role::Tilecastctl => uid == 0 || uid == self.daemon_uid || self.observer_uids.contains(&uid),
            Role::SessionBridge => false,
        }
    }

    fn is_admin(&self, uid: u32) -> bool {
        uid == 0 || uid == self.daemon_uid
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCredentials {
    pub uid: u32,
    pub gid: u32,
    pub pid: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SendError {
    #[error("session is closed")]
    Closed,
    #[error("event is not sent in this direction or to this role")]
    NotPermitted,
}

struct Outbound {
    sender: mpsc::Sender<Frame>,
    next_seq: u64,
}

struct SessionInner {
    id: SessionId,
    role: Role,
    peer: PeerCredentials,
    admin: bool,
    protocol_version: u32,
    features: Vec<ShortToken>,
    outbound: Mutex<Outbound>,
    cancel: CancellationToken,
    close_reason: Mutex<Option<&'static str>>,
}

/// A live session. Cheap to clone; all clones refer to the same session.
#[derive(Clone)]
pub struct SessionHandle {
    inner: Arc<SessionInner>,
}

impl std::fmt::Debug for SessionHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionHandle")
            .field("id", &self.inner.id)
            .field("role", &self.inner.role)
            .field("uid", &self.inner.peer.uid)
            .finish()
    }
}

impl SessionHandle {
    pub fn id(&self) -> SessionId {
        self.inner.id
    }

    pub fn role(&self) -> Role {
        self.inner.role
    }

    pub fn peer(&self) -> PeerCredentials {
        self.inner.peer
    }

    pub fn is_admin(&self) -> bool {
        self.inner.admin
    }

    pub fn protocol_version(&self) -> u32 {
        self.inner.protocol_version
    }

    pub fn features(&self) -> &[ShortToken] {
        &self.inner.features
    }

    pub fn is_closed(&self) -> bool {
        self.inner.cancel.is_cancelled()
    }

    /// Queues an event for this session. Never blocks: a full queue closes
    /// the session with reason `backpressure`.
    pub fn send_event(&self, event: Event) -> Result<(), SendError> {
        if event.direction() != Direction::DaemonToClient || !event.allowed_roles().contains(&self.inner.role) {
            return Err(SendError::NotPermitted);
        }
        let mut outbound = self.inner.outbound.lock().unwrap_or_else(|p| p.into_inner());
        let seq = outbound.next_seq;
        match outbound.sender.try_send(Frame::Event(EventFrame { seq, event })) {
            Ok(()) => {
                outbound.next_seq += 1;
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                drop(outbound);
                self.close("backpressure");
                Err(SendError::Closed)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err(SendError::Closed),
        }
    }

    fn send_frame(&self, frame: Frame) -> Result<(), SendError> {
        let outbound = self.inner.outbound.lock().unwrap_or_else(|p| p.into_inner());
        outbound.sender.try_send(frame).map_err(|_| SendError::Closed)
    }

    /// Sends `goodbye{reason}` (best effort) and ends the session.
    pub fn close(&self, reason: &'static str) {
        {
            let mut slot = self.inner.close_reason.lock().unwrap_or_else(|p| p.into_inner());
            if slot.is_some() {
                return;
            }
            *slot = Some(reason);
        }
        if let Ok(token) = ShortToken::new(reason) {
            let _ = self.send_frame(Frame::Goodbye(Goodbye { reason: token }));
        }
        self.inner.cancel.cancel();
    }

    fn close_reason(&self) -> &'static str {
        self.inner.close_reason.lock().unwrap_or_else(|p| p.into_inner()).unwrap_or("closed")
    }
}

/// Daemon behavior behind the transport.
#[async_trait]
pub trait IpcHandler: Send + Sync + 'static {
    /// Features enabled for a session: a subset of what the client requested.
    fn session_features(&self, role: Role, requested: &[ShortToken]) -> Vec<ShortToken>;
    /// Runs after `welcome` is queued. Renderer sessions are sent their
    /// configuration and current activation from here.
    async fn session_opened(&self, session: SessionHandle);
    /// A validated client → daemon event (direction, role and seq checked).
    async fn event(&self, session: &SessionHandle, event: Event);
    /// A validated request (role and admin checked). Return the result value.
    async fn request(&self, session: &SessionHandle, method: Method) -> Result<Value, ErrorBody>;
    /// Runs exactly once when a session ends.
    async fn session_closed(&self, session: &SessionHandle, reason: &str);
}

#[derive(Debug, thiserror::Error)]
pub enum BindError {
    #[error("{0} exists and is not a socket; refusing to replace it")]
    NotASocket(PathBuf),
    #[error("another process is already serving {0}")]
    InUse(PathBuf),
    #[error("could not bind {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub struct IpcServer {
    listener: UnixListener,
    path: PathBuf,
    policy: PeerPolicy,
    handler: Arc<dyn IpcHandler>,
    daemon_version: ShortText,
    sessions: Arc<Mutex<HashMap<SessionId, SessionHandle>>>,
}

impl std::fmt::Debug for IpcServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IpcServer").field("path", &self.path).finish()
    }
}

impl IpcServer {
    /// Binds the socket. A stale socket file left by a crashed daemon is
    /// replaced; any other file type at `path` is refused, and a live socket
    /// (another daemon) is an error.
    pub async fn bind(
        path: impl AsRef<Path>,
        policy: PeerPolicy,
        handler: Arc<dyn IpcHandler>,
        daemon_version: &str,
    ) -> Result<Self, BindError> {
        let path = path.as_ref().to_path_buf();
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_socket() => {
                if UnixStream::connect(&path).await.is_ok() {
                    return Err(BindError::InUse(path));
                }
                std::fs::remove_file(&path).map_err(|source| BindError::Io { path: path.clone(), source })?;
            }
            Ok(_) => return Err(BindError::NotASocket(path)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(BindError::Io { path, source }),
        }
        let listener = UnixListener::bind(&path).map_err(|source| BindError::Io { path: path.clone(), source })?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660))
            .map_err(|source| BindError::Io { path: path.clone(), source })?;
        Ok(Self {
            listener,
            path,
            policy,
            handler,
            daemon_version: ShortText::lossy(daemon_version),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Serves until `shutdown` is cancelled, then says goodbye to every
    /// session and removes the socket file.
    pub async fn run(self, shutdown: CancellationToken) {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                accepted = self.listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let context = ConnectionContext {
                                policy: self.policy.clone(),
                                handler: Arc::clone(&self.handler),
                                daemon_version: self.daemon_version.clone(),
                                sessions: Arc::clone(&self.sessions),
                                shutdown: shutdown.clone(),
                            };
                            connections.spawn(serve_connection(stream, context));
                        }
                        Err(error) => {
                            tracing::warn!(component = "ipc", event = "accept_failed", error = %error);
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                    }
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        let open: Vec<SessionHandle> =
            self.sessions.lock().unwrap_or_else(|p| p.into_inner()).values().cloned().collect();
        for session in open {
            session.close("daemon_shutdown");
        }
        let _ =
            tokio::time::timeout(Duration::from_secs(2), async { while connections.join_next().await.is_some() {} })
                .await;
        let _ = std::fs::remove_file(&self.path);
    }
}

struct ConnectionContext {
    policy: PeerPolicy,
    handler: Arc<dyn IpcHandler>,
    daemon_version: ShortText,
    sessions: Arc<Mutex<HashMap<SessionId, SessionHandle>>>,
    shutdown: CancellationToken,
}

fn rejected(code: RejectCode, message: &str) -> Frame {
    Frame::Rejected(Rejected {
        code,
        message: SafeText::lossy(message),
        min_protocol_version: DAEMON_MIN_PROTOCOL_VERSION,
        max_protocol_version: DAEMON_MAX_PROTOCOL_VERSION,
    })
}

fn error_body(code: &str, message: &str) -> ErrorBody {
    ErrorBody {
        code: ShortToken::new(code).unwrap_or_else(|_| ShortToken::new("internal_error").expect("literal token")),
        message: SafeText::lossy(message),
    }
}

async fn serve_connection(stream: UnixStream, context: ConnectionContext) {
    let peer = match stream.peer_cred() {
        Ok(credentials) => PeerCredentials { uid: credentials.uid(), gid: credentials.gid(), pid: credentials.pid() },
        Err(error) => {
            tracing::warn!(component = "ipc", event = "peer_credentials_unavailable", error = %error);
            return;
        }
    };
    if !context.policy.admits(peer.uid) {
        tracing::warn!(component = "ipc", event = "peer_rejected", uid = peer.uid);
        return;
    }
    let (mut reader, mut writer) = stream.into_split();

    let hello = match tokio::time::timeout(Duration::from_millis(HANDSHAKE_TIMEOUT_MS), read_frame(&mut reader)).await {
        Err(_) => {
            let _ = write_frame(&mut writer, &rejected(RejectCode::HandshakeTimeout, "No hello was received.")).await;
            return;
        }
        Ok(Ok(Frame::Hello(hello))) => hello,
        Ok(Ok(_)) | Ok(Err(IoError::Message(_))) => {
            let _ =
                write_frame(&mut writer, &rejected(RejectCode::MalformedHello, "The first frame must be hello.")).await;
            return;
        }
        Ok(Err(_)) => return,
    };

    let Some(version) = negotiate_version(hello.min_protocol_version, hello.max_protocol_version) else {
        let message = format!(
            "This tilecastd speaks IPC protocol versions {DAEMON_MIN_PROTOCOL_VERSION} through {DAEMON_MAX_PROTOCOL_VERSION}."
        );
        let _ = write_frame(&mut writer, &rejected(RejectCode::UnsupportedProtocolVersion, &message)).await;
        return;
    };
    if hello.role == Role::SessionBridge {
        let _ = write_frame(&mut writer, &rejected(RejectCode::RoleNotEnabled, "This role is not enabled.")).await;
        return;
    }
    if !context.policy.permits_role(peer.uid, hello.role) {
        tracing::warn!(component = "ipc", event = "role_rejected", uid = peer.uid, role = hello.role.as_str());
        let _ = write_frame(
            &mut writer,
            &rejected(RejectCode::RolePermissionDenied, "This account may not connect in that role."),
        )
        .await;
        return;
    }

    let session = match register_session(&context, &hello, peer, version) {
        Ok(session) => session,
        Err(reason) => {
            let _ = write_frame(&mut writer, &rejected(RejectCode::DaemonUnavailable, reason)).await;
            return;
        }
    };
    let (sender, mut receiver) = mpsc::channel::<Frame>(OUTBOUND_QUEUE_FRAMES);
    {
        let mut outbound = session.inner.outbound.lock().unwrap_or_else(|p| p.into_inner());
        outbound.sender = sender;
    }
    let welcome = Frame::Welcome(Welcome {
        protocol_version: version,
        session_id: session.id(),
        role: session.role(),
        daemon_version: context.daemon_version.clone(),
        features: session.features().to_vec(),
        max_frame_bytes: MAX_FRAME_BYTES as u32,
    });
    let _ = session.send_frame(welcome);

    tracing::info!(
        component = "ipc",
        event = "session_opened",
        session = %session.id(),
        role = session.role().as_str(),
        uid = peer.uid,
        client = hello.client.as_str()
    );

    let cancel = session.inner.cancel.clone();
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = receiver.recv().await {
            if write_frame(&mut writer, &frame).await.is_err() {
                break;
            }
            if matches!(frame, Frame::Goodbye(_)) {
                break;
            }
        }
    });

    context.handler.session_opened(session.clone()).await;
    let reason = read_loop(&mut reader, &session, &context).await;
    session.close(reason);
    // Give the writer a moment to flush the goodbye, then stop it.
    let _ = tokio::time::timeout(Duration::from_millis(500), writer_task).await;
    cancel.cancel();

    context.sessions.lock().unwrap_or_else(|p| p.into_inner()).remove(&session.id());
    let reason = session.close_reason();
    tracing::info!(component = "ipc", event = "session_closed", session = %session.id(), reason);
    context.handler.session_closed(&session, reason).await;
}

fn register_session(
    context: &ConnectionContext,
    hello: &Hello,
    peer: PeerCredentials,
    version: u32,
) -> Result<SessionHandle, &'static str> {
    let (placeholder, _) = mpsc::channel(1);
    let session = SessionHandle {
        inner: Arc::new(SessionInner {
            id: SessionId::new_random(),
            role: hello.role,
            peer,
            admin: context.policy.is_admin(peer.uid),
            protocol_version: version,
            features: context.handler.session_features(hello.role, &hello.features),
            outbound: Mutex::new(Outbound { sender: placeholder, next_seq: 1 }),
            cancel: context.shutdown.child_token(),
            close_reason: Mutex::new(None),
        }),
    };
    let mut sessions = context.sessions.lock().unwrap_or_else(|p| p.into_inner());
    match hello.role {
        Role::Renderer => {
            let previous: Vec<SessionHandle> =
                sessions.values().filter(|s| s.role() == Role::Renderer).cloned().collect();
            for old in previous {
                old.close("superseded");
            }
        }
        Role::Tilecastctl => {
            if sessions.values().filter(|s| s.role() == Role::Tilecastctl).count() >= MAX_TILECASTCTL_SESSIONS {
                return Err("Too many administration sessions are open.");
            }
        }
        Role::SessionBridge => return Err("This role is not enabled."),
    }
    sessions.insert(session.id(), session.clone());
    Ok(session)
}

async fn read_loop(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    session: &SessionHandle,
    context: &ConnectionContext,
) -> &'static str {
    let mut expected_seq = 1u64;
    loop {
        let payload = tokio::select! {
            _ = session.inner.cancel.cancelled() => {
                return if context.shutdown.is_cancelled() { "daemon_shutdown" } else { "closed" };
            }
            payload = read_payload(reader) => payload,
        };
        let payload = match payload {
            Ok(payload) => payload,
            Err(IoError::Closed) => return "peer_closed",
            Err(error) => {
                tracing::warn!(component = "ipc", event = "protocol_error", session = %session.id(), reason = error.reason_code());
                return error.reason_code();
            }
        };
        let frame = match Frame::decode(&payload) {
            Ok(frame) => frame,
            Err(MessageError::Method(error)) => {
                // A well-formed request for a method this daemon does not
                // know (or with invalid params) gets an error response rather
                // than a disconnect, so a newer CLI fails cleanly.
                let Some(id) = Frame::request_id(&payload) else {
                    return "malformed_frame";
                };
                let code = match error {
                    MethodError::Unknown(_) => error_codes::UNKNOWN_METHOD,
                    MethodError::InvalidParams { .. } => error_codes::INVALID_PARAMS,
                };
                let body = error_body(code, "The request could not be accepted.");
                if session.send_frame(Frame::Response(Response { id, outcome: Err(body) })).is_err() {
                    return "backpressure";
                }
                continue;
            }
            Err(error) => {
                tracing::warn!(component = "ipc", event = "protocol_error", session = %session.id(), error = %error);
                return "malformed_frame";
            }
        };
        match frame {
            Frame::Event(EventFrame { seq, event }) => {
                if seq != expected_seq {
                    return "event_sequence_violation";
                }
                expected_seq += 1;
                if event.direction() != Direction::ClientToDaemon || !event.allowed_roles().contains(&session.role()) {
                    return "event_not_permitted";
                }
                context.handler.event(session, event).await;
            }
            Frame::Request(request) => {
                let outcome = if !request.method.allowed_roles().contains(&session.role()) {
                    Err(error_body(error_codes::ROLE_NOT_PERMITTED, "This role may not call that method."))
                } else if request.method.is_administrative() && !session.is_admin() {
                    Err(error_body(error_codes::NOT_AUTHORIZED, "This request requires the tilecast account."))
                } else {
                    context.handler.request(session, request.method).await
                };
                if session.send_frame(Frame::Response(Response { id: request.id, outcome })).is_err() {
                    return "backpressure";
                }
            }
            Frame::Goodbye(_) => return "peer_goodbye",
            Frame::Hello(_) | Frame::Welcome(_) | Frame::Rejected(_) | Frame::Response(_) => {
                return "unexpected_frame";
            }
        }
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    #[test]
    fn root_administers_but_is_not_a_renderer_and_others_are_refused() {
        let mut policy = PeerPolicy::for_daemon_uid(990);
        policy.observer_uids.insert(1000);
        assert!(policy.admits(0) && policy.is_admin(0) && policy.permits_role(0, Role::Tilecastctl));
        assert!(!policy.permits_role(0, Role::Renderer), "root must not impersonate the renderer");
        assert!(policy.permits_role(990, Role::Renderer) && policy.is_admin(990));
        assert!(policy.admits(1000) && policy.permits_role(1000, Role::Tilecastctl) && !policy.is_admin(1000));
        assert!(!policy.permits_role(1000, Role::Renderer));
        assert!(!policy.admits(1001));
        assert!(!policy.permits_role(990, Role::SessionBridge), "reserved role");
    }
}
