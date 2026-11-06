//! Phone setup sessions (docs/phone-setup.md).
//!
//! While a Player has no server, Core shows a setup QR code and waits on
//! the setup relay for an envelope from Studio. A delivered address goes
//! through the URL policy and an installation identity check, then into the
//! ordinary [`PairingCoordinator::begin`]. A session stops after
//! [`SESSION_LIMIT`] so a screen left on the setup screen does not keep the
//! public relay busy; the host resumes it on a button press.
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use player_client::ServerClient;
use player_client::phone_setup::{Envelope, PhoneSetupError, RelayAddress, RelayOutcome, SetupKey, wait_for_envelope};
use player_client::url_policy::normalize_server_url;
use tokio::time::Instant;

use super::{PairingCoordinator, PairingHost, PairingStatus};

/// How long one setup session waits for a phone before it pauses.
pub const SESSION_LIMIT: Duration = Duration::from_secs(30 * 60);
const FIRST_BACKOFF: Duration = Duration::from_secs(15);
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// What the setup screen shows for phone setup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhoneSetupView {
    /// Show `url` as a QR code. `rejected` is true after the last address
    /// from a phone could not be used.
    Ready { url: String, rejected: bool },
    /// The session reached its limit. Offer a control that resumes it.
    Paused,
    /// The relay cannot be reached. Show no QR code.
    Unavailable,
}

/// The setup relay. Production uses [`SetupRelay`]; tests script it.
#[async_trait]
pub trait PhoneRelay: Send + Sync + std::fmt::Debug {
    fn address(&self) -> &RelayAddress;
    async fn wait(&self, code: &str, user_agent: &str) -> Result<RelayOutcome, PhoneSetupError>;
}

#[derive(Debug, Clone, Default)]
pub struct SetupRelay(pub RelayAddress);

impl SetupRelay {
    /// The relay at `origin`, or the public relay when `origin` is `None`.
    /// Returns `None` for an address the server URL policy rejects.
    pub fn at(origin: Option<&str>) -> Option<Self> {
        match origin {
            None => Some(Self::default()),
            Some(origin) => RelayAddress::new(origin).ok().map(Self),
        }
    }
}

#[async_trait]
impl PhoneRelay for SetupRelay {
    fn address(&self) -> &RelayAddress {
        &self.0
    }
    async fn wait(&self, code: &str, user_agent: &str) -> Result<RelayOutcome, PhoneSetupError> {
        wait_for_envelope(&self.0, code, user_agent).await
    }
}

enum Ended {
    /// Pairing started; the setup surface is no longer current.
    Paired,
    /// The Player left the setup state for another reason.
    Inactive,
    Paused,
}

impl PairingCoordinator {
    /// Enables phone setup with `relay`. Without it the setup surface shows
    /// discovery and manual entry only.
    pub fn with_phone_setup(mut self, relay: Arc<dyn PhoneRelay>) -> Self {
        self.phone = Some(relay);
        self
    }

    /// Starts a new session after [`PhoneSetupView::Paused`].
    pub fn resume_phone_setup(&self) {
        self.control.phone_resume.notify_waiters();
    }

