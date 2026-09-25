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
use edge_server::client::{MAX_MANIFEST_BYTES, ManifestFetch, ServerClient};
use edge_server::legacy::{ImportError, ImportMode, ImportOutcome, import_legacy};
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

const KEY: &str = "5c0b1f0e-8f1a-4c55-9a53-27f2f0b2f0aa";
const MEDIA: &[u8] = b"not really a PNG, but bytes are bytes for a content-addressed store";

struct Fake {
    /// What `/system/identity` reports.
    reported_installation: InstallationId,
    /// Answer every authenticated request with `device_credential_revoked`.
    revoked: AtomicBool,
    /// (path, carried a credential) for every request.
    log: Mutex<Vec<(String, bool)>>,
    heartbeats: Mutex<Vec<Value>>,
    /// Delivery ID -> server state, for the command routes.
    command_states: Mutex<BTreeMap<String, &'static str>>,
    results: Mutex<Vec<(String, Value)>>,
    /// Serve a configuration body beyond the client's bound.
    oversized_config: AtomicBool,
}

impl Fake {
    fn new(installation: InstallationId) -> Arc<Self> {
        Arc::new(Self {
            reported_installation: installation,
            revoked: AtomicBool::new(false),
            log: Mutex::new(Vec::new()),
            heartbeats: Mutex::new(Vec::new()),
            command_states: Mutex::new(BTreeMap::new()),
            results: Mutex::new(Vec::new()),
            oversized_config: AtomicBool::new(false),
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
        "/api/v1/player/manifest" => {
            if request.headers().get("if-none-match").and_then(|v| v.to_str().ok()) == Some("\"manifest-1\"") {
                let mut response = Response::new(Full::new(Bytes::new()));
                *response.status_mut() = StatusCode::NOT_MODIFIED;
                return Ok(response);
            }
            let mut response = data(json!({"schemaVersion": 11, "manifestVersion": 1,
                "screenId": ScreenId::new_random().to_string(), "assets": []}));
            response.headers_mut().insert("etag", "\"manifest-1\"".parse().unwrap());
            Ok(response)
        }
        "/api/v1/player/config" => {
            if fake.oversized_config.load(Ordering::SeqCst) {
                let padding = "x".repeat(edge_server::client::MAX_CONFIG_BYTES);
                return Ok(data(json!({"schemaVersion": 1, "configRevision": 8, "padding": padding})));
            }
            if request.headers().get("if-none-match").and_then(|v| v.to_str().ok()) == Some("\"config-7\"") {
                let mut response = Response::new(Full::new(Bytes::new()));
                *response.status_mut() = StatusCode::NOT_MODIFIED;
                return Ok(response);
            }
            let mut response = data(json!({"schemaVersion": 1, "configRevision": 7, "branding": {}}));
            response.headers_mut().insert("etag", "\"config-7\"".parse().unwrap());
            Ok(response)
        }
        "/api/v1/player/commands" => {
            let items: Vec<Value> = fake
                .command_states
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, state)| matches!(**state, "delivered" | "acknowledged"))
                .map(|(id, state)| {
                    json!({"id": id, "type": "reload_playback", "idempotencyKey": KEY, "payload": {}, "state": state})
                })
                .collect();
            Ok(data(json!({ "items": items })))
        }
        command if command.starts_with("/api/v1/player/commands/") => {
            let rest = command.trim_start_matches("/api/v1/player/commands/");
            let (id, action) = rest.split_once('/').unwrap();
            let state = fake.command_states.lock().unwrap().get(id).copied().unwrap_or("expired");
            match (action, state) {
                (_, "expired") => Ok(status(StatusCode::CONFLICT, "command_expired")),
                ("acknowledge", "succeeded" | "failed") => Ok(data(json!({"id": id, "state": state}))),
                ("acknowledge", _) => {
                    fake.command_states.lock().unwrap().insert(id.to_owned(), "acknowledged");
                    Ok(data(json!({"id": id, "state": "acknowledged"})))
                }
                ("result", _) => {
                    let body = request.into_body().collect().await.unwrap().to_bytes();
                    let body: Value = serde_json::from_slice(&body).unwrap();
                    let terminal = if body["success"] == true { "succeeded" } else { "failed" };
                    fake.command_states.lock().unwrap().insert(id.to_owned(), terminal);
                    fake.results.lock().unwrap().push((id.to_owned(), body));
                    Ok(data(json!({"id": id, "state": terminal})))
                }
                _ => Ok(status(StatusCode::NOT_FOUND, "not_found")),
            }
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

    let outcome =
        import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, started, ImportMode::Once).await.unwrap();
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
    let record = env.db.run(|c| commands::get(c, "cmd-2")).await.unwrap().expect("imported key");
    assert_eq!(record.state, commands::CommandState::Completed);
    assert_eq!(record.report_state, commands::ReportState::NotRequired);
    assert_eq!(record.command_id, None);
    let flags = env.db.run(|c| playback::get(c)).await.unwrap();
    assert!(flags.playback_disabled);
    assert_eq!(flags.server_clock_offset_ms, Some(1234));
    assert!(env.cas.verified_path(&Sha256Digest::of(MEDIA)).await.unwrap().is_some());
    assert!(env.cas.stat(&Sha256Digest::of(b"tampered bytes")).await.unwrap().is_none());
    assert_eq!(tree_snapshot(&env.legacy()), before, "legacy state must be untouched");

    // Idempotent.
    let again =
        import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, started, ImportMode::Once).await.unwrap();
    assert!(matches!(again, ImportOutcome::AlreadyComplete));

