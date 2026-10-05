//! Pairing a fresh headless installation: a real player against an
//! in-process fake Tilecast Server that speaks the ordinary pairing
//! protocol. The operator-facing surface is the pairing view (`pair`,
//! `status`); the window arrives in stage 6.
//!
//! Needs `--features test-util` for the reversible test sealer.
#![cfg(feature = "test-util")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use bytes::Bytes;
use http_body_util::{BodyExt as _, Full};
use hyper::body::Incoming as Body;
use hyper::{Request, Response, StatusCode};
use player_state::repo::binding::{self, CredentialState};
use player_state::repo::daemon as daemon_repo;
use player_types::{InstallationId, ScreenId, Timestamp};
use serde_json::{Value, json};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tilecast_windows::config::WindowsConfig;
use tilecast_windows::credential::SealedCredentialStore;
use tilecast_windows::daemon::DaemonContext;
use tilecast_windows::pairing_store::SealedPairingStore;
use tilecast_windows::paths::WindowsPaths;
use tilecast_windows::seal::TestSealer;

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
            "pollingIntervalSeconds": 1, "approvalUrl": "http://127.0.0.1/screens/pair",
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

struct Harness {
    dir: tempfile::TempDir,
    fake: Arc<FakeServer>,
    url: String,
}

struct Player {
    context: Arc<DaemonContext>,
    task: tokio::task::JoinHandle<()>,
}

impl Harness {
    async fn new() -> Self {
        let fake = Arc::new(FakeServer {
            installation: InstallationId::from_uuid(uuid::Uuid::new_v4()),
            screen: ScreenId::from_uuid(uuid::Uuid::new_v4()),
            pairing_enabled: AtomicBool::new(true),
            pairing: Mutex::new(Pairing::default()),
            authenticated: AtomicUsize::new(0),
            expires_in_ms: Mutex::new(600_000),
        });
        let url = serve(Arc::clone(&fake)).await;
        let dir = tempfile::tempdir().unwrap();
        Self { dir, fake, url }
    }

    fn paths(&self) -> WindowsPaths {
        WindowsPaths::new(self.dir.path().join("state"), self.dir.path().join("run"))
    }

    fn identity(&self) -> std::path::PathBuf {
        self.paths().identity_dir()
    }

    async fn start(&self) -> Player {
        let (context, signals) =
            tilecast_windows::daemon::build_with_sealer(WindowsConfig::default(), self.paths(), Arc::new(TestSealer))
                .await
                .unwrap();
        let task = tokio::spawn(tilecast_windows::daemon::run(Arc::clone(&context), signals));
        Player { context, task }
    }

    fn set_status(&self, status: &str) {
        self.fake.pairing.lock().unwrap().status = status.to_owned();
    }
}

