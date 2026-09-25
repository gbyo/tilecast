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
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU64, AtomicUsize, Ordering};
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
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt as _, Full, StreamBody};
use hyper::body::Incoming as Body;
use hyper::{Request, Response, StatusCode};
use serde_json::{Value, json};
use tilecastd::config::EdgeConfig;
use tilecastd::daemon::{Daemon, DaemonContext, Environment};

const CREDENTIAL: &str = "tc_device_01j8xk2m4n6p8q0r2s4t6v8w0y.ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ";
const FEATURES: &[&str] =
    &["status-surfaces-v1", "image", "video", "render-tree-v1", "layout-v1", "synchronized-playback-v1"];

// ------------------------------------------------------------ fake server

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AssetMode {
    Serve,
    Missing,
    Corrupt,
    Unavailable,
    /// Held until released: models a slow download.
    Held,
    /// Half the body, then the connection breaks: an interrupted download.
    Truncate,
    /// A resume is answered with a `Content-Range` that does not start at
    /// the requested offset.
    BadRange,
}

/// How the server's listener behaves, beyond answering 503 (`offline`).
const LINK_UP: u8 = 0;
/// Connections are closed as soon as they are made, and requests on kept
/// connections fail: the server is gone.
const LINK_REFUSED: u8 = 1;
/// Connections are accepted and never answered: a WAN outage.
const LINK_BLACKHOLE: u8 = 2;

type Out = Response<BoxBody<Bytes, std::io::Error>>;

fn body(bytes: impl Into<Bytes>) -> BoxBody<Bytes, std::io::Error> {
    Full::new(bytes.into()).map_err(|never: Infallible| match never {}).boxed()
}

/// `bytes=N-` or `bytes=N-M`, as the origin client sends it.
fn requested_range(request: &Request<Body>, len: usize) -> Option<(usize, usize)> {
    let value = request.headers().get("range")?.to_str().ok()?.strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    let start: usize = start.parse().ok()?;
    let end = if end.is_empty() { len.checked_sub(1)? } else { end.parse::<usize>().ok()?.min(len.checked_sub(1)?) };
    (start <= end).then_some((start, end))
}

fn partial(bytes: &[u8], end: usize, claimed_start: usize, mime: &str) -> Out {
    let mut response = Response::new(body(bytes[claimed_start..=end].to_vec()));
    *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    let headers = response.headers_mut();
    headers.insert("content-range", format!("bytes {claimed_start}-{end}/{}", bytes.len()).parse().unwrap());
    headers.insert("content-type", mime.parse().unwrap());
    response
}

/// Bytes, media type and behavior of one served variant path.
type Served = (Vec<u8>, String, AssetMode);

struct FakeServer {
    installation: InstallationId,
    manifest: Mutex<Value>,
    manifest_raw: Mutex<Option<String>>,
    offline: AtomicBool,
    link: AtomicU8,
    /// Asset requests that carried a `Range` header.
    range_requests: AtomicUsize,
    /// The player WebSocket: off by default, which the daemon treats like a
    /// server that refuses it and falls back to the HTTP heartbeat.
    socket_enabled: AtomicBool,
    socket_connections: AtomicUsize,
    /// `player.status` payloads received over the socket.
    socket_statuses: Mutex<Vec<Value>>,
    /// How far the server's clock is ahead of the host's, in its pings.
    server_clock_ahead_ms: AtomicI64,
    /// Bumped to drop every open socket without a close frame.
    socket_generation: AtomicUsize,
    assets: Mutex<HashMap<String, Served>>,
    release: tokio::sync::Notify,
    heartbeats: Mutex<Vec<Value>>,
    manifest_requests: AtomicUsize,
    /// The configuration document; `None` serves the server's revision 1.
    config: Mutex<Option<Value>>,
    config_requests: AtomicUsize,
    /// Offered command deliveries (`state` is the server state).
    commands: Mutex<Vec<Value>>,
    command_results: Mutex<Vec<(String, Value)>>,
    /// Keep offering a command after its result, as when a result report
    /// never reached the server.
    lose_results: AtomicBool,
}

impl FakeServer {
    fn new(installation: InstallationId) -> Arc<Self> {
        Arc::new(Self {
            installation,
            manifest: Mutex::new(Value::Null),
            manifest_raw: Mutex::new(None),
            offline: AtomicBool::new(false),
            link: AtomicU8::new(LINK_UP),
            range_requests: AtomicUsize::new(0),
            socket_enabled: AtomicBool::new(false),
            socket_connections: AtomicUsize::new(0),
            socket_statuses: Mutex::new(Vec::new()),
            server_clock_ahead_ms: AtomicI64::new(0),
            socket_generation: AtomicUsize::new(0),
            assets: Mutex::new(HashMap::new()),
            release: tokio::sync::Notify::new(),
            heartbeats: Mutex::new(Vec::new()),
            manifest_requests: AtomicUsize::new(0),
            config: Mutex::new(None),
            config_requests: AtomicUsize::new(0),
            commands: Mutex::new(Vec::new()),
            command_results: Mutex::new(Vec::new()),
            lose_results: AtomicBool::new(false),
        })
    }

    fn set_config(&self, config: Value) {
        *self.config.lock().unwrap() = Some(config);
    }

