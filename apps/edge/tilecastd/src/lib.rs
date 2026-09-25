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
//! * [`supervisor`] — the renderer recovery ladder.
//! * [`capabilities`] — daemon-owned capabilities and persistence.
//! * [`fixture`] — development presentation source.
//! * [`server_link`] — identity gate, player WebSocket and heartbeat, and
//!   driving manifest and configuration reconciliation.
//! * [`commands`], [`command_handlers`] — durable player commands and their
//!   fixed handlers.
//! * [`player_config`], [`config_sync`] — the player configuration document
//!   and its reconciliation.
//! * [`manifest_sync`] — the ordinary manifest endpoint, the target and its
//!   verified preparation.
//! * [`manifest`] — the manifest boundary, renderer compatibility and
//!   projection into the renderer contract.
//! * [`schedule`] — offline schedule and availability selection.
//! * [`activation`] — what the renderer shows, and evidence-gated promotion.
//! * [`activity`], [`telemetry`] — proof of play and telemetry through the
//!   bounded outbox; [`preview`] — the Studio live preview.
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
pub mod command_handlers;
pub mod commands;
pub mod config;
pub mod config_sync;
pub mod daemon;
pub mod discovery;
pub mod display_control;
pub mod fixture;
pub mod ipc_handler;
pub mod legacy_compat;
pub mod legacy_import;
pub mod logging;
pub mod manifest;
pub mod manifest_sync;
pub mod media;
pub mod media_channel;
pub mod pairing;
pub mod player_config;
pub mod presentation;
pub mod preview;
pub mod schedule;
pub mod self_test;
pub mod server_link;
pub mod supervisor;
pub mod telemetry;
