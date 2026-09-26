//! `tilecast-edge-update`: the narrow root helper for Tilecast Edge updates
//! (M10).
//!
//! `tilecastd` downloads and verifies an update and then asks this helper,
//! over a socket that only its unit can use, for one of five fixed
//! operations: `stage`, `activate`, `confirm`, `rollback` and `status`. The
//! helper has no device credential, no server connection and no network
//! access; it takes no path, unit name, command or URL from a request.
//!
//! * [`updater`]: the state machine.
//! * [`transaction`]: the root-owned transaction record that makes every
//!   step recoverable, independently of the candidate.
//! * [`evidence`]: what the helper checks itself before it confirms.
//! * [`server`]: the socket and its peer policy.
//! * [`host`] and `linux`: everything the helper does to the machine.
//! * [`guard_units`]: the boot and timer guard that rolls back a candidate
//!   that does not confirm.
//!
//! The written threat-boundary review is
//! `docs/tilecast-edge-update-threat-review.md`. Release verification and
//! installation are the `edge-release` crate, shared with
//! `tilecast-edge-migrate`.

pub mod evidence;
pub mod guard_units;
pub mod host;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod server;
pub mod transaction;
pub mod updater;

#[cfg(test)]
mod crash_tests;
#[cfg(test)]
mod fake;
