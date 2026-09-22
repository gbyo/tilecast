//! Node statements (`purpose = node.statement`).
//!
//! A node statement is something one Edge node says about itself: its
//! summary, its capability snapshot, that it holds an object. Statements are
//! signed with the node key and carry the node certificate, so any receiver
//! can check who said it without a directory lookup. They are **never**
//! authoritative: a statement can make a node try a peer first or show a peer
//! in diagnostics; it cannot change what a node plays, trusts or executes.
//!
//! Body (schema 1):
//!
//! ```json
//! {
//!   "schema": 1,
//!   "installationId": "…",
//!   "nodeId": "…",
//!   "type": "node.summary",
//!   "issuedAt": "2026-09-22T19:00:00Z",
//!   "expiresAt": "2026-09-22T19:05:00Z",
//!   "payload": {}
//! }
//! ```
//!
//! The certificate checks (chain to the installation Edge CA, installation
//! and node SANs, revocation) belong to `edge-identity`, which supplies the
//! key resolver passed to [`verify_statement`]. This module enforces the
//! body rules: schema, installation, node binding and a short lifetime, which
//! bounds how long a captured statement can be replayed.

use serde::{Deserialize, Serialize};

use super::{PublicKey, Purpose, SignedDocument, SignedError, SigningKey};
use crate::bounded::Token;
use crate::ids::{InstallationId, NodeId};
use crate::time::Timestamp;

pub const STATEMENT_SCHEMA_V1: u32 = 1;
/// Longest lifetime a statement may declare.
pub const MAX_STATEMENT_LIFETIME_SECONDS: i64 = 600;
/// Clock skew tolerated between nodes when judging `issuedAt`.
pub const MAX_STATEMENT_SKEW_SECONDS: i64 = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatementBody {
    pub schema: u32,
    pub installation_id: InstallationId,
    pub node_id: NodeId,
    #[serde(rename = "type")]
    pub statement_type: Token<64>,
    pub issued_at: Timestamp,
    pub expires_at: Timestamp,
    pub payload: serde_json::Map<String, serde_json::Value>,
}

/// Statement types defined in schema 1.
pub mod types {
    /// Bounded node summary (version, endpoints, load, capability revision).
    pub const NODE_SUMMARY: &str = "node.summary";
    /// The node's full capability snapshot.
    pub const NODE_CAPABILITIES: &str = "node.capabilities";
    /// Reply to an object-availability query: the node holds a verified,
    /// peerable object.
    pub const OBJECT_AVAILABILITY: &str = "object.availability";
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StatementError {
    #[error(transparent)]
    Signed(#[from] SignedError),
    #[error("statement body does not match schema {STATEMENT_SCHEMA_V1}")]
    InvalidBody,
    #[error("statement belongs to another installation")]
    WrongInstallation,
    #[error("statement node does not match its certificate")]
    NodeMismatch,
    #[error("statement is expired or not yet valid")]
    Stale,
}

/// Identity established by the caller's certificate check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementSigner {
    pub node_id: NodeId,
    pub public_key: PublicKey,
}

#[derive(Debug, Clone)]
pub struct VerifiedStatement {
    pub body: StatementBody,
    pub signer: StatementSigner,
}

/// Verifies a statement. `check_certificate` receives the certificate DER
/// and returns the identity it proves, or `None` to reject.
pub fn verify_statement<F>(
    document: &SignedDocument,
    installation_id: InstallationId,
    now: Timestamp,
    check_certificate: F,
) -> Result<VerifiedStatement, StatementError>
where
    F: FnOnce(&[u8]) -> Option<StatementSigner>,
{
    let mut signer = None;
    let verified = document.verify(Purpose::NodeStatement, |_, certificate| {
        let identity = check_certificate(certificate?)?;
        let key = identity.public_key.clone();
        signer = Some(identity);
        Some(key)
    })?;
    let signer = signer.ok_or(StatementError::Signed(SignedError::UntrustedKey))?;
    let body: StatementBody = serde_json::from_value(verified.body).map_err(|_| StatementError::InvalidBody)?;
    if body.schema != STATEMENT_SCHEMA_V1 {
        return Err(StatementError::InvalidBody);
    }
    if body.installation_id != installation_id {
        return Err(StatementError::WrongInstallation);
    }
    if body.node_id != signer.node_id {
        return Err(StatementError::NodeMismatch);
    }
    let lifetime = body.expires_at.since(body.issued_at).whole_seconds();
    let skewed_now = now.saturating_add(time::Duration::seconds(MAX_STATEMENT_SKEW_SECONDS));
    if lifetime <= 0
        || lifetime > MAX_STATEMENT_LIFETIME_SECONDS
        || body.expires_at <= now
        || body.issued_at > skewed_now
    {
        return Err(StatementError::Stale);
    }
    Ok(VerifiedStatement { body, signer })
}

/// The fields of a statement a node is about to sign.
#[derive(Debug, Clone)]
pub struct StatementDraft<'a> {
    pub installation_id: InstallationId,
    pub node_id: NodeId,
    pub statement_type: &'a str,
    pub now: Timestamp,
    pub lifetime_seconds: i64,
    pub payload: serde_json::Map<String, serde_json::Value>,
}