    /// Offers a command; returns its delivery ID.
    fn offer(&self, command_type: &str, key: uuid::Uuid, payload: Value) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.commands.lock().unwrap().push(json!({"id": id, "type": command_type,
            "idempotencyKey": key.to_string(), "payload": payload, "state": "delivered"}));
        id
    }

    fn results_for(&self, id: &str) -> Vec<Value> {
        self.command_results.lock().unwrap().iter().filter(|(rid, _)| rid == id).map(|(_, r)| r.clone()).collect()
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

fn data(value: Value) -> Out {
    let mut response = Response::new(body(Bytes::from(json!({ "data": value }).to_string())));
    response.headers_mut().insert("content-type", "application/json".parse().unwrap());
    response
}

fn status(code: StatusCode, error: &str) -> Out {
    let text = json!({"error": {"code": error, "message": error}}).to_string();
    let mut response = Response::new(body(Bytes::from(text)));
    *response.status_mut() = code;
    response
}

async fn handle(fake: Arc<FakeServer>, request: Request<Body>) -> Result<Out, std::io::Error> {
    match fake.link.load(Ordering::SeqCst) {
        LINK_REFUSED => return Err(std::io::Error::other("the server is gone")),
        LINK_BLACKHOLE => std::future::pending::<()>().await,
        _ => {}
    }
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
                let mut response = Response::new(body(Bytes::from(format!("{{\"data\":{raw}}}"))));
                response.headers_mut().insert("etag", "\"raw\"".parse().unwrap());
                return Ok(response);
            }
            let manifest = fake.manifest.lock().unwrap().clone();
            let etag = format!("\"{}\"", Sha256Digest::of(manifest.to_string().as_bytes()).to_hex());
            if request.headers().get("if-none-match").and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
                let mut response = Response::new(body(Bytes::new()));
                *response.status_mut() = StatusCode::NOT_MODIFIED;
                return Ok(response);
            }
            // The real server stamps `serverTime` per response; it is not part
            // of the manifest's identity.
            let mut manifest = manifest;
            if manifest.is_object() {
                let server_now = now_ms() + fake.server_clock_ahead_ms.load(Ordering::SeqCst);
                manifest["serverTime"] = json!(Timestamp::from_unix_millis(server_now).unwrap().to_string());
            }
            let mut response = data(manifest);
            response.headers_mut().insert("etag", etag.parse().unwrap());
            Ok(response)
        }
        "/api/v1/player/config" => {
            fake.config_requests.fetch_add(1, Ordering::SeqCst);
            let config =
                fake.config.lock().unwrap().clone().unwrap_or_else(|| json!({"schemaVersion": 1, "configRevision": 1}));
            // The real server's validator is derived from the revision alone.
            let etag = format!("\"config-{}\"", config["configRevision"]);
            if request.headers().get("if-none-match").and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
                let mut response = Response::new(body(Bytes::new()));
                *response.status_mut() = StatusCode::NOT_MODIFIED;
                return Ok(response);
            }
            let mut config = config;
            config["generatedAt"] = json!(Timestamp::from_unix_millis(now_ms()).unwrap().to_string());
            let mut response = data(config);
            response.headers_mut().insert("etag", etag.parse().unwrap());
            Ok(response)
        }
        "/api/v1/player/commands" => {
            let items: Vec<Value> = fake
                .commands
                .lock()
                .unwrap()
                .iter()
                .filter(|c| matches!(c["state"].as_str(), Some("delivered" | "acknowledged")))
                .cloned()
                .collect();
            Ok(data(json!({ "items": items })))
        }
        command if command.starts_with("/api/v1/player/commands/") => {
            let rest = command.trim_start_matches("/api/v1/player/commands/").to_owned();
            let (id, action) = rest.split_once('/').unwrap();
            let body = request.into_body().collect().await.unwrap().to_bytes();
            let mut commands = fake.commands.lock().unwrap();
            let Some(entry) = commands.iter_mut().find(|c| c["id"] == id) else {
                return Ok(status(StatusCode::CONFLICT, "command_expired"));
            };
            match action {
                "acknowledge" => {
                    if matches!(entry["state"].as_str(), Some("succeeded" | "failed")) {
                        return Ok(data(json!({"id": id, "state": entry["state"]})));
                    }
                    entry["state"] = json!("acknowledged");
                    Ok(data(json!({"id": id, "state": "acknowledged"})))
                }
                "result" => {
                    let result: Value = serde_json::from_slice(&body).unwrap();
                    if !fake.lose_results.load(Ordering::SeqCst) {
                        entry["state"] = json!(if result["success"] == true { "succeeded" } else { "failed" });
                    }
                    fake.command_results.lock().unwrap().push((id.to_owned(), result));
                    Ok(data(json!({"id": id, "state": entry["state"]})))
                }
                _ => Ok(status(StatusCode::NOT_FOUND, "not_found")),
            }
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
                    Ok(Response::new(body(Bytes::from(wrong))))
                }
                AssetMode::Held => {
                    fake.release.notified().await;
                    Ok(Response::new(body(Bytes::from(bytes))))
                }
                AssetMode::Truncate => {
                    let half = Bytes::from(bytes[..bytes.len() / 2].to_vec());
                    // The break comes after the first half is on the wire; an
                    // immediate error would abort before hyper flushed it.
                    let frames = futures_util::StreamExt::chain(
                        futures_util::stream::iter([Ok(hyper::body::Frame::data(half))]),
                        futures_util::stream::once(async {
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            Err(std::io::Error::other("connection lost"))
                        }),
                    );
                    let mut response = Response::new(StreamBody::new(frames).boxed());
                    response.headers_mut().insert("content-length", bytes.len().to_string().parse().unwrap());
                    Ok(response)
                }
                AssetMode::BadRange | AssetMode::Serve => {
                    if let Some((start, end)) = requested_range(&request, bytes.len()) {
                        fake.range_requests.fetch_add(1, Ordering::SeqCst);
                        let claimed = if mode == AssetMode::BadRange { (start + 7).min(end) } else { start };
                        return Ok(partial(&bytes, end, claimed, &mime));
                    }
                    let mut response = Response::new(body(Bytes::from(bytes)));
                    response.headers_mut().insert("content-type", mime.parse().unwrap());
                    response.headers_mut().insert("accept-ranges", "bytes".parse().unwrap());
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
            match fake.link.load(Ordering::SeqCst) {
                LINK_REFUSED => continue,
                LINK_BLACKHOLE => {
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(600)).await;
                        drop(stream);
                    });
                    continue;
                }
                _ => {}
            }
            let fake = Arc::clone(&fake);
            let mut head = [0_u8; 32];
            let upgrade =
                matches!(stream.peek(&mut head).await, Ok(n) if head[..n].starts_with(b"GET /api/v1/player/socket"));
            if upgrade && fake.socket_enabled.load(Ordering::SeqCst) {
                tokio::spawn(player_socket(fake, stream));
                continue;
            }
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

/// The ordinary player WebSocket: `server.hello`, then a `server.ping`
/// carrying the server's clock every 200 ms, recording `player.status`.
async fn player_socket(fake: Arc<FakeServer>, stream: tokio::net::TcpStream) {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request as Upgrade, Response as Accepted};
    let authorize = |request: &Upgrade, response: Accepted| -> Result<Accepted, ErrorResponse> {
        let expected = format!("Bearer {CREDENTIAL}");
        if request.headers().get("authorization").and_then(|v| v.to_str().ok()) == Some(expected.as_str()) {
            Ok(response)
        } else {
            let mut refused = ErrorResponse::new(None);
            *refused.status_mut() = StatusCode::UNAUTHORIZED;
            Err(refused)
        }
    };
    let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, authorize).await else { return };
    fake.socket_connections.fetch_add(1, Ordering::SeqCst);
    let generation = fake.socket_generation.load(Ordering::SeqCst);
    let hello = json!({"type": "server.hello", "protocolVersion": 1}).to_string();
    if socket.send(Message::Text(hello.into())).await.is_err() {
        return;
    }
    let mut ping = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if fake.socket_generation.load(Ordering::SeqCst) != generation {
                    // Dropped without a close frame, as a lost connection is.
                    return;
                }
                let server_now = now_ms() + fake.server_clock_ahead_ms.load(Ordering::SeqCst);
                let timestamp = Timestamp::from_unix_millis(server_now).unwrap().to_string();
                let message = json!({"type": "server.ping", "timestamp": timestamp}).to_string();
                if socket.send(Message::Text(message.into())).await.is_err() {
                    return;
                }
            }
            received = socket.next() => {
                let Some(Ok(Message::Text(text))) = received else { return };
                let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if value["type"] == "player.status" {
                    fake.socket_statuses.lock().unwrap().push(value["payload"].clone());
                }
            }
        }
    }
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
    identify: Vec<(String, u32)>,
    commands: Vec<edge_protocol::ipc::event::RendererCommandKind>,
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
                        Event::Identify(identify) => log
                            .lock()
                            .unwrap()
                            .identify
                            .push((identify.name.as_str().to_owned(), identify.duration_seconds)),
                        Event::RendererCommand(command) => log.lock().unwrap().commands.push(command.command),
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
            gstreamer_version: None,
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
    /// A daemon on its own runtime can be killed: dropping the runtime stops
    /// every task where it stands, with no shutdown path.
    runtime: Option<tokio::runtime::Runtime>,
}

