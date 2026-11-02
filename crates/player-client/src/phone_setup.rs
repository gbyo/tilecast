//! The Player half of phone setup (docs/phone-setup.md).
//!
//! A Player with no server makes a P-256 key pair and a setup code, shows
//! them in a QR code, and waits on the setup relay. Studio seals the server
//! address for that key; the relay only carries the envelope. The private
//! key lives in memory for one setup code and is consumed by the one
//! attempt to open an envelope.
//!
//! The setup code travels in the `Authorization` header, never in a URL.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::{SinkExt as _, StreamExt as _};
use player_types::InstallationId;
use ring::rand::{SecureRandom as _, SystemRandom};
use ring::{aead, agreement, hkdf};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{Connector, connect_async_tls_with_config};

use crate::client::tls_config;
use crate::url_policy::normalize_server_url;

/// The public relay. It also serves the setup page the QR code opens.
pub const DEFAULT_RELAY_URL: &str = "https://setup.tilecast.org";
/// The relay answers ping frames without waking its Durable Object, and
/// Cloudflare closes a WebSocket that carries nothing for 100 seconds.
pub const PING_INTERVAL: Duration = Duration::from_secs(25);
const ACTIVITY_TIMEOUT: Duration = Duration::from_secs(60);
const INFO: &[u8] = b"tilecast-setup-v1";
const MAX_ENVELOPE_BYTES: usize = 2048;
const MAX_PLAINTEXT_BYTES: usize = 1024;
const CODE_BYTES: usize = 16;
const P256_POINT_BYTES: usize = 65;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PhoneSetupError {
    #[error("the relay address is not allowed")]
    RelayUrl,
    #[error("the setup relay could not be reached")]
    Network,
    #[error("the setup relay is limiting requests")]
    RateLimited,
    #[error("a setup key could not be made")]
    Key,
    #[error("the envelope is not valid")]
    Envelope,
    #[error("the envelope could not be opened")]
    Open,
    #[error("the setup payload is not valid")]
    Payload,
}

/// One setup code and the key it is shown with.
pub struct SetupKey {
    private: agreement::EphemeralPrivateKey,
    public: Vec<u8>,
    code: String,
}

impl std::fmt::Debug for SetupKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SetupKey").finish_non_exhaustive()
    }
}

impl SetupKey {
    pub fn generate() -> Result<Self, PhoneSetupError> {
        let rng = SystemRandom::new();
        let private =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).map_err(|_| PhoneSetupError::Key)?;
        let public = private.compute_public_key().map_err(|_| PhoneSetupError::Key)?.as_ref().to_vec();
        let mut code = [0u8; CODE_BYTES];
        rng.fill(&mut code).map_err(|_| PhoneSetupError::Key)?;
        Ok(Self { private, public, code: URL_SAFE_NO_PAD.encode(code) })
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    /// The setup page address the QR code carries. The values are in the
    /// fragment, which a browser never sends to a server.
    pub fn qr_url(&self, relay: &RelayAddress) -> String {
        format!("{}/#v=1&r={}&k={}", relay.origin, self.code, URL_SAFE_NO_PAD.encode(&self.public))
    }

    /// Opens an envelope sealed for this key and setup code. The key is
    /// spent either way: a Player makes a new one after any envelope.
    pub fn open(self, envelope: &Envelope) -> Result<SetupPayload, PhoneSetupError> {
        let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, &envelope.epk);
        let code = self.code;
        let public = self.public;
        agreement::agree_ephemeral(self.private, &peer, |shared| {
            open_with_shared_secret(shared, &public, &code, envelope)
        })
        .map_err(|_| PhoneSetupError::Open)?
    }
}

