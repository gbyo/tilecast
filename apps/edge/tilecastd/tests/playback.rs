//! Manifest-to-playback behavior of a real `tilecastd` against an in-process
//! fake Tilecast Server (ordinary player API) and a scripted renderer over the
//! real IPC socket.
//!
//! The media capability channel binds a renderer by its process identity
//! (`/proc`), so these scenarios run on Linux, the Edge target, in
//! `ci/test-linux.sh`.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use edge_ipc::client::{ClientOptions, Incoming, IpcClient};
use edge_platform::systemd::Notifier;
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::event::{
    ActivationRef, Event, EvidenceKind, PluginState, PresentationAccepted, PresentationActivate, RendererInfo,
    RendererKind, RendererPlatform, RendererProgress, RendererReady,
};
use edge_protocol::ipc::presentation::PresentationDocument;
use edge_protocol::{InstallationId, ScreenId, Sha256Digest, Timestamp};
use edge_server::DeviceCredential;
use edge_state::repo::binding::{self, CredentialState, ServerBinding};
use edge_state::repo::manifests::{self, Binding, Stage};
use edge_state::{OpenOptions, StateDb};
use http_body_util::{BodyExt as _, Full};
use hyper::body::Incoming as Body;
use hyper::{Request, Response, StatusCode};
use serde_json::{Value, json};
use tilecastd::config::EdgeConfig;
use tilecastd::daemon::{Daemon, DaemonContext};

const CREDENTIAL: &str = "tc_device_01j8xk2m4n6p8q0r2s4t6v8w0y.ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ";
const FEATURES: &[&str] = &["status-surfaces-v1", "image", "video", "render-tree-v1", "layout-v1"];

// ------------------------------------------------------------ fake server

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AssetMode {
    Serve,
    Missing,
    Corrupt,
    Unavailable,
    /// Held until released: models a slow download.
    Held,
}

/// Bytes, media type and behavior of one served variant path.
type Served = (Vec<u8>, String, AssetMode);

struct FakeServer {
    installation: InstallationId,
    manifest: Mutex<Value>,
    manifest_raw: Mutex<Option<String>>,
    offline: AtomicBool,
    assets: Mutex<HashMap<String, Served>>,
    release: tokio::sync::Notify,
    heartbeats: Mutex<Vec<Value>>,
    manifest_requests: AtomicUsize,
}

impl FakeServer {
    fn new(installation: InstallationId) -> Arc<Self> {
        Arc::new(Self {
            installation,
            manifest: Mutex::new(Value::Null),
            manifest_raw: Mutex::new(None),
            offline: AtomicBool::new(false),
            assets: Mutex::new(HashMap::new()),
            release: tokio::sync::Notify::new(),
            heartbeats: Mutex::new(Vec::new()),
            manifest_requests: AtomicUsize::new(0),
        })
    }

    fn set_manifest(&self, manifest: Value) {
        *self.manifest_raw.lock().unwrap() = None;
        *self.manifest.lock().unwrap() = manifest;
    }

    fn set_raw_manifest(&self, raw: &str) {
        *self.manifest_raw.lock().unwrap() = Some(raw.to_owned());
    }

    fn add_asset(&self, asset: &Asset, mode: AssetMode) {
        self.assets.lock().unwrap().insert(asset.path(), (asset.bytes.clone(), asset.mime.clone(), mode));
    }

    fn set_mode(&self, asset: &Asset, mode: AssetMode) {
        if let Some(entry) = self.assets.lock().unwrap().get_mut(&asset.path()) {
            entry.2 = mode;
        }
    }
}

fn data(value: Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(json!({ "data": value }).to_string())));
    response.headers_mut().insert("content-type", "application/json".parse().unwrap());
    response
}

fn status(code: StatusCode, error: &str) -> Response<Full<Bytes>> {
    let body = json!({"error": {"code": error, "message": error}}).to_string();
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = code;
    response
}

