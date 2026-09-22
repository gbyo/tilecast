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
use std::time::Duration;

use edge_protocol::InstallationId;
use edge_protocol::signed::SignedDocument;
use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::credential::DeviceCredential;
use crate::url_policy::normalize_server_url;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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

fn tls_config() -> Result<rustls::ClientConfig, ServerError> {
    let mut roots = rustls::RootCertStore::empty();
    let loaded = rustls_native_certs::load_native_certs();
    for certificate in loaded.certs {
        let _ = roots.add(certificate);
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
}

impl ServerClient {
    /// Builds a client for a normalized server origin.
    pub fn new(server_url: &str) -> Result<Self, ServerError> {
        let base_url = normalize_server_url(server_url).map_err(|e| ServerError::Url(e.to_string()))?;
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls_config()?)
            // An idle bound for every request (large downloads included);
            // JSON calls add a total timeout on top.
            .read_timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            // Never follow a redirect with the credential attached.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("tilecastd/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ServerError::Network)?;
        Ok(Self { base_url, http })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    pub async fn identity(&self) -> Result<ServerIdentity, ServerError> {
        let response = self
            .http
            .get(self.url("/api/v1/system/identity"))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|_| ServerError::Network)?;
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
