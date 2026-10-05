//! The ordinary player pairing protocol (docs/player-protocol.md) for a
//! fresh installation.
//!
//! 1. The caller reads public installation identity and requires pairing to
//!    be enabled ([`crate::ServerClient::identity`]).
//! 2. [`crate::ServerClient::create_pairing_session`] creates a session with
//!    bounded device metadata. The visible six-character code may be shown;
//!    the private poll secret may not.
//! 3. [`crate::ServerClient::poll_pairing`] polls with
//!    `Authorization: Pairing <poll secret>`, never with the code.
//! 4. The first poll after approval returns a one-time enrollment token.
//! 5. [`crate::ServerClient::enroll`] exchanges it once for the device
//!    credential.
//!
//! The host keeps the session in its private pairing store, never in SQLite,
//! so it survives a restart without putting a secret in the state database.
//! The one-time token is written there before enrollment is tried,
//! so a crash between the approving poll and enrollment does not lose the
//! pairing. The stored session is removed on enrollment, expiry, rejection and reset.

use player_types::{InstallationId, ScreenId, Timestamp};
use serde::{Deserialize, Serialize};

use crate::client::{MAX_SMALL_JSON_BYTES, ServerClient, ServerError};
use crate::credential::DeviceCredential;

const MAX_TEXT: usize = 120;

/// Device metadata sent with a pairing request (`devices.DeviceMetadata`,
/// validated by the server to 1–120 characters per string).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceMetadata {
    pub player_installation_id: String,
    pub platform: String,
    pub manufacturer: String,
    pub model: String,
    /// The contract's field name; it carries the operating-system release.
    pub android_version: String,
    pub player_version: String,
    pub screen_width: u32,
    pub screen_height: u32,
    pub density: f32,
    pub locale: String,
    pub timezone: String,
}

fn field(value: &str, fallback: &str) -> String {
    let cleaned: String = value.chars().filter(|c| !c.is_control()).take(MAX_TEXT).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() { fallback.to_owned() } else { cleaned.to_owned() }
}

impl DeviceMetadata {
    /// Builds metadata the server accepts from whatever the host reports.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        player_installation_id: uuid::Uuid,
        platform: &str,
        manufacturer: &str,
        model: &str,
        os_release: &str,
        player_version: &str,
        screen: (u32, u32),
        locale: &str,
        timezone: &str,
    ) -> Self {
        Self {
            player_installation_id: player_installation_id.to_string(),
            platform: field(platform, "unknown"),
            manufacturer: field(manufacturer, "unknown"),
            model: field(model, "unknown"),
            android_version: field(os_release, "unknown"),
            player_version: field(player_version, "0.0.0"),
            screen_width: screen.0.clamp(1, 16_384),
            screen_height: screen.1.clamp(1, 16_384),
            density: 1.0,
            locale: field(locale, "en-US"),
            timezone: field(timezone, "UTC"),
        }
    }
}

/// A pairing session in progress. Holds the private poll secret and, after
/// approval, the one-time enrollment token; both are redacted in `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingSession {
    pub server_url: String,
    pub installation_id: InstallationId,
    pub session_id: uuid::Uuid,
    poll_secret: String,
    /// The visible code an administrator types in Studio.
    pub code: String,
    pub approval_url: String,
    #[serde(default)]
    pub organization_name: Option<String>,
    pub expires_at: Timestamp,
    /// The server's clock when the session was created, for the pairing
    /// countdown. Older saved sessions predate it.
    #[serde(default)]
    pub server_time: Option<String>,
    pub polling_interval_seconds: u32,
    #[serde(default)]
    enrollment_token: Option<String>,
}

impl std::fmt::Debug for PairingSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingSession")
            .field("server_url", &self.server_url)
            .field("installation_id", &self.installation_id)
            .field("session_id", &self.session_id)
            .field("code", &self.code)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PairingFileError {
    #[error("the pairing file must be a regular file readable only by its owner")]
    Permissions,
    #[error("the pairing file is malformed")]
    Format,
    #[error("pairing file error: {0}")]
    Io(String),
}

