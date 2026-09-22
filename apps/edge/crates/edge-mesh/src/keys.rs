//! The installation-scoped Zenoh keyspace (RFC §13.6).
//!
//! ```text
//! tilecast/<installation>/nodes/<node>/liveliness
//! tilecast/<installation>/nodes/<node>/summary        (signed statement)
//! tilecast/<installation>/nodes/<node>/capabilities   (signed statement)
//! tilecast/<installation>/changes/latest              (server-signed change hint)
//! tilecast/<installation>/changes/query               (?after=<sequence>)
//! tilecast/<installation>/objects/has/<sha256>        (query; signed replies)
//! ```
//!
//! The namespace is not a security boundary: every payload is verified by
//! signature, and a statement is accepted only on its own node's keys.
//! Subscriptions use the narrowest expression that works.

use edge_protocol::{InstallationId, NodeId, Sha256Digest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keyspace {
    root: String,
}

/// Which per-node key a sample arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKey {
    Liveliness,
    Summary,
    Capabilities,
}

impl NodeKey {
    fn suffix(&self) -> &'static str {
        match self {
            Self::Liveliness => "liveliness",
            Self::Summary => "summary",
            Self::Capabilities => "capabilities",
        }
    }
}

impl Keyspace {
    pub fn new(installation: InstallationId) -> Self {
        Self { root: format!("tilecast/{installation}") }
    }

    pub fn node(&self, node: NodeId, key: NodeKey) -> String {
        format!("{}/nodes/{node}/{}", self.root, key.suffix())
    }

    /// `tilecast/<installation>/nodes/*/<suffix>`.
    pub fn every_node(&self, key: NodeKey) -> String {
        format!("{}/nodes/*/{}", self.root, key.suffix())
    }

    pub fn changes_latest(&self) -> String {
        format!("{}/changes/latest", self.root)
    }

    pub fn changes_query(&self) -> String {
        format!("{}/changes/query", self.root)
    }

    pub fn object(&self, digest: &Sha256Digest) -> String {
        format!("{}/objects/has/{}", self.root, digest.to_hex())
    }

    pub fn every_object(&self) -> String {
        format!("{}/objects/has/*", self.root)
    }

    /// The node a per-node key names, if `key` is exactly such a key.
    pub fn parse_node(&self, key: &str, expected: NodeKey) -> Option<NodeId> {
        let rest = key.strip_prefix(&self.root)?.strip_prefix("/nodes/")?;
        let (node, suffix) = rest.split_once('/')?;
        (suffix == expected.suffix()).then(|| node.parse().ok()).flatten()
    }

    pub fn parse_object(&self, key: &str) -> Option<Sha256Digest> {
        let hex = key.strip_prefix(&self.root)?.strip_prefix("/objects/has/")?;
        Sha256Digest::parse(hex).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects_foreign_keys() {
        let installation = InstallationId::new_random();
        let keys = Keyspace::new(installation);
        let node = NodeId::new_random();
        let summary = keys.node(node, NodeKey::Summary);
        assert_eq!(keys.parse_node(&summary, NodeKey::Summary), Some(node));
        assert_eq!(keys.parse_node(&summary, NodeKey::Capabilities), None);
        let other = Keyspace::new(InstallationId::new_random());
        assert_eq!(other.parse_node(&summary, NodeKey::Summary), None);
        assert_eq!(keys.parse_node(&format!("{summary}/extra"), NodeKey::Summary), None);
        let digest = Sha256Digest::of(b"x");
        assert_eq!(keys.parse_object(&keys.object(&digest)), Some(digest));
    }
}
