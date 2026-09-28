//! Signed Tilecast Edge releases. The verification and the installer live in
//! the `edge-release` crate, which `tilecast-edge-update` (M10) shares; the
//! migrator's `install` is `edge_release::install::install`: stage the
//! unpacked tree, then activate it.

pub use edge_release::install::{InstallOutcome, Layout, activate, install, stage_from_dir, verify_installed};
pub use edge_release::manifest::{ReleaseError, trusted_key};
