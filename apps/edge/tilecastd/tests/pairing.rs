//! Pairing a fresh installation (M5): a real `tilecastd` with no legacy state
//! against an in-process fake Tilecast Server that speaks the ordinary
//! pairing protocol, and a scripted renderer on the real IPC socket.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use edge_ipc::client::{ClientOptions, Incoming, IpcClient};
use edge_platform::systemd::Notifier;
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::event::{Event, RendererInfo, RendererKind, RendererPlatform, RendererReady};
use edge_protocol::ipc::method::{Method, SubmitServerUrlParams};
use edge_protocol::ipc::presentation::PresentationDocument;
use edge_protocol::{InstallationId, ScreenId, Timestamp};
use edge_server::DeviceCredential;
use edge_server::pairing::PairingSession;
use edge_state::repo::binding::{self, CredentialState};
use edge_state::repo::daemon as daemon_repo;
use http_body_util::{BodyExt as _, Full};
use hyper::body::Incoming as Body;
use hyper::{Request, Response, StatusCode};
use serde_json::{Value, json};
use tilecastd::config::EdgeConfig;
use tilecastd::daemon::{Daemon, DaemonContext};

const CREDENTIAL: &str = "tc_device_01j8xk2m4n6p8q0r2s4t6v8w0y.ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ";
const POLL_SECRET: &str = "poll-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const TOKEN: &str = "enrollment-token-0123456789abcdefghijklmnopqrstu";

#[derive(Default)]
struct Pairing {
    sessions: usize,
    /// "pending", "approved", "claimed" (token already handed out), "rejected".
    status: String,
    metadata: Option<Value>,
    polls_with_code: usize,
    enrolled: usize,
}

struct FakeServer {
    installation: InstallationId,
    screen: ScreenId,
    pairing_enabled: AtomicBool,
    pairing: Mutex<Pairing>,
    authenticated: AtomicUsize,
    expires_in_ms: Mutex<i64>,
}

fn data(code: StatusCode, value: Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(json!({ "data": value }).to_string())));
    *response.status_mut() = code;
    response
}

fn error(code: StatusCode, name: &str) -> Response<Full<Bytes>> {
    let mut response =
        Response::new(Full::new(Bytes::from(json!({"error": {"code": name, "message": name}}).to_string())));
    *response.status_mut() = code;
    response
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

async fn handle(fake: Arc<FakeServer>, request: Request<Body>) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = request.uri().path().to_owned();
    let authorization = request.headers().get("authorization").and_then(|v| v.to_str().ok()).map(str::to_owned);
    if path == "/api/v1/system/identity" {
        return Ok(data(
            StatusCode::OK,
            json!({"product": "tilecast", "installationId": fake.installation.to_string(),
            "organizationName": "Greenwood Library", "apiVersion": "v1",
            "pairingEnabled": fake.pairing_enabled.load(Ordering::SeqCst)}),
        ));
    }
    if path == "/api/v1/player/pairing-sessions" && request.method() == hyper::Method::POST {
        let body: Value = serde_json::from_slice(&request.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["installationId"], fake.installation.to_string());
        let mut pairing = fake.pairing.lock().unwrap();
        pairing.sessions += 1;
        pairing.status = "pending".to_owned();
        pairing.metadata = Some(body["metadata"].clone());
        let expires = now_ms() + *fake.expires_in_ms.lock().unwrap();
        return Ok(data(
            StatusCode::CREATED,
            json!({
            "id": uuid::Uuid::from_u128(pairing.sessions as u128).to_string(),
            "code": format!("ABC{:03}", pairing.sessions), "pollSecret": POLL_SECRET,
            "expiresAt": Timestamp::from_unix_millis(expires).unwrap().to_string(),
            "serverTime": Timestamp::from_unix_millis(now_ms()).unwrap().to_string(),
            "pollingIntervalSeconds": 2, "approvalUrl": "http://127.0.0.1/screens/pair",
            "organizationName": "Greenwood Library"}),
        ));
    }
    if path.starts_with("/api/v1/player/pairing-sessions/") {
        let mut pairing = fake.pairing.lock().unwrap();
        if authorization.as_deref() != Some(&format!("Pairing {POLL_SECRET}")) {
            pairing.polls_with_code += 1;
            return Ok(error(StatusCode::UNAUTHORIZED, "pairing_secret_required"));
        }
        let answer = match pairing.status.as_str() {
            "approved" => {
                pairing.status = "claimed".to_owned();
                json!({"status": "claimed", "enrollmentToken": TOKEN, "expiresAt": "2099-01-01T00:00:00Z"})
            }
            "claimed" => json!({"status": "claimed", "expiresAt": "2099-01-01T00:00:00Z"}),
            other => json!({"status": other, "expiresAt": "2099-01-01T00:00:00Z", "failureReason": other}),
        };
        return Ok(data(StatusCode::OK, answer));
    }
    if path == "/api/v1/player/enroll" {
        let body: Value = serde_json::from_slice(&request.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let mut pairing = fake.pairing.lock().unwrap();
        if body["enrollmentToken"] != TOKEN {
            return Ok(error(StatusCode::UNAUTHORIZED, "enrollment_token_invalid"));
        }
        pairing.enrolled += 1;
        return Ok(data(
            StatusCode::CREATED,
            json!({"screenId": fake.screen.to_string(), "screenName": "Lobby",
            "deviceCredential": CREDENTIAL}),
        ));
    }
    if authorization.as_deref() == Some(&format!("Bearer {CREDENTIAL}")) {
        fake.authenticated.fetch_add(1, Ordering::SeqCst);
        return Ok(match path.as_str() {
            "/api/v1/player/heartbeat" => data(StatusCode::OK, json!({"accepted": true})),
            "/api/v1/player/config" => data(StatusCode::OK, json!({"schemaVersion": 1, "configRevision": 1})),
            "/api/v1/player/commands" => data(StatusCode::OK, json!({"items": []})),
            _ => error(StatusCode::NOT_FOUND, "not_found"),
        });
    }
    Ok(error(StatusCode::UNAUTHORIZED, "device_credential_invalid"))
}

async fn serve(fake: Arc<FakeServer>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            let fake = Arc::clone(&fake);
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |request| handle(Arc::clone(&fake), request));
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    format!("http://{address}")
}

