//! Bounded player telemetry (M8).
//!
//! The contract is the server's `POST /api/v1/player/telemetry`
//! (`telemetry_ingest.go`) and the Electron player's reporter
//! (`apps/player-linux/src/core/telemetry.ts`): one sample a minute with the
//! latest value of each gauge and the counters accumulated since the last
//! sample. Nothing high-rate is stored or sent: counters are sums over the
//! minute, taken from a one-second tick.
//!
//! A measurement Edge cannot make is omitted, never sent as zero. The server
//! tells the two apart. Nothing here names a host, an address, a URL or a
//! credential.
//!
//! Unlike the Electron player, which drops a sample it cannot send, Edge
//! queues samples in the outbox. The server accepts samples up to a day old
//! and evaluates them on their own clock, so a screen that was offline
//! reports what happened while it was offline. The outbox keeps at most 120
//! samples (two hours), so telemetry never pushes proof of play out.

use crate::daemon::DaemonContext;
use crate::server_link::LinkState;
use std::sync::Arc;

pub use player_core::TELEMETRY_INTERVAL as INTERVAL;

async fn observe(context: &DaemonContext) -> player_core::TelemetryTick {
    let (bound, connected) = {
        let link = context.link_state.lock().unwrap_or_else(|e| e.into_inner());
        (!matches!(*link, LinkState::Unbound), matches!(*link, LinkState::Connected))
    };
    let engine = context.presentation.lock().await;
    let status = engine.status();
    let playing = engine.current().is_some_and(|a| {
        matches!(&a.document, edge_protocol::ipc::presentation::PresentationDocument::Playing { items, .. } if !items.is_empty())
    });
    player_core::TelemetryTick {
        bound,
        connected,
        renderer_connected: status.connected,
        playing,
        healthy: status.state.as_str() == "healthy",
    }
}

fn device_uptime_seconds() -> Option<i64> {
    let text = edge_platform::fs::read_regular(std::path::Path::new("/proc/uptime"), 256).ok()??;
    let first = String::from_utf8_lossy(&text).split_whitespace().next()?.to_owned();
    first.split('.').next()?.parse().ok()
}

async fn gauges(context: &DaemonContext, now: edge_protocol::Timestamp) -> player_core::TelemetryGauges {
    let (status, display) = {
        let engine = context.presentation.lock().await;
        (engine.status(), engine.ready_info().and_then(|ready| ready.display.clone()))
    };
    let (usage, offset) = match context.db() {
        Some(db) => (
            db.run(|c| edge_state::repo::cas::usage(c)).await.ok(),
            db.run(|c| edge_state::repo::playback::get(c)).await.ok().and_then(|flags| flags.server_clock_offset_ms),
        ),
        None => (None, None),
    };
    player_core::TelemetryGauges {
        current_item_id: status.current_item_id.as_ref().map(|id| id.as_str().chars().take(128).collect()),
        item_started_at: status.current_item_started_at,
        last_meaningful_progress_at: status.last_progress_at,
        renderer_state: Some(status.state.as_str().to_owned()),
        cache_used_bytes: usage.as_ref().map(|u| u.used_bytes),
        cache_limit_bytes: usage.as_ref().map(|_| context.config.cas.limit_bytes),
        free_storage_bytes: context.space.available_bytes(&context.paths.state_dir).ok(),
        process_uptime_seconds: Some(now.since(context.started_at).whole_seconds().max(0)),
        device_uptime_seconds: device_uptime_seconds(),
        clock_offset_seconds: offset.map(|ms| (ms as f64 / 1000.0).round() as i64),
        display_connected: display.as_ref().map(|d| d.connected),
        display_resolution: display.as_ref().filter(|d| d.width > 0).map(|d| format!("{}x{}", d.width, d.height)),
        display_refresh_hz: display.as_ref().and_then(|d| d.refresh_millihertz).map(|mhz| f64::from(mhz) / 1000.0),
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
    async fn gauges(&self, now: edge_protocol::Timestamp) -> player_core::TelemetryGauges {
        gauges(self.0, now).await
    }
    fn has_authenticated_server(&self) -> bool {
        self.0.command_server.borrow().is_some()
    }
}

/// Edge supplies current renderer state and Linux measurements; Core owns the
/// sampling cadence, counters, and bounded offline queue.
pub async fn run(context: Arc<DaemonContext>) {
    let Some(core) = context.core.as_ref() else { return };
    core.run_telemetry(&Measurements(&context), &context.shutdown).await;
}
