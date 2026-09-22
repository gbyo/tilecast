//! The signed-document wrapper.
//!
//! Every piece of state that may travel across the LAN between Edge nodes is
//! a [`SignedDocument`]. The wrapper is deliberately small:
//!
//! ```json
//! {
//!   "format": "tilecast-edge-signed-v1",
//!   "purpose": "server.change",
//!   "body": "<base64url, no padding, of canonical JSON bytes>",
//!   "signature": {
//!     "alg": "ed25519",
//!     "keyId": "sha256:<hex of the raw 32-byte public key>",
//!     "value": "<base64url, no padding, of the 64-byte signature>"
//!   },
//!   "certificate": "<base64url DER>"      // node.statement only
//! }
//! ```
//!
//! **Signing input** is
//! `"tilecast-edge-signed-v1\n" || purpose || "\n" || body_bytes`.
//! The purpose is inside the signed bytes, so a signature made for one
//! purpose can never verify for another, and the format prefix separates
//! these signatures from TLS or any other use of the same key.
//!
//! **Verification order** is fixed and implemented once, here:
//! 1. wrapper shape and format string;
//! 2. purpose is the one the caller expects;
//! 3. body decodes and is within the purpose's size bound;
//! 4. the key ID resolves to a trusted key *chosen by the caller*;
//! 5. Ed25519 signature over the signing input;
//! 6. the body bytes are canonical JSON ([`crate::canonical`]).
//!
//! Only after all six does any code look at body fields. Purpose-specific
//! modules ([`change`], [`statement`]) then apply schema, installation and
//! staleness rules.
//!
//! Peers relay a `SignedDocument` byte-for-byte. A relaying node never
//! re-signs server state.

pub mod change;
pub mod statement;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

use crate::canonical::{self, CanonicalError};
use crate::digest::Sha256Digest;

pub const FORMAT_V1: &str = "tilecast-edge-signed-v1";
const ED25519: &str = "ed25519";

/// What a signed body is for. Closed: an unknown purpose fails to decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Purpose {
    /// A server change-feed entry, signed by the Edge authority key.
    #[serde(rename = "server.change")]
    ServerChange,
    /// A server snapshot (for example the current revocation set), signed by
    /// the Edge authority key. Not part of the sequenced feed.
    #[serde(rename = "server.snapshot")]
    ServerSnapshot,
    /// A statement a node makes about itself, signed by its node key and
    /// accompanied by its certificate. Never authoritative.
    #[serde(rename = "node.statement")]
    NodeStatement,
}

impl Purpose {
    pub fn as_str(&self) -> &'static str {
        match self {
            Purpose::ServerChange => "server.change",
            Purpose::ServerSnapshot => "server.snapshot",
            Purpose::NodeStatement => "node.statement",
        }
    }

    /// Upper bound on decoded body bytes for this purpose.
    pub fn max_body_bytes(&self) -> usize {
        match self {
            Purpose::ServerChange => 32 * 1024,
            // A revocation snapshot can list a few thousand node IDs.
            Purpose::ServerSnapshot => 512 * 1024,
            Purpose::NodeStatement => 16 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignatureBlock {
    pub alg: String,
    pub key_id: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedDocument {
    pub format: String,
    pub purpose: Purpose,
    pub body: String,
    pub signature: SignatureBlock,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate: Option<String>,
}

/// Upper bound on a whole encoded wrapper accepted from the network.
pub const MAX_DOCUMENT_BYTES: usize = 800 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SignedError {
    #[error("signed document is malformed")]
    Malformed,
    #[error("signed document is too large")]
    TooLarge,
    #[error("unsupported signed-document format")]
    UnsupportedFormat,
    #[error("signed document has an unexpected purpose")]
    WrongPurpose,
    #[error("unsupported signature algorithm")]
    UnsupportedAlgorithm,
    #[error("signing key is not trusted")]
    UntrustedKey,
    #[error("signature does not verify")]
    BadSignature,
    #[error("signed body is not canonical JSON: {0}")]
    NotCanonical(CanonicalError),
}

/// A 32-byte Ed25519 public key with its Tilecast key ID.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct PublicKey {
    raw: [u8; 32],
}

impl std::fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PublicKey({})", self.key_id())
    }
}

