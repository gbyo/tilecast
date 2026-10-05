//! Activity events: proof of play and operational events through the
//! bounded durable outbox.
//!
//! The contract is `docs/activity-event-contract.md`, and the semantics are
//! the reference player's. Stage 2 has no renderer, so only connection
//! events flow; item and presentation sessions arrive with playback in
//! stage 3. Every event is written to the outbox before anything is sent,
//! so a restart or an outage never loses one.

use std::sync::Arc;
use tokio::sync::mpsc;

pub use player_core::{ACTIVITY_FLUSH_INTERVAL as FLUSH_INTERVAL, ActivityHandle as Handle};

pub use player_core::{
    ActivityClocks as Clocks, ActivityEvent as Event, ActivitySignal as Signal, ActivityTracker as Tracker,
    PersistedActivity as Persisted, activity_reason as reason,
};

use crate::daemon::DaemonContext;

/// Connect host observations and semantic renderer signals to Core reporting.
pub async fn run(context: Arc<DaemonContext>, signals: mpsc::Receiver<Signal>) {
    let Some(core) = context.core.as_ref() else { return };
    let clocks = crate::clock::TaskClocks::new(context.clock.clone());
    let timezone = crate::device::timezone();
    core.run_activity(player_core::ActivityServices {
        clocks: &clocks,
        timezone: &timezone,
        handle: &context.activity,
        signals,
        server: context.command_server.subscribe(),
        report_wake: &context.report_wake,
        server_wake: &context.server_wake,
        shutdown: &context.shutdown,
    })
    .await;
}