/// HKDF-SHA-256 and AES-256-GCM, from an ECDH shared secret. Split from
/// [`SetupKey::open`] so the shared fixture can check it: ring cannot load a
/// fixed private key.
pub fn open_with_shared_secret(
    shared: &[u8],
    player_public: &[u8],
    code: &str,
    envelope: &Envelope,
) -> Result<SetupPayload, PhoneSetupError> {
    let mut salt = Vec::with_capacity(P256_POINT_BYTES * 2);
    salt.extend_from_slice(&envelope.epk);
    salt.extend_from_slice(player_public);
    let key: aead::UnboundKey = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt)
        .extract(shared)
        .expand(&[INFO], &aead::AES_256_GCM)
        .map_err(|_| PhoneSetupError::Open)?
        .into();
    let nonce = aead::Nonce::try_assume_unique_for_key(&envelope.iv).map_err(|_| PhoneSetupError::Envelope)?;
    let mut in_out = envelope.ct.clone();
    let plaintext = aead::LessSafeKey::new(key)
        .open_in_place(nonce, aead::Aad::from(code.as_bytes()), &mut in_out)
        .map_err(|_| PhoneSetupError::Open)?;
    SetupPayload::parse(plaintext)
}

/// A sealed envelope as the relay delivers it.
#[derive(Clone, PartialEq, Eq)]
pub struct Envelope {
    epk: Vec<u8>,
    iv: Vec<u8>,
    ct: Vec<u8>,
}

impl std::fmt::Debug for Envelope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Envelope").finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvelopeWire {
    v: u8,
    epk: String,
    iv: String,
    ct: String,
}

impl Envelope {
    pub fn parse(text: &str) -> Result<Self, PhoneSetupError> {
        if text.len() > MAX_ENVELOPE_BYTES {
            return Err(PhoneSetupError::Envelope);
        }
        let wire: EnvelopeWire = serde_json::from_str(text).map_err(|_| PhoneSetupError::Envelope)?;
        let bytes = |value: &str| URL_SAFE_NO_PAD.decode(value).map_err(|_| PhoneSetupError::Envelope);
        let envelope = Self { epk: bytes(&wire.epk)?, iv: bytes(&wire.iv)?, ct: bytes(&wire.ct)? };
        let valid = wire.v == 1
            && envelope.epk.len() == P256_POINT_BYTES
            && envelope.epk.first() == Some(&0x04)
            && envelope.iv.len() == NONCE_BYTES
            && envelope.ct.len() > TAG_BYTES
            && envelope.ct.len() <= MAX_PLAINTEXT_BYTES + TAG_BYTES;
        if valid { Ok(envelope) } else { Err(PhoneSetupError::Envelope) }
    }
}

/// What Studio sends: its own address and installation.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SetupPayload {
    pub server_url: String,
    pub installation_id: InstallationId,
}

impl SetupPayload {
    fn parse(plaintext: &[u8]) -> Result<Self, PhoneSetupError> {
        let payload: Self = serde_json::from_slice(plaintext).map_err(|_| PhoneSetupError::Payload)?;
        if payload.server_url.len() > 512 {
            return Err(PhoneSetupError::Payload);
        }
        Ok(payload)
    }
}

/// A validated relay origin. The relay follows the server URL policy, so a
/// test relay on the loopback address may use plain HTTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayAddress {
    origin: String,
}

impl RelayAddress {
    pub fn new(origin: &str) -> Result<Self, PhoneSetupError> {
        normalize_server_url(origin).map(|origin| Self { origin }).map_err(|_| PhoneSetupError::RelayUrl)
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    fn socket_url(&self) -> Result<String, PhoneSetupError> {
        let (scheme, rest) = self.origin.split_once("://").ok_or(PhoneSetupError::RelayUrl)?;
        let scheme = if scheme == "https" { "wss" } else { "ws" };
        Ok(format!("{scheme}://{rest}/v1/rendezvous"))
    }
}

impl Default for RelayAddress {
    fn default() -> Self {
        Self { origin: DEFAULT_RELAY_URL.to_owned() }
    }
}

/// How one wait on the relay ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayOutcome {
    Envelope(Envelope),
    /// The setup code expired (close code 4408).
    Expired,
    /// A newer connection took this setup code (close code 4409).
    Replaced,
    /// The relay refused the setup code: it expired or was already used.
    Closed,
}

/// Waits on the relay for one envelope. Cancel the future to stop waiting.
pub async fn wait_for_envelope(
    relay: &RelayAddress,
    code: &str,
    user_agent: &str,
) -> Result<RelayOutcome, PhoneSetupError> {
    wait_with_ping_interval(relay, code, user_agent, PING_INTERVAL).await
}