impl PublicKey {
    pub fn from_raw(raw: [u8; 32]) -> Self {
        Self { raw }
    }

    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        bytes.try_into().ok().map(Self::from_raw)
    }

    pub fn from_base64url(value: &str) -> Option<Self> {
        URL_SAFE_NO_PAD
            .decode(value)
            .ok()
            .and_then(|bytes| Self::from_slice(&bytes))
    }

    pub fn raw(&self) -> &[u8; 32] {
        &self.raw
    }

    pub fn to_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.raw)
    }

    /// `sha256:<hex>` of the raw public key.
    pub fn key_id(&self) -> String {
        format!("sha256:{}", Sha256Digest::of(&self.raw).to_hex())
    }

    pub fn verify(&self, message: &[u8], signature: &[u8]) -> bool {
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &self.raw)
            .verify(message, signature)
            .is_ok()
    }
}

/// A document whose wrapper, signature and canonical encoding have been
/// verified. Body fields have not yet been interpreted.
#[derive(Debug, Clone)]
pub struct VerifiedBody {
    pub purpose: Purpose,
    pub key_id: String,
    pub body_bytes: Vec<u8>,
    pub body: serde_json::Value,
    /// SHA-256 of the canonical body bytes: the document's identity for
    /// duplicate and conflict detection.
    pub body_digest: Sha256Digest,
    /// Present for node statements.
    pub certificate_der: Option<Vec<u8>>,
}

/// Builds the exact bytes that are signed.
pub fn signing_input(purpose: Purpose, body_bytes: &[u8]) -> Vec<u8> {
    let mut input = Vec::with_capacity(FORMAT_V1.len() + 32 + body_bytes.len());
    input.extend_from_slice(FORMAT_V1.as_bytes());
    input.push(b'\n');
    input.extend_from_slice(purpose.as_str().as_bytes());
    input.push(b'\n');
    input.extend_from_slice(body_bytes);
    input
}

impl SignedDocument {
    /// Decodes a wrapper from untrusted bytes without verifying it.
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, SignedError> {
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(SignedError::TooLarge);
        }
        serde_json::from_slice(bytes).map_err(|_| SignedError::Malformed)
    }

    pub fn to_json_bytes(&self) -> Vec<u8> {
        // Serializing a struct of strings cannot fail.
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// Runs verification steps 1–6 (see module docs). `resolve` maps the
    /// document's key ID to a trusted key; returning `None` rejects the
    /// document. For node statements the caller's resolver is where the
    /// certificate chain is checked.
    pub fn verify<F>(&self, expected: Purpose, resolve: F) -> Result<VerifiedBody, SignedError>
    where
        F: FnOnce(&str, Option<&[u8]>) -> Option<PublicKey>,
    {
        if self.format != FORMAT_V1 {
            return Err(SignedError::UnsupportedFormat);
        }
        if self.purpose != expected {
            return Err(SignedError::WrongPurpose);
        }
        if self.signature.alg != ED25519 {
            return Err(SignedError::UnsupportedAlgorithm);
        }
        let max = expected.max_body_bytes();
        // base64 expands by 4/3; reject before allocating the decode.
        if self.body.len() > max.div_ceil(3) * 4 {
            return Err(SignedError::TooLarge);
        }
        let body_bytes = URL_SAFE_NO_PAD
            .decode(&self.body)
            .map_err(|_| SignedError::Malformed)?;
        if body_bytes.len() > max {
            return Err(SignedError::TooLarge);
        }
        let signature = URL_SAFE_NO_PAD
            .decode(&self.signature.value)
            .map_err(|_| SignedError::Malformed)?;
        if signature.len() != 64 {
            return Err(SignedError::Malformed);
        }
        let certificate_der = match (&self.certificate, expected) {
            (Some(certificate), Purpose::NodeStatement) => {
                if certificate.len() > 8 * 1024 {
                    return Err(SignedError::TooLarge);
                }
                Some(
                    URL_SAFE_NO_PAD
                        .decode(certificate)
                        .map_err(|_| SignedError::Malformed)?,
                )
            }
            (None, Purpose::NodeStatement) => return Err(SignedError::Malformed),
            (Some(_), _) => return Err(SignedError::Malformed),
            (None, _) => None,
        };

        let key = resolve(&self.signature.key_id, certificate_der.as_deref())
            .ok_or(SignedError::UntrustedKey)?;
        if key.key_id() != self.signature.key_id {
            return Err(SignedError::UntrustedKey);
        }
        if !key.verify(&signing_input(expected, &body_bytes), &signature) {
            return Err(SignedError::BadSignature);
        }
        let body = canonical::parse_canonical(&body_bytes).map_err(SignedError::NotCanonical)?;
        Ok(VerifiedBody {
            purpose: expected,
            key_id: self.signature.key_id.clone(),
            body_digest: Sha256Digest::of(&body_bytes),
            body_bytes,
            body,
            certificate_der,
        })
    }
}