impl Player {
    async fn stop(self) {
        self.context.shutdown.cancel();
        self.task.await.unwrap();
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

fn state_dump(dir: &std::path::Path) -> String {
    let mut text = String::new();
    for entry in walk(dir) {
        if let Ok(bytes) = std::fs::read(&entry) {
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    text
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() { files.extend(walk(&path)) } else { files.push(path) }
    }
    files
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_clean_machine_pairs_is_approved_and_connects() {
    let harness = Harness::new().await;
    let player = harness.start().await;

    // A public host over plain HTTP is refused before anything is sent.
    assert!(tilecast_windows::pairing::begin(&player.context, "http://signs.example.org").await.is_err());
    assert_eq!(harness.fake.pairing.lock().unwrap().sessions, 0);

    tilecast_windows::pairing::begin(&player.context, &harness.url).await.unwrap();
    let code = wait_for("the pairing code", || tilecast_windows::pairing::view(&player.context).code).await;
    assert_eq!(code, "ABC001");
    let metadata = harness.fake.pairing.lock().unwrap().metadata.clone().unwrap();
    assert_eq!(metadata["platform"], "windows");
    assert_eq!((metadata["screenWidth"].clone(), metadata["screenHeight"].clone()), (json!(1920), json!(1080)));
    let db = player.context.db().unwrap().clone();
    let player_id = db.run(|c| daemon_repo::player_identity(c)).await.unwrap().expect("generated player ID");
    assert_eq!(player_id.source, daemon_repo::PlayerIdentitySource::Generated);
    assert_eq!(metadata["playerInstallationId"], player_id.player_id.to_string());

    // The secret is private: sealed in the session file, never plaintext in
    // SQLite or anywhere else on disk.
    let sealed = std::fs::read(harness.identity().join("pairing-session")).unwrap();
    assert!(!String::from_utf8_lossy(&sealed).contains(POLL_SECRET));
    let database = std::fs::read(harness.dir.path().join("state/state.db")).unwrap();
    assert!(!String::from_utf8_lossy(&database).contains(POLL_SECRET));

    harness.set_status("approved");
    wait_for("enrollment", || (harness.fake.pairing.lock().unwrap().enrolled == 1).then_some(())).await;
    wait_for("the paired view", || (tilecast_windows::pairing::view(&player.context).state == "paired").then_some(()))
        .await;
    let bound = db.run(|c| binding::get(c)).await.unwrap().expect("binding");
    assert_eq!((bound.installation_id, bound.screen_id), (harness.fake.installation, Some(harness.fake.screen)));
    assert_eq!(bound.credential_state, CredentialState::Stored);
    assert!(SealedCredentialStore::read_at(&harness.identity(), &TestSealer).unwrap().is_some());
    assert!(!harness.identity().join("pairing-session").exists(), "temporary secrets are cleared");
    wait_for("authenticated contact", || (harness.fake.authenticated.load(Ordering::SeqCst) > 0).then_some(())).await;
    assert_eq!(harness.fake.pairing.lock().unwrap().polls_with_code, 0, "the visible code never polls");
    let dump = state_dump(harness.dir.path());
    assert!(!dump.contains(POLL_SECRET) && !dump.contains(TOKEN), "no pairing secret remains on disk");
    assert!(!dump.contains(CREDENTIAL), "the credential is sealed at rest");

    // A paired screen refuses to pair again.
    assert!(tilecast_windows::pairing::begin(&player.context, &harness.url).await.is_err());
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_survives_a_restart_and_a_saved_token_enrolls_after_a_crash() {
    let harness = Harness::new().await;
    let player = harness.start().await;
    tilecast_windows::pairing::begin(&player.context, &harness.url).await.unwrap();
    wait_for("the code", || tilecast_windows::pairing::view(&player.context).code).await;
    player.stop().await;

    // Restart: the same session and code resume, no new session.
    let player = harness.start().await;
    assert_eq!(wait_for("the resumed code", || tilecast_windows::pairing::view(&player.context).code).await, "ABC001");
    assert_eq!(harness.fake.pairing.lock().unwrap().sessions, 1);
    player.stop().await;

    // The approving poll happened and the process died before enrolling: the
    // token was saved first, so the next start enrolls with it even though
    // the server will never hand it out again.
    let session = SealedPairingStore::read_at(&harness.identity(), &TestSealer).unwrap().unwrap();
    SealedPairingStore::write_at(&session.with_enrollment_token(TOKEN.to_owned()), &harness.identity(), &TestSealer)
        .unwrap();
    harness.set_status("claimed");
    let player = harness.start().await;
    wait_for("enrollment with the saved token", || (harness.fake.pairing.lock().unwrap().enrolled == 1).then_some(()))
        .await;
    wait_for("the credential", || SealedCredentialStore::read_at(&harness.identity(), &TestSealer).unwrap()).await;
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expiry_and_rejection_start_a_fresh_session_and_reset_clears_it() {
    let harness = Harness::new().await;
    *harness.fake.expires_in_ms.lock().unwrap() = 3_000;
    let player = harness.start().await;
    tilecast_windows::pairing::begin(&player.context, &harness.url).await.unwrap();
    wait_for("the first code", || tilecast_windows::pairing::view(&player.context).code.filter(|c| c == "ABC001"))
        .await;
    wait_for("a fresh session after expiry", || {
        tilecast_windows::pairing::view(&player.context).code.filter(|c| c == "ABC002")
    })
    .await;
    *harness.fake.expires_in_ms.lock().unwrap() = 600_000;
    harness.set_status("rejected");
    wait_for("a fresh session after rejection", || {
        tilecast_windows::pairing::view(&player.context).code.filter(|c| c == "ABC003")
    })
    .await;

    tilecast_windows::pairing::reset(&player.context).await;
    wait_for("the unpaired view", || {
        (tilecast_windows::pairing::view(&player.context).state == "unpaired").then_some(())
    })
    .await;
    assert!(!harness.identity().join("pairing-session").exists());
    player.stop().await;
}
