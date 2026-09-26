//! Tilecast Server REST client.
//!
//! The identity gate is enforced by types: [`ServerClient`] can only call
//! unauthenticated endpoints; an [`AuthenticatedServer`], which is the only
//! thing that can send the device credential, is obtained exclusively from
//! [`ServerClient::verify_installation`] after `/api/v1/system/identity`
//! reports the installation ID this node is bound to (AGENTS.md: "The
//! player's saved installation ID must match before it sends a stored
//! credential").
//!
//! Responses use the server's `{"data": …}` / `{"error": {code, message}}`
//! envelope. A credential is treated as dead only on
//! `device_credential_invalid` or `device_credential_revoked`, never on
//! network errors, 5xx or `screen_disabled`, matching the Linux player.

use std::sync::Arc;
use std::time::{Duration, Instant};

use edge_protocol::InstallationId;
use futures_util::{SinkExt as _, StreamExt as _};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};

use crate::credential::DeviceCredential;
use crate::url_policy::normalize_server_url;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const PLAYER_SOCKET_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(95);

// Response body bounds (docs/tilecast-edge.md §17.5: every network read is
// bounded). Each is far above what its endpoint legitimately returns and far
// below anything that could exhaust the daemon. A body is read in chunks and
// abandoned as soon as it passes its bound; `Content-Length` never sizes an
// allocation.
/// The server's own manifest bound (five MiB) plus envelope overhead.
pub const MAX_MANIFEST_BYTES: usize = 6 * 1024 * 1024;
/// Small JSON answers: identity, heartbeat, command acknowledgement and result.
pub const MAX_SMALL_JSON_BYTES: usize = 64 * 1024;
/// Error envelopes. Only a bounded code and message are kept from them.
pub const MAX_ERROR_BYTES: usize = 16 * 1024;
/// A player configuration document is a few KiB.
pub const MAX_CONFIG_BYTES: usize = crate::player_api::MAX_CONFIG_BYTES;
/// The pending command list: 8 KiB is the largest single payload the server
/// accepts, so this holds well over a hundred of the largest commands.
pub const MAX_COMMANDS_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ServerError {
    #[error("the server address is not allowed: {0}")]
    Url(String),
    #[error("the server could not be reached")]
    Network,
    #[error("the server answered {status} {code}")]
    Api { status: u16, code: String, message: String },
    #[error("the server belongs to installation {actual}, not {expected}")]
    IdentityMismatch { expected: InstallationId, actual: InstallationId },
    #[error("the server rejected the device credential")]
    CredentialRejected,
    #[error("the server response could not be read")]
    Decode,
    #[error("the server response exceeded its size bound")]
    ResponseTooLarge,
}

impl ServerError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Url(_) => "server_url_rejected",
            Self::Network => "server_unreachable",
            Self::Api { .. } => "server_error",
            Self::IdentityMismatch { .. } => "installation_identity_mismatch",
            Self::CredentialRejected => "device_credential_rejected",
            Self::Decode => "server_response_invalid",
            Self::ResponseTooLarge => "server_response_too_large",
        }
    }

    /// Worth retrying later without operator action.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Network | Self::Decode | Self::ResponseTooLarge => true,
            Self::Api { status, .. } => *status >= 500 || *status == 429,
            _ => false,
        }
    }
}

/// Public installation identity (`GET /api/v1/system/identity`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerIdentity {
    pub product: String,
    pub installation_id: InstallationId,
    pub organization_name: String,
    pub api_version: String,
    pub pairing_enabled: bool,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: String,
    #[serde(default)]
    message: String,
}

fn tls_config(
    additional_roots: &[rustls::pki_types::CertificateDer<'static>],
) -> Result<rustls::ClientConfig, ServerError> {
    let mut roots = rustls::RootCertStore::empty();
    let loaded = rustls_native_certs::load_native_certs();
    for certificate in loaded.certs {
        let _ = roots.add(certificate);
    }
    for certificate in additional_roots {
        roots.add(certificate.clone()).map_err(|_| ServerError::Url("invalid trusted CA certificate".to_owned()))?;
    }
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| ServerError::Url(e.to_string()))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(config)
}

#[derive(Debug, Clone)]
pub struct ServerClient {
    base_url: String,
    http: reqwest::Client,
    tls_roots: Vec<rustls::pki_types::CertificateDer<'static>>,
}

