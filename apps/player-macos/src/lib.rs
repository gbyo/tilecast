//! Tilecast Player for macOS 14 and later: the native Player Core host for
//! Macs.
//!
//! Player Core owns native Player behavior and [`webview_host`] composes it
//! for WebView hosts; this crate supplies the macOS operating-system
//! adapters through [`host::services`]. Off macOS the adapters compile to
//! documented fallbacks or errors so the workspace builds everywhere.

pub use webview_host::{config, daemon, pairing, pairing_store};

pub mod device;
pub mod host;
pub mod keychain;
pub mod paths;
pub mod secure_open;
pub mod space;

/// The Player release family, architecture selection excluded: the server
/// reaches only screens that report it (`docs/player-updates.md`).
pub const PLAYER_FAMILY: &str = "macos";

/// The release version stamped by `build.rs` (`release/VERSION`, or
/// `TILECAST_MACOS_VERSION` in release builds).
pub const RELEASE_VERSION: &str = env!("TILECAST_MACOS_RELEASE_VERSION");
