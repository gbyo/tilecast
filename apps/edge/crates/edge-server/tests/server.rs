//! Legacy import, the identity gate, player contact and the origin source
//! against an in-process fake Tilecast Server.
#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use edge_cas::{BlobSource, ContentStore, LruByDomain, SourceError, StorePolicy};
use edge_platform::disk::FixedSpace;
use edge_protocol::time::system_clock;
use edge_protocol::{InstallationId, PlayerId, ScreenId, Sha256Digest, Timestamp};
use edge_server::client::ServerClient;
use edge_server::legacy::{ImportError, ImportOutcome, import_legacy};
use edge_server::origin::OriginBlobSource;
use edge_server::{DeviceCredential, ServerError};
use edge_state::repo::{binding, commands, legacy, playback};
use edge_state::{OpenOptions, StateDb};
use futures_util::StreamExt as _;
use http_body_util::{BodyExt as _, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use serde_json::{Value, json};

const CREDENTIAL: &str = "tc_device_01j8xk2m4n6p8q0r2s4t6v8w0y.ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ";
fn now() -> Timestamp {
    system_clock().now()
}

const MEDIA: &[u8] = b"not really a PNG, but bytes are bytes for a content-addressed store";

struct Fake {
    /// What `/system/identity` reports.
    reported_installation: InstallationId,
    /// Answer every authenticated request with `device_credential_revoked`.
    revoked: AtomicBool,
    /// (path, carried a credential) for every request.
    log: Mutex<Vec<(String, bool)>>,
    heartbeats: Mutex<Vec<Value>>,
}

impl Fake {
    fn new(installation: InstallationId) -> Arc<Self> {
        Arc::new(Self {
            reported_installation: installation,
            revoked: AtomicBool::new(false),
            log: Mutex::new(Vec::new()),
            heartbeats: Mutex::new(Vec::new()),
        })
    }

    fn authenticated_paths(&self) -> Vec<String> {
        self.log.lock().unwrap().iter().filter(|(_, auth)| *auth).map(|(p, _)| p.clone()).collect()
    }
}

fn data(value: Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(json!({ "data": value }).to_string())));
    response.headers_mut().insert("content-type", "application/json".parse().unwrap());
    response
}

fn status(code: StatusCode, error: &str) -> Response<Full<Bytes>> {
    let mut response =
        Response::new(Full::new(Bytes::from(json!({"error": {"code": error, "message": "fake"}}).to_string())));
    *response.status_mut() = code;
    response
}

async fn handle(fake: Arc<Fake>, request: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = request.uri().path().to_owned();
    let auth = request.headers().get("authorization").and_then(|v| v.to_str().ok()).map(str::to_owned);
    fake.log.lock().unwrap().push((path.clone(), auth.is_some()));
    if path == "/api/v1/system/identity" {
        return Ok(data(json!({
            "product": "Tilecast", "installationId": fake.reported_installation.to_string(),
            "organizationName": "Greenwood Library", "apiVersion": "v1", "pairingEnabled": true
        })));
    }
    if auth.as_deref() != Some(&format!("Bearer {CREDENTIAL}")) {
        return Ok(status(StatusCode::UNAUTHORIZED, "device_credential_invalid"));
    }
    if fake.revoked.load(Ordering::SeqCst) {
        return Ok(status(StatusCode::UNAUTHORIZED, "device_credential_revoked"));
    }
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let (range, if_range) = (header("range"), header("if-range"));
    match path.as_str() {
        "/api/v1/player/heartbeat" => {
            let body = request.into_body().collect().await.unwrap().to_bytes();
            fake.heartbeats.lock().unwrap().push(serde_json::from_slice(&body).unwrap());
            Ok(data(json!({"accepted": true})))
        }
        "/api/v1/player/assets/a1/variants/v1" => {
            let etag = format!("\"sha256-{}\"", Sha256Digest::of(MEDIA).to_hex());
            let start = range
                .as_deref()
                .and_then(|r| r.strip_prefix("bytes="))
                .and_then(|r| r.strip_suffix('-'))
                .and_then(|r| r.parse::<usize>().ok());
            match start {
                Some(start) if if_range.as_deref() == Some(etag.as_str()) => {
                    let mut response = Response::new(Full::new(Bytes::copy_from_slice(&MEDIA[start..])));
                    *response.status_mut() = StatusCode::PARTIAL_CONTENT;
                    response.headers_mut().insert(
                        "content-range",
                        format!("bytes {start}-{}/{}", MEDIA.len() - 1, MEDIA.len()).parse().unwrap(),
                    );
                    Ok(response)
                }
                _ => Ok(Response::new(Full::new(Bytes::from_static(MEDIA)))),
            }
        }
        _ => Ok(status(StatusCode::NOT_FOUND, "not_found")),
    }
}

