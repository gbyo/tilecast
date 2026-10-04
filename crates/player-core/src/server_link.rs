//! Native server relationship and retry policy. Hosts own private storage.
use std::sync::Arc;
use std::time::{Duration, Instant};

use player_client::{AuthenticatedServer, CredentialStore, ServerClient, ServerError};
use player_state::repo::{
    binding::{self, CredentialState, ServerBinding},
    playback,
};
use player_types::Timestamp;

use crate::Dependencies;

pub const SERVER_RETRY_BASE: Duration = Duration::from_secs(2);
pub const SERVER_MAX_RETRY: Duration = Duration::from_secs(300);
pub const SERVER_HEALTHY_RESET: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerLinkState {
    Unbound,
    CredentialMissing,
    CredentialRejected,
    IdentityMismatch,
    Connected,
    Retrying(&'static str),
}

impl ServerLinkState {
    pub fn state_token(&self) -> &'static str {
        match self {
            Self::Unbound => "unbound",
            Self::Connected => "connected",
            Self::Retrying(_) => "retrying",
            Self::CredentialMissing | Self::CredentialRejected | Self::IdentityMismatch => "stopped",
        }
    }

    pub fn reason_code(&self) -> Option<&'static str> {
        match self {
            Self::Unbound => Some("not_bound"),
            Self::CredentialMissing => Some("device_credential_missing"),
            Self::CredentialRejected => Some("device_credential_rejected"),
            Self::IdentityMismatch => Some("installation_identity_mismatch"),
            Self::Connected => None,
            Self::Retrying(code) => Some(code),
        }
    }

    pub fn from_error(error: &ServerError) -> Self {
        match error {
            ServerError::IdentityMismatch { .. } => Self::IdentityMismatch,
            ServerError::CredentialRejected => Self::CredentialRejected,
            other => Self::Retrying(other.reason_code()),
        }
    }
}

/// Host randomness chooses jitter; Core owns the reference retry budget.
pub fn server_retry_delay(failures: u32, unit: f64) -> Duration {
    let base = SERVER_RETRY_BASE.as_millis() as u64;
    let exponent = failures.max(1).saturating_sub(1).min(16);
    let ceiling = base.saturating_mul(1 << exponent).min(SERVER_MAX_RETRY.as_millis() as u64);
    let floor = (base / 2).min(ceiling);
    let jitter = ((ceiling - floor) as f64 * unit.clamp(0.0, 1.0)) as u64;
    Duration::from_millis(floor + jitter.min(ceiling - floor))
}

#[derive(Debug, Default)]
pub struct ServerBackoff {
    failures: u32,
    connected_at: Option<Instant>,
}

impl ServerBackoff {
    pub fn connected(&mut self, now: Instant) {
        self.connected_at.get_or_insert(now);
    }

    pub fn failed(&mut self, now: Instant, jitter: f64) -> Duration {
        if self.connected_at.take().is_some_and(|at| now.duration_since(at) >= SERVER_HEALTHY_RESET) {
            self.failures = 0;
        }
        self.failures = self.failures.saturating_add(1);
        server_retry_delay(self.failures, jitter)
    }
}

#[derive(Debug, Clone)]
pub struct ServerRelationship {
    dependencies: Dependencies,
    credentials: Arc<dyn CredentialStore>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerRelationshipError {
    Unavailable(ServerLinkState),
    Client(ServerError),
    Identity(ServerError),
}

impl ServerRelationshipError {
    pub fn state(&self) -> ServerLinkState {
        match self {
            Self::Unavailable(state) => state.clone(),
            Self::Client(error) | Self::Identity(error) => ServerLinkState::from_error(error),
        }
    }
}

impl ServerRelationship {
    pub fn new(dependencies: Dependencies, credentials: Arc<dyn CredentialStore>) -> Self {
        Self { dependencies, credentials }
    }

