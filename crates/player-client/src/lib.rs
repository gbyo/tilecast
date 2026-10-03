//! Portable native Player relationship with Tilecast Server.
//! Only AuthenticatedServer may send a device credential, after installation
//! identity verification. Hosts supply product facts and private storage.
pub mod client;
pub mod credential;
pub mod download;
pub mod live_stream;
pub mod pairing;
pub mod player_api;
pub mod updates;
pub mod url_policy;
pub use client::{AuthenticatedServer, ServerClient, ServerError, ServerIdentity};
pub use credential::{CredentialError, CredentialStore, DeviceCredential};
pub use pairing::{PairingSession, PairingStore};
