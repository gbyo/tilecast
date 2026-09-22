//! Tilecast Edge wire contracts.
//!
//! This crate is the single Rust definition of every byte format that crosses
//! a Tilecast Edge process or machine boundary. It is organized into contract
//! families that do not depend on each other except through the shared
//! primitives:
//!
//! * **Shared primitives** — [`ids`], [`digest`], [`time`], [`bounded`],
//!   [`canonical`]. Strict parsing, one textual form per value.
//! * **Signed objects** — [`signed`]: the signed-document wrapper, server
//!   change envelopes ([`signed::change`]) and node statements
//!   ([`signed::statement`]). These travel between machines and are the only
//!   way authority crosses the LAN.
//! * **Capabilities** — [`capability`]: the versioned capability model shared
//!   by the daemon, the server API and Studio.
//! * **Context values** — [`context`]: typed Context Engine values as they
//!   appear on a wire. No evaluation lives here.
//! * **Local IPC** — [`ipc`]: the length-prefixed daemon ↔ renderer/CLI
//!   protocol. It never carries signed server documents or credentials to a
//!   renderer; it carries prepared, already-verified presentation state.
//!
//! Rules for anything added here:
//!
//! * Every wire struct rejects unknown fields. Additions need a new schema or
//!   protocol version, or a feature negotiated during the IPC handshake.
//! * Every string and collection that arrives from another process has an
//!   explicit bound, enforced during deserialization.
//! * Nothing in this crate performs I/O. Crates above it own sockets, files
//!   and databases.
//! * Golden fixtures for these formats live in `packages/edge-protocol` and
//!   are shared with the Go server and TypeScript clients. A change here that
//!   alters bytes on the wire must update those fixtures in the same commit.

pub mod bounded;
pub mod canonical;
pub mod capability;
pub mod context;
pub mod digest;
pub mod ids;
pub mod ipc;
pub mod signed;
pub mod time;

pub use digest::Sha256Digest;
pub use ids::{InstallationId, NodeId, ScreenId};
pub use time::Timestamp;

/// Version of the Tilecast Edge mesh protocol this build speaks. It is
/// reported to the server during enrollment and advertised in node summaries;
/// peers with a different mesh version do not exchange statements.
pub const MESH_PROTOCOL_VERSION: u32 = 1;