async fn handle(fake: Arc<FakeServer>, request: Request<Body>) -> Result<Response<Full<Bytes>>, Infallible> {
    if fake.offline.load(Ordering::SeqCst) {
        return Ok(status(StatusCode::SERVICE_UNAVAILABLE, "maintenance"));
    }
    let path = request.uri().path().to_owned();
    if path == "/api/v1/system/identity" {
        return Ok(data(json!({"product": "tilecast", "installationId": fake.installation.to_string(),
            "organizationName": "Playback Test", "apiVersion": "v1", "pairingEnabled": false})));
    }
    let authorized = request.headers().get("authorization").and_then(|v| v.to_str().ok())
        == Some(format!("Bearer {CREDENTIAL}").as_str());
    if !authorized {
        return Ok(status(StatusCode::UNAUTHORIZED, "device_credential_invalid"));
    }
    match path.as_str() {
        "/api/v1/player/heartbeat" => {
            let body = request.into_body().collect().await.unwrap().to_bytes();
            fake.heartbeats.lock().unwrap().push(serde_json::from_slice(&body).unwrap());
            Ok(data(json!({"accepted": true})))
        }
        "/api/v1/player/manifest" => {
            fake.manifest_requests.fetch_add(1, Ordering::SeqCst);
            if let Some(raw) = fake.manifest_raw.lock().unwrap().clone() {
                let mut response = Response::new(Full::new(Bytes::from(format!("{{\"data\":{raw}}}"))));
                response.headers_mut().insert("etag", "\"raw\"".parse().unwrap());
                return Ok(response);
            }
            let manifest = fake.manifest.lock().unwrap().clone();
            let etag = format!("\"{}\"", Sha256Digest::of(manifest.to_string().as_bytes()).to_hex());
            if request.headers().get("if-none-match").and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
                let mut response = Response::new(Full::new(Bytes::new()));
                *response.status_mut() = StatusCode::NOT_MODIFIED;
                return Ok(response);
            }
            let mut response = data(manifest);
            response.headers_mut().insert("etag", etag.parse().unwrap());
            Ok(response)
        }
        asset_path if asset_path.starts_with("/api/v1/player/assets/") => {
            let entry = fake.assets.lock().unwrap().get(asset_path).cloned();
            let Some((bytes, mime, mode)) = entry else {
                return Ok(status(StatusCode::NOT_FOUND, "media_variant_unavailable"));
            };
            match mode {
                AssetMode::Missing => Ok(status(StatusCode::NOT_FOUND, "media_variant_unavailable")),
                AssetMode::Unavailable => Ok(status(StatusCode::SERVICE_UNAVAILABLE, "maintenance")),
                AssetMode::Corrupt => {
                    let mut wrong = bytes.clone();
                    wrong[0] ^= 0xff;
                    Ok(Response::new(Full::new(Bytes::from(wrong))))
                }
                AssetMode::Held => {
                    fake.release.notified().await;
                    Ok(Response::new(Full::new(Bytes::from(bytes))))
                }
                AssetMode::Serve => {
                    let mut response = Response::new(Full::new(Bytes::from(bytes)));
                    response.headers_mut().insert("content-type", mime.parse().unwrap());
                    Ok(response)
                }
            }
        }
        // The player WebSocket is not served: the daemon falls back to the
        // ordinary HTTP heartbeat, exactly as with a server that refuses it.
        _ => Ok(status(StatusCode::NOT_FOUND, "not_found")),
    }
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

// ------------------------------------------------------------ content

static NEXT_SIZE: AtomicUsize = AtomicUsize::new(1);

#[derive(Clone, Debug)]
struct Asset {
    asset_id: uuid::Uuid,
    variant_id: uuid::Uuid,
    bytes: Vec<u8>,
    mime: String,
}

impl Asset {
    fn new(label: &str, mime: &str) -> Self {
        let mut bytes = format!("tilecast playback fixture {label} ").into_bytes();
        bytes.resize(1_000 + NEXT_SIZE.fetch_add(1, Ordering::SeqCst), b'#');
        Self {
            asset_id: uuid::Uuid::new_v4(),
            variant_id: uuid::Uuid::new_v4(),
            // A distinct size per fixture lets the harness tell grants apart
            // without the renderer ever seeing a digest.
            bytes,
            mime: mime.to_owned(),
        }
    }

    fn path(&self) -> String {
        format!("/api/v1/player/assets/{}/variants/{}", self.asset_id, self.variant_id)
    }

    fn digest(&self) -> Sha256Digest {
        Sha256Digest::of(&self.bytes)
    }

    fn manifest_asset(&self) -> Value {
        json!({"assetId": self.asset_id.to_string(), "variantId": self.variant_id.to_string(),
            "mimeType": self.mime, "sha256": self.digest().to_hex(), "fileSize": self.bytes.len(),
            "downloadPath": self.path()})
    }

    fn item(&self, id: uuid::Uuid) -> Value {
        let kind = if self.mime.starts_with("video/") { "video" } else { "image" };
        json!({"id": id.to_string(), "assetId": self.asset_id.to_string(), "variantId": self.variant_id.to_string(),
            "assetType": kind, "durationMs": 10000, "fitMode": "contain", "transition": "none",
            "audioEnabled": false, "volume": 0.5, "deliveryPolicy": "download"})
    }
}

