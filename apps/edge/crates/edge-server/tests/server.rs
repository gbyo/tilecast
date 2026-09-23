//! Legacy import, the identity gate, Edge enrollment and the origin source
//! against an in-process fake Tilecast Server.
#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use bytes::Bytes;
use edge_cas::{BlobSource, ContentStore, LruByDomain, SourceError, StorePolicy};
use edge_identity::RevocationSet;
use edge_identity::testing::TestCa;
use edge_platform::disk::FixedSpace;
use edge_protocol::signed::change::{AuthorityKey, AuthorityTrust, ChangeType};
use edge_protocol::signed::{Purpose, SignedDocument, SigningKey};
use edge_protocol::time::system_clock;
use edge_protocol::{InstallationId, NodeId, ScreenId, Sha256Digest, Timestamp};
use edge_server::client::ServerClient;
use edge_server::enrollment::{EnrollError, enroll};
use edge_server::feed::{FeedApplier, FeedError, Offer, Wake};
use edge_server::legacy::{ImportError, ImportOutcome, import_legacy};
use edge_server::origin::OriginBlobSource;
use edge_server::{DeviceCredential, ServerError};
use edge_state::repo::{binding, changes, commands, identity, legacy, playback};
use edge_state::{OpenOptions, StateDb};
use futures_util::StreamExt as _;
use http_body_util::{BodyExt as _, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use serde_json::{Value, json};
use x509_parser::prelude::FromDer as _;

const CREDENTIAL: &str = "tc_device_01j8xk2m4n6p8q0r2s4t6v8w0y.ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ";
fn now() -> Timestamp {
    system_clock().now()
}

const MEDIA: &[u8] = b"not really a PNG, but bytes are bytes for a content-addressed store";

struct Fake {
    /// What `/system/identity` reports.
    reported_installation: InstallationId,
    installation: InstallationId,
    ca: TestCa,
    authority: SigningKey,
    revoked_node: NodeId,
    /// (path, carried a credential) for every request.
    log: Mutex<Vec<(String, bool)>>,
    /// Signed change documents the feed endpoint serves, by sequence.
    changes: Mutex<Vec<(u64, Value)>>,
    snapshot_as_of: Mutex<u64>,
}

impl Fake {
    fn new(installation: InstallationId) -> Arc<Self> {
        Arc::new(Self {
            reported_installation: installation,
            installation,
            ca: TestCa::new(installation),
            authority: SigningKey::from_seed(&[7u8; 32]),
            revoked_node: NodeId::new_random(),
            log: Mutex::new(Vec::new()),
            changes: Mutex::new(Vec::new()),
            snapshot_as_of: Mutex::new(41),
        })
    }

    fn snapshot(&self) -> Value {
        let document = self
            .authority
            .sign(
                Purpose::ServerSnapshot,
                &json!({
                    "schema": 1, "installationId": self.installation.to_string(), "authorityEpoch": 1,
                    "type": "edge.revocation.snapshot", "asOfSequence": *self.snapshot_as_of.lock().unwrap(),
                    "generation": 3, "issuedAt": "2026-09-01T00:00:00Z",
                    "revoked": [{"nodeId": self.revoked_node.to_string(), "certificatesExpireAt": "2027-03-01T00:00:00Z"}]
                }),
                None,
            )
            .unwrap();
        serde_json::to_value(&document).unwrap()
    }

    fn change(&self, sequence: u64, previous: u64, change_type: &str, payload: Value) -> Value {
        let body = json!({
            "schema": 1, "installationId": self.installation.to_string(), "authorityEpoch": 1,
            "sequence": sequence, "previousSequence": previous, "type": change_type,
            "target": {"kind": "installation", "id": self.installation.to_string()}, "object": null,
            "revocationGeneration": 4, "issuedAt": "2026-09-01T00:00:00Z", "expiresAt": null, "payload": payload,
        });
        serde_json::to_value(self.authority.sign(Purpose::ServerChange, &body, None).unwrap()).unwrap()
    }

    fn publish(&self, sequence: u64, previous: u64, change_type: &str, payload: Value) -> Value {
        let document = self.change(sequence, previous, change_type, payload);
        self.changes.lock().unwrap().push((sequence, document.clone()));
        document
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

fn pem(label: &str, der: &[u8]) -> String {
    let body = base64::engine::general_purpose::STANDARD.encode(der);
    let lines: Vec<&str> = body.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
    format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
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
    let query = request.uri().query().unwrap_or("").to_owned();
    let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let if_range = request.headers().get("if-range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    match path.as_str() {
        "/api/v1/player/heartbeat" => Ok(data(json!({"accepted": true}))),
        "/api/v1/player/edge/enroll" => {
            let body = request.into_body().collect().await.unwrap().to_bytes();
            let body: Value = serde_json::from_slice(&body).unwrap();
            let csr = body["csrPem"].as_str().unwrap();
            // The node ID is the CSR subject; the fake trusts it, the real
            // server checks it against the screen's player installation ID.
            let der = pem_to_der(csr);
            let parsed = x509_parser::certification_request::X509CertificationRequest::from_der(&der);
            let node: NodeId = parsed
                .unwrap()
                .1
                .certification_request_info
                .subject
                .iter_common_name()
                .next()
                .unwrap()
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            let certificate = fake.ca.issue_from_csr(csr, node).unwrap();
            Ok(data(json!({
                "certificatePem": pem("CERTIFICATE", &certificate),
                "caCertificatePem": pem("CERTIFICATE", &fake.ca.ca_der),
                "installationId": fake.installation.to_string(),
                "screenId": ScreenId::new_random().to_string(),
                "nodeId": node.to_string(),
                "authority": {
                    "epoch": 1,
                    "keyId": fake.authority.public_key().key_id(),
                    "publicKey": fake.authority.public_key().to_base64url(),
                },
                "meshProtocolVersion": edge_protocol::MESH_PROTOCOL_VERSION,
                "notBefore": "2026-09-01T00:00:00Z",
                "notAfter": "2027-03-01T00:00:00Z",
                "renewAfter": "2027-01-30T00:00:00Z",
                "latestSequence": 41,
                "revocationSnapshot": fake.snapshot(),
            })))
        }
        "/api/v1/player/edge/revocations" => Ok(data(fake.snapshot())),
        "/api/v1/player/edge/changes" => {
            let param = |name: &str| {
                query.split('&').find_map(|kv| kv.strip_prefix(&format!("{name}="))).unwrap().parse::<u64>().unwrap()
            };
            let (after, limit) = (param("after"), param("limit"));
            let changes = fake.changes.lock().unwrap();
            let items: Vec<Value> =
                changes.iter().filter(|(s, _)| *s > after).take(limit as usize).map(|(_, d)| d.clone()).collect();
            let latest = changes.iter().map(|(s, _)| *s).max().unwrap_or(0);
            let oldest = changes.iter().map(|(s, _)| *s).min().unwrap_or(0);
            Ok(data(json!({"items": items, "latestSequence": latest, "oldestSequence": oldest})))
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

fn pem_to_der(pem: &str) -> Vec<u8> {
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD.decode(body).unwrap()
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

/// Uses a locally trusted CA certificate with ordinary hostname validation.
async fn serve_tls(fake: Arc<Fake>) -> (String, rustls::pki_types::CertificateDer<'static>) {
    let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let root = certified.cert.der().clone();
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der());
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![root.clone()], key.into())
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            let fake = Arc::clone(&fake);
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(stream) = acceptor.accept(stream).await else { return };
                let service = hyper::service::service_fn(move |request| handle(Arc::clone(&fake), request));
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    (format!("https://localhost:{}", address.port()), root)
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

    fn write_legacy(&self, server_url: &str, installation: InstallationId, screen: ScreenId, node: NodeId) {
        let write = |name: &str, value: Value| {
            std::fs::write(self.legacy().join(name), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        };
        write("installation.json", json!({"playerInstallationId": node.to_string()}));
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
async fn legacy_import_then_enrollment() {
    let installation = InstallationId::new_random();
    let screen = ScreenId::new_random();
    let node = NodeId::new_random();
    let fake = Fake::new(installation);
    let url = serve(Arc::clone(&fake)).await;
    let env = Env::new().await;
    env.write_legacy(&url, installation, screen, node);
    let before = tree_snapshot(&env.legacy());
    let started = now();

    let outcome = import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, started).await.unwrap();
    let ImportOutcome::Imported(summary) = outcome else { panic!("expected an import") };
    assert_eq!(summary.node_id, node);
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

    // Enrollment with the imported credential.
    let credential = DeviceCredential::load(&env.identity()).unwrap().unwrap();
    let (tls_url, tls_root) = serve_tls(Arc::clone(&fake)).await;
    let server = ServerClient::with_trust_roots(&tls_url, &[tls_root])
        .unwrap()
        .verify_installation(installation, credential)
        .await
        .unwrap();
    let revocations = RevocationSet::new();
    let enrolled = enroll(&server, &env.db, &env.identity(), node, &revocations, now()).await.unwrap();
    assert_eq!(enrolled.certificate.node_id, node);
    assert_eq!(enrolled.latest_sequence, 41);
    assert!(revocations.is_revoked(&fake.revoked_node));
    let active = env.db.run(|c| identity::active_certificate(c)).await.unwrap().unwrap();
    assert_eq!(active.fingerprint, enrolled.certificate.fingerprint);
    let trust = env.db.run(|c| identity::get_trust(c)).await.unwrap().unwrap();
    assert_eq!(trust.ca_certificate_der, fake.ca.ca_der);
    let feed = env.db.run(|c| changes::feed_state(c)).await.unwrap().unwrap();
    assert_eq!(feed.position.last_sequence, 41);
    assert_eq!(env.db.run(|c| identity::revocation_generation(c)).await.unwrap(), 3);
    let key_files = std::fs::read_dir(env.identity())
        .unwrap()
        .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("node-key-"))
        .count();
    assert_eq!(key_files, 1);

    // Renewal replaces the certificate and removes the superseded key.
    let renewed = enroll(&server, &env.db, &env.identity(), node, &revocations, now()).await.unwrap();
    assert_ne!(renewed.certificate.key_fingerprint, enrolled.certificate.key_fingerprint);
    let active = env.db.run(|c| identity::active_certificate(c)).await.unwrap().unwrap();
    assert_eq!(active.fingerprint, renewed.certificate.fingerprint);

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
async fn insecure_lan_binding_keeps_player_contact_but_cannot_bootstrap_edge_trust() {
    let installation = InstallationId::new_random();
    let fake = Fake::new(installation);
    let url = serve(Arc::clone(&fake)).await;
    let server = ServerClient::new(&url)
        .unwrap()
        .verify_installation(installation, DeviceCredential::parse(CREDENTIAL).unwrap())
        .await
        .unwrap();
    assert!(!server.has_secure_edge_bootstrap());
    assert_eq!(server.player_socket("0.1.0").await.unwrap_err(), ServerError::InsecureEdgeBootstrap);
    assert!(fake.authenticated_paths().is_empty());
    assert_eq!(server.edge_enroll("not-a-csr").await.unwrap_err(), ServerError::InsecureEdgeBootstrap);
    assert!(fake.authenticated_paths().is_empty());
    server.player_heartbeat(&json!({"screenWidth": 0, "screenHeight": 0, "playerVersion": "0.1.0"})).await.unwrap();
    assert_eq!(fake.authenticated_paths(), vec!["/api/v1/player/heartbeat"]);
}

#[tokio::test]
async fn import_refuses_a_different_installation_without_sending_the_credential() {
    let installation = InstallationId::new_random();
    let mut fake = Fake::new(installation);
    Arc::get_mut(&mut fake).unwrap().reported_installation = InstallationId::new_random();
    let url = serve(Arc::clone(&fake)).await;
    let env = Env::new().await;
    env.write_legacy(&url, installation, ScreenId::new_random(), NodeId::new_random());

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
    env.write_legacy("http://signage.example.org", installation, ScreenId::new_random(), NodeId::new_random());
    let error = import_legacy(&env.legacy(), &env.identity(), &env.db, &env.cas, now()).await.unwrap_err();
    assert!(matches!(error, ImportError::ServerUrl(_)), "{error:?}");
}

#[tokio::test]
async fn enrollment_refuses_a_changed_edge_ca() {
    let installation = InstallationId::new_random();
    let node = NodeId::new_random();
    let first = Fake::new(installation);
    let (first_url, first_root) = serve_tls(Arc::clone(&first)).await;
    let env = Env::new().await;
    let credential = DeviceCredential::parse(CREDENTIAL).unwrap();
    let server = ServerClient::with_trust_roots(&first_url, &[first_root])
        .unwrap()
        .verify_installation(installation, credential.clone())
        .await
        .unwrap();
    let revocations = RevocationSet::new();
    let enrolled = enroll(&server, &env.db, &env.identity(), node, &revocations, now()).await.unwrap();

    // Same installation, different CA: the pinned trust wins.
    let impostor = Fake::new(installation);
    let (impostor_url, impostor_root) = serve_tls(impostor).await;
    let server = ServerClient::with_trust_roots(&impostor_url, &[impostor_root])
        .unwrap()
        .verify_installation(installation, credential)
        .await
        .unwrap();
    let error = enroll(&server, &env.db, &env.identity(), node, &revocations, now()).await.unwrap_err();
    assert!(matches!(error, EnrollError::TrustChanged), "{error:?}");
    let active = env.db.run(|c| identity::active_certificate(c)).await.unwrap().unwrap();
    assert_eq!(active.fingerprint, enrolled.certificate.fingerprint);
}

async fn enrolled(fake: &Arc<Fake>) -> (Env, edge_server::AuthenticatedServer, RevocationSet, AuthorityTrust) {
    let (url, root) = serve_tls(Arc::clone(fake)).await;
    let env = Env::new().await;
    let credential = DeviceCredential::parse(CREDENTIAL).unwrap();
    let server = ServerClient::with_trust_roots(&url, &[root])
        .unwrap()
        .verify_installation(fake.installation, credential)
        .await
        .unwrap();
    let revocations = RevocationSet::new();
    enroll(&server, &env.db, &env.identity(), NodeId::new_random(), &revocations, now()).await.unwrap();
    let trust = AuthorityTrust {
        installation_id: fake.installation,
        keys: vec![AuthorityKey { epoch: 1, public_key: fake.authority.public_key().clone() }],
    };
    (env, server, revocations, trust)
}

fn document(value: &Value) -> SignedDocument {
    serde_json::from_value(value.clone()).unwrap()
}

#[tokio::test]
async fn feed_follows_the_signed_chain_across_integer_gaps() {
    let fake = Fake::new(InstallationId::new_random());
    let (env, server, revocations, trust) = enrolled(&fake).await;
    let victim = NodeId::new_random();
    fake.publish(
        42,
        41,
        "edge.node.revoked",
        json!({"nodeId": victim.to_string(), "screenId": null, "certificatesExpireAt": "2027-03-01T00:00:00Z"}),
    );
    // 43 and 44 were never committed (rolled-back transactions): a gap in the
    // integers, not in the chain.
    fake.publish(45, 42, "screen.presentation.changed", json!({}));
    fake.publish(46, 45, "future.change.type", json!({}));
    let mut applier = FeedApplier::new(env.db.clone(), trust, revocations.clone());
    let report = applier.reconcile(&server, now()).await.unwrap();
    assert_eq!((report.applied, report.last_sequence), (3, 46));
    assert!(revocations.is_revoked(&victim));
    assert!(report.wakes.contains(&Wake::Change(ChangeType::ScreenPresentationChanged)));
    assert_eq!(env.db.run(|c| identity::revocation_generation(c)).await.unwrap(), 4);

    // Idempotent.
    let again = applier.reconcile(&server, now()).await.unwrap();
    assert_eq!((again.applied, again.last_sequence), (0, 46));

    // A relayed change ahead of the chain is held, never applied early.
    let ahead = fake.change(48, 47, "screen.configuration.changed", json!({}));
    assert_eq!(applier.offer(&document(&ahead), "peer:x", now()).await.unwrap(), Offer::NeedsReconcile);
    assert_eq!(env.db.run(|c| changes::feed_state(c)).await.unwrap().unwrap().position.last_sequence, 46);
    // A relayed duplicate is harmless; a forged or conflicting one is not.
    let duplicate = fake.changes.lock().unwrap()[1].1.clone();
    assert_eq!(applier.offer(&document(&duplicate), "peer:x", now()).await.unwrap(), Offer::Duplicate);
    let conflicting = fake.change(45, 42, "organization.branding.changed", json!({}));
    assert!(matches!(applier.offer(&document(&conflicting), "peer:x", now()).await, Err(FeedError::Conflict(45))));
    let foreign = SigningKey::from_seed(&[8u8; 32]);
    let mut forged = document(&ahead);
    forged.signature = foreign
        .sign(Purpose::ServerChange, &serde_json::from_slice(&forged_body(&forged)).unwrap(), None)
        .unwrap()
        .signature;
    assert_eq!(applier.offer(&forged, "peer:x", now()).await.unwrap(), Offer::Rejected("change_unverifiable"));

    // The server closes the chain; the held change then applies too.
    fake.publish(47, 46, "screen.command.available", json!({}));
    let linked = fake.publish(48, 47, "screen.configuration.changed", json!({}));
    assert_eq!(linked, ahead);
    let report = applier.reconcile(&server, now()).await.unwrap();
    assert_eq!(report.last_sequence, 48);
    assert_eq!(applier.held(), 0);
}

fn forged_body(document: &SignedDocument) -> Vec<u8> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&document.body).unwrap()
}

#[tokio::test]
async fn feed_resynchronizes_when_the_server_retired_the_link() {
    let fake = Fake::new(InstallationId::new_random());
    let (env, server, _revocations, trust) = enrolled(&fake).await;
    // Retention removed 42..=99; the oldest retained change links to 99.
    fake.publish(100, 99, "screen.presentation.changed", json!({}));
    *fake.snapshot_as_of.lock().unwrap() = 100;
    let mut applier = FeedApplier::new(env.db.clone(), trust, RevocationSet::new());
    let report = applier.reconcile(&server, now()).await.unwrap();
    assert_eq!(report.wakes, vec![Wake::Resynced]);
    assert_eq!(report.last_sequence, 100);
    fake.publish(101, 100, "screen.presentation.changed", json!({}));
    let report = applier.reconcile(&server, now()).await.unwrap();
    assert_eq!((report.applied, report.last_sequence), (1, 101));
}