#[doc(hidden)]
pub async fn wait_with_ping_interval(
    relay: &RelayAddress,
    code: &str,
    user_agent: &str,
    ping_interval: Duration,
) -> Result<RelayOutcome, PhoneSetupError> {
    use tokio_tungstenite::tungstenite::Error;

    let mut request = relay.socket_url()?.into_client_request().map_err(|_| PhoneSetupError::RelayUrl)?;
    let headers = request.headers_mut();
    headers.insert("authorization", format!("Rendezvous {code}").parse().map_err(|_| PhoneSetupError::Key)?);
    headers.insert("user-agent", user_agent.parse().map_err(|_| PhoneSetupError::RelayUrl)?);
    let tls = Connector::Rustls(Arc::new(tls_config(&[]).map_err(|_| PhoneSetupError::RelayUrl)?));
    let config =
        WebSocketConfig::default().max_message_size(Some(MAX_ENVELOPE_BYTES)).max_frame_size(Some(MAX_ENVELOPE_BYTES));
    let connected = tokio::time::timeout(
        Duration::from_secs(15),
        connect_async_tls_with_config(request, Some(config), false, Some(tls)),
    )
    .await
    .map_err(|_| PhoneSetupError::Network)?;
    let mut stream = match connected {
        Ok((stream, _)) => stream,
        Err(Error::Http(response)) => {
            return match response.status().as_u16() {
                410 => Ok(RelayOutcome::Closed),
                429 => Err(PhoneSetupError::RateLimited),
                _ => Err(PhoneSetupError::Network),
            };
        }
        Err(_) => return Err(PhoneSetupError::Network),
    };

    let mut ping = tokio::time::interval(ping_interval);
    ping.tick().await;
    let mut last_activity = tokio::time::Instant::now();
    loop {
        tokio::select! {
            message = stream.next() => {
                let Some(message) = message else { return Err(PhoneSetupError::Network) };
                last_activity = tokio::time::Instant::now();
                match message.map_err(|_| PhoneSetupError::Network)? {
                    Message::Text(text) => {
                        let envelope = Envelope::parse(&text)?;
                        let _ = stream.close(None).await;
                        return Ok(RelayOutcome::Envelope(envelope));
                    }
                    Message::Close(frame) => {
                        return match frame.map(|frame| frame.code) {
                            Some(CloseCode::Library(4408)) => Ok(RelayOutcome::Expired),
                            Some(CloseCode::Library(4409)) => Ok(RelayOutcome::Replaced),
                            _ => Err(PhoneSetupError::Network),
                        };
                    }
                    _ => {}
                }
            }
            _ = ping.tick() => {
                if last_activity.elapsed() > ACTIVITY_TIMEOUT.max(ping_interval * 2) {
                    return Err(PhoneSetupError::Network);
                }
                stream.send(Message::Ping(Vec::new().into())).await.map_err(|_| PhoneSetupError::Network)?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../packages/player-contracts/fixtures/phone-setup-envelope.json");

    fn decode(value: &serde_json::Value) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(value.as_str().expect("string")).expect("base64url")
    }

    /// Studio's half, for the round trip only.
    fn seal(code: &str, player_public: &[u8], plaintext: &[u8]) -> String {
        let rng = SystemRandom::new();
        let ephemeral = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).expect("key");
        let epk = ephemeral.compute_public_key().expect("public").as_ref().to_vec();
        let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, player_public);
        let mut salt = epk.clone();
        salt.extend_from_slice(player_public);
        let key: aead::UnboundKey = agreement::agree_ephemeral(ephemeral, &peer, |shared| {
            hkdf::Salt::new(hkdf::HKDF_SHA256, &salt)
                .extract(shared)
                .expand(&[INFO], &aead::AES_256_GCM)
                .expect("okm")
                .into()
        })
        .expect("agree");
        let mut iv = [0u8; NONCE_BYTES];
        rng.fill(&mut iv).expect("iv");
        let mut ct = plaintext.to_vec();
        aead::LessSafeKey::new(key)
            .seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(iv), aead::Aad::from(code.as_bytes()), &mut ct)
            .expect("seal");
        serde_json::json!({"v": 1, "epk": URL_SAFE_NO_PAD.encode(epk), "iv": URL_SAFE_NO_PAD.encode(iv), "ct": URL_SAFE_NO_PAD.encode(ct)})
            .to_string()
    }

    #[test]
    fn shared_fixture_opens_only_the_valid_case() {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture");
        let player_public = decode(&fixture["player"]["publicKey"]);
        let code = fixture["player"]["setupCode"].as_str().expect("code");
        for case in fixture["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let envelope = Envelope::parse(&case["envelope"].to_string()).expect(name);
            let opened = open_with_shared_secret(&decode(&case["sharedSecret"]), &player_public, code, &envelope);
            if case["accepted"].as_bool().expect("accepted") {
                let payload = opened.expect(name);
                assert_eq!(payload.server_url, case["payload"]["serverUrl"].as_str().expect("url"), "{name}");
                assert_eq!(
                    payload.installation_id.to_string(),
                    case["payload"]["installationId"].as_str().expect("id"),
                    "{name}"
                );
            } else {
                assert!(opened.is_err(), "{name}");
            }
        }
    }

    #[test]
    fn round_trip_with_a_generated_key() {
        let key = SetupKey::generate().expect("key");
        let code = key.code().to_owned();
        let text = seal(
            &code,
            &key.public,
            br#"{"serverUrl":"https://signage.example.org","installationId":"0b0f4a52-9f1e-4f43-a0a4-6d3f7c1d2e11"}"#,
        );
        let payload = key.open(&Envelope::parse(&text).expect("envelope")).expect("open");
        assert_eq!(payload.server_url, "https://signage.example.org");
    }

    #[test]
    fn an_envelope_for_another_code_does_not_open() {
        let key = SetupKey::generate().expect("key");
        let text = seal(
            "another-setup-code-0000",
            &key.public,
            br#"{"serverUrl":"https://a.example","installationId":"0b0f4a52-9f1e-4f43-a0a4-6d3f7c1d2e11"}"#,
        );
        assert_eq!(key.open(&Envelope::parse(&text).expect("envelope")), Err(PhoneSetupError::Open));
    }

    #[test]
    fn envelope_shape_is_strict() {
        let valid = serde_json::json!({"v": 1, "epk": format!("BA{}", "A".repeat(85)), "iv": "A".repeat(16), "ct": "C".repeat(40)});
        assert!(Envelope::parse(&valid.to_string()).is_ok());
        for (field, value) in [
            ("v", serde_json::json!(2)),
            ("epk", serde_json::json!("A".repeat(87))),
            ("iv", serde_json::json!("A".repeat(15))),
            ("ct", serde_json::json!("C".repeat(20))),
        ] {
            let mut bad = valid.clone();
            bad[field] = value;
            assert_eq!(Envelope::parse(&bad.to_string()), Err(PhoneSetupError::Envelope), "{field}");
        }
        let mut extra = valid;
        extra["extra"] = serde_json::json!(1);
        assert_eq!(Envelope::parse(&extra.to_string()), Err(PhoneSetupError::Envelope));
    }

    #[test]
    fn qr_url_carries_the_code_and_key_in_the_fragment() {
        let key = SetupKey::generate().expect("key");
        let url = key.qr_url(&RelayAddress::default());
        let fragment = url.strip_prefix("https://setup.tilecast.org/#v=1&r=").expect("prefix");
        let (code, public) = fragment.split_once("&k=").expect("key");
        assert_eq!(code.len(), 22);
        assert_eq!(public.len(), 87);
        assert!(public.starts_with('B'));
    }

    #[test]
    fn relay_address_follows_the_server_url_policy() {
        assert_eq!(
            RelayAddress::new("http://127.0.0.1:8787").expect("loopback").socket_url().expect("url"),
            "ws://127.0.0.1:8787/v1/rendezvous"
        );
        assert_eq!(RelayAddress::default().socket_url().expect("url"), "wss://setup.tilecast.org/v1/rendezvous");
        assert_eq!(RelayAddress::new("http://relay.example.org"), Err(PhoneSetupError::RelayUrl));
    }
}
