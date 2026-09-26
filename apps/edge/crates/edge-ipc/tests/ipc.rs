//! End-to-end IPC tests over a real Unix socket.
#![allow(clippy::unwrap_used)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use edge_ipc::client::{ClientError, ClientOptions, Incoming, IpcClient};
use edge_ipc::server::{BindError, IpcHandler, IpcServer, PeerPolicy, SessionHandle};
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ids::ActivationId;
use edge_protocol::ipc::Role;
use edge_protocol::ipc::event::{
    ActivationRef, Event, EvidenceKind, PluginState, PresentationActivate, RendererInfo, RendererKind,
    RendererPlatform, RendererProgress, RendererReady,
};
use edge_protocol::ipc::message::{ErrorBody, EventFrame, Frame, RejectCode};
use edge_protocol::ipc::method::{Empty, Method};
use edge_protocol::ipc::presentation::{PresentationDocument, StatusSurface};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<Event>>,
    closed: Mutex<Vec<String>>,
    sessions: Mutex<Vec<SessionHandle>>,
}

#[async_trait]
impl IpcHandler for Recorder {
    fn session_features(&self, _role: Role, requested: &[ShortToken]) -> Vec<ShortToken> {
        requested.iter().filter(|f| f.as_str() == "image").cloned().collect()
    }

    async fn session_opened(&self, session: SessionHandle) {
        self.sessions.lock().unwrap().push(session);
    }

    async fn event(&self, _session: &SessionHandle, event: Event) {
        self.events.lock().unwrap().push(event);
    }

    async fn request(&self, _session: &SessionHandle, method: Method) -> Result<Value, ErrorBody> {
        Ok(json!({"method": method.name()}))
    }