    // A migration after a rollback: the legacy player ran another command
    // and forgot an old key. The refresh adds the new key and keeps every
    // key either player recorded.
    std::fs::write(env.legacy().join("executed-commands.json"), br#"{"keys": ["cmd-2", "cmd-3"]}"#).unwrap();
    let refreshed =
        import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, started, ImportMode::Refresh).await.unwrap();
    let ImportOutcome::Imported(summary) = refreshed else { panic!("expected a refresh") };
    assert!(summary.refreshed);
    for key in ["cmd-1", "cmd-2", "cmd-3"] {
        let record = env.db.run(move |c| commands::get(c, key)).await.unwrap().expect("key kept");
        assert_eq!(record.state, commands::CommandState::Completed, "{key}");
    }

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

    let error =
        import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, now(), ImportMode::Once).await.unwrap_err();
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
    let error =
        import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, now(), ImportMode::Once).await.unwrap_err();
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

#[tokio::test]
async fn player_manifest_uses_the_ordinary_endpoint_and_conditional_etag() {
    let installation = InstallationId::new_random();
    let fake = Fake::new(installation);
    let url = serve(Arc::clone(&fake)).await;
    let server = ServerClient::new(&url)
        .unwrap()
        .verify_installation(installation, DeviceCredential::parse(CREDENTIAL).unwrap())
        .await
        .unwrap();
    let ManifestFetch::Modified { document, etag } = server.player_manifest(None).await.unwrap() else {
        panic!("expected a manifest");
    };
    assert_eq!(document["schemaVersion"], 11);
    assert_eq!(etag, "\"manifest-1\"");
    assert_eq!(server.player_manifest(Some(&etag)).await.unwrap(), ManifestFetch::NotModified);
    assert!(server.player_manifest(Some(&"x".repeat(201))).await.is_err(), "validators are bounded");
    const { assert!(MAX_MANIFEST_BYTES > 5 * 1024 * 1024, "the server's own five MiB bound fits") };
}