impl PairingSession {
    pub fn is_expired(&self, now: Timestamp) -> bool {
        self.expires_at.unix_millis() <= now.unix_millis()
    }

    pub fn has_enrollment_token(&self) -> bool {
        self.enrollment_token.is_some()
    }

    pub fn with_enrollment_token(mut self, token: String) -> Self {
        self.enrollment_token = Some(token);
        self
    }
}

/// What one poll says.
#[derive(Clone, PartialEq, Eq)]
pub enum PollStatus {
    /// Waiting for an administrator (`pending` or `approved`).
    Waiting,
    /// Approved and claimed by this poll: the one-time enrollment token.
    Claimed(String),
    /// Claimed by an earlier poll whose answer was lost: the token is gone.
    TokenLost,
    /// Rejected, expired or unknown to the server: a bounded reason.
    Ended(String),
}

impl std::fmt::Debug for PollStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Waiting => f.write_str("Waiting"),
            Self::Claimed(_) => f.write_str("Claimed([redacted])"),
            Self::TokenLost => f.write_str("TokenLost"),
            Self::Ended(reason) => write!(f, "Ended({reason})"),
        }
    }
}

/// The enrolled screen and its credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enrolled {
    pub screen_id: ScreenId,
    pub screen_name: String,
    pub credential: DeviceCredential,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    id: uuid::Uuid,
    code: String,
    poll_secret: String,
    expires_at: String,
    #[serde(default)]
    server_time: String,
    #[serde(default)]
    polling_interval_seconds: u32,
    #[serde(default)]
    approval_url: String,
    #[serde(default)]
    organization_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Poll {
    status: String,
    #[serde(default)]
    enrollment_token: Option<String>,
    #[serde(default)]
    failure_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Enrollment {
    screen_id: ScreenId,
    screen_name: String,
    device_credential: String,
}

fn bounded(value: &str, limit: usize) -> String {
    value.chars().filter(|c| !c.is_control()).take(limit).collect()
}

fn valid_secret(value: &str) -> bool {
    (16..=512).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_graphic())
}

impl ServerClient {
    async fn send_json<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, ServerError> {
        let response =
            request.timeout(crate::client::REQUEST_TIMEOUT).send().await.map_err(|_| ServerError::Network)?;
        crate::client::decode_bounded(response, MAX_SMALL_JSON_BYTES).await
    }

    /// `POST /api/v1/player/pairing-sessions` for the installation whose
    /// identity the caller verified.
    pub async fn create_pairing_session(
        &self,
        installation_id: InstallationId,
        metadata: &DeviceMetadata,
    ) -> Result<PairingSession, ServerError> {
        let body = serde_json::json!({ "installationId": installation_id.to_string(), "metadata": metadata });
        let created: Created =
            self.send_json(self.http().post(self.url("/api/v1/player/pairing-sessions")).json(&body)).await?;
        let expires_at = Timestamp::parse(&created.expires_at).map_err(|_| ServerError::Decode)?;
        let code = bounded(&created.code, 16);
        if !valid_secret(&created.poll_secret) || code.is_empty() {
            return Err(ServerError::Decode);
        }
        Ok(PairingSession {
            server_url: self.base_url().to_owned(),
            installation_id,
            session_id: created.id,
            poll_secret: created.poll_secret,
            code,
            approval_url: bounded(&created.approval_url, 512),
            organization_name: Some(bounded(&created.organization_name, 120)).filter(|name| !name.is_empty()),
            expires_at,
            server_time: Some(bounded(&created.server_time, 64)).filter(|time| !time.is_empty()),
            polling_interval_seconds: created.polling_interval_seconds.clamp(2, 60),
            enrollment_token: None,
        })
    }

