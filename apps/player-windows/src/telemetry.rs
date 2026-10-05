//! Bounded player telemetry.
//!
//! The contract is the server's `POST /api/v1/player/telemetry` and the
//! reference player's reporter: one sample a minute with the latest value
//! of each gauge and the counters accumulated since the last sample. Nothing
//! high-rate is stored or sent: counters are sums over the minute, taken
//! from a one-second tick.
//!
//! A measurement the host cannot make is omitted, never sent as zero. The
//! server tells the two apart. Nothing here names a host, an address, a URL
//! or a credential.
//!
//! Unlike the reference web player, which drops a sample it cannot send,
//! Core queues samples in the outbox. The server accepts samples up to a day
//! old and evaluates them on their own clock, so a screen that was offline
//! reports what happened while it was offline.

use std::sync::Arc;

use crate::daemon::DaemonContext;
use player_core::ServerLinkState as LinkState;

pub use player_core::TELEMETRY_INTERVAL as INTERVAL;

async fn observe(context: &DaemonContext) -> player_core::TelemetryTick {
    let (bound, connected) = {
        let link = context.link_state.lock().unwrap_or_else(|e| e.into_inner());
        (!matches!(*link, LinkState::Unbound), matches!(*link, LinkState::Connected))
    };
    let engine = context.presentation.lock().unwrap_or_else(|e| e.into_inner());
    let playing = engine.current().is_some_and(|active| {
        active.document.get("state").and_then(|state| state.as_str()) == Some("playing")
            && active.document.get("items").and_then(|items| items.as_array()).is_some_and(|items| !items.is_empty())
    });
    player_core::TelemetryTick {
        bound,
        connected,
        renderer_connected: engine.renderer_session().is_some(),
        playing,
        healthy: engine.renderer_state() == "healthy",
    }
}

/// Device uptime in seconds from the Windows tick count.
fn device_uptime_seconds() -> Option<i64> {
    crate::win32::tick_count_ms().map(|ms| (ms / 1000) as i64)
}

async fn gauges(context: &DaemonContext, now: player_types::Timestamp) -> player_core::TelemetryGauges {
    let (current_item, progress_at, renderer_state) = {
        let engine = context.presentation.lock().unwrap_or_else(|e| e.into_inner());
        (engine.current_item(), engine.last_progress_at(), engine.renderer_state().to_owned())
    };
    let (usage, offset) = match context.db() {
        Some(db) => (
            db.run(|c| player_state::repo::cas::usage(c)).await.ok(),
            db.run(|c| player_state::repo::playback::get(c)).await.ok().and_then(|flags| flags.server_clock_offset_ms),
        ),
        None => (None, None),
    };
    player_core::TelemetryGauges {
        current_item_id: current_item.as_ref().map(|(item, _)| item.chars().take(128).collect()),
        item_started_at: current_item.map(|(_, started)| started),
        last_meaningful_progress_at: progress_at,
        renderer_state: Some(renderer_state),
        cache_used_bytes: usage.as_ref().map(|u| u.used_bytes),
        cache_limit_bytes: usage.as_ref().map(|_| context.config.cas.limit_bytes),
        free_storage_bytes: context.space.available_bytes(&context.paths.state_dir).ok(),
        process_uptime_seconds: Some(now.since(context.started_at).whole_seconds().max(0)),
        device_uptime_seconds: device_uptime_seconds(),
        clock_offset_seconds: offset.map(|ms| (ms as f64 / 1000.0).round() as i64),
        display_connected: None,
        display_resolution: None,
        display_refresh_hz: None,
    }
}

struct Measurements<'a>(&'a DaemonContext);

#[async_trait::async_trait]
impl player_core::TelemetryHost for Measurements<'_> {
    fn new_sample_id(&self) -> uuid::Uuid {
        uuid::Uuid::new_v4()
    }
    async fn observe(&self) -> player_core::TelemetryTick {
        observe(self.0).await
    }
    async fn gauges(&self, now: player_types::Timestamp) -> player_core::TelemetryGauges {
        gauges(self.0, now).await
    }
    fn has_authenticated_server(&self) -> bool {
        self.0.command_server.borrow().is_some()
    }
}

/// The host supplies current state and Windows measurements; Core owns the
/// sampling cadence, counters, and bounded offline queue.
pub async fn run(context: Arc<DaemonContext>) {
    let Some(core) = context.core.as_ref() else { return };
    core.run_telemetry(&Measurements(&context), &context.shutdown).await;
}
