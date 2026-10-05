//! Tilecast Player for Windows: the native Player Core host for Windows 10/11
//! PCs and tablets.
//!
//! The host owns what Player Core cannot: the Windows window (stage 6), the
//! WebView2 Runtime renderer (stage 3), DPAPI credential storage, the
//! MSIX-aware data layout, device facts, and platform services. Everything
//! shared with the other native players — pairing orchestration, the server
//! link, configuration acceptance, manifest preparation, offline activation,
//! Activity, telemetry, and command delivery — runs in
//! [`player_core`](player_core) through the ports in this crate.
//!
//! Stage 2 runs headless: pair, persist, restart, reconnect, and prepare
//! verified content, with no renderer yet. Rendering arrives in stage 3.

pub mod activity;
pub mod bridge;
pub mod capture;
pub mod clock;
pub mod commands;
pub mod config;
pub mod config_sync;
pub mod credential;
pub mod daemon;
pub mod device;
pub mod discovery;
pub mod envelope;
pub mod link;
pub mod live_stream;
pub mod manifest;
pub mod media;
pub mod msix;
pub mod offline;
pub mod pairing;
pub mod pairing_store;
pub mod paths;
pub mod player_config;
pub mod presentation;
pub mod presentation_capabilities;
pub mod preview;
pub mod projection;
pub mod ranges;
pub mod remote_web;
pub mod renderer_adapter;
pub mod runtime_files;
pub mod schemes;
pub mod seal;
pub mod secure_open;
pub mod space;
#[cfg(target_os = "windows")]
pub mod streams;
pub mod telemetry;
pub mod ui;
pub mod update;
pub mod widget_capabilities;
pub mod win32;

/// The Player release family, architecture selection excluded: the server
/// reaches only screens that report it (`docs/player-updates.md`).
pub const PLAYER_FAMILY: &str = "windows";

/// This build's Tilecast release version (`release/VERSION`).
pub const RELEASE_VERSION: &str = env!("TILECAST_WINDOWS_RELEASE_VERSION");

/// The HTTP user agent for Tilecast Server requests.
pub fn user_agent() -> String {
    format!("tilecast-windows/{RELEASE_VERSION}")
}