/// The real wall clock plus a step a test controls: an NTP correction or a
/// manual clock change, while monotonic time runs on.
#[derive(Debug, Default)]
struct SteppedClock(AtomicI64);

impl SteppedClock {
    fn step(&self, delta_ms: i64) {
        self.0.fetch_add(delta_ms, Ordering::SeqCst);
    }
}

impl edge_protocol::time::WallClock for SteppedClock {
    fn now(&self) -> Timestamp {
        Timestamp::from_unix_millis(now_ms() + self.0.load(Ordering::SeqCst)).unwrap()
    }
}

/// Free space a test controls.
#[derive(Debug)]
struct Space(AtomicU64);

impl edge_platform::disk::SpaceProbe for Space {
    fn available_bytes(&self, _: &Path) -> std::io::Result<u64> {
        Ok(self.0.load(Ordering::SeqCst))
    }
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

    fn config(&self) -> EdgeConfig {
        let dir = self.dir.path();
        let mut config = EdgeConfig::default();
        config.paths.state_dir = Some(dir.join("state"));
        config.paths.runtime_dir = Some(dir.join("run"));
        config.renderer.binary = dir.join("no-renderer");
        config
    }

    async fn start(&self) -> Player {
        let daemon = Daemon::start(self.config(), Notifier::disabled()).await.unwrap();
        let socket = daemon.socket_path();
        let context = Arc::clone(daemon.context());
        let task = tokio::spawn(daemon.run());
        Player { context, socket, task, runtime: None }
    }

    /// A daemon on its own runtime, with this configuration and host, that
    /// the test can kill.
    async fn start_killable(&self, config: EdgeConfig, environment: Environment) -> Player {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let daemon = runtime
            .spawn(async move { Daemon::start_with(config, Notifier::disabled(), environment).await.unwrap() })
            .await
            .unwrap();
        let socket = daemon.socket_path();
        let context = Arc::clone(daemon.context());
        let task = runtime.spawn(daemon.run());
        Player { context, socket, task, runtime: Some(runtime) }
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
        if let Some(runtime) = self.runtime {
            runtime.shutdown_background();
        }
    }

