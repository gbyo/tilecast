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
//! * [`server_link`] — identity gate, enrollment, change feed, Edge status.
//! * [`fabric`] — peer blob service and Zenoh mesh.
//! * [`legacy_import`] — the one-time `import-legacy` command.

pub mod capabilities;
pub mod config;
pub mod daemon;
pub mod fabric;
pub mod fixture;
pub mod identity_status;
pub mod ipc_handler;
pub mod legacy_import;
pub mod logging;
pub mod manifest;
pub mod media;
pub mod presentation;
pub mod schedule;
pub mod server_link;
pub mod supervisor;