/// Serves `fake` on 127.0.0.1 (plain HTTP is allowed for loopback).
async fn serve(fake: Arc<Fake>) -> String {
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
    format!("http://127.0.0.1:{}", address.port())
}

struct Env {
    dir: tempfile::TempDir,
    db: StateDb,
    cas: ContentStore,
}

impl Env {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for sub in ["legacy/cache/media", "identity", "state"] {
            std::fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        std::fs::set_permissions(dir.path().join("identity"), std::fs::Permissions::from_mode(0o700)).unwrap();
        let db = StateDb::open(dir.path().join("state/state.db"), OpenOptions::default()).unwrap();
        let cas = ContentStore::open(
            dir.path().join("state/cas"),
            dir.path().join("state/partial"),
            db.clone(),
            system_clock(),
            Arc::new(FixedSpace(1 << 40)),
            StorePolicy { limit_bytes: 1 << 30, reserved_free_bytes: 0 },
            Arc::new(LruByDomain),
        )
        .await
        .unwrap();
        Self { dir, db, cas }
    }

    fn legacy(&self) -> std::path::PathBuf {
        self.dir.path().join("legacy")
    }

    fn identity(&self) -> std::path::PathBuf {
        self.dir.path().join("identity")
    }

    fn write_legacy(&self, server_url: &str, installation: InstallationId, screen: ScreenId, player: PlayerId) {
        let write = |name: &str, value: Value| {
            std::fs::write(self.legacy().join(name), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        };
        write("installation.json", json!({"playerInstallationId": player.to_string()}));
        write(
            "credential.json",
            json!({
                // Trailing slash and whitespace: normalized before use.
                "serverUrl": format!(" {server_url}/ "), "installationId": installation.to_string(),
                "screenId": screen.to_string(), "screenName": "Lobby", "deviceCredential": CREDENTIAL,
                "enrolledAt": "2026-01-01T00:00:00Z"
            }),
        );
        write("executed-commands.json", json!({"keys": ["cmd-1", "cmd-2"]}));
        write("playback-flags.json", json!({"playbackDisabled": true}));
        let asset = |id: &str, bytes: &[u8]| {
            json!({"assetId": id, "variantId": "v1", "mimeType": "image/png",
                   "sha256": Sha256Digest::of(bytes).to_hex().to_uppercase(), "fileSize": bytes.len(),
                   "downloadPath": format!("/api/v1/player/assets/{id}/variants/v1")})
        };
        write(
            "manifest-active.json",
            json!({
                "manifest": {"assets": [asset("a1", MEDIA), asset("a2", b"expected bytes"), asset("a3", b"missing")]},
                "etag": null, "storedAt": "2026-01-01T00:00:00Z", "clockOffsetMs": 1234.4,
                "installationId": installation.to_string(), "screenId": screen.to_string(),
                "normalizedServerUrl": server_url,
            }),
        );
        std::fs::write(self.legacy().join("cache/media/a1-v1"), MEDIA).unwrap();
        // Same size, different bytes: must be rejected, never imported.
        std::fs::write(self.legacy().join("cache/media/a2-v1"), b"tampered bytes").unwrap();
    }
}

fn tree_snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.insert(path.strip_prefix(root).unwrap().display().to_string(), std::fs::read(&path).unwrap());
            }
        }
    }
    out
}