    /// As SIGKILL or a power cut: no task runs another step and nothing is
    /// flushed or marked clean.
    fn kill(mut self) {
        self.runtime.take().expect("a killable player").shutdown_background();
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
            ["takeover", "quick_present", "schedule", "direct_fallback", "none"].contains(&source.as_str().unwrap()),
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

// ------------------------------------------------------------ M4: configuration and commands

fn branded_config(revision: i64) -> Value {
    json!({"schemaVersion": 1, "configRevision": revision,
        "branding": {"disabledTitle": "Closed today", "disabledMessage": "See the front desk.",
            "backgroundColor": "#112233", "textColor": "#FFEECC", "footerText": "Greenwood Library",
            "noContentTitle": "Nothing scheduled"},
        "playback": {"defaultImageDurationSeconds": 12, "identifyShowsLocation": true, "screenLocation": "Main · Lobby",
            "regionalFormat": {"locale": "es-US", "timezone": "America/Chicago", "dateFormat": "locale",
                "timeFormat": "12-hour", "firstDayOfWeek": "sunday"}},
        "sync": {"statusReportSeconds": 60, "manifestReconciliationSeconds": 300}})
}

async fn accepted_revision(player: &Player, binding: &Binding) -> Option<i64> {
    let binding = binding.clone();
    player
        .context
        .db()
        .unwrap()
        .run(move |c| edge_state::repo::config::get_for(c, edge_state::repo::config::ConfigStage::Current, &binding))
        .await
        .unwrap()
        .map(|stored| stored.revision)
}

fn disabled_title(activation: &PresentationActivate) -> Option<(String, Option<String>, Option<String>)> {
    match &activation.presentation {
        PresentationDocument::Disabled(surface) => Some((
            surface.title.as_str().to_owned(),
            surface.background_color.as_ref().map(|c| c.as_str().to_owned()),
            surface.footer_text.as_ref().map(|c| c.as_str().to_owned()),
        )),
        _ => None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn configuration_and_disable_playback_change_the_screen_live_and_after_an_offline_restart() {
    let harness = Harness::new().await;
    harness.fake.set_config(branded_config(5));
    let asset = Asset::new("lobby", "image/png");
    let (player, renderer) = harness.committed(&asset, 3).await;
    let binding = harness.binding();
    wait_until("the configuration", || async { accepted_revision(&player, &binding).await == Some(5) }).await;
    // Playback defaults reach the items: the fixture authors 10 s, but a
    // delegating item takes the configured 12 s.
    let heartbeat_now = heartbeat(&player.context).await;
    assert_eq!(heartbeat_now["activeConfigRevision"], 5);
    assert!(heartbeat_now.get("configurationError").is_none());

    let key = uuid::Uuid::new_v4();
    let delivery = harness.fake.offer("disable_playback", key, json!({}));
    player.context.command_wake.notify_one();
    let surface = wait_for("the branded disabled surface", || renderer.last().as_ref().and_then(disabled_title)).await;
    assert_eq!(surface, ("Closed today".to_owned(), Some("#112233".to_owned()), Some("Greenwood Library".to_owned())));
    wait_for("the result", || harness.fake.results_for(&delivery).into_iter().next()).await;
    let result = harness.fake.results_for(&delivery).remove(0);
    assert_eq!((result["success"].clone(), result["code"].clone()), (json!(true), json!("playback_disabled")));
    let heartbeat_now = heartbeat(&player.context).await;
    assert_eq!(heartbeat_now["playbackDisabled"], true);
    assert_eq!(heartbeat_now["playbackState"], "disabled");
    renderer.stop();
    player.stop().await;

    // No server: the cached configuration and the persisted flag apply
    // before any network access.
    harness.fake.offline.store(true, Ordering::SeqCst);
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    let surface = wait_for("the disabled surface offline", || renderer.last().as_ref().and_then(disabled_title)).await;
    assert_eq!(surface.0, "Closed today");
    assert_eq!(player.context.player_config.read().unwrap().as_ref().map(|c| c.revision), Some(5));

    harness.fake.offline.store(false, Ordering::SeqCst);
    let delivery = harness.fake.offer("enable_playback", uuid::Uuid::new_v4(), json!({}));
    player.context.command_wake.notify_one();
    wait_for("content again", || renderer.last().filter(|a| shows(a, &asset))).await;
    wait_for("the result", || harness.fake.results_for(&delivery).into_iter().next()).await;
    assert_eq!(harness.fake.results_for(&delivery)[0]["code"], "playback_enabled");
    let PresentationDocument::Playing { items, .. } = &renderer.last().unwrap().presentation else { unreachable!() };
    assert_eq!(items[0].duration_ms, Some(10_000), "an authored duration stays authoritative");
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_invalid_or_unsupported_configuration_never_replaces_the_accepted_one() {
    let harness = Harness::new().await;
    harness.fake.set_config(branded_config(5));
    let asset = Asset::new("lobby", "image/png");
    let (player, renderer) = harness.committed(&asset, 3).await;
    let binding = harness.binding();
    wait_until("revision 5", || async { accepted_revision(&player, &binding).await == Some(5) }).await;

    for (document, reason) in [
        (branded_config(4), "config_revision_stale"),
        (with(branded_config(6), |c| c["schemaVersion"] = json!(9)), "config_schema_unsupported"),
        (with(branded_config(7), |c| c["power"] = json!("always")), "config_section_invalid"),
    ] {
        harness.fake.set_config(document);
        let before = harness.fake.config_requests.load(Ordering::SeqCst);
        player.push();
        wait_until("a configuration fetch", || async { harness.fake.config_requests.load(Ordering::SeqCst) > before })
            .await;
        wait_until(reason, || async {
            heartbeat(&player.context).await.get("configurationError").and_then(Value::as_str) == Some(reason)
        })
        .await;
        assert_eq!(accepted_revision(&player, &binding).await, Some(5), "{reason}");
        assert_eq!(heartbeat(&player.context).await["activeConfigRevision"], 5);
    }

    harness.fake.set_config(branded_config(8));
    player.push();
    wait_until("revision 8", || async { accepted_revision(&player, &binding).await == Some(8) }).await;
    wait_until("the error to clear", || async { heartbeat(&player.context).await.get("configurationError").is_none() })
        .await;
    let binding_previous = binding.clone();
    let previous = player
        .context
        .db()
        .unwrap()
        .run(move |c| {
            edge_state::repo::config::get_for(c, edge_state::repo::config::ConfigStage::Previous, &binding_previous)
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(previous.revision, 5, "the replaced document is kept for recovery");
    renderer.stop();
    player.stop().await;
}

/// `HH:MM` in UTC, `hours` from now.
fn utc_clock(hours: i64) -> String {
    let minutes = (now_ms() / 60_000 + hours * 60).rem_euclid(24 * 60);
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn outside_active_hours_the_screen_rests_until_a_takeover_outranks_it() {
    let harness = Harness::new().await;
    harness.fake.set_config(json!({"schemaVersion": 1, "configRevision": 3,
        "branding": {"textColor": "#AABBCC"},
        "power": {"activeHoursEnabled": true, "activeHoursTimezone": "UTC", "activeHoursDays": [1, 2, 3, 4, 5, 6, 7],
            "activeHoursStart": utc_clock(2), "activeHoursEnd": utc_clock(3),
            "outsideActiveHoursDisplay": "custom_text", "outsideActiveHoursText": "Closed for the night"}}));
    let asset = Asset::new("daytime", "image/png");
    harness.fake.add_asset(&asset, AssetMode::Serve);
    harness.fake.set_manifest(manifest(harness.screen, 3, &[&asset]));
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    let sleeping = wait_for("the rest surface", || {
        renderer.last().filter(|a| matches!(a.presentation, PresentationDocument::Sleep { .. }))
    })
    .await;
    let PresentationDocument::Sleep { display, text, text_color } = &sleeping.presentation else { unreachable!() };
    assert_eq!(display.as_ref().map(|d| d.as_str()), Some("custom_text"));
    assert_eq!(text.as_ref().map(|t| t.as_str()), Some("Closed for the night"));
    assert_eq!(text_color.as_ref().map(|t| t.as_str()), Some("#AABBCC"));
    assert_eq!(heartbeat(&player.context).await["playbackState"], "sleep");
    // Content never reached the screen, so nothing was promoted on evidence.
    let binding = harness.binding();
    assert!(player.stage(&binding, Stage::Active).await.is_none());
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(!renderer.log.lock().unwrap().activations.iter().any(|a| shows(a, &asset)));

    let urgent = Asset::new("urgent", "image/png");
    harness.fake.add_asset(&urgent, AssetMode::Serve);
    let takeover_playlist = uuid::Uuid::new_v4().to_string();
    harness.fake.set_manifest(with(manifest(harness.screen, 4, &[&asset, &urgent]), |m| {
        m["playlist"]["items"] = json!([asset.item(uuid::Uuid::new_v4())]);
        m["playlists"] = json!([{"id": takeover_playlist, "revision": 1, "name": "Alert",
            "items": [urgent.item(uuid::Uuid::new_v4())]}]);
        m["takeover"] = json!({"id": uuid::Uuid::new_v4().to_string(), "playlistId": takeover_playlist,
            "activatedAt": Timestamp::from_unix_millis(now_ms() - 60_000).unwrap().to_string(),
            "expiresAt": Timestamp::from_unix_millis(now_ms() + 3_600_000).unwrap().to_string()});
    }));
    player.push();
    wait_for("the takeover over the rest surface", || renderer.last().filter(|a| shows(a, &urgent))).await;
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == 4) })
        .await;
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn commands_run_at_most_once_across_redelivery_and_restart() {
    let harness = Harness::new().await;
    harness.fake.set_config(branded_config(2));
    let asset = Asset::new("lobby", "image/png");
    let (player, renderer) = harness.committed(&asset, 3).await;
    // Every result report is "lost": the server keeps offering the command.
    harness.fake.lose_results.store(true, Ordering::SeqCst);
    let key = uuid::Uuid::new_v4();
    let delivery = harness.fake.offer("identify_screen", key, json!({"durationSeconds": 30}));
    player.context.command_wake.notify_one();
    wait_for("identification", || renderer.log.lock().unwrap().identify.first().cloned()).await;
    for _ in 0..3 {
        player.context.command_wake.notify_one();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    assert!(harness.fake.results_for(&delivery).len() >= 2, "the stored result is resent to each redelivery");
    assert_eq!(renderer.log.lock().unwrap().identify.len(), 1, "never shown twice");
    assert_eq!(renderer.log.lock().unwrap().identify[0], ("Lobby · Main · Lobby".to_owned(), 30));
    renderer.stop();
    player.stop().await;

    // After a restart the same delivery, and a new delivery of the same key,
    // are answered from the stored result.
    let redelivered = harness.fake.offer("identify_screen", key, json!({"durationSeconds": 30}));
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    wait_for("the stored result for the new delivery", || harness.fake.results_for(&redelivered).into_iter().next())
        .await;
    for id in [&delivery, &redelivered] {
        let results = harness.fake.results_for(id);
        assert!(results.iter().all(|r| r["code"] == "identified" && r["success"] == true), "{results:?}");
    }
    assert!(renderer.log.lock().unwrap().identify.is_empty(), "not shown again after the restart");

    // Ordinary commands keep working: reload issues a new generation and a
    // skip reaches the renderer.
    harness.fake.lose_results.store(false, Ordering::SeqCst);
    let generation = wait_for("content", || renderer.last().filter(|a| shows(a, &asset))).await.generation;
    let reload = harness.fake.offer("reload_playback", uuid::Uuid::new_v4(), json!({}));
    let skip = harness.fake.offer("skip_current_item", uuid::Uuid::new_v4(), json!({}));
    let unsupported = harness.fake.offer("display_power_off", uuid::Uuid::new_v4(), json!({}));
    player.context.command_wake.notify_one();
    wait_for("reload", || renderer.last().filter(|a| a.generation > generation && shows(a, &asset))).await;
    wait_for("all results", || (harness.fake.results_for(&unsupported).len() == 1).then_some(())).await;
    assert_eq!(harness.fake.results_for(&reload)[0]["code"], "playback_reloaded");
    assert_eq!(harness.fake.results_for(&skip)[0]["code"], "skipped");
    assert_eq!(renderer.log.lock().unwrap().commands, vec![edge_protocol::ipc::event::RendererCommandKind::SkipItem]);
    let refused = &harness.fake.results_for(&unsupported)[0];
    assert_eq!((refused["success"].clone(), refused["code"].clone()), (json!(false), json!("unsupported_command")));
    renderer.stop();
    player.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn safe_mode_holds_its_surface_until_exit_safe_mode_and_sync_now_reconciles() {
    let harness = Harness::new().await;
    let asset = Asset::new("lobby", "image/png");
    let (player, renderer) = harness.committed(&asset, 3).await;
    // Drive the recovery ladder with synthetic time: no evidence is newer
    // than the real clock, so every rung is due.
    let mut at = now_ms() + 10 * 60_000;
    for _ in 0..40 {
        let mut engine = player.context.presentation.lock().await;
        engine.tick(at);
        if engine.is_safe_mode() {
            break;
        }
        drop(engine);
        at += 100_000;
    }
    assert!(player.context.presentation.lock().await.is_safe_mode());
    wait_for("the safe-mode surface", || {
        renderer.last().filter(|a| matches!(a.presentation, PresentationDocument::SafeMode { .. }))
    })
    .await;
    // Activation runs again and must not put content back over safe mode.
    for _ in 0..5 {
        player.context.manifest_wake.notify_one();
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(matches!(renderer.last().unwrap().presentation, PresentationDocument::SafeMode { .. }));
    assert_eq!(heartbeat(&player.context).await["safeMode"], true);

    let exit = harness.fake.offer("exit_safe_mode", uuid::Uuid::new_v4(), json!({}));
    player.context.command_wake.notify_one();
    wait_for("content after safe mode", || renderer.last().filter(|a| shows(a, &asset))).await;
    wait_for("the result", || harness.fake.results_for(&exit).into_iter().next()).await;
    assert_eq!(harness.fake.results_for(&exit)[0]["code"], "safe_mode_cleared");

    let before = harness.fake.manifest_requests.load(Ordering::SeqCst);
    let sync = harness.fake.offer("sync_now", uuid::Uuid::new_v4(), json!({}));
    player.context.command_wake.notify_one();
    wait_for("the sync result", || harness.fake.results_for(&sync).into_iter().next()).await;
    assert_eq!(harness.fake.results_for(&sync)[0]["code"], "synchronized");
    assert!(harness.fake.manifest_requests.load(Ordering::SeqCst) > before, "sync_now reconciled the manifest");
    renderer.stop();
    player.stop().await;
}

// ------------------------------------------------------------ M6: synchronized playback

fn grouped(screen: ScreenId, version: i64, assets: &[&Asset], items: &[uuid::Uuid]) -> Value {
    let mut value = manifest(screen, version, assets);
    value["playlist"]["items"] = Value::Array(assets.iter().zip(items).map(|(asset, id)| asset.item(*id)).collect());
    value["syncGroup"] = json!({"id": "lobby-wall", "playbackEpoch": "2026-09-01T00:00:00Z"});
    value
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_players_in_a_group_share_one_timeline_that_a_clock_correction_never_moves() {
    let first = Asset::new("wall-a", "image/png");
    let second = Asset::new("wall-b", "image/png");
    let items = [uuid::Uuid::new_v4(), uuid::Uuid::new_v4()];
    let mut timings = Vec::new();
    let mut running = Vec::new();
    for _ in 0..2 {
        let harness = Harness::new().await;
        harness.fake.add_asset(&first, AssetMode::Serve);
        harness.fake.add_asset(&second, AssetMode::Serve);
        harness.fake.set_manifest(grouped(harness.screen, 3, &[&first, &second], &items));
        let player = harness.start().await;
        let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
        let activation = wait_for("the synchronized activation", || {
            renderer
                .last()
                .filter(|a| matches!(a.presentation, PresentationDocument::Playing { synchronized: true, .. }))
        })
        .await;
        timings.push(activation.timing.clone().expect("group timing"));
        running.push((harness, player, renderer));
    }
    let (a, b) = (&timings[0], &timings[1]);
    assert_eq!((a.group_id.as_str(), a.anchor_unix_ms), (b.group_id.as_str(), b.anchor_unix_ms));
    assert_eq!(a.anchor_unix_ms, "2026-09-01T00:00:00Z".parse::<jiff::Timestamp>().unwrap().as_millisecond());
    assert_eq!(a.durations_ms, vec![10_000, 10_000]);
    assert_eq!(a.durations_ms, b.durations_ms);

    // A new server clock sample must not re-anchor or restart what plays.
    let (harness, player, renderer) = &running[0];
    let binding = harness.binding();
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some() }).await;
    let before = renderer.activation_count();
    let now = Timestamp::from_unix_millis(now_ms()).unwrap();
    player
        .context
        .db()
        .unwrap()
        .run(move |c| {
            let mut state = edge_state::repo::playback::get(c)?;
            state.server_clock_offset_ms = Some(4_321);
            state.server_clock_synchronized_at = Some(now);
            edge_state::repo::playback::put(c, &state, now)
        })
        .await
        .unwrap();
    for _ in 0..5 {
        player.context.manifest_wake.notify_one();
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(renderer.activation_count(), before, "a clock correction never restarts synchronized playback");

    // A renderer that rejoins (a crash, a restart) places itself with the
    // current offset on the unchanged anchor.
    let (harness, player, renderer) = running.remove(0);
    renderer.stop();
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    let rejoined = wait_for("the rejoining activation", || {
        renderer.last().filter(|a| a.timing.as_ref().is_some_and(|t| t.clock_offset_ms == 4_321))
    })
    .await;
    let timing = rejoined.timing.expect("group timing");
    assert_eq!((timing.anchor_unix_ms, timing.durations_ms), (a.anchor_unix_ms, a.durations_ms.clone()));
    running.push((harness, player, renderer));
    for (_, player, renderer) in running {
        renderer.stop();
        player.stop().await;
    }
}

// ------------------------------------------------------------ M6: qualification
//
// docs/tilecast-edge-next.md §6 maps every qualification scenario to its
// test. The property throughout: a failure never replaces last-known-good
// playback, and offline playback never waits for the server.

async fn wait_long(what: &str, seconds: u64, mut check: impl AsyncFnMut() -> bool) {
    for _ in 0..seconds * 10 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

fn link_state(player: &Player) -> &'static str {
    player.context.link_state.lock().unwrap().state_token()
}

/// Every regular file under `root`.
fn files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

fn cas_object(player: &Player, asset: &Asset) -> PathBuf {
    let hex = asset.digest().to_hex();
    files(&player.context.paths.cas_root())
        .into_iter()
        .find(|path| path.file_name().is_some_and(|name| name.to_string_lossy().contains(&hex)))
        .expect("the verified object")
}

async fn committed_killable(
    harness: &Harness,
    asset: &Asset,
    version: i64,
    environment: Environment,
) -> (Player, FakeRenderer) {
    harness.fake.add_asset(asset, AssetMode::Serve);
    harness.fake.set_manifest(manifest(harness.screen, version, &[asset]));
    let player = harness.start_killable(harness.config(), environment).await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    wait_for("the committed presentation", || renderer.last().filter(|a| shows(a, asset))).await;
    let binding = harness.binding();
    wait_until("promotion", || async {
        player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == version)
    })
    .await;
    (player, renderer)
}

/// #1 (a server that never answers at boot), #2 (the server goes away while
/// playing) and #3 (a WAN outage that swallows traffic).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_or_blackholed_server_never_stalls_committed_playback() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();
    let shown = renderer.activation_count();

    harness.fake.link.store(LINK_REFUSED, Ordering::SeqCst);
    player.push();
    wait_until("the link to notice", || async { link_state(&player) == "retrying" }).await;
    settle().await;
    assert_eq!(renderer.activation_count(), shown, "an outage never re-presents");
    assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3);

    // A WAN outage: requests hang. A renderer that restarts meanwhile gets
    // the committed presentation at once.
    harness.fake.link.store(LINK_BLACKHOLE, Ordering::SeqCst);
    player.push();
    settle().await;
    renderer.stop();
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    wait_for("the committed presentation during the outage", || renderer.last().filter(|a| shows(a, &first))).await;

    // A daemon restart while every request hangs: cached playback at once.
    player.stop().await;
    renderer.stop();
    let started = std::time::Instant::now();
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    wait_for("cached playback at boot", || renderer.last().filter(|a| shows(a, &first))).await;
    assert!(started.elapsed() < Duration::from_secs(10), "boot waited for the server: {:?}", started.elapsed());

    // Recovery: the next assignment arrives and plays.
    let second = Asset::new("second", "image/png");
    harness.fake.add_asset(&second, AssetMode::Serve);
    harness
        .fake
        .set_manifest(with(manifest(harness.screen, 4, &[&second]), |m| m["activationGraceSeconds"] = json!(1)));
    harness.fake.link.store(LINK_UP, Ordering::SeqCst);
    wait_long("recovery after the outage", 90, async || {
        player.push();
        tokio::time::sleep(Duration::from_millis(400)).await;
        renderer.last().is_some_and(|a| shows(&a, &second))
    })
    .await;
    renderer.stop();
    player.stop().await;
}

/// #5 (interrupted download), #6 (a resume answered with the wrong range)
/// and #7 (a partial file damaged on disk).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupted_misranged_and_tampered_downloads_never_reach_the_screen() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();
    let cas = player.context.cas.as_ref().unwrap().clone();
    let (mut committed, mut committed_version) = (first, 3);

    for (version, damage) in [(4, "tampered"), (5, "misranged")] {
        let next = Asset::new(damage, "image/png");
        harness.fake.add_asset(&next, AssetMode::Truncate);
        harness.fake.set_manifest(with(manifest(harness.screen, version, &[&next]), |m| {
            m["activationGraceSeconds"] = json!(1)
        }));
        player.preparation_reset();
        player.push();
        player.prepared_as(&binding, "failed").await;
        assert!(cas.usage().await.unwrap().partial_bytes > 0, "{damage}: the interrupted bytes are kept to resume");
        assert!(shows(&renderer.last().unwrap(), &committed), "{damage}");
        assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, committed_version, "{damage}");

        let ranges = harness.fake.range_requests.load(Ordering::SeqCst);
        if damage == "tampered" {
            for part in files(&player.context.paths.partial_dir()) {
                let mut bytes = std::fs::read(&part).unwrap();
                bytes[0] ^= 0xff;
                std::fs::write(&part, bytes).unwrap();
            }
            harness.fake.set_mode(&next, AssetMode::Serve);
        } else {
            harness.fake.set_mode(&next, AssetMode::BadRange);
        }
        player.preparation_reset();
        player.push();
        wait_until("the resume attempt", || async { harness.fake.range_requests.load(Ordering::SeqCst) > ranges })
            .await;
        settle().await;
        // Whatever the resume produced, damaged bytes never reach the screen.
        let last = renderer.last().unwrap();
        assert!(shows(&last, &committed) || shows(&last, &next), "{damage}");
        if !shows(&last, &next) {
            harness.fake.set_mode(&next, AssetMode::Serve);
        }
        wait_long("the verified replacement", 60, async || {
            player.push();
            tokio::time::sleep(Duration::from_millis(400)).await;
            renderer.last().is_some_and(|a| shows(&a, &next))
        })
        .await;
        let object = std::fs::read(cas_object(&player, &next)).unwrap();
        assert_eq!(Sha256Digest::of(&object), next.digest(), "{damage}: only verified bytes are stored");
        wait_until("promotion", || async {
            player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == version)
        })
        .await;
        (committed, committed_version) = (next, version);
    }
    renderer.stop();
    player.stop().await;
}

/// #11 (SIGKILL), #8 (a verified object damaged on disk) and #9 offline.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_killed_daemon_rehashes_its_store_and_resumes_cached_playback() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = committed_killable(&harness, &first, 3, Environment::default()).await;
    let object = cas_object(&player, &first);
    renderer.stop();
    player.kill();

    // Same-size damage, as a bad sector or a torn write leaves it.
    let mut bytes = std::fs::read(&object).unwrap();
    bytes[3] ^= 0xff;
    std::fs::write(&object, &bytes).unwrap();
    let player = harness.start_killable(harness.config(), Environment::default()).await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    wait_for("the repaired presentation", || renderer.last().filter(|a| shows(a, &first))).await;
    wait_until("the object to be verified again", || async {
        std::fs::read(cas_object(&player, &first)).is_ok_and(|b| Sha256Digest::of(&b) == first.digest())
    })
    .await;
    assert_eq!(player.stage(&harness.binding(), Stage::Active).await.unwrap().version, 3);
    renderer.stop();
    player.kill();

    // Killed again, and restarted with the server gone.
    harness.fake.link.store(LINK_REFUSED, Ordering::SeqCst);
    let player = harness.start_killable(harness.config(), Environment::default()).await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    wait_for("cached playback after an unclean stop", || renderer.last().filter(|a| shows(a, &first))).await;
    renderer.stop();
    player.stop().await;
}

/// #13 (the wall clock moves forward and back) and #14 (a correction while
/// playing): schedule windows follow wall time; nothing else restarts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wall_clock_steps_move_schedule_windows_and_nothing_else() {
    let harness = Harness::new().await;
    let direct = Asset::new("direct", "image/png");
    let scheduled = Asset::new("scheduled", "image/png");
    harness.fake.add_asset(&scheduled, AssetMode::Serve);
    let clock = Arc::new(SteppedClock::default());
    let environment = Environment { clock: clock.clone(), ..Environment::default() };
    let playlist = uuid::Uuid::new_v4().to_string();
    let hour = 3_600_000;
    let at = |offset: i64| Timestamp::from_unix_millis(now_ms() + offset).unwrap().to_string();
    let mut value = manifest(harness.screen, 3, &[&direct]);
    value["assets"].as_array_mut().unwrap().push(scheduled.manifest_asset());
    value["playlists"] = json!([{"id": playlist, "items": [scheduled.item(uuid::Uuid::new_v4())]}]);
    value["schedules"] = json!([{"id": uuid::Uuid::new_v4().to_string(), "playlistId": playlist, "type": "one_time",
        "timezone": "UTC", "priority": 10, "specificity": 1, "oneTimeStart": at(hour), "oneTimeEnd": at(2 * hour)}]);
    harness.fake.add_asset(&direct, AssetMode::Serve);
    harness.fake.set_manifest(value);
    let player = harness.start_killable(harness.config(), environment).await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    wait_for("the direct playlist", || renderer.last().filter(|a| shows(a, &direct))).await;

    // A small correction inside the same window changes nothing.
    let shown = renderer.activation_count();
    clock.step(5 * 60_000);
    player.context.manifest_wake.notify_one();
    settle().await;
    assert_eq!(renderer.activation_count(), shown, "a correction that crosses no boundary never re-presents");

    // Into the window, and back out: the daemon finds it within its bounded
    // sleep, without being woken.
    clock.step(hour);
    wait_long("the scheduled window", 45, async || renderer.last().is_some_and(|a| shows(&a, &scheduled))).await;
    clock.step(-hour);
    wait_long("the direct playlist again", 45, async || renderer.last().is_some_and(|a| shows(&a, &direct))).await;
    renderer.stop();
    player.stop().await;
}

/// #15: a stale persisted offset is used while there is nothing better, and
/// the first server sample replaces it; a fresh one within 250 ms is kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_persisted_server_offset_gives_way_to_the_next_sample() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let items = [uuid::Uuid::new_v4()];
    harness.fake.add_asset(&first, AssetMode::Serve);
    harness.fake.set_manifest(grouped(harness.screen, 3, &[&first], &items));
    let (player, renderer) = {
        let player = harness.start().await;
        let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
        wait_for("the grouped presentation", || renderer.last().filter(|a| a.timing.is_some())).await;
        (player, renderer)
    };
    renderer.stop();
    player.stop().await;

