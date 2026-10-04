//! Tilecast Edge's relationship with the Tilecast Server.
//!
//! The server stays the single authority (docs/tilecast-edge.md §8.1).
//! Portable transport and credential values live in player-client. This crate
//! owns Linux stores, legacy import, and temporary CAS origin glue. It sends credentials
//! only through an [`client::AuthenticatedServer`], which exists only after
//! public installation identity was verified.
//!
//! * [`url_policy`]: the player's server-address rules.
//! * [`credential`]: the device bearer credential at rest.
//! * [`client`]: REST client and the identity gate.
//! * [`pairing`]: pairing a fresh installation and the private session file.
//! * [`player_api`]: validated player configuration and command contracts.
//! * [`updates`]: Player update metadata and deployment status reports (M10).
//! * [`legacy`]: one-time import of Electron Linux Player state.
//! * [`origin`]: the server as a content-addressed store source.

pub mod client;
pub mod credential;
pub mod legacy;
pub mod live_stream;
pub mod origin;
pub mod pairing;
pub mod player_api;
pub mod updates;
pub mod url_policy;

pub use client::{AuthenticatedServer, ServerClient, ServerError, ServerIdentity};
pub use credential::{CredentialStore, DeviceCredential, FileCredentialStore};
pub use pairing::{FilePairingStore, PairingStore};
