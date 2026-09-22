//! Server change envelopes (`purpose = server.change`).
//!
//! A change envelope is the only way a server decision can reach an Edge node
//! through another node. Its canonical body (schema 1) is:
//!
//! ```json
//! {
//!   "schema": 1,
//!   "installationId": "…",
//!   "authorityEpoch": 1,
//!   "sequence": 1234,
//!   "previousSequence": 1229,
//!   "type": "screen.presentation.changed",
//!   "target": {"kind": "screen", "id": "…"},
//!   "object": {"sha256": "…", "sizeBytes": 18241, "kind": "presentation_bundle"},
//!   "revocationGeneration": 7,
//!   "issuedAt": "2026-09-22T19:00:00Z",
//!   "expiresAt": null,
//!   "payload": {}
//! }
//! ```
//!
//! # Sequence semantics (RFC Amendment A1.5)
//!
//! * `sequence` is the server's signed publication order. It is strictly
//!   increasing and may skip integers. A missing integer means nothing.
//! * `previousSequence` is the sequence of the change the server published
//!   immediately before this one (0 for the first). Because it is signed, a
//!   node that holds change *N* can prove whether it has seen every change up
//!   to *N*: it has, exactly when it can walk the `previousSequence` links
//!   back to the last sequence it applied.
//! * A node applies a change only when `previousSequence` equals its last
//!   applied sequence ([`ChainPosition::classify`]). A change that links to
//!   something unseen is held while the node fetches `after=<last>` from a
//!   peer or the server. The server's feed is authoritative; a peer that
//!   withholds a change can delay a node, never make it skip one.
//! * A node's first position comes from an authoritative server read (the
//!   `latestSequence` returned with Edge configuration or a signed snapshot),
//!   never from a peer.
//!
//! # Versioning
//!
//! * An unknown `schema` fails verification. The node stops at that change
//!   and reports it; it does not skip past something it cannot read.
//! * An unknown `type` with a known schema verifies and advances the chain
//!   but has no effect ([`ChangeType::Unknown`]). The server must not publish
//!   a type a node has to understand before that node advertises support.
//! * `expiresAt` is advisory for relays: an expired change still advances the
//!   chain, but its effect is skipped. Expiry is judged with the node's best
//!   clock by the caller; verification here never consults a clock.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{PublicKey, Purpose, SignedDocument, SignedError};
use crate::bounded::Token;
use crate::digest::Sha256Digest;
use crate::ids::{InstallationId, canonical_uuid_option};
use crate::time::Timestamp;

pub const CHANGE_SCHEMA_V1: u32 = 1;

/// Largest serialized `payload` object inside a change body.
pub const MAX_PAYLOAD_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Installation,
    Screen,
    DisplayGroup,
    Node,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeTarget {
    pub kind: TargetKind,
    #[serde(with = "canonical_uuid_option")]
    pub id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectRef {
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
    pub kind: Token<48>,
}

/// Known change types. New types are additive; see module docs.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ChangeType {
    ScreenPresentationChanged,
    ScreenConfigurationChanged,
    /// Hint only: commands are still fetched and acknowledged over the
    /// authenticated server API.
    ScreenCommandAvailable,
    ContentObjectPublished,
    ContextDefinitionChanged,
    ContextServerValueChanged,
    EdgeMeshConfigurationChanged,
    EdgeNodeRevoked,
    EdgeReleaseAvailable,
    PlayerReleaseAvailable,
    OrganizationBrandingChanged,
    Unknown(String),
}