    pub(super) fn phone_view(&self) -> Option<PhoneSetupView> {
        self.control.phone_view.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    pub(super) fn set_phone_active(&self, active: bool) {
        self.control.phone_active.send_if_modified(|current| std::mem::replace(current, active) != active);
    }

    fn phone_active(&self) -> bool {
        *self.control.phone_active.borrow()
    }

    async fn show_phone(&self, host: &impl PairingHost, view: Option<PhoneSetupView>) {
        *self.control.phone_view.lock().unwrap_or_else(|error| error.into_inner()) = view.clone();
        if self.phone_active() {
            host.show_pairing(PairingStatus::Setup { phone: view }).await;
        }
    }

    async fn until_inactive(&self) {
        let mut active = self.control.phone_active.subscribe();
        let _ = active.wait_for(|active| !active).await;
    }

    /// Runs beside the pairing loop for the life of the host.
    pub(super) async fn run_phone_setup(&self, user_agent: &str, host: &impl PairingHost, wake: &tokio::sync::Notify) {
        let Some(relay) = self.phone.clone() else { return std::future::pending().await };
        let mut active = self.control.phone_active.subscribe();
        loop {
            if active.wait_for(|active| *active).await.is_err() {
                return;
            }
            tracing::info!(component = "phone_setup", event = "session_started");
            match self.session(relay.as_ref(), user_agent, host).await {
                Ended::Paired => {
                    self.set_phone_active(false);
                    *self.control.phone_view.lock().unwrap_or_else(|error| error.into_inner()) = None;
                    wake.notify_one();
                }
                Ended::Inactive => {
                    *self.control.phone_view.lock().unwrap_or_else(|error| error.into_inner()) = None;
                }
                Ended::Paused => {
                    tracing::info!(component = "phone_setup", event = "paused");
                    // Notify::notify_waiters reaches a Notified created before publication,
                    // even if the host handles Resume before we first poll it.
                    let resume = self.control.phone_resume.notified();
                    self.show_phone(host, Some(PhoneSetupView::Paused)).await;
                    tokio::select! {
                        () = resume => {}
                        () = self.until_inactive() => {
                            *self.control.phone_view.lock().unwrap_or_else(|error| error.into_inner()) = None;
                        }
                    }
                }
            }
        }
    }

    async fn session(&self, relay: &dyn PhoneRelay, user_agent: &str, host: &impl PairingHost) -> Ended {
        let deadline = Instant::now() + SESSION_LIMIT;
        let mut backoff = FIRST_BACKOFF;
        let mut rejected = false;
        loop {
            let Ok(key) = SetupKey::generate() else {
                self.show_phone(host, Some(PhoneSetupView::Unavailable)).await;
                return Ended::Paused;
            };
            self.show_phone(host, Some(PhoneSetupView::Ready { url: key.qr_url(relay.address()), rejected })).await;
            let outcome = tokio::select! {
                () = self.until_inactive() => return Ended::Inactive,
                () = tokio::time::sleep_until(deadline) => return Ended::Paused,
                outcome = relay.wait(key.code(), user_agent) => outcome,
            };
            match outcome {
                Ok(RelayOutcome::Envelope(envelope)) => {
                    backoff = FIRST_BACKOFF;
                    match self.accept(key, &envelope, user_agent, host).await {
                        Ok(()) => return Ended::Paired,
                        Err(reason) => {
                            tracing::warn!(component = "phone_setup", event = "address_rejected", reason);
                            rejected = true;
                        }
                    }
                }
                Ok(RelayOutcome::Expired | RelayOutcome::Replaced | RelayOutcome::Closed) => {
                    backoff = FIRST_BACKOFF;
                }
                Err(PhoneSetupError::Envelope) => {
                    tracing::warn!(component = "phone_setup", event = "envelope_invalid");
                }
                Err(error) => {
                    tracing::warn!(component = "phone_setup", event = "relay_unavailable", error = %error);
                    self.show_phone(host, Some(PhoneSetupView::Unavailable)).await;
                    tokio::select! {
                        () = self.until_inactive() => return Ended::Inactive,
                        () = tokio::time::sleep_until(deadline) => return Ended::Paused,
                        () = tokio::time::sleep(backoff) => {}
                    }
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    }

    /// Opens the envelope and starts pairing with the address only when the
    /// server answers as the installation Studio named.
    async fn accept(
        &self,
        key: SetupKey,
        envelope: &Envelope,
        user_agent: &str,
        host: &impl PairingHost,
    ) -> Result<(), &'static str> {
        let payload = key.open(envelope).map_err(|_| "envelope_unopened")?;
        let url = normalize_server_url(&payload.server_url).map_err(|_| "server_url_rejected")?;
        let identity = ServerClient::new(&url, user_agent)
            .map_err(|_| "server_url_rejected")?
            .identity()
            .await
            .map_err(|error| error.reason_code())?;
        if identity.installation_id != payload.installation_id {
            return Err("installation_identity_mismatch");
        }
        self.begin(&url, user_agent, host).await.map_err(|_| "pairing_not_started")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use player_client::pairing::{DeviceMetadata, PairingFileError};
    use player_client::{CredentialError, CredentialStore, DeviceCredential, PairingSession, PairingStore};
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, PlayerId, Timestamp, time::ManualClock};
    use ring::{aead, agreement, hkdf, rand::SecureRandom as _};
    use std::sync::Mutex;
    use tokio::sync::mpsc;

    use crate::{Dependencies, PairingMetadataProvider, PlayerCore};

    #[derive(Debug, Default)]
    struct Stores {
        credential: Mutex<Option<DeviceCredential>>,
        session: Mutex<Option<PairingSession>>,
    }
    impl CredentialStore for Stores {
        fn load(&self) -> Result<Option<DeviceCredential>, CredentialError> {
            Ok(self.credential.lock().unwrap().clone())
        }
        fn save(&self, credential: &DeviceCredential) -> Result<(), CredentialError> {
            *self.credential.lock().unwrap() = Some(credential.clone());
            Ok(())
        }
        fn remove(&self) -> Result<(), CredentialError> {
            self.credential.lock().unwrap().take();
            Ok(())
        }
    }
    impl PairingStore for Stores {
        fn load(&self) -> Result<Option<PairingSession>, PairingFileError> {
            Ok(self.session.lock().unwrap().clone())
        }
        fn save(&self, session: &PairingSession) -> Result<(), PairingFileError> {
            *self.session.lock().unwrap() = Some(session.clone());
            Ok(())
        }
        fn remove(&self) -> Result<(), PairingFileError> {
            self.session.lock().unwrap().take();
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct Host {
        statuses: Mutex<Vec<PairingStatus>>,
        resume_on_pause: Mutex<Option<PairingCoordinator>>,
    }
    #[async_trait]
    impl PairingMetadataProvider for Host {
        fn new_player_id(&self) -> PlayerId {
            PlayerId::from_uuid(uuid::Uuid::from_u128(41))
        }
        async fn metadata(&self, player: PlayerId) -> DeviceMetadata {
            DeviceMetadata::new(*player.as_uuid(), "test", "Test", "TV", "1", "1.0.0", (1920, 1080), "en-US", "UTC")
        }
    }
    #[async_trait]
    impl PairingHost for Host {
        async fn show_pairing(&self, status: PairingStatus) {
            if matches!(status, PairingStatus::Setup { phone: Some(PhoneSetupView::Paused) })
                && let Some(core) = self.resume_on_pause.lock().unwrap().take()
            {
                core.resume_phone_setup();
            }
            self.statuses.lock().unwrap().push(status);
        }
    }
    impl Host {
        fn statuses(&self) -> Vec<PairingStatus> {
            self.statuses.lock().unwrap().clone()
        }
        fn last_phone(&self) -> Option<PhoneSetupView> {
            self.statuses().into_iter().rev().find_map(|status| match status {
                PairingStatus::Setup { phone } => phone,
                _ => None,
            })
        }
    }

    /// Hands out scripted outcomes, one per wait, and records each setup code.
    #[derive(Debug)]
    struct ScriptedRelay {
        address: RelayAddress,
        outcomes: tokio::sync::Mutex<mpsc::UnboundedReceiver<Result<RelayOutcome, PhoneSetupError>>>,
        codes: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl PhoneRelay for ScriptedRelay {
        fn address(&self) -> &RelayAddress {
            &self.address
        }
        async fn wait(&self, code: &str, _: &str) -> Result<RelayOutcome, PhoneSetupError> {
            self.codes.lock().unwrap().push(code.to_owned());
            match self.outcomes.lock().await.recv().await {
                Some(outcome) => outcome,
                None => std::future::pending().await,
            }
        }
    }

    fn installation() -> InstallationId {
        InstallationId::from_uuid(uuid::Uuid::from_u128(1))
    }

    /// Public identity and one pairing session, as a Tilecast Server serves them.
    async fn server() -> String {
        async fn handle(
            request: hyper::Request<hyper::body::Incoming>,
        ) -> Result<hyper::Response<http_body_util::Full<bytes::Bytes>>, std::convert::Infallible> {
            let body = match (request.method().as_str(), request.uri().path()) {
                ("GET", "/api/v1/system/identity") => serde_json::json!({"data": {
                    "product": "tilecast", "installationId": installation().to_string(),
                    "organizationName": "Library", "apiVersion": "v1", "pairingEnabled": true}}),
                ("POST", "/api/v1/player/pairing-sessions") => serde_json::json!({"data": {
                    "id": uuid::Uuid::from_u128(9), "code": "ABC123", "pollSecret": "p".repeat(43),
                    "expiresAt": "2027-01-15T08:10:00Z", "serverTime": "2027-01-15T08:00:00Z",
                    "pollingIntervalSeconds": 3, "approvalUrl": "/screens/pair/ABC123", "organizationName": "Library"}}),
                _ => serde_json::json!({"error": {"code": "not_found", "message": "Not found."}}),
            };
            Ok(hyper::Response::builder()
                .header("content-type", "application/json")
                .body(http_body_util::Full::new(bytes::Bytes::from(body.to_string())))
                .unwrap())
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                tokio::spawn(
                    hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(stream), hyper::service::service_fn(handle)),
                );
            }
        });
        format!("http://{address}")
    }

    /// Studio's half: seals `payload` for the key in a QR code URL.
    fn seal(qr_url: &str, payload: serde_json::Value) -> Envelope {
        let fragment = qr_url.split_once('#').unwrap().1;
        let params: std::collections::HashMap<&str, &str> =
            fragment.split('&').map(|pair| pair.split_once('=').unwrap()).collect();
        let code = params["r"];
        let player = URL_SAFE_NO_PAD.decode(params["k"]).unwrap();
        let rng = ring::rand::SystemRandom::new();
        let ephemeral = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let epk = ephemeral.compute_public_key().unwrap().as_ref().to_vec();
        let mut salt = epk.clone();
        salt.extend_from_slice(&player);
        let key: aead::UnboundKey = agreement::agree_ephemeral(
            ephemeral,
            &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, &player),
            |shared| {
                hkdf::Salt::new(hkdf::HKDF_SHA256, &salt)
                    .extract(shared)
                    .expand(&[b"tilecast-setup-v1".as_slice()], &aead::AES_256_GCM)
                    .unwrap()
                    .into()
            },
        )
        .unwrap();
        let mut iv = [0u8; 12];
        rng.fill(&mut iv).unwrap();
        let mut ct = payload.to_string().into_bytes();
        aead::LessSafeKey::new(key)
            .seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(iv), aead::Aad::from(code.as_bytes()), &mut ct)
            .unwrap();
        Envelope::parse(
            &serde_json::json!({"v": 1, "epk": URL_SAFE_NO_PAD.encode(epk), "iv": URL_SAFE_NO_PAD.encode(iv),
                "ct": URL_SAFE_NO_PAD.encode(ct)})
            .to_string(),
        )
        .unwrap()
    }

    struct Running {
        _dir: tempfile::TempDir,
        core: PairingCoordinator,
        stores: Arc<Stores>,
        host: Arc<Host>,
        relay: Arc<ScriptedRelay>,
        script: mpsc::UnboundedSender<Result<RelayOutcome, PhoneSetupError>>,
        shutdown: tokio_util::sync::CancellationToken,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.shutdown.cancel();
        }
    }

