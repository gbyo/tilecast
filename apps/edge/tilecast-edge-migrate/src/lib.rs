//! `tilecast-edge-migrate`: the Tilecast Edge installer and the one-way
//! migration from the Electron Linux Player (M7).
//!
//! It runs as root, only when an operator starts it or at boot to finish an
//! interrupted attempt. It is not a daemon: it has no listener, sends
//! nothing to the network and never reads the device credential. Its
//! operations are a fixed set:
//!
//! * [`release`]: verify a signed release and install it under
//!   `/opt/tilecast-edge/<version>/`;
//! * [`migrate`]: the migration and clean-install state machine, with
//!   [`settle`] deciding when a started Edge counts as working;
//! * [`state`]: the durable record that makes every step recoverable;
//! * [`host`]: the only way the migrator changes the machine.
//!
//! The written threat-boundary review is
//! `docs/tilecast-edge-migration-threat-review.md`.

pub mod host;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod migrate;
pub mod release;
pub mod settle;
pub mod state;

#[cfg(test)]
mod crash_tests;
#[cfg(test)]
mod fake;
