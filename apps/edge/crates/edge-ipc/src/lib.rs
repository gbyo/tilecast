//! Tilecast Edge local IPC transport.
//!
//! [`server::IpcServer`] accepts local sessions for `tilecastd` and enforces
//! every rule in `edge_protocol::ipc` that does not depend on daemon state:
//! peer UID policy, handshake, version negotiation, role checks, direction
//! checks, per-direction event sequence numbers, frame bounds and outbound
//! backpressure. What a session *means* is decided by the daemon through
//! [`server::IpcHandler`].
//!
//! [`client::IpcClient`] is the matching Rust client used by `tilecastctl`
//! and by tests that stand in for a renderer. The C renderer implements the
//! same protocol independently against the shared fixtures.

pub mod client;
pub mod io;
pub mod server;

pub use server::{IpcHandler, IpcServer, PeerPolicy, SessionHandle};
