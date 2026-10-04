//! Native pairing policy. Hosts own private stores, device facts, and surfaces.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use async_trait::async_trait;
use player_client::pairing::{DeviceMetadata, Enrolled, PollStatus};
use player_client::{CredentialStore, PairingSession, PairingStore, ServerClient, ServerError, ServerIdentity};
use player_state::repo::{
    binding::{self, CredentialState, ServerBinding},
    daemon,
};
use player_types::PlayerId;

use crate::Dependencies;

pub const PAIRING_RETRY: Duration = Duration::from_secs(5);
const ENROLL_ATTEMPTS: u32 = 10;

#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error("local state is unavailable")]
    LocalStateUnavailable,
    #[error("the Player is already paired")]
    AlreadyPaired,
    #[error("pairing is disabled")]
    PairingDisabled,
    #[error("the pairing session could not be stored")]
    SessionNotStored,
    #[error(transparent)]
    Server(#[from] ServerError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingOutcome {
    Enrolled,
    Replace(String),
    Retry,
}

/// Device facts are collected only after public installation identity answers.
#[async_trait]
pub trait PairingMetadataProvider: Send + Sync {
    async fn metadata(&self, player: PlayerId) -> DeviceMetadata;
}

/// Semantic pairing state. Hosts construct their own Runtime status payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingStatus {
    Paired,
    Enrolled,
    Setup,
    AddressRejected,
    Reset,
    Waiting { code: String, approval_url: String, organization_name: Option<String> },
    Renewing { reason: String },
}

#[async_trait]
pub trait PairingHost: PairingMetadataProvider {
    async fn show_pairing(&self, status: PairingStatus);
}

#[derive(Debug, Default)]
struct Control {
    suppressed: AtomicBool,
    renewal: Mutex<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct PairingCoordinator {
    dependencies: Dependencies,
    credentials: Arc<dyn CredentialStore>,
    sessions: Arc<dyn PairingStore>,
    control: Arc<Control>,
}

impl PairingCoordinator {
    pub fn new(
        dependencies: Dependencies,
        credentials: Arc<dyn CredentialStore>,
        sessions: Arc<dyn PairingStore>,
    ) -> Self {
        Self { dependencies, credentials, sessions, control: Arc::new(Control::default()) }
    }

    pub async fn begin(&self, url: &str, user_agent: &str, host: &impl PairingHost) -> Result<(), PairingError> {
        self.may_pair().await?;
        self.control.suppressed.store(false, Ordering::Release);
        let client = ServerClient::new(url, user_agent)?;
        let session = self.create_session(&client, host).await?;
        tracing::info!(component = "pairing", event = "session_created", server = %client.base_url());
        self.show_session(host, &session).await;
        Ok(())
    }

    pub async fn reset(&self, host: &impl PairingHost) {
        self.control.suppressed.store(true, Ordering::Release);
        self.take_renewal();
        let _ = self.sessions.remove();
        host.show_pairing(PairingStatus::Reset).await;
    }

    async fn show_session(&self, host: &impl PairingHost, session: &PairingSession) {
        host.show_pairing(PairingStatus::Waiting {
            code: session.code.clone(),
            approval_url: session.approval_url.clone(),
            organization_name: session.organization_name.clone(),
        })
        .await;
    }

    fn renew_later(&self, url: &str) {
        *self.control.renewal.lock().unwrap_or_else(|error| error.into_inner()) = Some(url.to_owned());
    }

    fn take_renewal(&self) -> Option<String> {
        self.control.renewal.lock().unwrap_or_else(|error| error.into_inner()).take()
    }