    async fn session_closed(&self, _session: &SessionHandle, reason: &str) {
        self.closed.lock().unwrap().push(reason.to_owned());
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    handler: Arc<Recorder>,
    shutdown: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

fn uid() -> u32 {
    rustix::process::getuid().as_raw()
}

async fn start(policy: PeerPolicy) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("edge.sock");
    let handler = Arc::new(Recorder::default());
    let server = IpcServer::bind(&path, policy, handler.clone(), "0.1.0-test").await.unwrap();
    let shutdown = CancellationToken::new();
    let task = tokio::spawn(server.run(shutdown.clone()));
    Harness { _dir: dir, path, handler, shutdown, task }
}

async fn eventually(mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached");
}

fn renderer() -> ClientOptions {
    let mut options = ClientOptions::new(Role::Renderer, "tilecast-renderer-test", "0.0.1");
    options.features = vec![ShortToken::new("image").unwrap(), ShortToken::new("unknown-future").unwrap()];
    options
}

fn ready() -> Event {
    Event::RendererReady(RendererReady {
        renderer: RendererInfo {
            kind: RendererKind::Wpe,
            version: ShortText::new("0.0.1").unwrap(),
            engine_version: ShortText::new("2.54.0").unwrap(),
            gstreamer_version: None,
            platform: RendererPlatform::Headless,
        },
        features: vec![ShortToken::new("image").unwrap()],
        display: None,
    })
}

#[tokio::test]
async fn handshake_negotiates_features_and_serves_requests() {
    let harness = start(PeerPolicy::for_daemon_uid(uid())).await;
    let client = IpcClient::connect(&harness.path, renderer()).await.unwrap();
    assert_eq!(client.welcome().protocol_version, 1);
    assert_eq!(client.welcome().role, Role::Renderer);
    assert_eq!(client.welcome().features.iter().map(|f| f.as_str()).collect::<Vec<_>>(), vec!["image"]);
    let reply = client.request(Method::Ping(Empty {})).await.unwrap().unwrap();
    assert_eq!(reply, json!({"method": "ping"}));
    client.send_event(ready()).await.unwrap();
    eventually(|| harness.handler.events.lock().unwrap().len() == 1).await;
    // Method not permitted for the renderer role.
    let denied = client.request(Method::StatusGet(Empty {})).await.unwrap().unwrap_err();
    assert_eq!(denied.code.as_str(), "role_not_permitted");
    harness.shutdown.cancel();
    harness.task.await.unwrap();
}

#[tokio::test]
async fn unsupported_version_and_malformed_hello_are_rejected() {
    let harness = start(PeerPolicy::for_daemon_uid(uid())).await;
    let mut options = renderer();
    options.min_protocol_version = 2;
    options.max_protocol_version = 9;
    match IpcClient::connect(&harness.path, options).await {
        Err(ClientError::Rejected(rejected)) => {
            assert_eq!(rejected.code, RejectCode::UnsupportedProtocolVersion);
            assert_eq!((rejected.min_protocol_version, rejected.max_protocol_version), (1, 1));
        }
        other => panic!("expected rejection, got {other:?}"),
    }

    // A request before hello.
    let mut stream = tokio::net::UnixStream::connect(&harness.path).await.unwrap();
    let payload = br#"{"type":"request","id":"r1","method":"ping","params":{}}"#;
    stream.write_all(&(payload.len() as u32).to_be_bytes()).await.unwrap();
    stream.write_all(payload).await.unwrap();
    let reply = edge_ipc::io::read_frame(&mut stream).await.unwrap();
    assert!(matches!(reply, Frame::Rejected(r) if r.code == RejectCode::MalformedHello));

    // Garbage JSON.
    let mut stream = tokio::net::UnixStream::connect(&harness.path).await.unwrap();
    stream.write_all(&3u32.to_be_bytes()).await.unwrap();
    stream.write_all(b"{{{").await.unwrap();
    let reply = edge_ipc::io::read_frame(&mut stream).await.unwrap();
    assert!(matches!(reply, Frame::Rejected(r) if r.code == RejectCode::MalformedHello));

    // Oversized header: the connection is dropped without reading a payload.
    let mut stream = tokio::net::UnixStream::connect(&harness.path).await.unwrap();
    stream.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
    assert!(edge_ipc::io::read_frame(&mut stream).await.is_err());

    // Reserved role.
    let options = ClientOptions::new(Role::SessionBridge, "bridge", "0");
    assert!(matches!(
        IpcClient::connect(&harness.path, options).await,
        Err(ClientError::Rejected(r)) if r.code == RejectCode::RoleNotEnabled
    ));
    harness.shutdown.cancel();
}

#[tokio::test]
async fn handshake_times_out() {
    let harness = start(PeerPolicy::for_daemon_uid(uid())).await;
    let mut stream = tokio::net::UnixStream::connect(&harness.path).await.unwrap();
    let started = std::time::Instant::now();
    let reply = edge_ipc::io::read_frame(&mut stream).await.unwrap();
    assert!(matches!(reply, Frame::Rejected(r) if r.code == RejectCode::HandshakeTimeout));
    assert!(started.elapsed() >= Duration::from_millis(4_500));
    harness.shutdown.cancel();
}

/// Root is always admitted with every role (policy, see `PeerPolicy`), so
/// UID-refusal tests are meaningful only for a non-root test process.
fn running_as_root() -> bool {
    let root = uid() == 0;
    if root {
        eprintln!("skipped: the test process is root, which the peer policy always admits");
    }
    root
}

#[tokio::test]
async fn role_and_admin_policy_follow_peer_uid() {
    if running_as_root() {
        return;
    }
    // This process is only an observer: tilecastctl yes, renderer and admin no.
    let mut policy = PeerPolicy::for_daemon_uid(uid().wrapping_add(4242));
    policy.observer_uids.insert(uid());
    let harness = start(policy).await;
    assert!(matches!(
        IpcClient::connect(&harness.path, renderer()).await,
        Err(ClientError::Rejected(r)) if r.code == RejectCode::RolePermissionDenied
    ));
    let ctl =
        IpcClient::connect(&harness.path, ClientOptions::new(Role::Tilecastctl, "tilecastctl", "0")).await.unwrap();
    assert!(ctl.request(Method::StatusGet(Empty {})).await.unwrap().is_ok());
    let admin = ctl.request(Method::DiagnosticsShowStatus(Empty {})).await.unwrap().unwrap_err();
    assert_eq!(admin.code.as_str(), "not_authorized");
    harness.shutdown.cancel();
}

#[tokio::test]
async fn unadmitted_uid_is_dropped_silently() {
    if running_as_root() {
        return;
    }
    let harness = start(PeerPolicy::for_daemon_uid(uid().wrapping_add(4242))).await;
    let result = IpcClient::connect(&harness.path, renderer()).await;
    assert!(matches!(result, Err(ClientError::Io(_))), "{result:?}");
    harness.shutdown.cancel();
}

#[tokio::test]
async fn unknown_method_gets_error_response_and_session_survives() {
    let harness = start(PeerPolicy::for_daemon_uid(uid())).await;
    let client =
        IpcClient::connect(&harness.path, ClientOptions::new(Role::Tilecastctl, "tilecastctl", "0")).await.unwrap();
    // Write a raw request for a method this daemon does not know.
    let mut stream = tokio::net::UnixStream::connect(&harness.path).await.unwrap();
    let hello = Frame::Hello(edge_protocol::ipc::message::Hello {
        min_protocol_version: 1,
        max_protocol_version: 1,
        role: Role::Tilecastctl,
        client: ShortToken::new("raw").unwrap(),
        client_version: ShortText::new("0").unwrap(),
        features: vec![],
    });
    edge_ipc::io::write_frame(&mut stream, &hello).await.unwrap();
    assert!(matches!(edge_ipc::io::read_frame(&mut stream).await.unwrap(), Frame::Welcome(_)));
    let payload = br#"{"type":"request","id":"r9","method":"shell.exec","params":{"cmd":"id"}}"#;
    stream.write_all(&(payload.len() as u32).to_be_bytes()).await.unwrap();
    stream.write_all(payload).await.unwrap();
    match edge_ipc::io::read_frame(&mut stream).await.unwrap() {
        Frame::Response(response) => {
            assert_eq!(response.id.as_str(), "r9");
            assert_eq!(response.outcome.unwrap_err().code.as_str(), "unknown_method");
        }
        other => panic!("expected response, got {other:?}"),
    }
    assert!(client.request(Method::Ping(Empty {})).await.unwrap().is_ok());
    harness.shutdown.cancel();
}

#[tokio::test]
async fn wrong_direction_and_sequence_violations_close_the_session() {
    let harness = start(PeerPolicy::for_daemon_uid(uid())).await;

    // A renderer may not send a daemon → client event.
    let client = IpcClient::connect(&harness.path, renderer()).await.unwrap();
    let activate = Event::PresentationActivate(Box::new(PresentationActivate {
        activation_id: ActivationId::new_random(),
        generation: 1,
        presentation: PresentationDocument::Idle(StatusSurface {
            title: SafeText::new("t").unwrap(),
            message: SafeText::new("m").unwrap(),
            background_color: None,
            text_color: None,
            logo_src: None,
            footer_text: None,
            status: None,
        }),
        content: vec![],
        timing: None,
        projection: None,
    }));
    client.send_event(activate).await.unwrap();
    eventually(|| harness.handler.closed.lock().unwrap().contains(&"event_not_permitted".to_owned())).await;

    // A repeated sequence number.
    let client = IpcClient::connect(&harness.path, renderer()).await.unwrap();
    client.send_raw(&Frame::Event(EventFrame { seq: 1, event: ready() })).await.unwrap();
    client.send_raw(&Frame::Event(EventFrame { seq: 1, event: ready() })).await.unwrap();
    eventually(|| harness.handler.closed.lock().unwrap().contains(&"event_sequence_violation".to_owned())).await;

    // A malformed event payload (path smuggled into progress).
    let mut stream = tokio::net::UnixStream::connect(&harness.path).await.unwrap();
    let hello = Frame::Hello(edge_protocol::ipc::message::Hello {
        min_protocol_version: 1,
        max_protocol_version: 1,
        role: Role::Renderer,
        client: ShortToken::new("raw").unwrap(),
        client_version: ShortText::new("0").unwrap(),
        features: vec![],
    });
    edge_ipc::io::write_frame(&mut stream, &hello).await.unwrap();
    let _welcome = edge_ipc::io::read_frame(&mut stream).await.unwrap();
    let payload = serde_json::to_vec(&json!({
        "type": "event", "seq": 1, "event": "renderer.progress",
        "data": {"activation": {"activationId": ActivationId::new_random(), "generation": 1},
                 "kind": "image_shown", "path": "/var/lib/tilecast-edge/identity"}
    }))
    .unwrap();
    stream.write_all(&(payload.len() as u32).to_be_bytes()).await.unwrap();
    stream.write_all(&payload).await.unwrap();
    eventually(|| harness.handler.closed.lock().unwrap().contains(&"malformed_frame".to_owned())).await;
    harness.shutdown.cancel();
}

#[tokio::test]
async fn second_renderer_supersedes_first_and_disconnect_is_reported() {
    let harness = start(PeerPolicy::for_daemon_uid(uid())).await;
    let first = IpcClient::connect(&harness.path, renderer()).await.unwrap();
    let second = IpcClient::connect(&harness.path, renderer()).await.unwrap();
    assert_eq!(first.next_incoming(Duration::from_secs(2)).await.unwrap(), Incoming::Goodbye("superseded".into()));
    eventually(|| harness.handler.closed.lock().unwrap().contains(&"superseded".to_owned())).await;

    // Reconnect semantics: a fresh session starts its sequence at 1 again.
    second
        .send_event(Event::RendererProgress(RendererProgress {
            activation: ActivationRef { activation_id: ActivationId::new_random(), generation: 1 },
            item_id: None,
            kind: EvidenceKind::SurfaceShown,
            zone_id: None,
        }))
        .await
        .unwrap();
    eventually(|| harness.handler.events.lock().unwrap().len() == 1).await;
    drop(second);
    eventually(|| harness.handler.closed.lock().unwrap().contains(&"peer_closed".to_owned())).await;
    harness.shutdown.cancel();
}

#[tokio::test]
async fn slow_client_is_disconnected_instead_of_buffered() {
    let harness = start(PeerPolicy::for_daemon_uid(uid())).await;
    // Connect but never read.
    let _client = IpcClient::connect(&harness.path, renderer()).await.unwrap();
    eventually(|| harness.handler.sessions.lock().unwrap().len() == 1).await;
    let session = harness.handler.sessions.lock().unwrap()[0].clone();
    let big = json!({"type": "brand_bug", "text": "x".repeat(200_000)});
    let mut closed = false;
    for _ in 0..10_000 {
        let event = Event::PluginState(PluginState {
            plugins: vec![big.clone()],
            content: vec![],
            clock_offset_ms: 0,
            aliases: vec![],
        });
        if session.send_event(event).is_err() {
            closed = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    // The test client's reader task does read, so give the queue a stalled peer
    // by dropping into a tight loop; either the queue fills or the kernel
    // buffer and the client channel do. Both end in a bounded close.
    assert!(closed || session.is_closed(), "flooding must eventually close the session");
    harness.shutdown.cancel();
}

#[tokio::test]
async fn shutdown_says_goodbye_and_removes_socket() {
    let harness = start(PeerPolicy::for_daemon_uid(uid())).await;
    let client = IpcClient::connect(&harness.path, renderer()).await.unwrap();
    harness.shutdown.cancel();
    assert_eq!(
        client.next_incoming(Duration::from_secs(2)).await.unwrap(),
        Incoming::Goodbye("daemon_shutdown".into())
    );
    harness.task.await.unwrap();
    assert!(!harness.path.exists());
}

#[tokio::test]
async fn bind_replaces_stale_socket_but_never_other_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("edge.sock");
    // Stale socket: bound and dropped without cleanup.
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    let handler = Arc::new(Recorder::default());
    let server = IpcServer::bind(&path, PeerPolicy::for_daemon_uid(uid()), handler.clone(), "0").await.unwrap();
    // Live socket: a second bind refuses.
    assert!(matches!(
        IpcServer::bind(&path, PeerPolicy::for_daemon_uid(uid()), handler.clone(), "0").await,
        Err(BindError::InUse(_))
    ));
    drop(server);
    let regular = dir.path().join("regular");
    std::fs::write(&regular, b"important").unwrap();
    assert!(matches!(
        IpcServer::bind(&regular, PeerPolicy::for_daemon_uid(uid()), handler, "0").await,
        Err(BindError::NotASocket(_))
    ));
    assert_eq!(std::fs::read(&regular).unwrap(), b"important");
}
