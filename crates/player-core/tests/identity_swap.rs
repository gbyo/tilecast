//! A different installation can take over a server address while the Player
//! holds an identity-verified handle (docs/device-credential-security.md,
//! "Identity changes during a session"). A stub server swaps its installation
//! ID between requests and records which requests carried the credential.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt as _, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use player_client::client::ServerError;
use player_client::{AuthenticatedServer, CredentialError, CredentialStore, DeviceCredential, ServerClient};
use player_core::{Dependencies, ServerLinkState, ServerRelationship, ServerRelationshipError};
use player_state::repo::binding::{self, CredentialState, ServerBinding};
use player_state::{OpenOptions, StateDb};
use player_types::InstallationId;
use player_types::time::{ManualClock, Timestamp, WallClock};

const CREDENTIAL: &str = "tc_device_abcdefghijklmnopqrstuvwxyz.abcdefghijklmnopqrstuvwxyz0123456789ABCD";

fn installation(n: u128) -> InstallationId {
    InstallationId::from_uuid(uuid::Uuid::from_u128(n))
}

/// One address whose installation can change between requests.
struct Stub {
    installation: Mutex<InstallationId>,
    /// The installation that knows the device credential.
    enrolled: InstallationId,
    /// The enrolled installation revokes the credential.
    revoked: AtomicBool,
    /// Close the next credentialed request without answering.
    drop_next: AtomicBool,
    identity_reads: AtomicUsize,
    /// `(path, carried an Authorization header, installation that answered)`.
    credentialed: Mutex<Vec<(String, InstallationId)>>,
}

impl Stub {
    fn swap_to(&self, installation: InstallationId) {
        *self.installation.lock().unwrap() = installation;
    }

    fn current(&self) -> InstallationId {
        *self.installation.lock().unwrap()
    }

    /// Credentialed requests that reached an installation other than `enrolled`.
    fn credential_leaks(&self) -> Vec<String> {
        self.credentialed
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, answered_by)| *answered_by != self.enrolled)
            .map(|(path, _)| path.clone())
            .collect()
    }
}

fn json(status: StatusCode, body: serde_json::Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body.to_string())));
    *response.status_mut() = status;
    response
}

async fn handle(stub: Arc<Stub>, request: Request<Incoming>) -> Result<Response<Full<Bytes>>, std::io::Error> {
    let current = stub.current();
    if request.uri().path() == "/api/v1/system/identity" {
        stub.identity_reads.fetch_add(1, Ordering::SeqCst);
        return Ok(json(
            StatusCode::OK,
            serde_json::json!({"data": {
                "product": "Tilecast", "installationId": current.to_string(),
                "organizationName": "Test", "apiVersion": "v1", "pairingEnabled": false,
            }}),
        ));
    }
    if request.headers().contains_key(hyper::header::AUTHORIZATION) {
        stub.credentialed.lock().unwrap().push((request.uri().path().to_owned(), current));
    }
    if stub.drop_next.swap(false, Ordering::SeqCst) {
        return Err(std::io::Error::other("connection lost"));
    }
    // A substitute installation has no record of this device.
    if current != stub.enrolled {
        return Ok(json(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({"error": {"code": "device_credential_invalid", "message": "invalid"}}),
        ));
    }
    if stub.revoked.load(Ordering::SeqCst) {
        return Ok(json(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({"error": {"code": "device_credential_revoked", "message": "revoked"}}),
        ));
    }
    let _ = request.into_body().collect().await;
    Ok(json(StatusCode::OK, serde_json::json!({"data": {"items": []}})))
}