    /// Run one reconciliation pass; return the existing protocol's next delay.
    pub async fn reconcile(&self, user_agent: &str, host: &impl PairingHost) -> Duration {
        let mut delay = None;
        match self.may_pair().await {
            Err(_) => host.show_pairing(PairingStatus::Paired).await,
            Ok(bound) => match self.sessions.load() {
                Ok(Some(session)) => {
                    self.show_session(host, &session).await;
                    let interval = Duration::from_secs(u64::from(session.polling_interval_seconds));
                    let server_url = session.server_url.clone();
                    let outcome = match ServerClient::new(&server_url, user_agent) {
                        Ok(client) => self.step(&client, session).await,
                        Err(_) => PairingOutcome::Replace("server_url_rejected".to_owned()),
                    };
                    match outcome {
                        PairingOutcome::Enrolled => host.show_pairing(PairingStatus::Enrolled).await,
                        PairingOutcome::Retry => delay = Some(interval),
                        PairingOutcome::Replace(reason) => {
                            tracing::info!(component = "pairing", event = "session_ended", reason = reason.as_str());
                            let _ = self.sessions.remove();
                            host.show_pairing(PairingStatus::Renewing { reason }).await;
                            match ServerClient::new(&server_url, user_agent) {
                                Ok(client) => {
                                    delay = Some(Duration::ZERO);
                                    if self.create_session(&client, host).await.is_err() {
                                        tracing::warn!(
                                            component = "pairing",
                                            event = "renewal_failed",
                                            reason = "session_creation_failed"
                                        );
                                        delay = Some(PAIRING_RETRY);
                                        self.renew_later(&server_url);
                                    }
                                }
                                Err(_) => host.show_pairing(PairingStatus::AddressRejected).await,
                            }
                        }
                    }
                }
                Ok(None) => match bound.filter(|record| record.credential_state != CredentialState::Stored) {
                    Some(record) if !self.control.suppressed.load(Ordering::Acquire) => {
                        if self.begin(&record.server_url, user_agent, host).await.is_err() {
                            delay = Some(PAIRING_RETRY * 6);
                        }
                    }
                    _ => {
                        if let Some(url) = self.take_renewal() {
                            if self.begin(&url, user_agent, host).await.is_err() {
                                self.renew_later(&url);
                                delay = Some(PAIRING_RETRY);
                            }
                        } else {
                            host.show_pairing(PairingStatus::Setup).await;
                        }
                    }
                },
                Err(error) => {
                    tracing::error!(component = "pairing", event = "session_unreadable", error = %error);
                    let _ = self.sessions.remove();
                    delay = Some(PAIRING_RETRY);
                }
            },
        }
        delay.unwrap_or(Duration::from_secs(3600))
    }

    pub async fn run(
        &self,
        user_agent: &str,
        host: &impl PairingHost,
        wake: &tokio::sync::Notify,
        shutdown: &tokio_util::sync::CancellationToken,
    ) {
        loop {
            let wait = self.reconcile(user_agent, host).await;
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = wake.notified() => {}
                () = tokio::time::sleep(wait) => {}
            }
        }
    }

    /// A binding alone is insufficient: there must also be a usable credential.
    pub async fn may_pair(&self) -> Result<Option<ServerBinding>, PairingError> {
        let bound = self
            .dependencies
            .state
            .run(|connection| binding::get(connection))
            .await
            .map_err(|_| PairingError::LocalStateUnavailable)?;
        let present = self.credentials.load().ok().flatten().is_some();
        match &bound {
            Some(record) if record.credential_state == CredentialState::Stored && present => {
                Err(PairingError::AlreadyPaired)
            }
            _ => Ok(bound),
        }
    }

    async fn player_id(&self) -> Result<PlayerId, PairingError> {
        let now = self.dependencies.clock.now();
        self.dependencies
            .state
            .run(move |connection| {
                if let Some(identity) = daemon::player_identity(connection)? {
                    return Ok(identity.player_id);
                }
                let id = PlayerId::from_uuid(uuid::Uuid::new_v4());
                daemon::set_player_identity(connection, id, daemon::PlayerIdentitySource::Generated, now)?;
                Ok(id)
            })
            .await
            .map_err(|_| PairingError::LocalStateUnavailable)
    }

    pub async fn create_session(
        &self,
        client: &ServerClient,
        metadata: &impl PairingMetadataProvider,
    ) -> Result<PairingSession, PairingError> {
        self.create_with(client, metadata).await
    }

    async fn create_with(
        &self,
        client: &impl PairingApi,
        metadata: &impl PairingMetadataProvider,
    ) -> Result<PairingSession, PairingError> {
        let identity = client.identity().await?;
        if !identity.pairing_enabled {
            return Err(PairingError::PairingDisabled);
        }
        let player = self.player_id().await?;
        let metadata = metadata.metadata(player).await;
        let session = client.create(identity.installation_id, &metadata).await?;
        self.sessions.save(&session).map_err(|_| PairingError::SessionNotStored)?;
        Ok(session)
    }

    pub async fn step(&self, client: &ServerClient, session: PairingSession) -> PairingOutcome {
        self.step_with(client, session).await
    }