    // An hour-old sample 90 s off, as a player that sat offline keeps.
    let stale_at = Timestamp::from_unix_millis(now_ms() - 3_600_000).unwrap();
    let db = StateDb::open(harness.dir.path().join("state/state.db"), OpenOptions::default()).unwrap();
    db.run_blocking(move |c| {
        let mut state = edge_state::repo::playback::get(c)?;
        state.server_clock_offset_ms = Some(90_000);
        state.server_clock_synchronized_at = Some(stale_at);
        edge_state::repo::playback::put(c, &state, stale_at)
    })
    .unwrap();
    drop(db);

    harness.fake.link.store(LINK_REFUSED, Ordering::SeqCst);
    let player = harness.start().await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    let offline = wait_for("offline playback", || renderer.last().filter(|a| a.timing.is_some())).await;
    assert_eq!(offline.timing.unwrap().clock_offset_ms, 90_000, "offline, the persisted offset is the best estimate");

    let offset = async || {
        let db = player.context.db().unwrap();
        db.run(|c| edge_state::repo::playback::get(c)).await.unwrap()
    };
    harness.fake.server_clock_ahead_ms.store(1_500, Ordering::SeqCst);
    harness.fake.socket_enabled.store(true, Ordering::SeqCst);
    harness.fake.link.store(LINK_UP, Ordering::SeqCst);
    player.push();
    wait_long("the first server sample", 60, async || {
        offset().await.server_clock_offset_ms.is_some_and(|ms| (ms - 1_500).abs() < 500)
    })
    .await;
    let sampled = offset().await;
    assert!(sampled.server_clock_synchronized_at.unwrap().unix_millis() > now_ms() - 60_000);