    /// `GET /api/v1/player/pairing-sessions/{id}` with the private secret.
    pub async fn poll_pairing(&self, session: &PairingSession) -> Result<PollStatus, ServerError> {
        let path = format!("/api/v1/player/pairing-sessions/{}", session.session_id);
        let request = self
            .http()
            .get(self.url(&path))
            .header(reqwest::header::AUTHORIZATION, format!("Pairing {}", session.poll_secret));
        let poll: Poll = match self.send_json(request).await {
            Ok(poll) => poll,
            Err(ServerError::Api { status: 404 | 410, code, .. }) => return Ok(PollStatus::Ended(code)),
            Err(error) => return Err(error),
        };
        Ok(match poll.status.as_str() {
            "pending" | "approved" => PollStatus::Waiting,
            "claimed" => match poll.enrollment_token.filter(|token| valid_secret(token)) {
                Some(token) => PollStatus::Claimed(token),
                None => PollStatus::TokenLost,
            },
            other => PollStatus::Ended(bounded(poll.failure_reason.as_deref().unwrap_or(other), 64)),
        })
    }

    /// `POST /api/v1/player/enroll` with the session's stored one-time token.
    pub async fn enroll(&self, session: &PairingSession) -> Result<Enrolled, ServerError> {
        let token = session.enrollment_token.as_deref().ok_or(ServerError::Decode)?;
        let body = serde_json::json!({ "pairingSessionId": session.session_id, "enrollmentToken": token });
        let enrolled: Enrollment =
            self.send_json(self.http().post(self.url("/api/v1/player/enroll")).json(&body)).await?;
        let credential = DeviceCredential::parse(&enrolled.device_credential).map_err(|_| ServerError::Decode)?;
        Ok(Enrolled { screen_id: enrolled.screen_id, screen_name: bounded(&enrolled.screen_name, 120), credential })
    }
}

/// Host-owned persistence of short-lived private pairing state.
pub trait PairingStore: Send + Sync + std::fmt::Debug {
    fn load(&self) -> Result<Option<PairingSession>, PairingFileError>;
    fn save(&self, session: &PairingSession) -> Result<(), PairingFileError>;
    fn remove(&self) -> Result<(), PairingFileError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> PairingSession {
        PairingSession {
            server_url: "https://signs.example.org".into(),
            installation_id: InstallationId::from_uuid(uuid::Uuid::new_v4()),
            session_id: uuid::Uuid::new_v4(),
            poll_secret: "p".repeat(43),
            code: "ABC123".into(),
            approval_url: "https://signs.example.org/screens/pair".into(),
            organization_name: None,
            expires_at: Timestamp::from_unix_millis(2_000_000_000_000).unwrap(),
            server_time: Some("2026-08-06T06:56:40Z".to_owned()),
            polling_interval_seconds: 3,
            enrollment_token: None,
        }
    }

    #[test]
    fn pairing_secrets_are_redacted() {
        let with_token = session().with_enrollment_token("t".repeat(43));
        let debug = format!("{with_token:?} {:?}", PollStatus::Claimed("t".repeat(43)));
        assert!(!debug.contains("ppp") && !debug.contains("ttt"), "{debug}");
    }

    #[test]
    fn metadata_is_always_acceptable_to_the_server() {
        let metadata = DeviceMetadata::new(
            uuid::Uuid::new_v4(),
            "linux",
            "",
            &"m".repeat(500),
            "6.8\n",
            "0.1.0",
            (0, 99_999),
            "",
            "",
        );
        assert_eq!(metadata.manufacturer, "unknown");
        assert_eq!(metadata.model.len(), 120);
        assert_eq!(metadata.android_version, "6.8");
        assert_eq!((metadata.screen_width, metadata.screen_height), (1, 16_384));
        assert_eq!((metadata.locale.as_str(), metadata.timezone.as_str()), ("en-US", "UTC"));
    }
}