    async fn step_with(&self, client: &impl PairingApi, session: PairingSession) -> PairingOutcome {
        let session = if session.has_enrollment_token() {
            session
        } else {
            if session.is_expired(self.dependencies.clock.now()) {
                return PairingOutcome::Replace("expired".to_owned());
            }
            match client.poll(&session).await {
                Ok(PollStatus::Waiting) => return PairingOutcome::Retry,
                Ok(PollStatus::Claimed(token)) => {
                    let claimed = session.with_enrollment_token(token);
                    // Preserve the existing enrollment policy, including logging
                    // a failed token write before trying the claimed token.
                    if self.sessions.save(&claimed).is_err() {
                        tracing::error!(component = "pairing", event = "token_not_stored");
                    }
                    claimed
                }
                Ok(PollStatus::TokenLost) => return PairingOutcome::Replace("enrollment_token_lost".to_owned()),
                Ok(PollStatus::Ended(reason)) => return PairingOutcome::Replace(reason),
                Err(error) => {
                    tracing::warn!(component = "pairing", event = "poll_failed", reason = error.reason_code());
                    return PairingOutcome::Retry;
                }
            }
        };
        for attempt in 0..ENROLL_ATTEMPTS {
            match client.enroll(&session).await {
                Ok(enrolled) => {
                    if self.credentials.save(&enrolled.credential).is_err() {
                        tracing::error!(component = "pairing", event = "credential_not_stored");
                        return PairingOutcome::Retry;
                    }
                    let now = self.dependencies.clock.now();
                    let record = ServerBinding {
                        server_url: session.server_url.clone(),
                        installation_id: session.installation_id,
                        organization_name: session.organization_name.clone(),
                        screen_id: Some(enrolled.screen_id),
                        screen_name: Some(enrolled.screen_name.clone()),
                        credential_state: CredentialState::Stored,
                        identity_verified_at: Some(now),
                        bound_at: now,
                    };
                    if self
                        .dependencies
                        .state
                        .run(move |connection| binding::put(connection, &record, now))
                        .await
                        .is_err()
                    {
                        return PairingOutcome::Retry;
                    }
                    let _ = self.sessions.remove();
                    tracing::info!(component = "pairing", event = "enrolled", screen = %enrolled.screen_id);
                    return PairingOutcome::Enrolled;
                }
                Err(ServerError::Network) if attempt + 1 < ENROLL_ATTEMPTS => tokio::time::sleep(PAIRING_RETRY).await,
                Err(error) => {
                    tracing::warn!(component = "pairing", event = "enrollment_refused", reason = error.reason_code());
                    return PairingOutcome::Replace("enrollment_failed".to_owned());
                }
            }
        }
        PairingOutcome::Replace("enrollment_failed".to_owned())
    }
}

#[async_trait]
trait PairingApi: Send + Sync {
    async fn identity(&self) -> Result<ServerIdentity, ServerError>;
    async fn create(
        &self,
        installation: player_types::InstallationId,
        metadata: &DeviceMetadata,
    ) -> Result<PairingSession, ServerError>;
    async fn poll(&self, session: &PairingSession) -> Result<PollStatus, ServerError>;
    async fn enroll(&self, session: &PairingSession) -> Result<Enrolled, ServerError>;
}