impl ServerClient {
    /// Builds a client for a normalized server origin.
    pub fn new(server_url: &str) -> Result<Self, ServerError> {
        Self::with_trust_roots(server_url, &[])
    }

    /// Adds operator-provided CA certificates while retaining normal hostname validation.
    pub fn with_trust_roots(
        server_url: &str,
        additional_roots: &[rustls::pki_types::CertificateDer<'static>],
    ) -> Result<Self, ServerError> {
        let base_url = normalize_server_url(server_url).map_err(|e| ServerError::Url(e.to_string()))?;
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls_config(additional_roots)?)
            // An idle bound for every request (large downloads included);
            // JSON calls add a total timeout on top.
            .read_timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            // Never follow a redirect with the credential attached.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("tilecastd/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ServerError::Network)?;
        Ok(Self { base_url, http, tls_roots: additional_roots.to_vec() })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// The unauthenticated HTTP client (identity and pairing only).
    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub async fn identity(&self) -> Result<ServerIdentity, ServerError> {
        let response =
            self.http.get(self.url("/api/v1/system/identity")).timeout(REQUEST_TIMEOUT).send().await.map_err(
                |error| {
                    tracing::warn!(component = "server", event = "identity_request_failed", error = ?error);
                    ServerError::Network
                },
            )?;
        decode(response, MAX_SMALL_JSON_BYTES).await
    }

    /// The only way to obtain an [`AuthenticatedServer`].
    pub async fn verify_installation(
        &self,
        expected: InstallationId,
        credential: DeviceCredential,
    ) -> Result<AuthenticatedServer, ServerError> {
        let identity = self.identity().await?;
        if identity.installation_id != expected {
            return Err(ServerError::IdentityMismatch { expected, actual: identity.installation_id });
        }
        Ok(AuthenticatedServer { client: self.clone(), credential, installation_id: expected, identity })
    }
}

/// Reads at most `limit` body bytes. A declared or actual length beyond the
/// bound ends the read with [`ServerError::ResponseTooLarge`] without
/// reading further.
pub(crate) async fn read_bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, ServerError> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(ServerError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ServerError::Network)? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(ServerError::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Maps a non-success answer to a bounded error. An error body beyond
/// [`MAX_ERROR_BYTES`] or without the error envelope keeps only its status:
/// the credential is judged rejected only from a readable envelope.
pub(crate) async fn error_from(response: reqwest::Response) -> ServerError {
    let status = response.status();
    let error = match read_bounded(response, MAX_ERROR_BYTES).await {
        Ok(bytes) => serde_json::from_slice::<ErrorEnvelope>(&bytes).map(|e| e.error).ok(),
        Err(_) => None,
    }
    .unwrap_or(ErrorBody { code: format!("http_{}", status.as_u16()), message: String::new() });
    if error.code == "device_credential_invalid" || error.code == "device_credential_revoked" {
        return ServerError::CredentialRejected;
    }
    ServerError::Api {
        status: status.as_u16(),
        code: error.code.chars().take(64).collect(),
        message: error.message.chars().take(240).collect(),
    }
}

pub(crate) async fn decode_bounded<T: DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
) -> Result<T, ServerError> {
    decode(response, limit).await
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response, limit: usize) -> Result<T, ServerError> {
    if !response.status().is_success() {
        return Err(error_from(response).await);
    }
    let bytes = read_bounded(response, limit).await?;
    serde_json::from_slice::<Envelope<T>>(&bytes).map(|e| e.data).map_err(|_| ServerError::Decode)
}

/// A server whose installation identity matched; can send the credential.
#[derive(Clone)]
pub struct AuthenticatedServer {
    client: ServerClient,
    credential: DeviceCredential,
    installation_id: InstallationId,
    identity: ServerIdentity,
}

impl std::fmt::Debug for AuthenticatedServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthenticatedServer")
            .field("base_url", &self.client.base_url)
            .field("installation_id", &self.installation_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ManifestFetch {
    NotModified,
    Modified { document: serde_json::Value, etag: String },
}

/// Events from the existing Tilecast Player socket protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlayerSocketEvent {
    Hello,
    Ping(String),
    ManifestChanged,
    ConfigChanged,
    CommandsAvailable,
    Closed,
    Other,
}

/// A live socket obtained only from an identity-verified server.
pub struct PlayerSocket {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    last_activity: Instant,
}

impl std::fmt::Debug for PlayerSocket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlayerSocket").finish_non_exhaustive()
    }
}

