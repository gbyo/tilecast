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

use std::sync::Arc;
use std::time::{Duration, Instant};

use edge_state::repo::outbox;
use serde::Serialize;

use crate::daemon::DaemonContext;
use crate::server_link::LinkState;

/// Matches the server's rollup bucket.
pub const INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Counters {
    connected_seconds: u32,
    disconnected_seconds: u32,
    healthy_playback_seconds: u32,
    stalled_playback_seconds: u32,
    socket_reconnect_count: u32,
    renderer_crash_count: u32,
}

#[derive(Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct Interval {
    seconds: u32,
    connected_seconds: u32,
    disconnected_seconds: u32,
    healthy_playback_seconds: u32,
    stalled_playback_seconds: u32,
    socket_reconnect_count: u32,
    renderer_crash_count: u32,
}

#[derive(Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_started_at: Option<edge_protocol::Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_meaningful_progress_at: Option<edge_protocol::Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    renderer_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_limit_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    free_storage_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_uptime_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_uptime_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clock_offset_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_connected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_refresh_hz: Option<f64>,
    interval: Interval,
}

/// One second of observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Tick {
    bound: bool,
    connected: bool,
    renderer_connected: bool,
    /// A playing presentation is on screen.
    playing: bool,
    healthy: bool,
}

#[derive(Debug, Default)]
struct Accumulator {
    counters: Counters,
    previous: Option<Tick>,
}

impl Accumulator {
    fn observe(&mut self, tick: Tick) {
        let c = &mut self.counters;
        if tick.bound {
            if tick.connected {
                c.connected_seconds += 1;
            } else {
                c.disconnected_seconds += 1;
            }
        }
        if tick.playing {
            if tick.healthy {
                c.healthy_playback_seconds += 1;
            } else {
                c.stalled_playback_seconds += 1;
            }
        }
        if let Some(previous) = self.previous {
            if previous.connected && !tick.connected {
                c.socket_reconnect_count += 1;
            }
            if previous.renderer_connected && !tick.renderer_connected {
                c.renderer_crash_count += 1;
            }
        }
        self.previous = Some(tick);
    }

    fn take(&mut self, seconds: u32) -> Interval {
        let c = std::mem::take(&mut self.counters);
        Interval {
            seconds: seconds.min(INTERVAL.as_secs() as u32),
            connected_seconds: c.connected_seconds,
            disconnected_seconds: c.disconnected_seconds,
            healthy_playback_seconds: c.healthy_playback_seconds,
            stalled_playback_seconds: c.stalled_playback_seconds,
            socket_reconnect_count: c.socket_reconnect_count,
            renderer_crash_count: c.renderer_crash_count,
        }
    }
}

async fn observe(context: &DaemonContext) -> Tick {
    let (bound, connected) = {
        let link = context.link_state.lock().unwrap_or_else(|e| e.into_inner());
        (!matches!(*link, LinkState::Unbound), matches!(*link, LinkState::Connected))
    };
    let engine = context.presentation.lock().await;
    let status = engine.status();
    let playing = engine.current().is_some_and(|a| {
        matches!(&a.document, edge_protocol::ipc::presentation::PresentationDocument::Playing { items, .. } if !items.is_empty())
    });
    Tick {
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

async fn sample(context: &DaemonContext, interval: Interval) -> Sample {
    let now = context.now();
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
    Sample {
        observed_at: serde_json::to_value(now).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
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
        interval,
    }
}

/// The telemetry task: a one-second observation tick and a one-minute
/// sample into the outbox. The activity task sends queued samples.
pub async fn run(context: Arc<DaemonContext>) {
    let Some(db) = context.db().cloned() else { return };
    let mut second = tokio::time::interval(Duration::from_secs(1));
    second.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut accumulator = Accumulator::default();
    let mut since = Instant::now();
    loop {
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            _ = second.tick() => {}
        }
        accumulator.observe(observe(&context).await);
        if since.elapsed() < INTERVAL {
            continue;
        }
        let seconds = since.elapsed().as_secs() as u32;
        since = Instant::now();
        let interval = accumulator.take(seconds);
        // An unbound screen has no server to report to.
        if context.command_server.borrow().is_none()
            && db.run(|c| edge_state::repo::binding::get(c)).await.ok().flatten().is_none()
        {
            continue;
        }
        let body = match serde_json::to_string(&sample(&context, interval).await) {
            Ok(body) => body,
            Err(_) => continue,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let now = context.now();
        if let Err(error) = db.run(move |c| outbox::enqueue_telemetry(c, &id, &body, now)).await {
            tracing::warn!(component = "telemetry", event = "enqueue_failed", reason = error.reason_code());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_are_sums_over_the_minute_and_reset() {
        let mut accumulator = Accumulator::default();
        let playing = Tick { bound: true, connected: true, renderer_connected: true, playing: true, healthy: true };
        for _ in 0..30 {
            accumulator.observe(playing);
        }
        for _ in 0..10 {
            accumulator.observe(Tick { connected: false, healthy: false, ..playing });
        }
        accumulator.observe(Tick { renderer_connected: false, ..playing });
        let interval = accumulator.take(61);
        assert_eq!(
            interval,
            Interval {
                seconds: 60,
                connected_seconds: 31,
                disconnected_seconds: 10,
                healthy_playback_seconds: 31,
                stalled_playback_seconds: 10,
                socket_reconnect_count: 1,
                renderer_crash_count: 1,
            }
        );
        assert_eq!(accumulator.take(60).connected_seconds, 0, "reset after each sample");
    }

    #[test]
    fn an_unmeasured_gauge_is_omitted_not_zero() {
        let value =
            serde_json::to_value(Sample { observed_at: "2026-09-25T00:00:00Z".into(), ..Sample::default() }).unwrap();
        let keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["interval", "observedAt"]);
    }
}
