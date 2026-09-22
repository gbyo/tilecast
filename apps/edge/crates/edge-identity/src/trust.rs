//! Pinned trust material: the installation Edge CA and the revocation set.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use edge_protocol::signed::snapshot::RevocationSnapshot;
use edge_protocol::{InstallationId, NodeId, Sha256Digest, Timestamp};

/// The installation Edge CA a node pinned at enrollment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustAnchor {
    pub installation_id: InstallationId,
    pub ca_der: Vec<u8>,
}

impl TrustAnchor {
    pub fn fingerprint(&self) -> String {
        Sha256Digest::of(&self.ca_der).to_hex()
    }
}

/// Revoked peer node IDs, shared by every verifier in the process so an
/// update applies to the next handshake and the next statement immediately.
///
/// Entries are kept until every certificate of the revoked node has expired
/// (`forget_after`); after that certificate expiry rejects the node anyway.
#[derive(Debug, Clone, Default)]
pub struct RevocationSet {
    inner: Arc<RwLock<Inner>>,
}

#[derive(Debug, Default)]
struct Inner {
    generation: u64,
    revoked: HashMap<NodeId, Timestamp>,
}

impl RevocationSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_revoked(&self, node: &NodeId) -> bool {
        self.inner.read().unwrap_or_else(|p| p.into_inner()).revoked.contains_key(node)
    }

    pub fn generation(&self) -> u64 {
        self.inner.read().unwrap_or_else(|p| p.into_inner()).generation
    }

    /// Adds one revocation (from a verified `edge.node.revoked` change).
    pub fn revoke(&self, node: NodeId, forget_after: Timestamp, generation: u64) {
        let mut inner = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let entry = inner.revoked.entry(node).or_insert(forget_after);
        if forget_after > *entry {
            *entry = forget_after;
        }
        inner.generation = inner.generation.max(generation);
    }

    /// Merges a verified snapshot. Snapshots only add knowledge; an older
    /// generation is ignored entirely.
    pub fn apply_snapshot(&self, snapshot: &RevocationSnapshot) -> bool {
        let mut inner = self.inner.write().unwrap_or_else(|p| p.into_inner());
        if snapshot.generation < inner.generation {
            return false;
        }
        for entry in &snapshot.revoked {
            let current = inner.revoked.entry(entry.node_id).or_insert(entry.certificates_expire_at);
            if entry.certificates_expire_at > *current {
                *current = entry.certificates_expire_at;
            }
        }
        inner.generation = snapshot.generation;
        true
    }

    /// Forgets entries whose certificates have all expired.
    pub fn prune(&self, now: Timestamp) {
        self.inner.write().unwrap_or_else(|p| p.into_inner()).revoked.retain(|_, forget| *forget > now);
    }

    pub fn entries(&self) -> Vec<(NodeId, Timestamp)> {
        let inner = self.inner.read().unwrap_or_else(|p| p.into_inner());
        let mut entries: Vec<_> = inner.revoked.iter().map(|(k, v)| (*k, *v)).collect();
        entries.sort();
        entries
    }
}