struct Renderer {
    client: Arc<IpcClient>,
    documents: Arc<Mutex<Vec<PresentationDocument>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Renderer {
    async fn connect(socket: &std::path::Path) -> Self {
        let client = Arc::new(
            IpcClient::connect(socket, ClientOptions::new(Role::Renderer, "fake-renderer", "0.1.0")).await.unwrap(),
        );
        let documents = Arc::new(Mutex::new(Vec::new()));
        let task = tokio::spawn({
            let (client, documents) = (Arc::clone(&client), Arc::clone(&documents));
            async move {
                while let Ok(Incoming::Event(_, event)) = client.next_incoming(Duration::from_secs(120)).await {
                    match event {
                        Event::RendererConfigure(_) => {
                            let _ = client
                                .send_event(Event::RendererReady(RendererReady {
                                    renderer: RendererInfo {
                                        kind: RendererKind::Wpe,
                                        version: ShortText::new("0.1.0").unwrap(),
                                        engine_version: ShortText::new("2.54.0").unwrap(),
                                        gstreamer_version: None,
                                        platform: RendererPlatform::Headless,
                                    },
                                    features: vec![ShortToken::new("status-surfaces-v1").unwrap()],
                                    display: Some(edge_protocol::ipc::event::DisplayInfo {
                                        connected: true,
                                        width: 3840,
                                        height: 2160,
                                        refresh_millihertz: None,
                                    }),
                                }))
                                .await;
                        }
                        Event::PresentationActivate(activation) => {
                            documents.lock().unwrap().push(activation.presentation.clone())
                        }
                        _ => {}
                    }
                }
            }
        });
        Self { client, documents, task }
    }

    fn last(&self) -> Option<PresentationDocument> {
        self.documents.lock().unwrap().last().cloned()
    }

    async fn submit(&self, url: &str) -> Value {
        self.client
            .request(Method::SetupSubmitServerUrl(SubmitServerUrlParams { url: SafeText::new(url).unwrap() }))
            .await
            .unwrap()
            .unwrap()
    }
}

struct Harness {
    dir: tempfile::TempDir,
    fake: Arc<FakeServer>,
    url: String,
}

struct Player {
    context: Arc<DaemonContext>,
    socket: PathBuf,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl Harness {
    async fn new() -> Self {
        let fake = Arc::new(FakeServer {
            installation: InstallationId::new_random(),
            screen: ScreenId::new_random(),
            pairing_enabled: AtomicBool::new(true),
            pairing: Mutex::new(Pairing::default()),
            authenticated: AtomicUsize::new(0),
            expires_in_ms: Mutex::new(600_000),
        });
        let url = serve(Arc::clone(&fake)).await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("state")).unwrap();
        Self { dir, fake, url }
    }