    /// Only a public installation identity match yields an authenticated client.
    pub async fn verify(
        &self,
        user_agent: &str,
    ) -> Result<(ServerBinding, AuthenticatedServer), ServerRelationshipError> {
        let Ok(Some(bound)) = self.dependencies.state.run(|connection| binding::get(connection)).await else {
            return Err(ServerRelationshipError::Unavailable(ServerLinkState::Unbound));
        };
        if bound.credential_state == CredentialState::Rejected {
            return Err(ServerRelationshipError::Unavailable(ServerLinkState::CredentialRejected));
        }
        let credential = match self.credentials.load() {
            Ok(Some(credential)) => credential,
            Ok(None) => return Err(ServerRelationshipError::Unavailable(ServerLinkState::CredentialMissing)),
            Err(error) => {
                tracing::error!(component = "server", event = "credential_unreadable", error = %error);
                return Err(ServerRelationshipError::Unavailable(ServerLinkState::CredentialMissing));
            }
        };
        let client = ServerClient::new(&bound.server_url, user_agent).map_err(ServerRelationshipError::Client)?;
        let server = client.verify_installation(bound.installation_id, credential).await.map_err(|error| {
            if matches!(error, ServerError::IdentityMismatch { .. }) {
                tracing::error!(component = "server", event = "identity_mismatch", error = %error);
            }
            ServerRelationshipError::Identity(error)
        })?;
        let now = self.dependencies.clock.now();
        let _ = self.dependencies.state.run(move |connection| binding::mark_identity_verified(connection, now)).await;
        Ok((bound, server))
    }

    /// Call only after an authenticated endpoint confirms invalid/revoked.
    pub async fn reject_credential(&self) {
        tracing::warn!(component = "server", event = "credential_rejected");
        let now = self.dependencies.clock.now();
        let _ = self
            .dependencies
            .state
            .run(move |connection| binding::set_credential_state(connection, CredentialState::Rejected, now))
            .await;
        let _ = self.credentials.remove();
    }

    /// Persist the policy-clock sample so cached scheduling survives a restart.
    pub async fn sample_clock(&self, timestamp: &str) {
        let Ok(server_time) = Timestamp::parse(timestamp) else { return };
        let received_at = self.dependencies.clock.now();
        let sample = server_time.unix_millis().saturating_sub(received_at.unix_millis());
        let coarse = !timestamp.contains('.');
        let _ = self
            .dependencies
            .state
            .run(move |connection| {
                let mut state = playback::get(connection)?;
                let stale = state
                    .server_clock_synchronized_at
                    .is_none_or(|at| received_at.unix_millis() - at.unix_millis() > 300_000);
                if let Some(offset) = refined_server_offset(state.server_clock_offset_ms, sample, coarse, stale) {
                    state.server_clock_offset_ms = Some(offset);
                    state.server_clock_synchronized_at = Some(received_at);
                    playback::put(connection, &state, received_at)?;
                }
                Ok(())
            })
            .await;
    }
}

pub fn refined_server_offset(current: Option<i64>, sample: i64, coarse: bool, stale: bool) -> Option<i64> {
    if coarse {
        return match current {
            Some(old) if (sample..=sample.saturating_add(1_000)).contains(&old) => None,
            _ => Some(sample.saturating_add(500)),
        };
    }
    match current {
        Some(old) if old.abs_diff(sample) < 250 && !stale => None,
        _ => Some(sample),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_client::{CredentialError, DeviceCredential};
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, time::ManualClock};
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };

    #[derive(Debug, Default)]
    struct Credentials {
        value: Mutex<Option<DeviceCredential>>,
        unreadable: AtomicBool,
        fail_remove: AtomicBool,
    }