/// Builds and signs a statement for this node.
pub fn sign_statement(
    key: &SigningKey,
    certificate_der: &[u8],
    draft: StatementDraft<'_>,
) -> Result<SignedDocument, SignedError> {
    let lifetime = draft.lifetime_seconds.clamp(1, MAX_STATEMENT_LIFETIME_SECONDS);
    let issued_at = draft.now.truncate_to_seconds();
    let body = serde_json::json!({
        "schema": STATEMENT_SCHEMA_V1,
        "installationId": draft.installation_id,
        "nodeId": draft.node_id,
        "type": draft.statement_type,
        "issuedAt": issued_at.to_signed_form(),
        "expiresAt": issued_at.saturating_add(time::Duration::seconds(lifetime)).to_signed_form(),
        "payload": draft.payload,
    });
    key.sign(Purpose::NodeStatement, &body, Some(certificate_der))
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTALLATION: &str = "5a0b8f3e-2c1d-4e6f-8a9b-0c1d2e3f4a5b";
    const NODE: &str = "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a";

    fn now() -> Timestamp {
        Timestamp::parse("2026-09-22T19:00:00Z").expect("time")
    }

    fn signer(key: &SigningKey) -> StatementSigner {
        StatementSigner { node_id: NODE.parse().expect("node"), public_key: key.public_key().clone() }
    }

    fn statement(key: &SigningKey, node: &str) -> SignedDocument {
        sign_statement(
            key,
            b"fake-der",
            StatementDraft {
                installation_id: INSTALLATION.parse().expect("id"),
                node_id: node.parse().expect("node"),
                statement_type: types::NODE_SUMMARY,
                now: now(),
                lifetime_seconds: 300,
                payload: serde_json::Map::new(),
            },
        )
        .expect("sign")
    }

    #[test]
    fn verifies_and_binds_node_to_certificate() {
        let key = SigningKey::from_seed(&[3u8; 32]);
        let installation = INSTALLATION.parse().expect("id");
        let ok = verify_statement(&statement(&key, NODE), installation, now(), |der| {
            assert_eq!(der, b"fake-der");
            Some(signer(&key))
        })
        .expect("valid");
        assert_eq!(ok.body.statement_type.as_str(), types::NODE_SUMMARY);

        // A valid certificate cannot speak for another node ID.
        let other_node = "2f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a";
        assert_eq!(
            verify_statement(&statement(&key, other_node), installation, now(), |_| Some(signer(&key))).unwrap_err(),
            StatementError::NodeMismatch
        );
    }

    #[test]
    fn rejects_expired_future_and_foreign_statements() {
        let key = SigningKey::from_seed(&[3u8; 32]);
        let installation: InstallationId = INSTALLATION.parse().expect("id");
        let doc = statement(&key, NODE);
        let later = now().saturating_add(time::Duration::seconds(301));
        assert_eq!(
            verify_statement(&doc, installation, later, |_| Some(signer(&key))).unwrap_err(),
            StatementError::Stale
        );
        let earlier = now().saturating_sub(time::Duration::seconds(600));
        assert_eq!(
            verify_statement(&doc, installation, earlier, |_| Some(signer(&key))).unwrap_err(),
            StatementError::Stale
        );
        let foreign: InstallationId = "00000000-0000-4000-8000-000000000000".parse().expect("id");
        assert_eq!(
            verify_statement(&doc, foreign, now(), |_| Some(signer(&key))).unwrap_err(),
            StatementError::WrongInstallation
        );
        assert!(matches!(
            verify_statement(&doc, installation, now(), |_| None),
            Err(StatementError::Signed(SignedError::UntrustedKey))
        ));
    }
}
