//! `tilecast-airplay`: the Tilecast Edge AirPlay supervisor
//! (docs/tilecast-edge-airplay.md §4.1).
//!
//! `tilecast-airplay.socket` starts it when `tilecastd` connects. It is the
//! only Edge process that starts a program, and it starts only the
//! release's `bin/uxplay`, with a fixed argument vector and no shell. It runs
//! as the unprivileged `tilecast-airplay` account. It owns no Tilecast
//! state, no Server connection, no device credential and no Presentation
//! Network secret.
//!
//! * [`uxplay`]: the `-rc` file, the argument vector, and the fixed grammar
//!   that classifies UxPlay output. No I/O.
//! * [`supervisor`]: the control connection, the UxPlay process, the probe
//!   and the peer policy.
//!
//! The threat-boundary review is
//! `docs/tilecast-edge-airplay-threat-review.md`. The protocol is
//! `edge_protocol::airplay`.

pub mod supervisor;
pub mod uxplay;