    fn start() -> Running {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let clock = ManualClock::new(Timestamp::from_unix_millis(1_800_000_000_000).unwrap());
        let stores = Arc::new(Stores::default());
        let (script, outcomes) = mpsc::unbounded_channel();
        let relay = Arc::new(ScriptedRelay {
            address: RelayAddress::default(),
            outcomes: tokio::sync::Mutex::new(outcomes),
            codes: Mutex::default(),
        });
        let core = PlayerCore::new(Dependencies { state, clock })
            .pairing(stores.clone(), stores.clone())
            .with_phone_setup(relay.clone());
        let host = Arc::new(Host::default());
        let shutdown = tokio_util::sync::CancellationToken::new();
        let (task_core, task_host, task_shutdown) = (core.clone(), host.clone(), shutdown.clone());
        tokio::spawn(async move {
            let wake = tokio::sync::Notify::new();
            task_core.run("test", &*task_host, &wake, &task_shutdown).await;
        });
        Running { _dir: dir, core, stores, host, relay, script, shutdown }
    }

    async fn until<T>(host: &Host, mut found: impl FnMut(&Host) -> Option<T>) -> T {
        for _ in 0..2000 {
            if let Some(value) = found(host) {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out; statuses: {:?}", host.statuses());
    }

    fn ready_url(host: &Host) -> Option<(String, bool)> {
        match host.last_phone() {
            Some(PhoneSetupView::Ready { url, rejected }) => Some((url, rejected)),
            _ => None,
        }
    }

    #[tokio::test]
    async fn a_delivered_address_starts_pairing() {
        let running = start();
        let server = server().await;
        let (url, rejected) = until(&running.host, ready_url).await;
        assert!(!rejected);
        assert!(url.starts_with("https://setup.tilecast.org/#v=1&r="));
        let envelope = seal(&url, serde_json::json!({"serverUrl": server, "installationId": installation()}));
        running.script.send(Ok(RelayOutcome::Envelope(envelope))).unwrap();
        until(&running.host, |host| {
            matches!(host.statuses().last(), Some(PairingStatus::Waiting { .. })).then_some(())
        })
        .await;
        assert_eq!(running.stores.session.lock().unwrap().as_ref().map(|s| s.code.clone()), Some("ABC123".into()));
        assert!(!running.core.phone_active());
    }

    #[tokio::test]
    async fn an_address_for_another_installation_is_rejected_with_a_new_code() {
        let running = start();
        let server = server().await;
        let (url, _) = until(&running.host, ready_url).await;
        let other = InstallationId::from_uuid(uuid::Uuid::from_u128(2));
        let envelope = seal(&url, serde_json::json!({"serverUrl": server, "installationId": other}));
        running.script.send(Ok(RelayOutcome::Envelope(envelope))).unwrap();
        let (next, rejected) = until(&running.host, |host| ready_url(host).filter(|(next, _)| *next != url)).await;
        assert!(rejected);
        assert_ne!(next, url);
        assert!(running.stores.session.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn an_expired_code_is_replaced() {
        let running = start();
        let (url, _) = until(&running.host, ready_url).await;
        running.script.send(Ok(RelayOutcome::Expired)).unwrap();
        let (next, rejected) = until(&running.host, |host| ready_url(host).filter(|(next, _)| *next != url)).await;
        assert!(!rejected);
        assert_ne!(next, url);
        let codes = running.relay.codes.lock().unwrap().clone();
        assert_eq!(codes.len(), 2);
        assert_ne!(codes[0], codes[1]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unreachable_relay_hides_the_code_and_retries() {
        let running = start();
        until(&running.host, ready_url).await;
        running.script.send(Err(PhoneSetupError::Network)).unwrap();
        until(&running.host, |host| (host.last_phone() == Some(PhoneSetupView::Unavailable)).then_some(())).await;
        tokio::time::sleep(FIRST_BACKOFF).await;
        until(&running.host, ready_url).await;
        assert_eq!(running.relay.codes.lock().unwrap().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_resume_during_paused_publication_starts_a_new_session() {
        let running = start();
        let (first, _) = until(&running.host, ready_url).await;
        *running.host.resume_on_pause.lock().unwrap() = Some(running.core.clone());
        tokio::time::sleep(SESSION_LIMIT).await;
        until(&running.host, |host| ready_url(host).filter(|(next, _)| *next != first)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_pauses_after_its_limit_and_resumes_on_request() {
        let running = start();
        let (first, _) = until(&running.host, ready_url).await;
        tokio::time::sleep(SESSION_LIMIT).await;
        until(&running.host, |host| (host.last_phone() == Some(PhoneSetupView::Paused)).then_some(())).await;
        let codes = running.relay.codes.lock().unwrap().len();
        tokio::time::sleep(Duration::from_secs(4 * 3600)).await;
        assert_eq!(running.relay.codes.lock().unwrap().len(), codes, "a paused session leaves the relay alone");
        running.core.resume_phone_setup();
        let (next, _) = until(&running.host, |host| ready_url(host).filter(|(next, _)| *next != first)).await;
        assert_ne!(next, first);
    }

    #[tokio::test]
    async fn a_typed_address_ends_the_phone_session() {
        let running = start();
        let server = server().await;
        until(&running.host, ready_url).await;
        running.core.begin(&server, "test", &*running.host).await.unwrap();
        let shown = running.host.statuses().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let after = running.host.statuses();
        assert!(matches!(after[shown - 1], PairingStatus::Waiting { .. }));
        assert!(
            after[shown..].iter().all(|status| !matches!(status, PairingStatus::Setup { .. })),
            "the setup surface must not return over the pairing code: {after:?}"
        );
        assert!(!running.core.phone_active());
    }
}
