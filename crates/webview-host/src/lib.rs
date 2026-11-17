//! The native WebView Player host shared by the Windows and macOS Players.
//!
//! Player Core owns native Player behavior: pairing, the server link,
//! configuration acceptance, manifest preparation, offline activation,
//! Activity, telemetry, recovery, and command delivery. This crate is the
//! composition of Core that both WebView hosts share: the daemon context and
//! its supervised task set, the Core host ports, the Runtime projection, the
//! presentation engine and its `RendererPort`, verified media grants, the
//! `tilecast://`/`tcmedia://` scheme contract, remote web surfaces, and the
//! capture broker.
//!
//! It calls no OS API. Each platform crate supplies its window and WebView,
//! credential sealing, device facts, free space, secure opening, capture
//! backend, and update delivery through the narrow seams in [`host`], and
//! nothing here branches on a platform name. Shared Player crates never
//! depend on this crate.

pub mod activity;
pub mod bridge;
pub mod capture;
pub mod clock;
pub mod commands;
pub mod config;
pub mod config_sync;
pub mod credential;
pub mod daemon;
pub mod discovery;
pub mod host;
pub mod link;
pub mod live_stream;
pub mod manifest;
pub mod media;
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
pub mod release_version;
pub mod remote_web;
pub mod renderer_adapter;
pub mod runtime_files;
pub mod schemes;
pub mod seal;
pub mod telemetry;
#[cfg(feature = "test-util")]
pub mod testing;
pub mod ui;
pub mod widget_capabilities;
