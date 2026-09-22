//! Tilecast Edge's relationship with the Tilecast Server.
//!
//! The server stays the single authority (RFC §7). This crate is the only
//! place that holds the device credential, and it can send that credential
//! only through an [`client::AuthenticatedServer`], which exists only after
//! public installation identity was verified.
//!
//! * [`url_policy`]: the player's server-address rules.
//! * [`credential`]: the device bearer credential at rest.
//! * [`client`]: REST client and the identity gate.
//! * [`legacy`]: one-time import of Electron Linux Player state.
//! * [`enrollment`]: Edge key, CSR, certificate and trust pinning.
//! * [`feed`]: the signed change feed consumer.
//! * [`origin`]: the server as a content-addressed store source.

pub mod client;
pub mod credential;
pub mod enrollment;
pub mod feed;
pub mod legacy;
pub mod origin;
pub mod url_policy;

pub use client::{AuthenticatedServer, ServerClient, ServerError, ServerIdentity};
pub use credential::DeviceCredential;