    // Samples within 250 ms of a fresh offset are not written again.
    harness.fake.server_clock_ahead_ms.store(1_600, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(offset().await.server_clock_synchronized_at, sampled.server_clock_synchronized_at);
    renderer.stop();
    player.stop().await;
}

/// #4: status goes over the WebSocket; when the socket is lost it falls back
/// to the HTTP heartbeat and playback never notices.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn losing_the_player_socket_falls_back_to_the_heartbeat() {
    let harness = Harness::new().await;
    harness.fake.socket_enabled.store(true, Ordering::SeqCst);
    harness.fake.set_config(json!({"schemaVersion": 1, "configRevision": 2, "sync": {"statusReportSeconds": 15}}));
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    wait_long("status over the socket", 60, async || !harness.fake.socket_statuses.lock().unwrap().is_empty()).await;
    let shown = renderer.activation_count();
    let heartbeats = harness.fake.heartbeats.lock().unwrap().len();

    harness.fake.socket_enabled.store(false, Ordering::SeqCst);
    harness.fake.socket_generation.fetch_add(1, Ordering::SeqCst);
    wait_long("the fallback heartbeat", 60, async || {
        player.push();
        tokio::time::sleep(Duration::from_millis(500)).await;
        harness.fake.heartbeats.lock().unwrap().len() > heartbeats
    })
    .await;
    assert_eq!(renderer.activation_count(), shown, "losing the socket never re-presents");
    assert_eq!(link_state(&player), "connected");