impl PlayerSocket {
    pub async fn next_event(&mut self) -> Result<PlayerSocketEvent, ServerError> {
        let Some(message) = self.stream.next().await else { return Ok(PlayerSocketEvent::Closed) };
        let event = match message.map_err(|_| ServerError::Network)? {
            Message::Text(text) => {
                if text.len() > 64 * 1024 {
                    return Err(ServerError::Decode);
                }
                let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| ServerError::Decode)?;
                Ok(match value.get("type").and_then(serde_json::Value::as_str) {
                    Some("server.hello") => PlayerSocketEvent::Hello,
                    Some("server.ping") => PlayerSocketEvent::Ping(
                        value
                            .get("timestamp")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .chars()
                            .take(40)
                            .collect(),
                    ),
                    Some("manifest.changed") => PlayerSocketEvent::ManifestChanged,
                    Some("config.changed") => PlayerSocketEvent::ConfigChanged,
                    Some("commands.available") => PlayerSocketEvent::CommandsAvailable,
                    _ => PlayerSocketEvent::Other,
                })
            }
            Message::Close(_) => Ok(PlayerSocketEvent::Closed),
            _ => Ok(PlayerSocketEvent::Other),
        }?;
        if event != PlayerSocketEvent::Closed {
            self.last_activity = Instant::now();
        }
        Ok(event)
    }

    pub async fn send_pong(&mut self, timestamp: &str) -> Result<(), ServerError> {
        let value = serde_json::json!({"type": "player.pong", "timestamp": timestamp});
        self.send_json(value).await
    }

    pub async fn send_status(&mut self, heartbeat: &serde_json::Value, version: &str) -> Result<(), ServerError> {
        self.send_json(serde_json::json!({
            "type": "player.status", "protocolVersion": 1, "playerVersion": version, "payload": heartbeat,
        }))
        .await
    }

    async fn send_json(&mut self, value: serde_json::Value) -> Result<(), ServerError> {
        let remaining = PLAYER_SOCKET_ACTIVITY_TIMEOUT.saturating_sub(self.last_activity.elapsed());
        tokio::time::timeout(remaining, self.stream.send(Message::Text(value.to_string().into())))
            .await
            .map_err(|_| ServerError::Network)?
            .map_err(|_| ServerError::Network)
    }
}

impl AuthenticatedServer {
    pub fn installation_id(&self) -> InstallationId {
        self.installation_id
    }

    pub fn identity(&self) -> &ServerIdentity {
        &self.identity
    }

    pub fn base_url(&self) -> &str {
        self.client.base_url()
    }

    /// The ordinary authenticated player WebSocket. It follows the server
    /// address's scheme: `wss` for HTTPS, `ws` only where the URL policy
    /// already allowed plain HTTP (private LAN addresses).
    pub async fn player_socket(&self, version: &str) -> Result<PlayerSocket, ServerError> {
        let (scheme, origin) = self.client.base_url.split_once("://").ok_or(ServerError::Decode)?;
        let ws_scheme = if scheme == "https" { "wss" } else { "ws" };
        let address = format!("{ws_scheme}://{origin}/api/v1/player/socket");
        let mut request =
            address.into_client_request().map_err(|_| ServerError::Url("invalid socket address".to_owned()))?;
        request
            .headers_mut()
            .insert("authorization", self.credential.authorization_header().parse().map_err(|_| ServerError::Decode)?);
        let tls = Connector::Rustls(Arc::new(tls_config(&self.client.tls_roots)?));
        let config = WebSocketConfig::default().max_message_size(Some(64 * 1024)).max_frame_size(Some(64 * 1024));
        let (stream, _) = tokio::time::timeout(
            Duration::from_secs(15),
            connect_async_tls_with_config(request, Some(config), false, Some(tls)),
        )
        .await
        .map_err(|_| ServerError::Network)?
        .map_err(|_| ServerError::Network)?;
        let mut socket = PlayerSocket { stream, last_activity: Instant::now() };
        socket
            .send_json(serde_json::json!({"type": "player.hello", "protocolVersion": 1, "playerVersion": version}))
            .await?;
        Ok(socket)
    }