#[async_trait]
impl PairingApi for ServerClient {
    async fn identity(&self) -> Result<ServerIdentity, ServerError> {
        ServerClient::identity(self).await
    }
    async fn create(
        &self,
        installation: player_types::InstallationId,
        metadata: &DeviceMetadata,
    ) -> Result<PairingSession, ServerError> {
        self.create_pairing_session(installation, metadata).await
    }
    async fn poll(&self, session: &PairingSession) -> Result<PollStatus, ServerError> {
        self.poll_pairing(session).await
    }
    async fn enroll(&self, session: &PairingSession) -> Result<Enrolled, ServerError> {
        ServerClient::enroll(self, session).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_client::pairing::PairingFileError;
    use player_client::{CredentialError, DeviceCredential};
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, ScreenId, Timestamp, time::ManualClock};
    use std::collections::VecDeque;
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };

    #[derive(Debug)]
    struct Stores {
        state: StateDb,
        events: Mutex<Vec<&'static str>>,
        credential: Mutex<Option<DeviceCredential>>,
        session: Mutex<Option<PairingSession>>,
        fail_credential: AtomicBool,
        fail_session: AtomicBool,
    }
    impl CredentialStore for Stores {
        fn load(&self) -> Result<Option<DeviceCredential>, CredentialError> {
            Ok(self.credential.lock().unwrap().clone())
        }
        fn save(&self, credential: &DeviceCredential) -> Result<(), CredentialError> {
            self.events.lock().unwrap().push("credential");
            if self.fail_credential.load(Ordering::Relaxed) {
                return Err(CredentialError::Permissions);
            }
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
            self.events.lock().unwrap().push(if session.has_enrollment_token() { "token" } else { "session" });
            if self.fail_session.load(Ordering::Relaxed) {
                return Err(PairingFileError::Permissions);
            }
            *self.session.lock().unwrap() = Some(session.clone());
            Ok(())
        }
        fn remove(&self) -> Result<(), PairingFileError> {
            // The session is never retired before credential and binding persist.
            assert!(self.credential.lock().unwrap().is_some());
            let bound = self.state.run_blocking(|c| binding::get(c)).unwrap().unwrap();
            assert_eq!(bound.credential_state, CredentialState::Stored);
            self.events.lock().unwrap().push("remove");
            self.session.lock().unwrap().take();
            Ok(())
        }
    }
    #[async_trait]
    impl PairingMetadataProvider for Stores {
        async fn metadata(&self, player: PlayerId) -> DeviceMetadata {
            self.events.lock().unwrap().push("metadata");
            let stored = self.state.run_blocking(|c| daemon::player_identity(c)).unwrap().unwrap();
            assert_eq!(stored.player_id, player);
            DeviceMetadata::new(*player.as_uuid(), "test", "test", "test", "test", "test", (1920, 1080), "en-US", "UTC")
        }
    }
    struct Api {
        stores: Arc<Stores>,
        enabled: AtomicBool,
        polls: Mutex<VecDeque<Result<PollStatus, ServerError>>>,
        enrollments: Mutex<VecDeque<Result<Enrolled, ServerError>>>,
    }
    #[async_trait]
    impl PairingApi for Api {
        async fn identity(&self) -> Result<ServerIdentity, ServerError> {
            self.stores.events.lock().unwrap().push("identity");
            Ok(ServerIdentity {
                product: "tilecast".into(),
                installation_id: installation(),
                organization_name: "Library".into(),
                api_version: "v1".into(),
                pairing_enabled: self.enabled.load(Ordering::Relaxed),
            })
        }
        async fn create(&self, id: InstallationId, _: &DeviceMetadata) -> Result<PairingSession, ServerError> {
            assert_eq!(id, installation());
            self.stores.events.lock().unwrap().push("create");
            Ok(session())
        }
        async fn poll(&self, _: &PairingSession) -> Result<PollStatus, ServerError> {
            self.stores.events.lock().unwrap().push("poll");
            self.polls.lock().unwrap().pop_front().unwrap_or(Ok(PollStatus::Waiting))
        }
        async fn enroll(&self, session: &PairingSession) -> Result<Enrolled, ServerError> {
            assert!(session.has_enrollment_token());
            self.stores.events.lock().unwrap().push("enroll");
            self.enrollments.lock().unwrap().pop_front().unwrap_or_else(|| {
                Ok(Enrolled {
                    screen_id: ScreenId::from_uuid(uuid::Uuid::from_u128(2)),
                    screen_name: "Lobby".into(),
                    credential: DeviceCredential::parse(&format!("tc_device_{}.{}", "0".repeat(26), "s".repeat(43)))
                        .unwrap(),
                })
            })
        }
    }
    fn installation() -> InstallationId {
        InstallationId::from_uuid(uuid::Uuid::from_u128(1))
    }
    fn session() -> PairingSession {
        serde_json::from_value(serde_json::json!({
            "serverUrl":"https://signs.example.org", "installationId":installation(),
            "sessionId":uuid::Uuid::from_u128(3), "pollSecret":"p".repeat(43), "code":"ABC123",
            "approvalUrl":"https://signs.example.org/screens/pair", "organizationName":"Library",
            "expiresAt":Timestamp::from_unix_millis(1_800_000_010_000).unwrap(), "pollingIntervalSeconds":2
        }))
        .unwrap()
    }
    fn fixture() -> (tempfile::TempDir, PairingCoordinator, Arc<Stores>, Api) {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let stores = Arc::new(Stores {
            state: state.clone(),
            events: Mutex::new(vec![]),
            credential: Mutex::new(None),
            session: Mutex::new(Some(session())),
            fail_credential: AtomicBool::new(false),
            fail_session: AtomicBool::new(false),
        });
        let core = PlayerCoreForTest::new(Dependencies {
            state,
            clock: ManualClock::new(Timestamp::from_unix_millis(1_800_000_000_000).unwrap()),
        });
        let pairing = core.pairing(stores.clone(), stores.clone());
        let api = Api {
            stores: stores.clone(),
            enabled: AtomicBool::new(true),
            polls: Mutex::new(VecDeque::new()),
            enrollments: Mutex::new(VecDeque::new()),
        };
        (dir, pairing, stores, api)
    }
    use crate::PlayerCore as PlayerCoreForTest;

    #[derive(Debug, Default)]
    struct Sessions(Mutex<Option<PairingSession>>);

    impl PairingStore for Sessions {
        fn load(&self) -> Result<Option<PairingSession>, PairingFileError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, session: &PairingSession) -> Result<(), PairingFileError> {
            *self.0.lock().unwrap() = Some(session.clone());
            Ok(())
        }
        fn remove(&self) -> Result<(), PairingFileError> {
            self.0.lock().unwrap().take();
            Ok(())
        }
    }

    #[derive(Default)]
    struct Host(Mutex<Vec<PairingStatus>>);

    #[async_trait]
    impl PairingMetadataProvider for Host {
        async fn metadata(&self, _: PlayerId) -> DeviceMetadata {
            panic!("a rejected address must not collect device metadata")
        }
    }

    #[async_trait]
    impl PairingHost for Host {
        async fn show_pairing(&self, status: PairingStatus) {
            self.0.lock().unwrap().push(status);
        }
    }

    #[tokio::test]
    async fn reset_suppresses_repair_until_an_explicit_pairing_attempt() {
        let (_dir, core, stores, _) = fixture();
        let sessions = Arc::new(Sessions(Mutex::new(Some(session()))));
        let core = PairingCoordinator::new(core.dependencies, stores.clone(), sessions.clone());
        let now = core.dependencies.clock.now();
        stores
            .state
            .run(move |connection| {
                binding::put(
                    connection,
                    &ServerBinding {
                        server_url: "http://public.example.org".to_owned(),
                        installation_id: installation(),
                        organization_name: None,
                        screen_id: None,
                        screen_name: None,
                        credential_state: CredentialState::Rejected,
                        identity_verified_at: None,
                        bound_at: now,
                    },
                    now,
                )
            })
            .await
            .unwrap();
        let host = Host::default();
        core.renew_later("https://unused.example.org");
        core.reset(&host).await;
        assert!(sessions.load().unwrap().is_none());
        assert!(core.take_renewal().is_none());
        assert_eq!(core.reconcile("test", &host).await, Duration::from_secs(3600));
        assert_eq!(*host.0.lock().unwrap(), vec![PairingStatus::Reset, PairingStatus::Setup]);
        assert!(matches!(
            core.begin("http://public.example.org", "test", &host).await,
            Err(PairingError::Server(ServerError::Url(_)))
        ));
        assert_eq!(core.reconcile("test", &host).await, Duration::from_secs(30));
        assert!(stores.state.run(|connection| daemon::player_identity(connection)).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn public_identity_precedes_metadata_and_persistent_player_identity() {
        let (_dir, core, stores, api) = fixture();
        api.enabled.store(false, Ordering::Relaxed);
        assert!(matches!(core.create_with(&api, stores.as_ref()).await, Err(PairingError::PairingDisabled)));
        assert_eq!(*stores.events.lock().unwrap(), vec!["identity"]);
        assert!(stores.state.run(|c| daemon::player_identity(c)).await.unwrap().is_none());
        api.enabled.store(true, Ordering::Relaxed);
        stores.events.lock().unwrap().clear();
        core.create_with(&api, stores.as_ref()).await.unwrap();
        assert_eq!(*stores.events.lock().unwrap(), vec!["identity", "metadata", "create", "session"]);
        let first = stores.state.run(|c| daemon::player_identity(c)).await.unwrap().unwrap();
        core.create_with(&api, stores.as_ref()).await.unwrap();
        assert_eq!(stores.state.run(|c| daemon::player_identity(c)).await.unwrap().unwrap(), first);
        stores.fail_session.store(true, Ordering::Relaxed);
        assert!(matches!(core.create_with(&api, stores.as_ref()).await, Err(PairingError::SessionNotStored)));
    }

    #[tokio::test]
    async fn enrollment_retires_session_only_after_credential_and_binding() {
        let (_dir, core, stores, api) = fixture();
        api.polls.lock().unwrap().push_back(Ok(PollStatus::Claimed("t".repeat(43))));
        assert_eq!(core.step_with(&api, session()).await, PairingOutcome::Enrolled);
        assert_eq!(*stores.events.lock().unwrap(), vec!["poll", "token", "enroll", "credential", "remove"]);
        assert!(stores.session.lock().unwrap().is_none());
        let bound = stores.state.run(|c| binding::get(c)).await.unwrap().unwrap();
        assert_eq!(bound.installation_id, installation());
        assert_eq!(bound.screen_name.as_deref(), Some("Lobby"));
        assert!(matches!(core.may_pair().await, Err(PairingError::AlreadyPaired)));
        stores.credential.lock().unwrap().take();
        assert!(core.may_pair().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn saved_token_resumes_after_expiry_without_polling_again() {
        let (_dir, core, stores, api) = fixture();
        let mut expired = session();
        expired.expires_at = Timestamp::from_unix_millis(1_799_999_999_999).unwrap();
        assert_eq!(core.step_with(&api, expired.clone()).await, PairingOutcome::Replace("expired".into()));
        assert!(stores.events.lock().unwrap().is_empty());
        let claimed = expired.with_enrollment_token("t".repeat(43));
        *stores.session.lock().unwrap() = Some(claimed.clone());
        assert_eq!(core.step_with(&api, claimed).await, PairingOutcome::Enrolled);
        assert_eq!(*stores.events.lock().unwrap(), vec!["enroll", "credential", "remove"]);
    }

    #[tokio::test]
    async fn credential_write_failure_keeps_the_claim_and_does_not_bind() {
        let (_dir, core, stores, api) = fixture();
        stores.fail_credential.store(true, Ordering::Relaxed);
        api.polls.lock().unwrap().push_back(Ok(PollStatus::Claimed("t".repeat(43))));
        assert_eq!(core.step_with(&api, session()).await, PairingOutcome::Retry);
        assert!(stores.session.lock().unwrap().as_ref().unwrap().has_enrollment_token());
        assert!(stores.credential.lock().unwrap().is_none());
        assert!(stores.state.run(|c| binding::get(c)).await.unwrap().is_none());
        assert_eq!(*stores.events.lock().unwrap(), vec!["poll", "token", "enroll", "credential"]);
    }

    #[tokio::test(start_paused = true)]
    async fn enrollment_retries_only_network_failures_with_the_existing_budget() {
        let (_dir, core, stores, api) = fixture();
        api.enrollments.lock().unwrap().extend((0..ENROLL_ATTEMPTS).map(|_| Err(ServerError::Network)));
        let claimed = session().with_enrollment_token("t".repeat(43));
        let start = tokio::time::Instant::now();
        assert_eq!(core.step_with(&api, claimed.clone()).await, PairingOutcome::Replace("enrollment_failed".into()));
        assert_eq!(start.elapsed(), PAIRING_RETRY * (ENROLL_ATTEMPTS - 1));
        assert_eq!(stores.events.lock().unwrap().iter().filter(|&&e| e == "enroll").count(), ENROLL_ATTEMPTS as usize);
        stores.events.lock().unwrap().clear();
        api.enrollments.lock().unwrap().push_back(Err(ServerError::Api {
            status: 500,
            code: "server_error".into(),
            message: "".into(),
        }));
        assert_eq!(core.step_with(&api, claimed).await, PairingOutcome::Replace("enrollment_failed".into()));
        assert_eq!(*stores.events.lock().unwrap(), vec!["enroll"]);
    }

    #[tokio::test]
    async fn polling_waits_and_server_verdicts_do_not_attempt_enrollment() {
        let (_dir, core, stores, api) = fixture();
        for (reply, outcome) in [
            (Ok(PollStatus::Waiting), PairingOutcome::Retry),
            (Err(ServerError::Network), PairingOutcome::Retry),
            (Ok(PollStatus::TokenLost), PairingOutcome::Replace("enrollment_token_lost".into())),
            (Ok(PollStatus::Ended("rejected".into())), PairingOutcome::Replace("rejected".into())),
        ] {
            stores.events.lock().unwrap().clear();
            api.polls.lock().unwrap().push_back(reply);
            assert_eq!(core.step_with(&api, session()).await, outcome);
            assert_eq!(*stores.events.lock().unwrap(), vec!["poll"]);
        }
    }
}