    let connections = harness.fake.socket_connections.load(Ordering::SeqCst);
    harness.fake.socket_enabled.store(true, Ordering::SeqCst);
    wait_long("the socket to return", 90, async || {
        player.push();
        tokio::time::sleep(Duration::from_millis(500)).await;
        harness.fake.socket_connections.load(Ordering::SeqCst) > connections
    })
    .await;
    renderer.stop();
    player.stop().await;
}

/// #16 (free space at the reserve floor) and #17 (the store at its limit):
/// typed failures, and the committed presentation stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_disk_or_store_fails_preparation_and_keeps_playing() {
    let harness = Harness::new().await;
    let space = Arc::new(Space(AtomicU64::new(u64::MAX / 4)));
    let environment = Environment { space: space.clone(), ..Environment::default() };
    let first = Asset::new("first", "image/png");
    let (player, renderer) = committed_killable(&harness, &first, 3, environment).await;
    let binding = harness.binding();

    let second = Asset::new("second", "image/png");
    harness.fake.add_asset(&second, AssetMode::Serve);
    harness
        .fake
        .set_manifest(with(manifest(harness.screen, 4, &[&second]), |m| m["activationGraceSeconds"] = json!(1)));
    space.0.store(player.context.config.cas.reserved_free_bytes, Ordering::SeqCst);
    player.preparation_reset();
    player.push();
    let reason = player.prepared_as(&binding, "failed").await;
    assert!(reason.is_some_and(|r| !r.is_empty()), "the reserve floor is a typed failure");
    assert!(shows(&renderer.last().unwrap(), &first));
    assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3);
    let heartbeat = heartbeat(&player.context).await;
    assert!(heartbeat["lastSynchronizationError"].is_string());
    assert_eq!(heartbeat["availableStorageBytes"], json!(player.context.config.cas.reserved_free_bytes));
    renderer.stop();
    player.stop().await;

    // The store's own limit, with the active content pinned.
    let mut config = harness.config();
    config.cas.limit_bytes = first.bytes.len() as u64 + second.bytes.len() as u64 - 1;
    let player = harness.start_killable(config, Environment::default()).await;
    let renderer = FakeRenderer::connect(&player.socket, Evidence::Auto).await;
    player.preparation_reset();
    player.push();
    let reason = player.prepared_as(&binding, "failed").await;
    assert!(reason.is_some_and(|r| !r.is_empty()), "the store limit is a typed failure");
    assert!(shows(&renderer.last().unwrap(), &first), "the pinned active content is never evicted");
    assert_eq!(player.stage(&binding, Stage::Active).await.unwrap().version, 3);
    renderer.stop();
    player.stop().await;
}

