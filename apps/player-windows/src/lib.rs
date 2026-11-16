//! Tilecast Player for Windows: the native Player Core host for Windows 10/11
//! PCs and tablets.
//!
//! The host owns what Player Core and the shared WebView host cannot: the
//! Windows window and the WebView2 Runtime renderer, DPAPI credential
//! sealing, the MSIX-aware data layout and updates, device facts, and
//! Graphics Capture. Everything shared with the other native players —
//! pairing orchestration, the server link, configuration acceptance,
//! manifest preparation, offline activation, Activity, telemetry, and
//! command delivery — runs in [`player_core`], composed by
//! [`webview_host`], which this crate supplies through
//! [`host::services`].

// The shared WebView host modules, at their historical paths.
pub use webview_host::{
    activity, bridge, capture, clock, commands, config, config_sync, credential, daemon, discovery, link, live_stream,
    manifest, media, offline, pairing, pairing_store, player_config, presentation, presentation_capabilities, preview,
    projection, ranges, remote_web, renderer_adapter, runtime_files, schemes, telemetry, ui, widget_capabilities,
};

pub mod device;
pub mod envelope;
pub mod host;
pub mod msix;
pub mod paths;
pub mod renderer;
pub mod seal;
pub mod secure_open;
pub mod space;
#[cfg(target_os = "windows")]
pub mod streams;
pub mod update;
#[cfg(windows)]
mod webview;
pub mod win32;

/// The Player release family, architecture selection excluded: the server
/// reaches only screens that report it (`docs/player-updates.md`).
pub const PLAYER_FAMILY: &str = "windows";

/// This build's Tilecast release version (`release/VERSION`).
pub const RELEASE_VERSION: &str = env!("TILECAST_WINDOWS_RELEASE_VERSION");

/// `%LOCALAPPDATA%\Tilecast\Tilecast Player\tilecast-windows.toml`, beside
/// the state it configures.
pub const CONFIG_FILE_NAME: &str = "tilecast-windows.toml";

/// The HTTP user agent for Tilecast Server requests.
pub fn user_agent() -> String {
    host::IDENTITY.user_agent()
}
