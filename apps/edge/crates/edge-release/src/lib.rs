//! Signed Tilecast Edge releases.
//!
//! * [`manifest`]: the M7 release manifest, signed with the Tilecast update
//!   key, that lists every file of a release tree.
//! * [`envelope`]: the M10 update envelope, signed with the same key, that
//!   binds a release archive to its manifest.
//! * [`protocol`]: the fixed request vocabulary of `tilecast-edge-update`.
//! * [`install`] and [`archive`] (feature `install`): the one installer
//!   that both root tools use. It stages an immutable version from an
//!   unpacked tree or a signed archive, and activates it.
//!
//! `tilecastd` uses the envelope and the protocol only; it never installs.

pub mod envelope;
pub mod manifest;
pub mod protocol;

#[cfg(feature = "install")]
pub mod archive;
#[cfg(feature = "install")]
pub mod install;
#[cfg(feature = "test-util")]
pub mod testing;

pub use envelope::{UpdateEnvelope, VerifiedEnvelope, verify_envelope};
pub use manifest::{ReleaseError, ReleaseManifest, VerifiedRelease};
