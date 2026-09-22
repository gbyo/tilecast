//! Tilecast Edge node identity (RFC §10–11).
//!
//! Three trust relationships exist and are never collapsed:
//!
//! 1. **Server ↔ node**: the existing device bearer credential. It is used
//!    only toward the Tilecast Server after installation identity is
//!    verified, and never leaves the node otherwise. Not handled here.
//! 2. **Node ↔ node**: installation-scoped mTLS certificates issued by the
//!    server's Edge CA for keys generated on the node ([`key`], [`csr`],
//!    [`certificate`], [`tls`]).
//! 3. **Server-signed data ↔ any node**: the Edge authority key, pinned at
//!    enrollment ([`trust`]); verification lives in
//!    `edge_protocol::signed`.
//!
//! # Invariants
//!
//! * The node private key is generated here, stored `0600` in the identity
//!   directory, and never serialized anywhere else: not to the server, not
//!   over IPC, not to peers, not to logs.
//! * A peer is accepted only when its certificate chains to *this node's
//!   pinned* installation CA, carries this installation's ID, names a node
//!   and the node purpose, and that node is not revoked
//!   ([`certificate::verify_peer`]). Hostnames and IP addresses are never
//!   part of the decision: being reachable proves nothing.
//! * Trust material changes only through an authenticated server response
//!   (enrollment, renewal, signed snapshot/changes), never from a peer.

pub mod certificate;
pub mod csr;
pub mod key;
pub mod renewal;
#[cfg(any(test, feature = "test-util"))]
pub mod testing;
pub mod tls;
pub mod trust;

pub use certificate::{EdgeIdentity, PeerRejection, verify_peer};
pub use key::NodeKey;
pub use trust::{RevocationSet, TrustAnchor};

/// URI SAN prefix for Tilecast Edge identities.
pub const URN_PREFIX: &str = "urn:tilecast:edge:";
/// Purpose SAN for node certificates.
pub const PURPOSE_NODE: &str = "urn:tilecast:edge:purpose:node";

pub fn urn(kind: &str, id: &str) -> String {
    format!("{URN_PREFIX}{kind}:{id}")
}