#[tokio::test]
async fn legacy_import_then_player_contact() {
    let installation = InstallationId::new_random();
    let screen = ScreenId::new_random();
    let player = PlayerId::new_random();
    let fake = Fake::new(installation);
    let url = serve(Arc::clone(&fake)).await;
    let env = Env::new().await;
    env.write_legacy(&url, installation, screen, player);
    let before = tree_snapshot(&env.legacy());
    let started = now();

    let outcome = import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, started).await.unwrap();
    let ImportOutcome::Imported(summary) = outcome else { panic!("expected an import") };
    assert_eq!(summary.player_id, player);
    assert_eq!(summary.server_url, url);
    assert_eq!((summary.media_imported, summary.media_rejected, summary.media_missing), (1, 1, 1));
    assert_eq!(summary.executed_command_keys, 2);
    // Identity is read before the credential is ever sent; the import itself
    // sends no authenticated request at all.
    assert_eq!(fake.authenticated_paths(), Vec::<String>::new());

    let bound = env.db.run(|c| binding::get(c)).await.unwrap().unwrap();
    assert_eq!((bound.installation_id, bound.screen_id), (installation, Some(screen)));
    assert_eq!(bound.organization_name.as_deref(), Some("Greenwood Library"));
    assert_eq!(bound.credential_state, binding::CredentialState::Stored);
    let credential_mode = std::fs::metadata(env.identity().join("device-credential")).unwrap().permissions().mode();
    assert_eq!(credential_mode & 0o777, 0o600);
    assert!(DeviceCredential::load(&env.identity()).unwrap().is_some());
    let state = env.db.run(|c| commands::state(c, "cmd-2")).await.unwrap();
    assert_eq!(state, Some(commands::CommandState::Completed));
    let flags = env.db.run(|c| playback::get(c)).await.unwrap();
    assert!(flags.playback_disabled);
    assert_eq!(flags.server_clock_offset_ms, Some(1234));
    assert!(env.cas.verified_path(&Sha256Digest::of(MEDIA)).await.unwrap().is_some());
    assert!(env.cas.stat(&Sha256Digest::of(b"tampered bytes")).await.unwrap().is_none());
    assert_eq!(tree_snapshot(&env.legacy()), before, "legacy state must be untouched");

    // Idempotent.
    let again = import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, started).await.unwrap();
    assert!(matches!(again, ImportOutcome::AlreadyComplete));

    // Ordinary player contact with the imported credential.
    let credential = DeviceCredential::load(&env.identity()).unwrap().unwrap();
    let server =
        ServerClient::new(&bound.server_url).unwrap().verify_installation(installation, credential).await.unwrap();
    server.player_heartbeat(&json!({"screenWidth": 0, "screenHeight": 0, "playerVersion": "0.1.0"})).await.unwrap();
    assert_eq!(fake.authenticated_paths(), vec!["/api/v1/player/heartbeat".to_owned()]);
    assert_eq!(fake.heartbeats.lock().unwrap()[0]["playerVersion"], "0.1.0");

    // The origin serves the imported object's bytes with If-Range resume.
    let origin = OriginBlobSource::new(server.clone(), "/api/v1/player/assets/a1/variants/v1").unwrap();
    let digest = Sha256Digest::of(MEDIA);
    let stream = origin.open(&digest, MEDIA.len() as u64, 10).await.unwrap();
    assert_eq!(stream.start, 10);
    let body: Vec<u8> = stream.body.map(|c| c.unwrap().to_vec()).collect::<Vec<_>>().await.concat();
    assert_eq!(body, &MEDIA[10..]);
    let missing = OriginBlobSource::new(server.clone(), "/api/v1/player/assets/zz/variants/v1").unwrap();
    assert!(matches!(missing.open(&digest, 1, 0).await, Err(SourceError::NotFound)));
    assert!(OriginBlobSource::new(server, "/api/v1/player/../admin").is_err());
}

#[tokio::test]
async fn import_refuses_a_different_installation_without_sending_the_credential() {
    let installation = InstallationId::new_random();
    let mut fake = Fake::new(installation);
    Arc::get_mut(&mut fake).unwrap().reported_installation = InstallationId::new_random();
    let url = serve(Arc::clone(&fake)).await;
    let env = Env::new().await;
    env.write_legacy(&url, installation, ScreenId::new_random(), PlayerId::new_random());

    let error = import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, now()).await.unwrap_err();
    assert!(matches!(error, ImportError::Server(ServerError::IdentityMismatch { .. })), "{error:?}");
    assert!(fake.authenticated_paths().is_empty());
    assert!(DeviceCredential::load(&env.identity()).unwrap().is_none());
    assert!(env.db.run(|c| binding::get(c)).await.unwrap().is_none());
    let record = env.db.run(|c| legacy::get(c)).await.unwrap().unwrap();
    assert_eq!(record.state, legacy::ImportState::Failed);
    assert_eq!(record.failure_code.as_deref(), Some("installation_identity_mismatch"));
}

#[tokio::test]
async fn import_refuses_a_public_http_server_address() {
    let env = Env::new().await;
    let installation = InstallationId::new_random();
    env.write_legacy("http://signage.example.org", installation, ScreenId::new_random(), PlayerId::new_random());
    let error = import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, now()).await.unwrap_err();
    assert!(matches!(error, ImportError::ServerUrl(_)), "{error:?}");
}

#[tokio::test]
async fn a_revoked_credential_is_reported_as_rejected() {
    let installation = InstallationId::new_random();
    let fake = Fake::new(installation);
    let url = serve(Arc::clone(&fake)).await;
    let credential = DeviceCredential::parse(CREDENTIAL).unwrap();
    let server = ServerClient::new(&url).unwrap().verify_installation(installation, credential).await.unwrap();
    fake.revoked.store(true, Ordering::SeqCst);
    let error = server.player_heartbeat(&json!({"screenWidth": 0, "screenHeight": 0, "playerVersion": "0.1.0"})).await;
    assert_eq!(error, Err(ServerError::CredentialRejected));
}