/// #19: a database from a newer release is refused and left exactly as it
/// was: the daemon enters recovery mode and writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_newer_state_schema_is_refused_without_being_touched() {
    let harness = Harness::new().await;
    let path = harness.dir.path().join("state/state.db");
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (99, 'future', 0)", [])
            .unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let player = harness.start().await;
    let status = tilecastd::ipc_handler::DaemonIpc::new(Arc::clone(&player.context)).status().await;
    assert_eq!(status.mode, edge_protocol::ipc::status::DaemonMode::Recovery);
    player.stop().await;
    assert!(std::fs::read(&path).unwrap() == before, "the newer database was modified");
    let wal = harness.dir.path().join("state/state.db-wal");
    assert!(std::fs::metadata(&wal).map_or(true, |m| m.len() == 0), "the refusal wrote to the log");
}

/// #23: a takeover that arrives while a replacement is still downloading
/// shows at once; a takeover whose content cannot be prepared changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_takeover_during_preparation_outranks_it() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let binding = harness.binding();
    let slow = Asset::new("slow", "image/png");
    harness.fake.add_asset(&slow, AssetMode::Held);
    harness.fake.set_manifest(manifest(harness.screen, 4, &[&slow]));
    player.push();
    wait_until("the slow preparation", || async { player.preparation().1 == "preparing" }).await;

    let takeover = |version: i64, asset: &Asset| {
        let playlist = uuid::Uuid::new_v4().to_string();
        let mut value = manifest(harness.screen, version, &[&first]);
        value["assets"].as_array_mut().unwrap().push(asset.manifest_asset());
        value["playlists"] = json!([{"id": playlist, "items": [asset.item(uuid::Uuid::new_v4())]}]);
        value["takeover"] = json!({"id": uuid::Uuid::new_v4().to_string(), "playlistId": playlist,
            "activatedAt": Timestamp::from_unix_millis(now_ms() - 1_000).unwrap().to_string(),
            "expiresAt": Timestamp::from_unix_millis(now_ms() + 3_600_000).unwrap().to_string()});
        value
    };
    let broken = Asset::new("broken", "image/png");
    harness.fake.add_asset(&broken, AssetMode::Missing);
    harness.fake.set_manifest(takeover(5, &broken));
    player.preparation_reset();
    player.push();
    player.prepared_as(&binding, "failed").await;
    assert!(shows(&renderer.last().unwrap(), &first), "a takeover that cannot be prepared changes nothing");

    let alert = Asset::new("alert", "image/png");
    harness.fake.add_asset(&alert, AssetMode::Serve);
    harness.fake.set_manifest(takeover(6, &alert));
    player.push();
    wait_for("the takeover", || renderer.last().filter(|a| shows(a, &alert))).await;
    let PresentationDocument::Playing { takeover, .. } = renderer.last().unwrap().presentation else { panic!() };
    assert!(takeover);
    harness.fake.release.notify_waiters();
    wait_until("promotion", || async { player.stage(&binding, Stage::Active).await.is_some_and(|m| m.version == 6) })
        .await;
    renderer.stop();
    player.stop().await;
}

/// #24: Quick Present shows at once, without waiting for an item boundary,
/// and the assigned content returns when it expires, with no new manifest.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quick_present_replaces_and_then_restores_the_assignment() {
    let harness = Harness::new().await;
    let first = Asset::new("first", "image/png");
    let (player, renderer) = harness.committed(&first, 3).await;
    let presented = Asset::new("presented", "image/png");
    harness.fake.add_asset(&presented, AssetMode::Serve);
    let playlist = uuid::Uuid::new_v4().to_string();
    let mut value = manifest(harness.screen, 4, &[&first]);
    value["assets"].as_array_mut().unwrap().push(presented.manifest_asset());
    value["playlists"] = json!([{"id": playlist, "items": [presented.item(uuid::Uuid::new_v4())]}]);
    value["presentationOverride"] = json!({"id": uuid::Uuid::new_v4().to_string(), "contentType": "playlist",
        "contentId": playlist, "contentName": "Show now",
        "startedAt": Timestamp::from_unix_millis(now_ms() - 1_000).unwrap().to_string(),
        "expiresAt": Timestamp::from_unix_millis(now_ms() + 6_000).unwrap().to_string()});
    harness.fake.set_manifest(value);
    player.push();
    wait_for("Quick Present", || renderer.last().filter(|a| shows(a, &presented))).await;
    assert_eq!(heartbeat(&player.context).await["selectionSource"], "quick_present");
    wait_long("the assignment to return", 30, async || renderer.last().is_some_and(|a| shows(&a, &first))).await;
    assert_eq!(heartbeat(&player.context).await["selectionSource"], "direct_fallback");
    renderer.stop();
    player.stop().await;
}