async fn authenticated(fake: &Arc<Fake>, installation: InstallationId) -> edge_server::AuthenticatedServer {
    let url = serve(Arc::clone(fake)).await;
    ServerClient::new(&url)
        .unwrap()
        .verify_installation(installation, DeviceCredential::parse(CREDENTIAL).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn player_config_is_conditional_and_bounded() {
    use edge_server::player_api::ConfigFetch;
    let installation = InstallationId::new_random();
    let fake = Fake::new(installation);
    let server = authenticated(&fake, installation).await;
    let ConfigFetch::Modified { document, etag } = server.player_config(None).await.unwrap() else {
        panic!("expected a configuration");
    };
    assert_eq!(document["configRevision"], 7);
    assert_eq!(etag.as_deref(), Some("\"config-7\""));
    assert_eq!(server.player_config(etag.as_deref()).await.unwrap(), ConfigFetch::NotModified);
    fake.oversized_config.store(true, Ordering::SeqCst);
    assert_eq!(server.player_config(None).await, Err(ServerError::ResponseTooLarge));
}

#[tokio::test]
async fn commands_are_acknowledged_and_reported_by_delivery_id() {
    use edge_server::player_api::{AcknowledgeOutcome, ReportOutcome};
    let installation = InstallationId::new_random();
    let fake = Fake::new(installation);
    let server = authenticated(&fake, installation).await;
    let id = uuid::Uuid::new_v4();
    fake.command_states.lock().unwrap().insert(id.to_string(), "delivered");
    let batch = server.player_commands().await.unwrap();
    assert_eq!(batch.commands.len(), 1);
    assert_eq!((batch.commands[0].id, batch.commands[0].idempotency_key.as_str()), (id, KEY));
    assert_eq!(server.acknowledge_command(id).await.unwrap(), AcknowledgeOutcome::Acknowledged);
    assert_eq!(server.report_command_result(id, true, "playback_reloaded", "").await.unwrap(), ReportOutcome::Accepted);
    assert_eq!(server.acknowledge_command(id).await.unwrap(), AcknowledgeOutcome::AlreadySettled { succeeded: true });
    let expired = uuid::Uuid::new_v4();
    assert_eq!(server.acknowledge_command(expired).await.unwrap(), AcknowledgeOutcome::NotActionable);
    assert_eq!(
        server.report_command_result(expired, false, "command_interrupted", "").await.unwrap(),
        ReportOutcome::NotAccepted
    );
    assert_eq!(fake.results.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn import_never_follows_a_link_in_the_legacy_directory() {
    let installation = InstallationId::new_random();
    let fake = Fake::new(installation);
    let url = serve(Arc::clone(&fake)).await;
    let env = Env::new().await;
    env.write_legacy(&url, installation, ScreenId::new_random(), PlayerId::new_random());
    // A cached media file replaced by a link to its correct bytes elsewhere.
    let outside = env.dir.path().join("outside");
    std::fs::write(&outside, MEDIA).unwrap();
    std::fs::remove_file(env.legacy().join("cache/media/a1-v1")).unwrap();
    std::os::unix::fs::symlink(&outside, env.legacy().join("cache/media/a1-v1")).unwrap();
    let outcome = import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, now(), ImportMode::Once).await;
    let ImportOutcome::Imported(summary) = outcome.unwrap() else { panic!("expected an import") };
    assert_eq!((summary.media_imported, summary.media_rejected), (0, 2), "the link is rejected, not followed");
    assert!(env.cas.stat(&Sha256Digest::of(MEDIA)).await.unwrap().is_none());

    // A linked credential file is missing, not read.
    let env = Env::new().await;
    env.write_legacy(&url, installation, ScreenId::new_random(), PlayerId::new_random());
    let credential = env.dir.path().join("credential.json");
    std::fs::rename(env.legacy().join("credential.json"), &credential).unwrap();
    std::os::unix::fs::symlink(&credential, env.legacy().join("credential.json")).unwrap();
    let error =
        import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, now(), ImportMode::Once).await.unwrap_err();
    assert!(matches!(error, ImportError::Missing("credential.json")), "{error:?}");
}
