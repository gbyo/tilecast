//! Tilecast Edge wire contracts.
//!
//! This crate is the single Rust definition of every byte format that crosses
//! a Tilecast Edge process boundary. It is organized into contract families
//! that do not depend on each other except through the shared primitives:
//!
//! * **Shared primitives** — [`ids`], [`digest`], [`time`], [`bounded`].
//!   Strict parsing, one textual form per value.
//! * **Capabilities** — [`capability`]: the versioned capability model the
//!   daemon uses to decide what this device can do.
//! * **Local IPC** — [`ipc`]: the length-prefixed daemon ↔ renderer/CLI
//!   protocol. It never carries credentials or server responses to a
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
//!   are shared with the renderer. A change here that alters bytes on the
//!   wire must update those fixtures in the same commit.

pub mod bounded;
pub mod capability;
pub mod digest;
pub mod ids;
pub mod ipc;
pub mod time;

pub use digest::Sha256Digest;
pub use ids::{InstallationId, PlayerId, ScreenId};
pub use time::Timestamp;
