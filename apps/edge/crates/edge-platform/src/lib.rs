//! Tilecast Edge host integration (section numbers refer to
//! `docs/tilecast-edge.md`).
//!
//! * [`paths`]: the canonical filesystem layout (§5) and how it maps onto
//!   systemd-managed directories.
//! * [`systemd`]: `sd_notify` readiness, status, stopping and watchdog.
//! * [`activation`]: the socket that systemd passes to `tilecast-edge-update`.
//! * [`disk`]: free-space measurement for CAS reserve enforcement.
//! * [`fs`]: opening files that another account may control.
//! * [`capabilities`]: the capability registry and the provider trait every
//!   machine integration implements (§12).
//! * [`providers`]: providers that need only filesystem/environment probes.
//! * [`display`]: HDMI-CEC and DDC/CI display control (M9).
//!
//! Rules for providers (§19):
//!
//! * A provider never runs a shell or another program: `tilecastd` starts no
//!   processes (docs/tilecast-edge.md §4.1). Display control uses the kernel
//!   CEC and i2c-dev interfaces directly ([`display`]); PipeWire is reached
//!   through the user-session bridge, never from the daemon.
//! * A provider failure degrades its own capabilities; it can never stop the
//!   daemon, playback or another provider.
//! * `detail` text is safe for administrators: no command output, addresses,
//!   serial numbers or user data.
//! * Anything privileged goes through a narrow helper with a fixed operation
//!   allowlist (today `tilecast-networkd`). No provider gains root.

pub mod activation;
pub mod capabilities;
pub mod disk;
pub mod display;
pub mod fs;
pub mod paths;
pub mod providers;
pub mod systemd;