impl ChangeType {
    pub fn parse(value: &str) -> Self {
        match value {
            "screen.presentation.changed" => Self::ScreenPresentationChanged,
            "screen.configuration.changed" => Self::ScreenConfigurationChanged,
            "screen.command.available" => Self::ScreenCommandAvailable,
            "content.object.published" => Self::ContentObjectPublished,
            "context.definition.changed" => Self::ContextDefinitionChanged,
            "context.server-value.changed" => Self::ContextServerValueChanged,
            "edge.mesh.configuration.changed" => Self::EdgeMeshConfigurationChanged,
            "edge.node.revoked" => Self::EdgeNodeRevoked,
            "edge.release.available" => Self::EdgeReleaseAvailable,
            "player.release.available" => Self::PlayerReleaseAvailable,
            "organization.branding.changed" => Self::OrganizationBrandingChanged,
            other => Self::Unknown(other.to_owned()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::ScreenPresentationChanged => "screen.presentation.changed",
            Self::ScreenConfigurationChanged => "screen.configuration.changed",
            Self::ScreenCommandAvailable => "screen.command.available",
            Self::ContentObjectPublished => "content.object.published",
            Self::ContextDefinitionChanged => "context.definition.changed",
            Self::ContextServerValueChanged => "context.server-value.changed",
            Self::EdgeMeshConfigurationChanged => "edge.mesh.configuration.changed",
            Self::EdgeNodeRevoked => "edge.node.revoked",
            Self::EdgeReleaseAvailable => "edge.release.available",
            Self::PlayerReleaseAvailable => "player.release.available",
            Self::OrganizationBrandingChanged => "organization.branding.changed",
            Self::Unknown(other) => other,
        }
    }
}

/// The schema-1 body exactly as signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeBody {
    pub schema: u32,
    pub installation_id: InstallationId,
    pub authority_epoch: u32,
    pub sequence: u64,
    pub previous_sequence: u64,
    #[serde(rename = "type")]
    pub change_type: Token<64>,
    pub target: ChangeTarget,
    pub object: Option<ObjectRef>,
    pub revocation_generation: u64,
    pub issued_at: Timestamp,
    pub expires_at: Option<Timestamp>,
    pub payload: serde_json::Map<String, serde_json::Value>,
}

/// Payload of `edge.node.revoked`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRevokedPayload {
    pub node_id: crate::ids::NodeId,
    #[serde(with = "canonical_uuid_option")]
    pub screen_id: Option<Uuid>,
    /// Latest `notAfter` among the revoked node's certificates. Once this
    /// passes, the revocation entry can be forgotten because certificate
    /// expiry rejects the node anyway.
    pub certificates_expire_at: Timestamp,
}

/// One trusted Edge authority key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityKey {
    pub epoch: u32,
    pub public_key: PublicKey,
}

/// What a node trusts for server-signed documents. Pinned at enrollment and
/// changed only through an authenticated server response, never by a peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityTrust {
    pub installation_id: InstallationId,
    pub keys: Vec<AuthorityKey>,
}