    impl CredentialStore for Credentials {
        fn load(&self) -> Result<Option<DeviceCredential>, CredentialError> {
            if self.unreadable.load(Ordering::Relaxed) {
                return Err(CredentialError::Permissions);
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn save(&self, credential: &DeviceCredential) -> Result<(), CredentialError> {
            *self.value.lock().unwrap() = Some(credential.clone());
            Ok(())
        }
        fn remove(&self) -> Result<(), CredentialError> {
            if self.fail_remove.load(Ordering::Relaxed) {
                return Err(CredentialError::Permissions);
            }
            self.value.lock().unwrap().take();
            Ok(())
        }
    }

    fn fixture() -> (tempfile::TempDir, ServerRelationship, Arc<Credentials>, Arc<ManualClock>) {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let clock = ManualClock::new(Timestamp::parse("2026-10-04T12:00:00Z").unwrap());
        let credentials = Arc::new(Credentials::default());
        let relationship = ServerRelationship::new(Dependencies { state, clock: clock.clone() }, credentials.clone());
        (dir, relationship, credentials, clock)
    }

    async fn bind(relationship: &ServerRelationship) {
        let now = relationship.dependencies.clock.now();
        relationship
            .dependencies
            .state
            .run(move |connection| {
                binding::put(
                    connection,
                    &ServerBinding {
                        // Invalid public HTTP proves an unavailable credential cannot start transport.
                        server_url: "http://public.example.org".into(),
                        installation_id: InstallationId::from_uuid(uuid::Uuid::from_u128(1)),
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
    }

    #[tokio::test]
    async fn unavailable_and_rejected_credentials_never_start_identity_transport() {
        let (_dir, relationship, credentials, _) = fixture();
        assert_eq!(relationship.verify("test").await.unwrap_err().state(), ServerLinkState::Unbound);
        bind(&relationship).await;
        assert_eq!(relationship.verify("test").await.unwrap_err().state(), ServerLinkState::CredentialMissing);
        credentials.unreadable.store(true, Ordering::Relaxed);
        assert_eq!(relationship.verify("test").await.unwrap_err().state(), ServerLinkState::CredentialMissing);
        relationship.reject_credential().await;
        assert_eq!(relationship.verify("test").await.unwrap_err().state(), ServerLinkState::CredentialRejected);
    }

    #[tokio::test]
    async fn a_failed_private_file_removal_does_not_reuse_a_rejected_credential() {
        let (_dir, relationship, credentials, _) = fixture();
        bind(&relationship).await;
        let credential = DeviceCredential::parse(&format!("tc_device_{}.{}", "a".repeat(26), "b".repeat(43))).unwrap();
        credentials.save(&credential).unwrap();
        credentials.fail_remove.store(true, Ordering::Relaxed);
        relationship.reject_credential().await;
        assert!(credentials.load().unwrap().is_some());
        assert_eq!(relationship.verify("test").await.unwrap_err().state(), ServerLinkState::CredentialRejected);
        credentials.fail_remove.store(false, Ordering::Relaxed);
        relationship.reject_credential().await;
        assert!(credentials.load().unwrap().is_none());
    }

    #[tokio::test]
    async fn clock_samples_preserve_precision_and_survive_database_reopen() {
        let (dir, relationship, _, clock) = fixture();
        relationship.sample_clock("2026-10-04T12:00:00.040Z").await;
        let first = relationship.dependencies.state.run(|connection| playback::get(connection)).await.unwrap();
        assert_eq!(first.server_clock_offset_ms, Some(40));
        relationship.sample_clock("malformed").await;
        relationship.sample_clock("2026-10-04T12:00:00.100Z").await;
        relationship.sample_clock("2026-10-04T12:00:00Z").await;
        assert_eq!(relationship.dependencies.state.run(|connection| playback::get(connection)).await.unwrap(), first);
        clock.set(Timestamp::parse("2026-10-04T12:05:01Z").unwrap());
        relationship.sample_clock("2026-10-04T12:05:01.100Z").await;
        let reopened = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let persisted = reopened.run(|connection| playback::get(connection)).await.unwrap();
        assert_eq!(persisted.server_clock_offset_ms, Some(100));
        assert_eq!(persisted.server_clock_synchronized_at, Some(relationship.dependencies.clock.now()));
    }

    #[test]
    fn retry_streak_resets_only_after_a_healthy_connection() {
        let start = Instant::now();
        let mut backoff = ServerBackoff::default();
        for _ in 0..5 {
            backoff.failed(start, 0.5);
        }
        assert_eq!(backoff.failures, 5);
        backoff.connected(start);
        backoff.failed(start + Duration::from_secs(10), 0.5);
        assert_eq!(backoff.failures, 6);
        backoff.connected(start + Duration::from_secs(10));
        backoff.connected(start + Duration::from_secs(60));
        backoff.failed(start + Duration::from_secs(10) + SERVER_HEALTHY_RESET, 0.5);
        assert_eq!(backoff.failures, 1);
    }

    #[test]
    fn transient_failures_never_mean_credential_rejection() {
        for error in [
            ServerError::Network,
            ServerError::Decode,
            ServerError::ResponseTooLarge,
            ServerError::Api { status: 500, code: "server_error".into(), message: String::new() },
            ServerError::Api { status: 403, code: "screen_disabled".into(), message: String::new() },
        ] {
            assert!(matches!(ServerLinkState::from_error(&error), ServerLinkState::Retrying(_)));
        }
        assert_eq!(ServerLinkState::from_error(&ServerError::CredentialRejected), ServerLinkState::CredentialRejected);
    }
}
