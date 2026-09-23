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
use edge_protocol::signed::SignedDocument;
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
    #[error("Edge trust bootstrap requires HTTPS")]
    InsecureEdgeBootstrap,
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
            Self::InsecureEdgeBootstrap => "edge_secure_bootstrap_required",
        }
    }

    /// Worth retrying later without operator action.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Network | Self::Decode => true,
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

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    pub async fn identity(&self) -> Result<ServerIdentity, ServerError> {
        let response =
            self.http.get(self.url("/api/v1/system/identity")).timeout(REQUEST_TIMEOUT).send().await.map_err(
                |error| {
                    tracing::warn!(component = "server", event = "identity_request_failed", error = ?error);
                    ServerError::Network
                },
            )?;
        decode(response).await
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

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, ServerError> {
    let status = response.status();
    let bytes = response.bytes().await.map_err(|_| ServerError::Network)?;
    if status.is_success() {
        return serde_json::from_slice::<Envelope<T>>(&bytes).map(|e| e.data).map_err(|_| ServerError::Decode);
    }
    let error = serde_json::from_slice::<ErrorEnvelope>(&bytes)
        .map(|e| e.error)
        .unwrap_or(ErrorBody { code: format!("http_{}", status.as_u16()), message: String::new() });
    if error.code == "device_credential_invalid" || error.code == "device_credential_revoked" {
        return Err(ServerError::CredentialRejected);
    }
    Err(ServerError::Api {
        status: status.as_u16(),
        code: error.code.chars().take(64).collect(),
        message: error.message.chars().take(240).collect(),
    })
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityKeyResponse {
    pub epoch: u32,
    pub key_id: String,
    pub public_key: String,
}

/// `POST /api/v1/player/edge/enroll`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub certificate_pem: String,
    pub ca_certificate_pem: String,
    pub installation_id: InstallationId,
    pub screen_id: edge_protocol::ScreenId,
    pub node_id: edge_protocol::NodeId,
    pub authority: AuthorityKeyResponse,
    pub mesh_protocol_version: u32,
    pub not_before: String,
    pub not_after: String,
    pub renew_after: String,
    pub latest_sequence: u64,
    pub revocation_snapshot: SignedDocument,
}

/// `GET /api/v1/player/edge/changes`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePage {
    pub items: Vec<SignedDocument>,
    pub latest_sequence: u64,
    pub oldest_sequence: u64,
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

    pub fn has_secure_edge_bootstrap(&self) -> bool {
        self.client.base_url.starts_with("https://")
    }

    pub async fn player_socket(&self, version: &str) -> Result<PlayerSocket, ServerError> {
        if !self.has_secure_edge_bootstrap() {
            return Err(ServerError::InsecureEdgeBootstrap);
        }
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

    pub async fn edge_enroll(&self, csr_pem: &str) -> Result<EnrollResponse, ServerError> {
        if !self.has_secure_edge_bootstrap() {
            return Err(ServerError::InsecureEdgeBootstrap);
        }
        let body = serde_json::json!({"csrPem": csr_pem, "meshProtocolVersion": edge_protocol::MESH_PROTOCOL_VERSION});
        let response = self
            .request(reqwest::Method::POST, "/api/v1/player/edge/enroll")
            .json(&body)
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        decode(response).await
    }

    pub async fn edge_changes(&self, after: u64, limit: u32) -> Result<ChangePage, ServerError> {
        let path = format!("/api/v1/player/edge/changes?after={after}&limit={}", limit.clamp(1, 500));
        let response = self.request(reqwest::Method::GET, &path).send().await.map_err(|_| ServerError::Network)?;
        decode(response).await
    }

    pub async fn edge_revocations(&self) -> Result<SignedDocument, ServerError> {
        let response = self
            .request(reqwest::Method::GET, "/api/v1/player/edge/revocations")
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        decode(response).await
    }

    pub async fn edge_status(&self, status: &serde_json::Value) -> Result<(), ServerError> {
        let response = self
            .request(reqwest::Method::POST, "/api/v1/player/edge/status")
            .json(status)
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        let _: serde_json::Value = decode(response).await?;
        Ok(())
    }

    /// The normal player contact path. Edge status remains a separate, slower report.
    pub async fn player_heartbeat(&self, heartbeat: &serde_json::Value) -> Result<(), ServerError> {
        let response = self
            .request(reqwest::Method::POST, "/api/v1/player/heartbeat")
            .json(heartbeat)
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
        let _: serde_json::Value = decode(response).await?;
        Ok(())
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
