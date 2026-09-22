//! Tilecast Edge peer content delivery (RFC §14).
//!
//! Bytes move between nodes over HTTPS with mutual TLS, never over Zenoh.
//! Zenoh (`edge-mesh`) only answers "who has this hash"; this crate:
//!
//! * [`server`]: the read-only peer blob service (`HEAD`/`GET
//!   /v1/blobs/sha256/<hash>`, single ranges, peerable objects only);
//! * [`client`]: a peer as an `edge_cas::BlobSource`;
//! * [`selector`]: peer ranking, cooldown and per-object suppression;
//! * [`range`]: the strict single-range parser.
//!
//! Trust is never implied by discovery: every connection runs
//! `edge_identity::verify_peer` in both directions, and every received byte
//! is verified by the content store before it can be used or re-served.

pub mod client;
pub mod range;
pub mod selector;
pub mod server;

pub use client::{PeerBlobSource, PeerEndpoint};
pub use selector::{PeerCandidate, PeerSelector};
pub use server::{BlobServerLimits, PeerBlobServer, TransferGauge};
