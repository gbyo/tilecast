//! Shared native Player semantic values. This crate performs no I/O.
//!
//! Hosts supply randomness and clock implementations. Edge wire framing,
//! session identity, and transport remain in the Edge protocol crate.

pub mod bounded;
pub mod capability;
pub mod digest;
pub mod ids;
pub mod time;

pub use digest::Sha256Digest;
pub use ids::{ActivationId, InstallationId, PlayerId, ScreenId};
pub use time::Timestamp;
