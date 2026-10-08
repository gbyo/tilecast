//! `tilecastd`: the Tilecast Edge daemon.
//!
//! The binary (`main.rs`) only parses arguments; everything else is here so
//! integration tests can run a real daemon in-process against temporary
//! directories.
//!
//! Module ownership:
//!
//! * [`daemon`] — lifecycle, shared context, background tasks.
//! * [`config`] — operator configuration.
//! * [`ipc_handler`] — what IPC events and requests do.
//! * [`presentation`] — the current activation and renderer link.
//! * [`capabilities`] — daemon-owned capabilities and persistence.
//! * [`fixture`] — development presentation source.
//! * [`server_link`] — Core server-loop composition and Edge heartbeat projection.
//! * [`commands`], [`command_handlers`] — Core command-loop composition and fixed Linux handlers.
//! * [`player_config`], [`config_sync`] — Runtime/platform projections and installation of accepted configuration.
//! * [`manifest_sync`] — Core manifest preparation with Edge compatibility checks.
//! * [`manifest`] — the manifest boundary, renderer compatibility and
//!   projection into the renderer contract.
//! * [`activation`] — Runtime projection and opaque comparison keys for Core offline activation.
//! * [`activity`], [`telemetry`] — semantic signal projection and measured gauges for Core reporting.
//!   [`preview`] connects capture and server services to Core preview policy.
//! * [`capture`] — the renderer-capture broker shared by preview and Watch
//!   Live; [`live_stream`] — the Studio Watch Live coordinator.
//! * [`display_control`] — HDMI-CEC and DDC/CI display control, scheduled
//!   display actions and their readback (M9).
//! * [`media`], [`media_channel`] — renderer media capabilities.
//! * [`pairing`], [`discovery`] — pairing a fresh installation and finding
//!   servers on the LAN through Avahi.
//! * [`legacy_import`], [`legacy_compat`] — the `import-legacy` and
//!   `check-legacy-compat` migration steps.
//! * [`self_test`] — the release self-test host.

pub mod activation;
pub mod activity;
pub mod capabilities;
pub mod capture;
pub mod command_handlers;
pub mod commands;
pub mod config;
pub mod config_sync;
pub mod daemon;
pub mod discovery;
pub mod display_control;
pub mod fixture;
pub mod idle_inhibit;
pub mod ipc_handler;
pub mod legacy_compat;
pub mod legacy_import;
pub mod live_stream;
pub mod logging;
pub mod manifest;
pub mod manifest_sync;
pub mod media;
pub mod media_channel;
pub mod network_task;
pub mod pairing;
pub mod player_config;
pub mod presentation;
pub mod presentation_capabilities;
pub mod presentation_network;
pub mod preview;
pub mod remote_web;
mod renderer_adapter;
pub mod resume;
pub mod self_test;
pub mod server_link;
pub mod telemetry;
pub mod update;
pub mod update_checkpoint;
pub mod widget_capabilities;