    fn identity(&self) -> PathBuf {
        self.dir.path().join("state/identity")
    }

    async fn start(&self) -> Player {
        let mut config = EdgeConfig::default();
        config.paths.state_dir = Some(self.dir.path().join("state"));
        config.paths.runtime_dir = Some(self.dir.path().join("run"));
        config.renderer.binary = self.dir.path().join("no-renderer");
        let daemon = Daemon::start(config, Notifier::disabled()).await.unwrap();
        let socket = daemon.socket_path();
        let context = Arc::clone(daemon.context());
        let task = tokio::spawn(daemon.run());
        Player { context, socket, task }
    }

    fn set_status(&self, status: &str) {
        self.fake.pairing.lock().unwrap().status = status.to_owned();
    }
}

impl Player {
    async fn stop(self) {
        self.context.shutdown.cancel();
        self.task.await.unwrap().unwrap();
    }
}

async fn wait_for<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    for _ in 0..300 {
        if let Some(value) = check() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

fn pairing_code(document: Option<PresentationDocument>) -> Option<String> {
    match document? {
        PresentationDocument::Pairing { code, .. } => Some(code.as_str().to_owned()),
        _ => None,
    }
}

fn state_dump(dir: &std::path::Path) -> String {
    let mut text = String::new();
    for entry in walk(dir) {
        if let Ok(bytes) = std::fs::read(&entry) {
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    text
}

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() { files.extend(walk(&path)) } else { files.push(path) }
    }
    files
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_clean_machine_pairs_is_approved_and_connects_without_legacy_state() {
    let harness = Harness::new().await;
    let player = harness.start().await;
    let renderer = Renderer::connect(&player.socket).await;
    wait_for("the setup surface", || renderer.last().filter(|d| matches!(d, PresentationDocument::Setup {}))).await;

    // A public host over plain HTTP is refused before anything is sent.
    let refused = renderer.submit("http://signs.example.org").await;
    assert_eq!(refused["ok"], false);
    assert_eq!(harness.fake.pairing.lock().unwrap().sessions, 0);

    let accepted = renderer.submit(&harness.url).await;
    assert_eq!(accepted["ok"], true, "{accepted}");
    let code = wait_for("the pairing code", || pairing_code(renderer.last())).await;
    assert_eq!(code, "ABC001");
    let metadata = harness.fake.pairing.lock().unwrap().metadata.clone().unwrap();
    assert_eq!(metadata["platform"], "linux");
    assert_eq!((metadata["screenWidth"].clone(), metadata["screenHeight"].clone()), (json!(3840), json!(2160)));
    let db = player.context.db().unwrap().clone();
    let player_id = db.run(|c| daemon_repo::player_identity(c)).await.unwrap().expect("generated player ID");
    assert_eq!(player_id.source, daemon_repo::PlayerIdentitySource::Generated);
    assert_eq!(metadata["playerInstallationId"], player_id.player_id.to_string());

    // The secret is private: only in the 0600 session file, never on the
    // socket, in the presentation or in SQLite.
    let mode = std::os::unix::fs::PermissionsExt::mode(
        &std::fs::metadata(harness.identity().join("pairing-session")).unwrap().permissions(),
    );
    assert_eq!(mode & 0o777, 0o600);
    let shown = format!("{:?}", renderer.documents.lock().unwrap());
    assert!(!shown.contains(POLL_SECRET));
    let database = std::fs::read(harness.dir.path().join("state/state.db")).unwrap();
    assert!(!String::from_utf8_lossy(&database).contains(POLL_SECRET));

    harness.set_status("approved");
    wait_for("enrollment", || (harness.fake.pairing.lock().unwrap().enrolled == 1).then_some(())).await;
    wait_for("the paired surface", || renderer.last().filter(|d| matches!(d, PresentationDocument::Idle(_)))).await;
    let bound = db.run(|c| binding::get(c)).await.unwrap().expect("binding");
    assert_eq!((bound.installation_id, bound.screen_id), (harness.fake.installation, Some(harness.fake.screen)));
    assert_eq!(bound.credential_state, CredentialState::Stored);
    assert!(DeviceCredential::load(&harness.identity()).unwrap().is_some());
    assert!(!harness.identity().join("pairing-session").exists(), "temporary secrets are cleared");
    wait_for("authenticated contact", || (harness.fake.authenticated.load(Ordering::SeqCst) > 0).then_some(())).await;
    assert_eq!(harness.fake.pairing.lock().unwrap().polls_with_code, 0, "the visible code never polls");
    let dump = state_dump(harness.dir.path());
    assert!(!dump.contains(POLL_SECRET) && !dump.contains(TOKEN), "no pairing secret remains on disk");

    // A paired screen refuses to pair again.
    assert_eq!(renderer.submit(&harness.url).await["ok"], false);
    renderer.task.abort();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_survives_a_restart_and_a_saved_token_enrolls_after_a_crash() {
    let harness = Harness::new().await;
    let player = harness.start().await;
    let renderer = Renderer::connect(&player.socket).await;
    assert_eq!(renderer.submit(&harness.url).await["ok"], true);
    wait_for("the code", || pairing_code(renderer.last())).await;
    renderer.task.abort();
    player.stop().await;

    // Restart: the same session and code resume, no new session.
    let player = harness.start().await;
    let renderer = Renderer::connect(&player.socket).await;
    assert_eq!(wait_for("the resumed code", || pairing_code(renderer.last())).await, "ABC001");
    assert_eq!(harness.fake.pairing.lock().unwrap().sessions, 1);
    renderer.task.abort();
    player.stop().await;

    // The approving poll happened and the process died before enrolling: the
    // token was saved first, so the next start enrolls with it even though
    // the server will never hand it out again.
    let session = PairingSession::load(&harness.identity()).unwrap().unwrap();
    session.with_enrollment_token(TOKEN.to_owned()).save(&harness.identity()).unwrap();
    harness.set_status("claimed");
    let player = harness.start().await;
    wait_for("enrollment with the saved token", || (harness.fake.pairing.lock().unwrap().enrolled == 1).then_some(()))
        .await;
    wait_for("the credential", || DeviceCredential::load(&harness.identity()).unwrap()).await;
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expiry_and_rejection_start_a_fresh_session_and_reset_clears_it() {
    let harness = Harness::new().await;
    *harness.fake.expires_in_ms.lock().unwrap() = 3_000;
    let player = harness.start().await;
    let renderer = Renderer::connect(&player.socket).await;
    assert_eq!(renderer.submit(&harness.url).await["ok"], true);
    wait_for("the first code", || pairing_code(renderer.last()).filter(|c| c == "ABC001")).await;
    wait_for("a fresh session after expiry", || pairing_code(renderer.last()).filter(|c| c == "ABC002")).await;
    *harness.fake.expires_in_ms.lock().unwrap() = 600_000;
    harness.set_status("rejected");
    wait_for("a fresh session after rejection", || pairing_code(renderer.last()).filter(|c| c == "ABC003")).await;

    player.context.pairing_wake.notify_one();
    let reset = IpcClient::connect(&player.socket, ClientOptions::new(Role::Tilecastctl, "test", "0.1.0"))
        .await
        .unwrap()
        .request(Method::PairingReset(edge_protocol::ipc::method::Empty {}))
        .await
        .unwrap();
    assert!(reset.is_ok());
    wait_for("the setup surface", || renderer.last().filter(|d| matches!(d, PresentationDocument::Setup {}))).await;
    assert!(!harness.identity().join("pairing-session").exists());
    renderer.task.abort();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_server_with_pairing_disabled_is_refused_with_a_reason() {
    let harness = Harness::new().await;
    harness.fake.pairing_enabled.store(false, Ordering::SeqCst);
    let player = harness.start().await;
    let renderer = Renderer::connect(&player.socket).await;
    let answer = renderer.submit(&harness.url).await;
    assert_eq!(answer["ok"], false);
    assert!(answer["error"].as_str().unwrap().contains("turned off"), "{answer}");
    assert_eq!(harness.fake.pairing.lock().unwrap().sessions, 0);
    renderer.task.abort();
    player.stop().await;
}
