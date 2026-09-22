//! Server snapshots (`purpose = server.snapshot`).
//!
//! A snapshot is a signed statement of current server state that is not a
//! feed entry. Schema 1 defines one type:
//!
//! ```json
//! {
//!   "schema": 1,
//!   "installationId": "…",
//!   "authorityEpoch": 1,
//!   "type": "edge.revocation.snapshot",
//!   "asOfSequence": 1240,
//!   "generation": 8,
//!   "issuedAt": "2026-09-22T19:05:00Z",
//!   "revoked": [{"nodeId": "…", "certificatesExpireAt": "2027-03-21T19:05:00Z"}]
//! }
//! ```
//!
//! A node adopts a revocation snapshot at enrollment (so it rejects peers
//! revoked before it joined) and whenever its feed position is older than the
//! server's retention. Snapshots only ever add knowledge: a node keeps any
//! revocation it already holds until that node's certificates expire, and
//! ignores a snapshot whose generation is older than the one it has.

use serde::{Deserialize, Serialize};

use super::change::{AuthorityTrust, ChangeError};
use super::{Purpose, SignedDocument};
use crate::bounded::{Token, bounded_vec};
use crate::ids::{InstallationId, NodeId};
use crate::time::Timestamp;

pub const SNAPSHOT_SCHEMA_V1: u32 = 1;
pub const REVOCATION_SNAPSHOT: &str = "edge.revocation.snapshot";
pub const MAX_REVOKED: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokedNode {
    pub node_id: NodeId,
    pub certificates_expire_at: Timestamp,
}

fn revoked<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<RevokedNode>, D::Error> {
    bounded_vec(d, MAX_REVOKED)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevocationSnapshot {
    pub schema: u32,
    pub installation_id: InstallationId,
    pub authority_epoch: u32,
    #[serde(rename = "type")]
    pub snapshot_type: Token<64>,
    pub as_of_sequence: u64,
    pub generation: u64,
    pub issued_at: Timestamp,
    #[serde(deserialize_with = "revoked")]
    pub revoked: Vec<RevokedNode>,
}

/// Verifies a revocation snapshot for this installation.
pub fn verify_revocation_snapshot(
    document: &SignedDocument,
    trust: &AuthorityTrust,
) -> Result<RevocationSnapshot, ChangeError> {
    let mut epoch = None;
    let verified = document.verify(Purpose::ServerSnapshot, |key_id, _| {
        trust.resolve(key_id).map(|key| {
            epoch = Some(key.epoch);
            key.public_key.clone()
        })
    })?;
    let snapshot: RevocationSnapshot = serde_json::from_value(verified.body).map_err(|_| ChangeError::InvalidBody)?;
    if snapshot.schema != SNAPSHOT_SCHEMA_V1 {
        return Err(ChangeError::UnsupportedSchema(u64::from(snapshot.schema)));
    }
    if snapshot.snapshot_type.as_str() != REVOCATION_SNAPSHOT {
        return Err(ChangeError::InvalidBody);
    }
    if snapshot.installation_id != trust.installation_id {
        return Err(ChangeError::WrongInstallation);
    }
    if Some(snapshot.authority_epoch) != epoch {
        return Err(ChangeError::EpochMismatch);
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signed::SigningKey;
    use crate::signed::change::AuthorityKey;
    use serde_json::json;

    const INSTALLATION: &str = "5a0b8f3e-2c1d-4e6f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn verifies_and_rejects_wrong_purpose() {
        let key = SigningKey::from_seed(&[9u8; 32]);
        let trust = AuthorityTrust {
            installation_id: INSTALLATION.parse().expect("id"),
            keys: vec![AuthorityKey { epoch: 1, public_key: key.public_key().clone() }],
        };
        let body = json!({
            "schema": 1, "installationId": INSTALLATION, "authorityEpoch": 1,
            "type": REVOCATION_SNAPSHOT, "asOfSequence": 3, "generation": 2,
            "issuedAt": "2026-09-22T19:05:00Z",
            "revoked": [{"nodeId": "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a", "certificatesExpireAt": "2027-03-21T19:05:00Z"}]
        });
        let document = key.sign(Purpose::ServerSnapshot, &body, None).expect("sign");
        let snapshot = verify_revocation_snapshot(&document, &trust).expect("valid");
        assert_eq!(snapshot.revoked.len(), 1);
        let as_change = key.sign(Purpose::ServerChange, &body, None).expect("sign");
        assert!(verify_revocation_snapshot(&as_change, &trust).is_err());
    }
}