impl AuthorityTrust {
    pub fn resolve(&self, key_id: &str) -> Option<&AuthorityKey> {
        self.keys.iter().find(|key| key.public_key.key_id() == key_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChangeError {
    #[error(transparent)]
    Signed(#[from] SignedError),
    #[error("change body does not match schema {CHANGE_SCHEMA_V1}")]
    InvalidBody,
    #[error("unsupported change schema {0}")]
    UnsupportedSchema(u64),
    #[error("change belongs to another installation")]
    WrongInstallation,
    #[error("change was signed with a key from a different authority epoch")]
    EpochMismatch,
    #[error("change sequence links are invalid")]
    InvalidSequence,
    #[error("change payload is too large")]
    PayloadTooLarge,
}

/// A change whose signature, encoding, schema and installation are verified.
#[derive(Debug, Clone)]
pub struct VerifiedChange {
    pub body: ChangeBody,
    pub change_type: ChangeType,
    /// SHA-256 of the canonical body. Two different digests for one sequence
    /// is an authority fault and must be reported, not resolved.
    pub body_digest: Sha256Digest,
    /// The original wrapper, retained so it can be relayed byte-for-byte.
    pub document: SignedDocument,
}

impl VerifiedChange {
    pub fn is_expired(&self, now: Timestamp) -> bool {
        self.body.expires_at.is_some_and(|expires| expires <= now)
    }
}

/// Verifies a server change envelope for this node's installation.
pub fn verify_change(document: &SignedDocument, trust: &AuthorityTrust) -> Result<VerifiedChange, ChangeError> {
    let mut signer_epoch = None;
    let verified = document.verify(Purpose::ServerChange, |key_id, _| {
        trust.resolve(key_id).map(|key| {
            signer_epoch = Some(key.epoch);
            key.public_key.clone()
        })
    })?;

    // Check the schema number before strict decoding so a future schema is
    // reported as such rather than as a malformed body.
    let schema = verified.body.get("schema").and_then(serde_json::Value::as_u64).ok_or(ChangeError::InvalidBody)?;
    if schema != u64::from(CHANGE_SCHEMA_V1) {
        return Err(ChangeError::UnsupportedSchema(schema));
    }
    let body: ChangeBody = serde_json::from_value(verified.body).map_err(|_| ChangeError::InvalidBody)?;
    if body.installation_id != trust.installation_id {
        return Err(ChangeError::WrongInstallation);
    }
    if Some(body.authority_epoch) != signer_epoch {
        return Err(ChangeError::EpochMismatch);
    }
    if body.sequence == 0 || body.previous_sequence >= body.sequence {
        return Err(ChangeError::InvalidSequence);
    }
    if serde_json::to_vec(&body.payload).map_or(usize::MAX, |bytes| bytes.len()) > MAX_PAYLOAD_BYTES {
        return Err(ChangeError::PayloadTooLarge);
    }
    Ok(VerifiedChange {
        change_type: ChangeType::parse(body.change_type.as_str()),
        body,
        body_digest: verified.body_digest,
        document: document.clone(),
    })
}

/// A node's position in the signed feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChainPosition {
    /// Greatest sequence this node has applied (or adopted as its baseline
    /// from an authoritative server read). 0 means "no baseline yet".
    pub last_sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainDecision {
    /// At or before the current position. Compare digests with the stored
    /// entry: equal is a harmless duplicate, different is an authority fault.
    AlreadySeen,
    /// Links directly to the current position; apply it now.
    Next,
    /// Links to a publication this node has not seen. Hold it and fetch
    /// changes after `after` until the chain closes.
    Missing { after: u64, up_to: u64 },
}

impl ChainPosition {
    pub fn classify(&self, change: &ChangeBody) -> ChainDecision {
        if change.sequence <= self.last_sequence {
            ChainDecision::AlreadySeen
        } else if change.previous_sequence == self.last_sequence {
            ChainDecision::Next
        } else {
            ChainDecision::Missing { after: self.last_sequence, up_to: change.sequence }
        }
    }

    pub fn advance(&mut self, change: &ChangeBody) {
        debug_assert_eq!(self.classify(change), ChainDecision::Next);
        self.last_sequence = change.sequence;
    }
}

/// Bounded holding area for verified changes that arrived ahead of the chain
/// (usually relayed by a peer). Draining yields every held change that now
/// links, in order.
#[derive(Debug, Default)]
pub struct PendingChanges {
    by_previous: BTreeMap<u64, VerifiedChange>,
}

impl PendingChanges {
    pub const MAX_HELD: usize = 256;

    /// Holds a change. When full, the change furthest from the current
    /// position is dropped: it will be fetched again from the feed.
    pub fn hold(&mut self, change: VerifiedChange) {
        self.by_previous.insert(change.body.previous_sequence, change);
        while self.by_previous.len() > Self::MAX_HELD {
            let Some(last) = self.by_previous.keys().next_back().copied() else {
                break;
            };
            self.by_previous.remove(&last);
        }
    }

    /// Removes and returns the held change that links to `position`, if any.
    pub fn take_next(&mut self, position: ChainPosition) -> Option<VerifiedChange> {
        self.by_previous.remove(&position.last_sequence)
    }

    /// Discards held changes at or before `position`.
    pub fn prune(&mut self, position: ChainPosition) {
        self.by_previous.retain(|_, change| change.body.sequence > position.last_sequence);
    }

    pub fn len(&self) -> usize {
        self.by_previous.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_previous.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signed::SigningKey;
    use serde_json::json;

    const INSTALLATION: &str = "5a0b8f3e-2c1d-4e6f-8a9b-0c1d2e3f4a5b";

    fn body(sequence: u64, previous: u64) -> serde_json::Value {
        json!({
            "schema": 1,
            "installationId": INSTALLATION,
            "authorityEpoch": 1,
            "sequence": sequence,
            "previousSequence": previous,
            "type": "screen.presentation.changed",
            "target": {"kind": "screen", "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7"},
            "object": null,
            "revocationGeneration": 0,
            "issuedAt": "2026-09-22T19:00:00Z",
            "expiresAt": null,
            "payload": {}
        })
    }

    fn setup() -> (SigningKey, AuthorityTrust) {
        let key = SigningKey::from_seed(&[1u8; 32]);
        let trust = AuthorityTrust {
            installation_id: INSTALLATION.parse().expect("id"),
            keys: vec![AuthorityKey { epoch: 1, public_key: key.public_key().clone() }],
        };
        (key, trust)
    }

    fn signed(key: &SigningKey, value: serde_json::Value) -> SignedDocument {
        key.sign(Purpose::ServerChange, &value, None).expect("sign")
    }

    #[test]
    fn verifies_valid_change() {
        let (key, trust) = setup();
        let change = verify_change(&signed(&key, body(5, 3)), &trust).expect("valid");
        assert_eq!(change.change_type, ChangeType::ScreenPresentationChanged);
        assert_eq!(change.body.sequence, 5);
    }

    #[test]
    fn rejects_wrong_installation_epoch_schema_and_links() {
        let (key, trust) = setup();
        let mut other = body(5, 3);
        other["installationId"] = json!("00000000-0000-4000-8000-000000000000");
        assert_eq!(verify_change(&signed(&key, other), &trust).unwrap_err(), ChangeError::WrongInstallation);

        let mut epoch = body(5, 3);
        epoch["authorityEpoch"] = json!(2);
        assert_eq!(verify_change(&signed(&key, epoch), &trust).unwrap_err(), ChangeError::EpochMismatch);

        let mut schema = body(5, 3);
        schema["schema"] = json!(2);
        assert_eq!(verify_change(&signed(&key, schema), &trust).unwrap_err(), ChangeError::UnsupportedSchema(2));

        assert_eq!(verify_change(&signed(&key, body(5, 5)), &trust).unwrap_err(), ChangeError::InvalidSequence);

        let mut extra = body(5, 3);
        extra["surprise"] = json!(1);
        assert_eq!(verify_change(&signed(&key, extra), &trust).unwrap_err(), ChangeError::InvalidBody);
    }

    #[test]
    fn peer_cannot_forge_or_alter() {
        let (_, trust) = setup();
        let forger = SigningKey::from_seed(&[2u8; 32]);
        assert!(matches!(
            verify_change(&signed(&forger, body(9, 5)), &trust),
            Err(ChangeError::Signed(SignedError::UntrustedKey))
        ));
    }

    #[test]
    fn unknown_type_verifies_but_is_marked_unknown() {
        let (key, trust) = setup();
        let mut future = body(6, 5);
        future["type"] = json!("screen.hologram.changed");
        let change = verify_change(&signed(&key, future), &trust).expect("valid");
        assert_eq!(change.change_type, ChangeType::Unknown("screen.hologram.changed".into()));
    }

    #[test]
    fn chain_uses_links_not_integer_contiguity() {
        let (key, trust) = setup();
        let decode = |seq, prev| verify_change(&signed(&key, body(seq, prev)), &trust).expect("valid");
        let mut position = ChainPosition { last_sequence: 10 };

        // Gap in integers, but the chain links: apply.
        let c14 = decode(14, 10);
        assert_eq!(position.classify(&c14.body), ChainDecision::Next);
        position.advance(&c14.body);

        // A peer relays 20, which links to 17: something is missing.
        let c20 = decode(20, 17);
        assert_eq!(position.classify(&c20.body), ChainDecision::Missing { after: 14, up_to: 20 });
        let mut pending = PendingChanges::default();
        pending.hold(c20);

        // The feed then supplies 17 (linking to 14); 20 becomes applicable.
        let c17 = decode(17, 14);
        assert_eq!(position.classify(&c17.body), ChainDecision::Next);
        position.advance(&c17.body);
        let next = pending.take_next(position).expect("20 links to 17");
        position.advance(&next.body);
        assert_eq!(position.last_sequence, 20);
        assert!(pending.is_empty());

        assert_eq!(position.classify(&decode(17, 14).body), ChainDecision::AlreadySeen);
    }

    #[test]
    fn pending_is_bounded() {
        let (key, trust) = setup();
        let mut pending = PendingChanges::default();
        for index in 0..(PendingChanges::MAX_HELD as u64 + 10) {
            let seq = 1_000 + index * 2 + 1;
            pending.hold(verify_change(&signed(&key, body(seq, seq - 1)), &trust).expect("valid"));
        }
        assert_eq!(pending.len(), PendingChanges::MAX_HELD);
    }
}