/// An Ed25519 signing key held in memory.
///
/// Production nodes load theirs from the Edge identity directory; the private
/// half is never serialized by this crate.
pub struct SigningKey {
    pair: ring::signature::Ed25519KeyPair,
    public: PublicKey,
}

impl std::fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SigningKey({})", self.public.key_id())
    }
}

impl SigningKey {
    /// Loads a PKCS#8 v1 or v2 Ed25519 private key.
    pub fn from_pkcs8(der: &[u8]) -> Result<Self, SignedError> {
        use ring::signature::KeyPair as _;
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(der)
            .map_err(|_| SignedError::Malformed)?;
        let public =
            PublicKey::from_slice(pair.public_key().as_ref()).ok_or(SignedError::Malformed)?;
        Ok(Self { pair, public })
    }

    /// Deterministic key from a 32-byte seed. Tests and fixtures only.
    #[cfg(any(test, feature = "test-util"))]
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        use ring::signature::KeyPair as _;
        #[allow(clippy::unwrap_used)]
        let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(seed).unwrap();
        #[allow(clippy::unwrap_used)]
        let public = PublicKey::from_slice(pair.public_key().as_ref()).unwrap();
        Self { pair, public }
    }

    pub fn public_key(&self) -> &PublicKey {
        &self.public
    }

    /// Signs a JSON body. The body is canonicalized here, so a caller cannot
    /// produce a document that fails step 6 of verification.
    pub fn sign(
        &self,
        purpose: Purpose,
        body: &serde_json::Value,
        certificate_der: Option<&[u8]>,
    ) -> Result<SignedDocument, SignedError> {
        let body_bytes = canonical::canonicalize(body).map_err(SignedError::NotCanonical)?;
        if body_bytes.len() > purpose.max_body_bytes() {
            return Err(SignedError::TooLarge);
        }
        let signature = self.pair.sign(&signing_input(purpose, &body_bytes));
        Ok(SignedDocument {
            format: FORMAT_V1.to_owned(),
            purpose,
            body: URL_SAFE_NO_PAD.encode(&body_bytes),
            signature: SignatureBlock {
                alg: ED25519.to_owned(),
                key_id: self.public.key_id(),
                value: URL_SAFE_NO_PAD.encode(signature.as_ref()),
            },
            certificate: certificate_der.map(|der| URL_SAFE_NO_PAD.encode(der)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key() -> SigningKey {
        SigningKey::from_seed(&[7u8; 32])
    }

    fn trust(key: &SigningKey) -> impl Fn(&str, Option<&[u8]>) -> Option<PublicKey> + '_ {
        move |id, _| (id == key.public_key().key_id()).then(|| key.public_key().clone())
    }

    #[test]
    fn sign_verify_round_trip() {
        let key = key();
        let doc = key
            .sign(Purpose::ServerChange, &json!({"b": 1, "a": "x"}), None)
            .expect("signed");
        let verified = doc
            .verify(Purpose::ServerChange, trust(&key))
            .expect("verifies");
        assert_eq!(verified.body_bytes, b"{\"a\":\"x\",\"b\":1}");
        let reparsed = SignedDocument::from_json_bytes(&doc.to_json_bytes()).expect("decodes");
        assert_eq!(reparsed, doc);
    }

    #[test]
    fn purpose_is_bound_into_signature() {
        let key = key();
        let mut doc = key
            .sign(Purpose::ServerSnapshot, &json!({"a": 1}), None)
            .expect("signed");
        assert_eq!(
            doc.verify(Purpose::ServerChange, trust(&key)).unwrap_err(),
            SignedError::WrongPurpose
        );
        doc.purpose = Purpose::ServerChange;
        assert_eq!(
            doc.verify(Purpose::ServerChange, trust(&key)).unwrap_err(),
            SignedError::BadSignature
        );
    }

    #[test]
    fn tampered_body_and_signature_are_rejected() {
        let key = key();
        let doc = key
            .sign(Purpose::ServerChange, &json!({"sequence": 1}), None)
            .expect("signed");

        let mut tampered = doc.clone();
        tampered.body = URL_SAFE_NO_PAD.encode(b"{\"sequence\":2}");
        assert_eq!(
            tampered
                .verify(Purpose::ServerChange, trust(&key))
                .unwrap_err(),
            SignedError::BadSignature
        );

        let mut bad_sig = doc.clone();
        bad_sig.signature.value = URL_SAFE_NO_PAD.encode([0u8; 64]);
        assert_eq!(
            bad_sig
                .verify(Purpose::ServerChange, trust(&key))
                .unwrap_err(),
            SignedError::BadSignature
        );

        let other = SigningKey::from_seed(&[8u8; 32]);
        assert_eq!(
            doc.verify(Purpose::ServerChange, trust(&other))
                .unwrap_err(),
            SignedError::UntrustedKey
        );
    }

    #[test]
    fn non_canonical_body_is_rejected_even_when_signed() {
        let key = key();
        let body = b"{\"b\":1,\"a\":2}";
        let signature = key.pair.sign(&signing_input(Purpose::ServerChange, body));
        let doc = SignedDocument {
            format: FORMAT_V1.to_owned(),
            purpose: Purpose::ServerChange,
            body: URL_SAFE_NO_PAD.encode(body),
            signature: SignatureBlock {
                alg: ED25519.to_owned(),
                key_id: key.public_key().key_id(),
                value: URL_SAFE_NO_PAD.encode(signature.as_ref()),
            },
            certificate: None,
        };
        assert_eq!(
            doc.verify(Purpose::ServerChange, trust(&key)).unwrap_err(),
            SignedError::NotCanonical(CanonicalError::NotCanonical)
        );
    }

    #[test]
    fn wrapper_rules() {
        let key = key();
        let doc = key
            .sign(Purpose::ServerChange, &json!({}), None)
            .expect("signed");
        let mut wrong_format = doc.clone();
        wrong_format.format = "tilecast-edge-signed-v2".into();
        assert_eq!(
            wrong_format
                .verify(Purpose::ServerChange, trust(&key))
                .unwrap_err(),
            SignedError::UnsupportedFormat
        );
        let mut with_cert = doc.clone();
        with_cert.certificate = Some("AA".into());
        assert_eq!(
            with_cert
                .verify(Purpose::ServerChange, trust(&key))
                .unwrap_err(),
            SignedError::Malformed
        );
        assert!(SignedDocument::from_json_bytes(b"{\"format\":1}").is_err());
        let mut extra = serde_json::to_value(&doc).expect("json");
        extra["unexpected"] = json!(true);
        assert!(
            SignedDocument::from_json_bytes(&serde_json::to_vec(&extra).expect("bytes")).is_err()
        );
        assert!(SignedDocument::from_json_bytes(&vec![b' '; MAX_DOCUMENT_BYTES + 1]).is_err());
    }
}
