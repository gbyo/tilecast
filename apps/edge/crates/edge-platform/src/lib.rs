//! Tilecast Edge host integration (section numbers refer to
//! `docs/tilecast-edge.md`).
//!
//! * [`paths`]: the canonical filesystem layout (§5) and how it maps onto
//!   systemd-managed directories.
//! * [`systemd`]: `sd_notify` readiness, status, stopping and watchdog.
//! * [`disk`]: free-space measurement for CAS reserve enforcement.
//! * [`capabilities`]: the capability registry and the provider trait every
//!   machine integration implements (§12).
//! * [`providers`]: providers that need only filesystem/environment probes.
//!
//! Rules for providers (§19):
//!
//! * A provider never runs a shell and never interpolates values into
//!   commands. Subprocess providers (CEC, DDC, PipeWire tools) use fixed argv,
//!   bounded time and bounded output.
//! * A provider failure degrades its own capabilities; it can never stop the
//!   daemon, playback or another provider.
//! * `detail` text is safe for administrators: no command output, addresses,
//!   serial numbers or user data.
//! * Anything privileged goes through a narrow helper with a fixed operation
//!   allowlist (today `tilecast-networkd`). No provider gains root.

pub mod capabilities;
pub mod disk;
pub mod paths;
pub mod providers;
pub mod systemd;