async fn serve(enrolled: InstallationId) -> (String, Arc<Stub>) {
    let stub = Arc::new(Stub {
        installation: Mutex::new(enrolled),
        enrolled,
        revoked: AtomicBool::new(false),
        drop_next: AtomicBool::new(false),
        identity_reads: AtomicUsize::new(0),
        credentialed: Mutex::new(Vec::new()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let serving = Arc::clone(&stub);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            let serving = Arc::clone(&serving);
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |request| handle(Arc::clone(&serving), request));
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    (format!("http://{address}"), stub)
}

async fn verified(url: &str, enrolled: InstallationId) -> AuthenticatedServer {
    ServerClient::new(url, "test")
        .unwrap()
        .verify_installation(enrolled, DeviceCredential::parse(CREDENTIAL).unwrap())
        .await
        .unwrap()
}

fn mismatch(enrolled: InstallationId, actual: InstallationId) -> ServerError {
    ServerError::IdentityMismatch { expected: enrolled, actual }
}

#[tokio::test]
async fn a_swapped_installation_is_refused_before_the_next_request_carries_the_credential() {
    let enrolled = installation(1);
    let (url, stub) = serve(enrolled).await;
    let server = verified(&url, enrolled).await.with_identity_freshness(Duration::ZERO);
    server.player_commands().await.unwrap();

    stub.swap_to(installation(2));
    assert_eq!(server.player_commands().await.unwrap_err(), mismatch(enrolled, installation(2)));
    assert_eq!(server.player_heartbeat(&serde_json::json!({})).await.unwrap_err(), mismatch(enrolled, installation(2)));
    assert!(server.player_socket("test").await.is_err());
    assert_eq!(stub.credential_leaks(), Vec::<String>::new());
}

#[tokio::test]
async fn the_check_is_bounded_in_time_and_shared_by_every_clone() {
    let enrolled = installation(1);
    let (url, stub) = serve(enrolled).await;
    let server = verified(&url, enrolled).await.with_identity_freshness(Duration::from_millis(150));
    let clone = server.clone();
    let reads_after_verification = stub.identity_reads.load(Ordering::SeqCst);

    for _ in 0..3 {
        server.player_commands().await.unwrap();
        clone.player_commands().await.unwrap();
    }
    assert_eq!(stub.identity_reads.load(Ordering::SeqCst), reads_after_verification, "a burst shares one check");

    stub.swap_to(installation(2));
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Whichever consumer polls next, none sends the credential to the new installation.
    assert_eq!(clone.player_commands().await.unwrap_err(), mismatch(enrolled, installation(2)));
    assert_eq!(server.player_commands().await.unwrap_err(), mismatch(enrolled, installation(2)));
    assert_eq!(stub.credential_leaks(), Vec::<String>::new());
}

#[tokio::test]
async fn a_credential_refusal_from_another_installation_is_not_a_rejected_credential() {
    // Inside the freshness window the request goes out, and the substitute
    // answers "invalid". Core deletes the credential on that answer, so the
    // client must settle whose answer it is first.
    let enrolled = installation(1);
    let (url, stub) = serve(enrolled).await;
    let server = verified(&url, enrolled).await;
    stub.swap_to(installation(2));
    assert_eq!(server.player_commands().await.unwrap_err(), mismatch(enrolled, installation(2)));
    assert_eq!(ServerLinkState::from_error(&mismatch(enrolled, installation(2))).state_token(), "stopped");

    // The same refusal from the enrolled installation is still a rejection.
    stub.swap_to(enrolled);
    stub.revoked.store(true, Ordering::SeqCst);
    assert_eq!(server.player_commands().await.unwrap_err(), ServerError::CredentialRejected);
}

#[tokio::test]
async fn a_transport_failure_drops_the_proof_even_inside_the_window() {
    let enrolled = installation(1);
    let (url, stub) = serve(enrolled).await;
    let server = verified(&url, enrolled).await;
    let before = stub.identity_reads.load(Ordering::SeqCst);

    stub.drop_next.store(true, Ordering::SeqCst);
    assert_eq!(server.player_commands().await.unwrap_err(), ServerError::Network);
    stub.swap_to(installation(2));
    assert_eq!(server.player_commands().await.unwrap_err(), mismatch(enrolled, installation(2)));
    assert!(stub.identity_reads.load(Ordering::SeqCst) > before);

    // The enrolled installation returning to the address recovers the handle.
    stub.swap_to(enrolled);
    server.player_commands().await.unwrap();
}

#[derive(Debug)]
struct Credentials(Mutex<Option<DeviceCredential>>);

impl CredentialStore for Credentials {
    fn load(&self) -> Result<Option<DeviceCredential>, CredentialError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, credential: &DeviceCredential) -> Result<(), CredentialError> {
        *self.0.lock().unwrap() = Some(credential.clone());
        Ok(())
    }
    fn remove(&self) -> Result<(), CredentialError> {
        self.0.lock().unwrap().take();
        Ok(())
    }
}

#[tokio::test]
async fn a_swap_between_link_passes_stops_the_link_and_keeps_the_credential() {
    let enrolled = installation(1);
    let (url, stub) = serve(enrolled).await;
    let dir = tempfile::tempdir().unwrap();
    let clock = ManualClock::new(Timestamp::parse("2026-10-04T12:00:00Z").unwrap());
    let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
    let credentials = Arc::new(Credentials(Mutex::new(Some(DeviceCredential::parse(CREDENTIAL).unwrap()))));
    let relationship =
        ServerRelationship::new(Dependencies { state: state.clone(), clock: clock.clone() }, credentials.clone());
    let now = clock.now();
    state
        .run(move |connection| {
            binding::put(
                connection,
                &ServerBinding {
                    server_url: url.clone(),
                    installation_id: enrolled,
                    organization_name: None,
                    screen_id: None,
                    screen_name: None,
                    credential_state: CredentialState::Stored,
                    identity_verified_at: None,
                    bound_at: now,
                },
                now,
            )
        })
        .await
        .unwrap();

    let (_, server) = relationship.verify("test").await.unwrap();
    let server = server.with_identity_freshness(Duration::ZERO);
    server.player_commands().await.unwrap();

    stub.swap_to(installation(2));
    let error = server.player_commands().await.unwrap_err();
    assert_eq!(
        ServerLinkState::from_error(&error),
        ServerLinkState::IdentityMismatch { expected: enrolled.to_string(), actual: installation(2).to_string() }
    );
    // The next pass reaches the same verdict, and nothing deleted the credential.
    let Err(ServerRelationshipError::Identity(pass_error)) = relationship.verify("test").await else {
        panic!("the link must stop on the substitute installation");
    };
    assert_eq!(pass_error, mismatch(enrolled, installation(2)));
    assert!(credentials.load().unwrap().is_some());
    assert_eq!(stub.credential_leaks(), Vec::<String>::new());
}