/// A server manifest for `screen` whose direct assignment plays `assets` in
/// order. Grace defaults to an hour so only a boundary activates a
/// replacement unless a test says otherwise.
fn manifest(screen: ScreenId, version: i64, assets: &[&Asset]) -> Value {
    let items: Vec<Value> = assets.iter().map(|asset| asset.item(uuid::Uuid::new_v4())).collect();
    json!({
        "schemaVersion": 11, "manifestVersion": version, "screenId": screen.to_string(),
        "generatedAt": "2026-09-23T00:00:00Z", "serverTime": Timestamp::from_unix_millis(now_ms()).unwrap().to_string(),
        "mode": "presentation",
        "assets": assets.iter().map(|asset| asset.manifest_asset()).collect::<Vec<_>>(),
        "playlist": {"id": uuid::Uuid::new_v4().to_string(), "revision": 1, "name": "Lobby", "items": items},
        "playlists": [], "schedules": [], "websites": [], "widgets": [], "dataSources": [], "plugins": [], "layouts": [],
        "prefetchHorizonDays": 14, "activationGraceSeconds": 3600
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

// ------------------------------------------------------------ fake renderer

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Evidence {
    /// Accept and report content evidence for every activation.
    Auto,
    /// Accept, but report nothing until the test asks.
    AcceptOnly,
    /// Neither accept nor report until the test asks.
    Silent,
}

#[derive(Default)]
struct RendererLog {
    activations: Vec<PresentationActivate>,
    plugins: Vec<PluginState>,
}

struct FakeRenderer {
    client: Arc<IpcClient>,
    log: Arc<Mutex<RendererLog>>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeRenderer {
    async fn connect(socket: &Path, mode: Evidence) -> Self {
        let client = Arc::new(
            IpcClient::connect(socket, ClientOptions::new(Role::Renderer, "fake-renderer", "0.1.0")).await.unwrap(),
        );
        let log = Arc::new(Mutex::new(RendererLog::default()));
        let task = tokio::spawn({
            let (client, log) = (Arc::clone(&client), Arc::clone(&log));
            async move {
                loop {
                    let incoming = match client.next_incoming(Duration::from_secs(120)).await {
                        Ok(incoming) => incoming,
                        Err(_) => return,
                    };
                    let Incoming::Event(_, event) = incoming else { return };
                    match event {
                        Event::RendererConfigure(_) => {
                            let _ = client.send_event(ready()).await;
                        }
                        Event::PresentationActivate(activation) => {
                            let reference = ActivationRef {
                                activation_id: activation.activation_id,
                                generation: activation.generation,
                            };
                            log.lock().unwrap().activations.push(*activation.clone());
                            if mode == Evidence::Silent {
                                continue;
                            }
                            let _ = client
                                .send_event(Event::PresentationAccepted(PresentationAccepted { activation: reference }))
                                .await;
                            if mode == Evidence::Auto {
                                report_content(&client, &activation).await;
                            }
                        }
                        Event::PluginState(state) => log.lock().unwrap().plugins.push(state),
                        _ => {}
                    }
                }
            }
        });
        Self { client, log, task }
    }

    fn last(&self) -> Option<PresentationActivate> {
        self.log.lock().unwrap().activations.last().cloned()
    }

    fn activation_count(&self) -> usize {
        self.log.lock().unwrap().activations.len()
    }

    async fn accept(&self, activation: &PresentationActivate) {
        let reference = ActivationRef { activation_id: activation.activation_id, generation: activation.generation };
        self.client
            .send_event(Event::PresentationAccepted(PresentationAccepted { activation: reference }))
            .await
            .unwrap();
    }

    async fn evidence(&self, activation: &PresentationActivate, kind: EvidenceKind, item: Option<&str>) {
        let reference = ActivationRef { activation_id: activation.activation_id, generation: activation.generation };
        self.client
            .send_event(Event::RendererProgress(RendererProgress {
                activation: reference,
                item_id: item.map(|id| SafeText::new(id.to_owned()).unwrap()),
                kind,
                zone_id: None,
            }))
            .await
            .unwrap();
    }

    fn stop(self) {
        self.task.abort();
    }
}

fn ready() -> Event {
    Event::RendererReady(RendererReady {
        renderer: RendererInfo {
            kind: RendererKind::Wpe,
            version: ShortText::new("0.1.0").unwrap(),
            engine_version: ShortText::new("2.54.0").unwrap(),
            platform: RendererPlatform::Headless,
        },
        features: FEATURES.iter().map(|f| ShortToken::new(*f).unwrap()).collect(),
        display: None,
    })
}

fn first_item(activation: &PresentationActivate) -> Option<(String, edge_protocol::ipc::presentation::ItemKind)> {
    match &activation.presentation {
        PresentationDocument::Playing { items, .. } => {
            items.first().map(|item| (item.id.as_str().to_owned(), item.kind))
        }
        _ => None,
    }
}

async fn report_content(client: &IpcClient, activation: &PresentationActivate) {
    let Some((item, kind)) = first_item(activation) else { return };
    let reference = ActivationRef { activation_id: activation.activation_id, generation: activation.generation };
    let content = match kind {
        edge_protocol::ipc::presentation::ItemKind::Video => EvidenceKind::VideoProgress,
        edge_protocol::ipc::presentation::ItemKind::Widget => EvidenceKind::WidgetShown,
        edge_protocol::ipc::presentation::ItemKind::Layout => EvidenceKind::LayoutShown,
        _ => EvidenceKind::ImageShown,
    };
    for kind in [EvidenceKind::ItemStarted, content] {
        let _ = client
            .send_event(Event::RendererProgress(RendererProgress {
                activation: reference,
                item_id: Some(SafeText::new(item.clone()).unwrap()),
                kind,
                zone_id: None,
            }))
            .await;
    }
}

// ------------------------------------------------------------ harness

struct Harness {
    dir: tempfile::TempDir,
    fake: Arc<FakeServer>,
    url: String,
    screen: ScreenId,
    installation: InstallationId,
}

struct Player {
    context: Arc<DaemonContext>,
    socket: PathBuf,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl Harness {
    async fn new() -> Self {
        let installation = InstallationId::new_random();
        let fake = FakeServer::new(installation);
        let url = serve(Arc::clone(&fake)).await;
        let dir = tempfile::tempdir().unwrap();
        let screen = ScreenId::new_random();
        let state = dir.path().join("state");
        std::fs::create_dir_all(state.join("identity")).unwrap();
        let db = StateDb::open(state.join("state.db"), OpenOptions::default()).unwrap();
        let now = Timestamp::from_unix_millis(now_ms()).unwrap();
        let bound = ServerBinding {
            server_url: url.clone(),
            installation_id: installation,
            organization_name: Some("Playback Test".to_owned()),
            screen_id: Some(screen),
            screen_name: Some("Lobby".to_owned()),
            credential_state: CredentialState::Stored,
            identity_verified_at: None,
            bound_at: now,
        };
        db.run_blocking(move |c| binding::put(c, &bound, now)).unwrap();
        drop(db);
        DeviceCredential::parse(CREDENTIAL).unwrap().save(&state.join("identity")).unwrap();
        Self { dir, fake, url, screen, installation }
    }

    fn binding(&self) -> Binding {
        Binding { installation_id: self.installation, screen_id: self.screen, server_url: self.url.clone() }
    }

    async fn start(&self) -> Player {
        let dir = self.dir.path();
        let mut config = EdgeConfig::default();
        config.paths.state_dir = Some(dir.join("state"));
        config.paths.runtime_dir = Some(dir.join("run"));
        config.renderer.binary = dir.join("no-renderer");
        let daemon = Daemon::start(config, Notifier::disabled()).await.unwrap();
        let socket = daemon.socket_path();
        let context = Arc::clone(daemon.context());
        let task = tokio::spawn(daemon.run());
        Player { context, socket, task }
    }

    /// A playing presentation of `asset` committed as the active manifest.
    async fn committed(&self, asset: &Asset, version: i64) -> (Player, FakeRenderer) {
        self.fake.add_asset(asset, AssetMode::Serve);
        self.fake.set_manifest(manifest(self.screen, version, &[asset]));
        let player = self.start().await;
        let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
        wait_for("the committed presentation", || renderer.last().filter(|a| shows(a, asset))).await;
        let binding = self.binding();
        wait_until("promotion", || async {
            player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == version)
        })
        .await;
        (player, renderer)
    }
}

impl Player {
    async fn stop(self) {
        self.context.shutdown.cancel();
        self.task.await.unwrap().unwrap();
    }

    /// Makes the server link reconcile now, as a WebSocket push would.
    fn push(&self) {
        self.context.server_wake.notify_one();
    }

    async fn stage(&self, binding: &Binding, stage: Stage) -> Option<manifests::StoredManifest> {
        let binding = binding.clone();
        self.context.db().unwrap().run(move |c| manifests::get_for(c, stage, &binding)).await.unwrap()
    }

    async fn target(&self, binding: &Binding) -> Option<manifests::Target> {
        let binding = binding.clone();
        self.context.db().unwrap().run(move |c| manifests::target(c, &binding)).await.unwrap()
    }

    /// Forgets the last preparation outcome so a test can wait for the next.
    fn preparation_reset(&self) {
        *self.context.preparation.lock().unwrap() = Default::default();
    }

    fn preparation(&self) -> (Option<Sha256Digest>, &'static str, Option<String>) {
        let status = self.context.preparation.lock().unwrap().clone();
        (status.target, status.state, status.reason)
    }

    /// Waits until preparation of the current target settles in `state`.
    async fn prepared_as(&self, binding: &Binding, state: &str) -> Option<String> {
        wait_until(state, || async {
            let target = self.target(binding).await.map(|t| t.digest);
            let (prepared, observed, _) = self.preparation();
            target.is_some() && prepared == target && observed == state
        })
        .await;
        self.preparation().2
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

async fn wait_until<F: std::future::Future<Output = bool>>(what: &str, mut check: impl FnMut() -> F) {
    for _ in 0..300 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

/// A playing activation whose only granted media is `asset`, reached through
/// an opaque capability rather than a content address or path.
fn shows(activation: &PresentationActivate, asset: &Asset) -> bool {
    let PresentationDocument::Playing { items, .. } = &activation.presentation else { return false };
    items.first().is_some_and(|item| item.src.as_str().starts_with("tcmedia://cap/"))
        && activation.content.len() == 1
        && activation.content[0].size_bytes == asset.bytes.len() as u64
        && activation.content[0].mime_type.as_str() == asset.mime
}

fn with(mut value: Value, mutate: impl FnOnce(&mut Value)) -> Value {
    mutate(&mut value);
    value
}

/// Reports an item boundary on what the renderer is showing.
async fn item_boundary(renderer: &FakeRenderer) {
    let current = renderer.last().unwrap();
    let (item, _) = first_item(&current).unwrap();
    renderer.evidence(&current, EvidenceKind::ItemTransition, Some(&item)).await;
}

/// The playback status fields the server validates before recording player
/// status (`playlists.Service.ReportStatus`); one unknown value discards the
/// whole status.
async fn heartbeat(context: &DaemonContext) -> Value {
    let heartbeat = tilecastd::server_link::build_heartbeat(context).await;
    if let Some(source) = heartbeat.get("selectionSource") {
        assert!(
            ["takeover", "schedule", "direct_fallback", "none"].contains(&source.as_str().unwrap()),
            "the server discards status with selectionSource {source}"
        );
    }
    if let Some(state) = heartbeat.get("takeoverState") {
        assert!(["pending", "preparing", "ready", "active", "failed", "expired"].contains(&state.as_str().unwrap()));
    }
    heartbeat
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1500)).await;
}

// ------------------------------------------------------------ scenarios

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn assignment_prepares_activates_and_promotes_only_after_evidence() {
    let harness = Harness::new().await;
    let image = Asset::new("image", "image/png");
    harness.fake.add_asset(&image, AssetMode::Serve);
    harness.fake.set_manifest(manifest(harness.screen, 3, &[&image]));
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::AcceptOnly).await;

    let activation = wait_for("the assigned image activation", || renderer.last().filter(|a| shows(a, &image))).await;
    let binding = harness.binding();
    assert!(player.stage(&binding, Stage::Pending).await.is_some(), "prepared and waiting for evidence");
    assert!(player.stage(&binding, Stage::Active).await.is_none(), "acceptance alone never commits");
    let pending = heartbeat(&player.context).await;
    assert_eq!(pending["pendingManifestVersion"], 3);
    assert!(pending.get("activeManifestVersion").is_none());

    let (item, _) = first_item(&activation).unwrap();
    renderer.evidence(&activation, EvidenceKind::ItemStarted, Some(&item)).await;
    settle().await;
    assert!(player.stage(&binding, Stage::Active).await.is_none(), "item_started is not content evidence");
    renderer.evidence(&activation, EvidenceKind::ImageShown, Some(&item)).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some() }).await;
    assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3);
    assert!(player.stage(&binding, Stage::Pending).await.is_none());

    // The ordinary heartbeat reports what is playing, with the reference
    // player's field meanings.
    assert!(!harness.fake.heartbeats.lock().unwrap().is_empty(), "the ordinary heartbeat was sent");
    let heartbeat = heartbeat(&player.context).await;
    assert_eq!(heartbeat["activeManifestVersion"], 3);
    assert!(heartbeat.get("pendingManifestVersion").is_none());
    assert_eq!(heartbeat["currentItemId"], item);
    assert!(heartbeat["currentItemStartedAt"].is_string());
    assert_eq!(heartbeat["selectionSource"], "direct_fallback");
    assert_eq!(heartbeat["currentPlaylistId"], harness.fake.manifest.lock().unwrap()["playlist"]["id"]);
    assert!(heartbeat["lastMeaningfulProgressAt"].is_string());
    assert_eq!(heartbeat["webRuntimeVersion"], 0);
    assert!(heartbeat["nativePresentationCapabilities"].is_object());
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replacement_waits_for_an_item_boundary_then_commits() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();
    let second = Asset::new("second", "video/mp4");
    harness.fake.add_asset(&second, AssetMode::Serve);
    harness.fake.set_manifest(manifest(harness.screen, 4, &[&second]));
    player.push();
    wait_until("the replacement to be prepared", || async {
        player.stage(&binding, Stage::Pending).await.is_some_and(|m| m.version == 4)
    })
    .await;
    let shown = renderer.activation_count();
    settle().await;
    assert_eq!(renderer.activation_count(), shown, "a playing presentation is not interrupted mid-item");
    assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3);

    item_boundary(&renderer).await;
    wait_for("the replacement on screen", || renderer.last().filter(|a| shows(a, &second))).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == 4) })
        .await;
    assert_eq!(player.stage(&binding, Stage::Previous).await.unwrap().version, 3);
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replacement_activates_after_its_grace_period_or_at_once_for_a_takeover() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();

    let graced = Asset::new("graced", "image/png");
    harness.fake.add_asset(&graced, AssetMode::Serve);
    harness
        .fake
        .set_manifest(with(manifest(harness.screen, 4, &[&graced]), |m| m["activationGraceSeconds"] = json!(2)));
    player.push();
    wait_for("the grace-period activation", || renderer.last().filter(|a| shows(a, &graced))).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == 4) })
        .await;

    let urgent = Asset::new("urgent", "image/png");
    harness.fake.add_asset(&urgent, AssetMode::Serve);
    let takeover_playlist = uuid::Uuid::new_v4().to_string();
    let takeover_id = uuid::Uuid::new_v4().to_string();
    harness.fake.set_manifest(with(manifest(harness.screen, 5, &[&graced, &urgent]), |m| {
        m["playlist"]["items"] = json!([graced.item(uuid::Uuid::new_v4())]);
        m["playlists"] = json!([{"id": takeover_playlist, "revision": 1, "name": "Alert",
            "items": [urgent.item(uuid::Uuid::new_v4())]}]);
        m["takeover"] = json!({"id": takeover_id, "playlistId": takeover_playlist,
            "activatedAt": Timestamp::from_unix_millis(now_ms() - 60_000).unwrap().to_string(),
            "expiresAt": Timestamp::from_unix_millis(now_ms() + 3_600_000).unwrap().to_string()});
    }));
    player.push();
    wait_for("the takeover without waiting for a boundary", || renderer.last().filter(|a| shows(a, &urgent))).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == 5) })
        .await;
    let heartbeat = heartbeat(&player.context).await;
    assert_eq!(heartbeat["selectionSource"], "takeover");
    assert_eq!(heartbeat["activeTakeoverId"], takeover_id);
    assert_eq!(heartbeat["takeoverState"], "active");
    assert_eq!(heartbeat["currentPlaylistId"], takeover_playlist);
    assert!(heartbeat["nextTransitionAt"].is_string(), "the takeover's expiry is the next transition");
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_newer_manifest_supersedes_a_slow_preparation_and_a_stale_pending() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();

    // B is still downloading when C arrives: B is abandoned, C prepared.
    let slow = Asset::new("slow", "image/png");
    harness.fake.add_asset(&slow, AssetMode::Held);
    let b = manifest(harness.screen, 4, &[&slow]);
    harness.fake.set_manifest(b);
    player.push();
    wait_until("B to be preparing", || async { player.preparation().1 == "preparing" }).await;
    let b_digest = player.target(&binding).await.unwrap().digest;
    let quick = Asset::new("quick", "image/png");
    harness.fake.add_asset(&quick, AssetMode::Serve);
    harness.fake.set_manifest(manifest(harness.screen, 5, &[&quick]));
    player.push();
    wait_until("C to be pending", || async {
        player.stage(&binding, Stage::Pending).await.is_some_and(|m| m.version == 5)
    })
    .await;
    harness.fake.set_mode(&slow, AssetMode::Serve);
    harness.fake.release.notify_waiters();
    settle().await;
    assert_eq!(player.stage(&binding, Stage::Pending).await.unwrap().version, 5, "abandoned B never becomes pending");
    assert_ne!(player.target(&binding).await.unwrap().digest, b_digest);

    // C is prepared but not yet shown when D arrives: C is discarded, the
    // committed presentation stays until D is ready.
    let later = Asset::new("later", "image/png");
    harness.fake.add_asset(&later, AssetMode::Held);
    harness.fake.set_manifest(manifest(harness.screen, 6, &[&later]));
    player.push();
    wait_until("the stale pending to be discarded", || async {
        player.target(&binding).await.is_some_and(|t| t.version == 6)
            && player.stage(&binding, Stage::Pending).await.is_none()
    })
    .await;
    item_boundary(&renderer).await;
    settle().await;
    assert!(shows(&renderer.last().unwrap(), &first), "a discarded preparation is never shown");
    assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3);

    harness.fake.set_mode(&later, AssetMode::Serve);
    harness.fake.release.notify_waiters();
    player.push();
    wait_until("D to be pending", || async {
        player.stage(&binding, Stage::Pending).await.is_some_and(|m| m.version == 6)
    })
    .await;
    item_boundary(&renderer).await;
    wait_for("D on screen", || renderer.last().filter(|a| shows(a, &later))).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == 6) })
        .await;
    for activation in renderer.log.lock().unwrap().activations.iter() {
        assert!(!shows(activation, &slow) && !shows(activation, &quick), "superseded content never reached the screen");
    }
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_manifests_never_replace_the_committed_presentation() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();
    let committed_target = player.target(&binding).await.unwrap().digest;
    let other = Asset::new("other", "image/png");
    harness.fake.add_asset(&other, AssetMode::Serve);

    let cases: Vec<(&str, Value)> = vec![
        ("another screen", manifest(ScreenId::new_random(), 4, &[&other])),
        ("an older version", manifest(harness.screen, 2, &[&other])),
        ("an unknown schema", with(manifest(harness.screen, 4, &[&other]), |m| m["schemaVersion"] = json!(99))),
        (
            "a hash claim that is not SHA-256",
            with(manifest(harness.screen, 4, &[&other]), |m| m["assets"][0]["sha256"] = json!("abc")),
        ),
        (
            "a download path off the player API",
            with(manifest(harness.screen, 4, &[&other]), |m| {
                m["assets"][0]["downloadPath"] = json!("https://elsewhere.example/a.png");
            }),
        ),
    ];
    for (label, document) in cases {
        let requests = harness.fake.manifest_requests.load(Ordering::SeqCst);
        harness.fake.set_manifest(document);
        player.push();
        wait_until(label, || async { harness.fake.manifest_requests.load(Ordering::SeqCst) > requests }).await;
        settle().await;
        assert_eq!(player.target(&binding).await.unwrap().digest, committed_target, "{label} never becomes the target");
        assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3, "{label}");
        assert!(player.stage(&binding, Stage::Pending).await.is_none(), "{label}");
        assert!(shows(&renderer.last().unwrap(), &first), "{label}");
    }
    harness.fake.set_raw_manifest("{\"schemaVersion\": 11, \"assets\": \"not a list\"}");
    player.push();
    settle().await;
    assert_eq!(player.target(&binding).await.unwrap().digest, committed_target, "malformed JSON");
    assert_eq!(player.preparation().1, "invalid");
    assert!(shows(&renderer.last().unwrap(), &first));
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_downloads_keep_the_committed_presentation_and_recover() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();
    let second = Asset::new("second", "image/png");
    harness.fake.add_asset(&second, AssetMode::Missing);
    harness
        .fake
        .set_manifest(with(manifest(harness.screen, 4, &[&second]), |m| m["activationGraceSeconds"] = json!(1)));

    for mode in [AssetMode::Missing, AssetMode::Corrupt, AssetMode::Unavailable] {
        harness.fake.set_mode(&second, mode);
        player.preparation_reset();
        player.push();
        let reason = player.prepared_as(&binding, "failed").await;
        assert!(reason.is_some_and(|r| !r.is_empty()), "{mode:?} has a typed reason");
        assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3, "{mode:?}");
        assert!(player.stage(&binding, Stage::Pending).await.is_none(), "{mode:?}");
        assert!(shows(&renderer.last().unwrap(), &first), "{mode:?}");
        let heartbeat = heartbeat(&player.context).await;
        assert!(heartbeat["lastSynchronizationError"].is_string(), "{mode:?} is reported");
    }

    // Origin 503 for everything, then recovery: playback never waits.
    harness.fake.offline.store(true, Ordering::SeqCst);
    player.push();
    settle().await;
    assert!(shows(&renderer.last().unwrap(), &first));
    harness.fake.offline.store(false, Ordering::SeqCst);
    harness.fake.set_mode(&second, AssetMode::Serve);
    player.push();
    wait_for("the recovered replacement", || renderer.last().filter(|a| shows(a, &second))).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == 4) })
        .await;
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn incompatible_content_is_typed_and_never_replaces_playback() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();
    let website = uuid::Uuid::new_v4().to_string();
    harness.fake.set_manifest(with(manifest(harness.screen, 4, &[&first]), |m| {
        m["websites"] = json!([{"assetId": website, "name": "Menu", "url": "https://menu.example/"}]);
    }));
    player.push();
    let reason = player.prepared_as(&binding, "incompatible").await;
    assert_eq!(reason.as_deref(), Some("presentation_incompatible_website"));
    let requests = harness.fake.manifest_requests.load(Ordering::SeqCst);
    player.push();
    wait_until("the next reconciliation", || async {
        harness.fake.manifest_requests.load(Ordering::SeqCst) > requests
    })
    .await;
    settle().await;
    assert_eq!(player.preparation().1, "incompatible", "a deterministic rejection is not retried");
    assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3);
    assert!(player.stage(&binding, Stage::Pending).await.is_none());
    assert!(shows(&renderer.last().unwrap(), &first));
    let heartbeat = heartbeat(&player.context).await;
    assert_eq!(heartbeat["lastSynchronizationError"], "presentation_incompatible_website");
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cached_presentation_plays_after_restart_without_the_server() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "video/mp4");
    let (player, renderer) = harness.committed(&first, 3).await;
    renderer.stop();
    player.stop().await;

    harness.fake.offline.store(true, Ordering::SeqCst);
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    let shown = wait_for("the cached presentation", || renderer.last().filter(|a| shows(a, &first))).await;
    assert!(matches!(first_item(&shown), Some((_, edge_protocol::ipc::presentation::ItemKind::Video))));
    assert_eq!(player.stage(&harness.binding(), Stage::Active).await.unwrap().version, 3);
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_during_a_trial_keeps_the_committed_manifest_until_evidence() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();
    let second = Asset::new("second", "image/png");
    harness.fake.add_asset(&second, AssetMode::Serve);
    harness.fake.set_manifest(manifest(harness.screen, 4, &[&second]));
    player.push();
    wait_until("the replacement to be pending", || async {
        player.stage(&binding, Stage::Pending).await.is_some_and(|m| m.version == 4)
    })
    .await;
    // Restart while pending: nothing was accepted yet.
    renderer.stop();
    player.stop().await;

    harness.fake.offline.store(true, Ordering::SeqCst);
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::AcceptOnly).await;
    // Nothing is playing after a restart, so the prepared target is tried.
    wait_for("the prepared replacement", || renderer.last().filter(|a| shows(a, &second))).await;
    settle().await;
    assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3, "accepted is not committed");
    // Restart after acceptance, before evidence.
    renderer.stop();
    player.stop().await;

    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    wait_for("the replacement again", || renderer.last().filter(|a| shows(a, &second))).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == 4) })
        .await;
    assert_eq!(player.stage(&binding, Stage::Previous).await.unwrap().version, 3);
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn evidence_counts_only_for_the_current_activation_of_the_current_renderer() {
    let harness = Harness::new().await;
    let image = Asset::new("image", "image/png");
    harness.fake.add_asset(&image, AssetMode::Held);
    harness.fake.set_manifest(manifest(harness.screen, 3, &[&image]));
    let player = harness.start().await;
    let binding = harness.binding();
    let first = FakeRenderer::connect(&player.socket, Evidence::AcceptOnly).await;
    // The waiting surface is shown while the content downloads.
    let surface = wait_for("the waiting surface", || first.last()).await;
    assert!(!matches!(surface.presentation, PresentationDocument::Playing { .. }));
    harness.fake.set_mode(&image, AssetMode::Serve);
    harness.fake.release.notify_waiters();
    player.push();
    let trial = wait_for("the trial", || first.last().filter(|a| shows(a, &image))).await;
    assert!(surface.generation < trial.generation);
    first.stop();

    // A reconnecting renderer starts from nothing: the old session's
    // acceptance does not carry over.
    let second = FakeRenderer::connect(&player.socket, Evidence::Silent).await;
    let current = wait_for("the trial again", || second.last().filter(|a| shows(a, &image))).await;
    assert_eq!(current.activation_id, trial.activation_id);
    assert_ne!(current.content[0].uri, trial.content[0].uri, "grants never outlive a renderer session");
    let (item, _) = first_item(&current).unwrap();

    // Evidence for an older activation (the waiting surface) never counts.
    second.evidence(&surface, EvidenceKind::ImageShown, Some(&item)).await;
    second.accept(&current).await;
    settle().await;
    assert!(player.stage(&binding, Stage::Active).await.is_none(), "stale evidence never commits");
    second.stop();

    // Nor does the new session's evidence without its own acceptance.
    let third = FakeRenderer::connect(&player.socket, Evidence::Silent).await;
    let current = wait_for("the trial once more", || third.last().filter(|a| shows(a, &image))).await;
    third.evidence(&current, EvidenceKind::ImageShown, Some(&item)).await;
    settle().await;
    assert!(player.stage(&binding, Stage::Active).await.is_none(), "evidence without this session's acceptance");
    third.accept(&current).await;
    third.evidence(&current, EvidenceKind::ImageShown, Some(&item)).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some() }).await;
    third.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn layouts_widgets_and_plugins_reach_the_renderer_as_projection_inputs() {
    let harness = Harness::new().await;
    let background = Asset::new("background", "image/png");
    let logo = Asset::new("logo", "image/png");
    harness.fake.add_asset(&background, AssetMode::Serve);
    harness.fake.add_asset(&logo, AssetMode::Serve);
    let layout = uuid::Uuid::new_v4().to_string();
    let widget = uuid::Uuid::new_v4().to_string();
    let item = uuid::Uuid::new_v4().to_string();
    harness.fake.set_manifest(with(manifest(harness.screen, 3, &[&background, &logo]), |m| {
        m["schemaVersion"] = json!(13);
        m["layouts"] = json!([{"id": layout, "document": {"schemaVersion": 2,
            "canvas": {"width": 1920, "height": 1080, "backgroundAssetId": background.asset_id.to_string(),
                "backgroundVariantId": background.variant_id.to_string()},
            "placements": [{"id": "zone", "type": "widget", "widgetId": widget}]}}]);
        m["widgets"] = json!([{"assetId": widget, "name": "Clock", "provider": "clock",
            "presentation": {"schemaVersion": 1, "kind": "native", "requiredCapabilities": {"content.text": 1},
                "native": {"root": {"type": "text"}}}}]);
        m["playlist"]["items"] = json!([{"id": item, "assetId": layout, "layoutId": layout, "assetType": "layout",
            "deliveryPolicy": "stream", "durationMs": 5000, "fitMode": "contain", "transition": "none",
            "audioEnabled": false, "volume": 0}]);
        m["plugins"] = json!([{"id": uuid::Uuid::new_v4().to_string(), "type": "brand_bug", "version": 1,
            "config": {"corner": "top-right", "imageAssetId": logo.asset_id.to_string(),
                "imageVariantId": logo.variant_id.to_string()}}]);
    }));
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    let activation = wait_for("the layout activation", || {
        renderer.last().filter(|a| matches!(&a.presentation, PresentationDocument::Playing { .. }))
    })
    .await;
    let PresentationDocument::Playing { items, .. } = &activation.presentation else { unreachable!() };
    assert_eq!(items[0].kind, edge_protocol::ipc::presentation::ItemKind::Layout);
    assert_eq!(items[0].layout.as_ref().unwrap()["layoutId"], layout);
    let projection = activation.projection.as_ref().expect("projection inputs");
    assert!(projection.manifest["layouts"].is_array() && projection.manifest["widgets"].is_array());
    let alias = projection.media.iter().find(|m| m.asset_id == background.asset_id).expect("background alias");
    assert_eq!(alias.variant_id, background.variant_id);
    for alias in &projection.media {
        assert!(alias.uri.as_str().starts_with("tcmedia://cap/"), "aliases resolve to capabilities");
        assert!(activation.content.iter().any(|c| c.uri == alias.uri), "every alias is granted");
    }

    let plugins = wait_for("the plugin state", || {
        renderer.log.lock().unwrap().plugins.iter().rev().find(|p| !p.plugins.is_empty()).cloned()
    })
    .await;
    assert_eq!(plugins.plugins[0]["type"], "brand_bug");
    assert_eq!(plugins.aliases.len(), 1);
    assert_eq!(plugins.aliases[0].asset_id, logo.asset_id);
    assert!(plugins.content.iter().any(|c| c.uri.as_str() == plugins.aliases[0].uri.as_str()));
    let binding = harness.binding();
    wait_until("promotion on layout evidence", || async { player.stage(&binding, Stage::Active).await.is_some() })
        .await;
    let heartbeat = heartbeat(&player.context).await;
    assert_eq!(heartbeat["currentItemId"], item);
    renderer.stop();
    player.stop().await;
}
