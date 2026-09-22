//! Tilecast Edge LAN fabric on Zenoh (RFC §13, §15.5).
//!
//! * [`config`]: peer-mode, TLS-only Zenoh configuration from the node's
//!   Edge credentials;
//! * [`keys`]: the installation-scoped keyspace;
//! * [`mesh`]: presence, signed node statements, object-availability
//!   queries and server-change hints.
//!
//! The mesh is transport and wake-up only. It never carries media, never
//! makes a peer authoritative for server state, and never implies trust from
//! discovery: Zenoh links require mutual TLS against the installation CA, and
//! every statement is verified against the certificate, installation and
//! revocation set before use.

pub mod config;
pub mod keys;
pub mod mesh;

pub use config::{Multicast, Transport};
pub use mesh::{Mesh, MeshError, MeshEvent, MeshIdentity, MeshLocal, NodeSummary, ObjectHolder};