    fn raw_request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .http
            .request(method, self.client.url(path))
            .header(reqwest::header::AUTHORIZATION, self.credential.authorization_header())
    }

    /// A bounded JSON API request.
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.raw_request(method, path).timeout(REQUEST_TIMEOUT)
    }

    /// The normal player contact path. Edge status remains a separate, slower report.
    pub async fn player_heartbeat(&self, heartbeat: &serde_json::Value) -> Result<(), ServerError> {
        let response = self
            .request(reqwest::Method::POST, "/api/v1/player/heartbeat")
            .json(heartbeat)
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        let _: serde_json::Value = decode(response, MAX_SMALL_JSON_BYTES).await?;
        Ok(())
    }

    /// Reads the existing server compiler's manifest without introducing an Edge compiler.
    pub async fn player_manifest(&self, etag: Option<&str>) -> Result<ManifestFetch, ServerError> {
        let mut request = self.request(reqwest::Method::GET, "/api/v1/player/manifest");
        if let Some(etag) = etag {
            if etag.len() > 200 {
                return Err(ServerError::Decode);
            }
            let header = reqwest::header::HeaderValue::from_str(etag).map_err(|_| ServerError::Decode)?;
            request = request.header(reqwest::header::IF_NONE_MATCH, header);
        }
        let response = request.send().await.map_err(|_| ServerError::Network)?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(ManifestFetch::NotModified);
        }
        if !response.status().is_success() {
            return Err(error_from(response).await);
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 200)
            .ok_or(ServerError::Decode)?
            .to_owned();
        let bytes = read_bounded(response, MAX_MANIFEST_BYTES).await?;
        let envelope: Envelope<serde_json::Value> = serde_json::from_slice(&bytes).map_err(|_| ServerError::Decode)?;
        if !envelope.data.is_object() {
            return Err(ServerError::Decode);
        }
        Ok(ManifestFetch::Modified { document: envelope.data, etag })
    }

    /// The ordinary player configuration endpoint, conditional on the
    /// validator of the configuration already accepted.
    pub async fn player_config(&self, etag: Option<&str>) -> Result<crate::player_api::ConfigFetch, ServerError> {
        let mut request = self.request(reqwest::Method::GET, "/api/v1/player/config");
        if let Some(etag) = etag {
            if etag.len() > 200 {
                return Err(ServerError::Decode);
            }
            let header = reqwest::header::HeaderValue::from_str(etag).map_err(|_| ServerError::Decode)?;
            request = request.header(reqwest::header::IF_NONE_MATCH, header);
        }
        let response = request.send().await.map_err(|_| ServerError::Network)?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(crate::player_api::ConfigFetch::NotModified);
        }
        if !response.status().is_success() {
            return Err(error_from(response).await);
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 200)
            .map(str::to_owned);
        let bytes = read_bounded(response, MAX_CONFIG_BYTES).await?;
        let envelope: Envelope<serde_json::Value> = serde_json::from_slice(&bytes).map_err(|_| ServerError::Decode)?;
        if !envelope.data.is_object() {
            return Err(ServerError::Decode);
        }
        Ok(crate::player_api::ConfigFetch::Modified { document: envelope.data, etag })
    }

    /// Pending commands (`GET /player/commands`). Each item is validated on
    /// its own: a malformed item is returned as rejected, never as runnable.
    pub async fn player_commands(&self) -> Result<crate::player_api::CommandBatch, ServerError> {
        let response = self
            .request(reqwest::Method::GET, "/api/v1/player/commands")
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        let data: serde_json::Value = decode(response, MAX_COMMANDS_BYTES).await?;
        crate::player_api::parse_command_batch(&data).ok_or(ServerError::Decode)
    }

    /// `POST /player/commands/{id}/acknowledge`.
    pub async fn acknowledge_command(
        &self,
        command_id: uuid::Uuid,
    ) -> Result<crate::player_api::AcknowledgeOutcome, ServerError> {
        let path = format!("/api/v1/player/commands/{command_id}/acknowledge");
        let response = self.request(reqwest::Method::POST, &path).send().await.map_err(|_| ServerError::Network)?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            let _ = error_from(response).await;
            return Ok(crate::player_api::AcknowledgeOutcome::NotActionable);
        }
        let data: serde_json::Value = decode(response, MAX_SMALL_JSON_BYTES).await?;
        Ok(crate::player_api::acknowledge_outcome(&data))
    }

    /// `POST /player/commands/{id}/result`. The server treats a repeated
    /// terminal report as success, so resending a stored result is safe.
    pub async fn report_command_result(
        &self,
        command_id: uuid::Uuid,
        success: bool,
        code: &str,
        message: &str,
    ) -> Result<crate::player_api::ReportOutcome, ServerError> {
        let path = format!("/api/v1/player/commands/{command_id}/result");
        let body = serde_json::json!({ "success": success, "code": code, "message": message });
        let response =
            self.request(reqwest::Method::POST, &path).json(&body).send().await.map_err(|_| ServerError::Network)?;
        match response.status() {
            reqwest::StatusCode::CONFLICT
            | reqwest::StatusCode::UNPROCESSABLE_ENTITY
            | reqwest::StatusCode::BAD_REQUEST => {
                let _ = error_from(response).await;
                Ok(crate::player_api::ReportOutcome::NotAccepted)
            }
            _ => {
                let _: serde_json::Value = decode(response, MAX_SMALL_JSON_BYTES).await?;
                Ok(crate::player_api::ReportOutcome::Accepted)
            }
        }
    }

    /// `POST /player/activity-events` with at most
    /// [`crate::player_api::MAX_ACTIVITY_BATCH`] events, each an already
    /// serialized event object from the outbox.
    pub async fn post_activity_events(
        &self,
        events: &[&str],
    ) -> Result<crate::player_api::ActivityBatchOutcome, ServerError> {
        if events.is_empty() || events.len() > crate::player_api::MAX_ACTIVITY_BATCH {
            return Err(ServerError::Decode);
        }
        let body = format!("{{\"events\":[{}]}}", events.join(","));
        let response = self
            .request(reqwest::Method::POST, "/api/v1/player/activity-events")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        let status = response.status();
        if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY || status == reqwest::StatusCode::BAD_REQUEST {
            return Ok(crate::player_api::activity_refusal(&error_from(response).await));
        }
        let data: serde_json::Value = decode(response, MAX_SMALL_JSON_BYTES).await?;
        crate::player_api::activity_acknowledgement(&data).ok_or(ServerError::Decode)
    }

    /// `POST /player/telemetry` with one serialized sample.
    pub async fn post_telemetry(&self, sample: &str) -> Result<crate::player_api::TelemetryOutcome, ServerError> {
        let response = self
            .request(reqwest::Method::POST, "/api/v1/player/telemetry")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(sample.to_owned())
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        let status = response.status();
        if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY || status == reqwest::StatusCode::BAD_REQUEST {
            let _ = error_from(response).await;
            return Ok(crate::player_api::TelemetryOutcome::Refused);
        }
        let _: serde_json::Value = decode(response, MAX_SMALL_JSON_BYTES).await?;
        Ok(crate::player_api::TelemetryOutcome::Accepted)
    }

    /// `GET /player/preview-session`: whether Studio holds a preview lease.
    pub async fn preview_session(&self) -> Result<crate::player_api::PreviewSession, ServerError> {
        let response = self
            .request(reqwest::Method::GET, "/api/v1/player/preview-session")
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        let data: serde_json::Value = decode(response, MAX_SMALL_JSON_BYTES).await?;
        Ok(crate::player_api::preview_session(&data))
    }

    /// `POST /player/preview`: one bounded JPEG, or an unavailable status
    /// (a protected state or a failed capture), as multipart form data.
    pub async fn post_preview(&self, upload: &crate::player_api::PreviewUpload<'_>) -> Result<(), ServerError> {
        let boundary = format!("tilecast-{}", uuid::Uuid::new_v4().simple());
        let body = crate::player_api::preview_form(&boundary, upload).ok_or(ServerError::Decode)?;
        let response = self
            .request(reqwest::Method::POST, "/api/v1/player/preview")
            .header(reqwest::header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
            .body(body)
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(error_from(response).await)
    }

    /// Opens an authenticated download (for the origin blob source).
    pub(crate) async fn get_range(
        &self,
        path: &str,
        offset: u64,
        validator: Option<&str>,
    ) -> Result<reqwest::Response, ServerError> {
        let mut request = self.raw_request(reqwest::Method::GET, path);
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            if let Some(validator) = validator {
                request = request.header(reqwest::header::IF_RANGE, validator);
            }
        }
        request.send().await.map_err(|_| ServerError::Network)
    }
}
