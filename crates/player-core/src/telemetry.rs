//! Bounded native telemetry cadence, interval aggregation, and offline queueing.
//! Hosts provide measured gauges and semantic playback observations.
use crate::Dependencies;
use player_state::repo::{binding, outbox};
use player_types::Timestamp;
use serde::Serialize;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Matches the server's rollup bucket.
pub const TELEMETRY_INTERVAL: Duration = Duration::from_secs(60);

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
pub struct TelemetryGauges {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_started_at: Option<player_types::Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_meaningful_progress_at: Option<player_types::Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renderer_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_limit_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_storage_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_uptime_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_uptime_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock_offset_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_connected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_refresh_hz: Option<f64>,
}

/// One second of observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TelemetryTick {
    pub bound: bool,
    pub connected: bool,
    pub renderer_connected: bool,
    /// A playing presentation is on screen.
    pub playing: bool,
    pub healthy: bool,
}

#[derive(Debug, Default)]
struct Accumulator {
    counters: Counters,
    previous: Option<TelemetryTick>,
}

impl Accumulator {
    fn observe(&mut self, tick: TelemetryTick) {
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
            seconds: seconds.min(TELEMETRY_INTERVAL.as_secs() as u32),
            connected_seconds: c.connected_seconds,
            disconnected_seconds: c.disconnected_seconds,
            healthy_playback_seconds: c.healthy_playback_seconds,
            stalled_playback_seconds: c.stalled_playback_seconds,
            socket_reconnect_count: c.socket_reconnect_count,
            renderer_crash_count: c.renderer_crash_count,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct Sample {
    observed_at: String,
    #[serde(flatten)]
    gauges: TelemetryGauges,
    interval: Interval,
}

#[async_trait::async_trait]
pub trait TelemetryHost: Send + Sync {
    fn new_sample_id(&self) -> uuid::Uuid;
    async fn observe(&self) -> TelemetryTick;
    async fn gauges(&self, observed_at: Timestamp) -> TelemetryGauges;
    fn has_authenticated_server(&self) -> bool;
}

async fn enqueue(dependencies: &Dependencies, host: &impl TelemetryHost, interval: Interval) {
    let db = &dependencies.state;
    // An unbound screen has no server to report to. A bound offline screen
    // retains its samples through the bounded outbox.
    if !host.has_authenticated_server() && db.run(|c| binding::get(c)).await.ok().flatten().is_none() {
        return;
    }
    let now = dependencies.clock.now();
    let observed_at =
        serde_json::to_value(now).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default();
    let sample = Sample { observed_at, gauges: host.gauges(now).await, interval };
    let body = match serde_json::to_string(&sample) {
        Ok(body) => body,
        Err(_) => return,
    };
    let id = host.new_sample_id().to_string();
    let now = dependencies.clock.now();
    if let Err(error) = db.run(move |c| outbox::enqueue_telemetry(c, &id, &body, now)).await {
        tracing::warn!(component = "telemetry", event = "enqueue_failed", reason = error.reason_code());
    }
}

/// One-second observations and one sample per minute. Queue delivery remains
/// independent of playback and sampling; missed ticks are skipped.
pub(crate) async fn drive_telemetry(
    dependencies: Dependencies,
    host: &impl TelemetryHost,
    shutdown: &CancellationToken,
) {
    let mut second = tokio::time::interval(Duration::from_secs(1));
    second.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut accumulator = Accumulator::default();
    let mut since = Instant::now();
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
            _ = second.tick() => {}
        }
        accumulator.observe(host.observe().await);
        if since.elapsed() < TELEMETRY_INTERVAL {
            continue;
        }
        let seconds = since.elapsed().as_secs() as u32;
        since = Instant::now();
        enqueue(&dependencies, host, accumulator.take(seconds)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_state::repo::binding::{CredentialState, ServerBinding};
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, ScreenId, time::ManualClock};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Host(AtomicUsize);

    #[async_trait::async_trait]
    impl TelemetryHost for Host {
        fn new_sample_id(&self) -> uuid::Uuid {
            uuid::Uuid::from_u128(self.0.load(Ordering::Relaxed) as u128)
        }
        async fn observe(&self) -> TelemetryTick {
            TelemetryTick { bound: true, connected: false, renderer_connected: true, playing: true, healthy: true }
        }
        async fn gauges(&self, observed_at: Timestamp) -> TelemetryGauges {
            self.0.fetch_add(1, Ordering::Relaxed);
            TelemetryGauges {
                current_item_id: Some("item".into()),
                item_started_at: Some(observed_at),
                renderer_state: Some("healthy".into()),
                cache_used_bytes: Some(4096),
                ..TelemetryGauges::default()
            }
        }
        fn has_authenticated_server(&self) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn offline_samples_keep_the_wire_fields_and_the_queue_bound() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let now = Timestamp::parse("2026-10-04T12:00:00Z").unwrap();
        let clock = ManualClock::new(now);
        let dependencies = Dependencies { state, clock: clock.clone() };
        let host = Host(AtomicUsize::new(0));
        enqueue(&dependencies, &host, Interval::default()).await;
        assert_eq!(host.0.load(Ordering::Relaxed), 0, "unbound screens do not collect queued samples");
        dependencies
            .state
            .run(move |connection| {
                binding::put(
                    connection,
                    &ServerBinding {
                        server_url: "https://signs.example.org".into(),
                        installation_id: InstallationId::from_uuid(uuid::Uuid::from_u128(1)),
                        organization_name: None,
                        screen_id: Some(ScreenId::from_uuid(uuid::Uuid::from_u128(2))),
                        screen_name: None,
                        credential_state: CredentialState::Stored,
                        identity_verified_at: Some(now),
                        bound_at: now,
                    },
                    now,
                )?;
                outbox::enqueue_activity(connection, &uuid::Uuid::new_v4().to_string(), now, |_| "{}".into())?;
                Ok(())
            })
            .await
            .unwrap();
        for minute in 0..121 {
            enqueue(
                &dependencies,
                &host,
                Interval { seconds: 60, disconnected_seconds: 60, healthy_playback_seconds: 60, ..Interval::default() },
            )
            .await;
            clock.set(Timestamp::from_unix_seconds(now.unix_seconds() + (minute + 1) * 60).unwrap());
        }
        let rows = dependencies
            .state
            .run(|connection| outbox::pending(connection, outbox::OutboxKind::TelemetrySample, 500))
            .await
            .unwrap();
        assert_eq!(rows.len(), 120);
        assert_eq!(rows[0].event_id, uuid::Uuid::from_u128(2).to_string());
        let value: serde_json::Value = serde_json::from_str(&rows[0].body).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"observedAt":"2026-10-04T12:01:00Z",
            "currentItemId":"item","itemStartedAt":"2026-10-04T12:01:00Z","rendererState":"healthy","cacheUsedBytes":4096,
            "interval":{"seconds":60,"connectedSeconds":0,"disconnectedSeconds":60,"healthyPlaybackSeconds":60,
                "stalledPlaybackSeconds":0,"socketReconnectCount":0,"rendererCrashCount":0}})
        );
        let activity = dependencies
            .state
            .run(|connection| outbox::pending(connection, outbox::OutboxKind::ActivityEvent, 500))
            .await
            .unwrap();
        assert_eq!(activity.len(), 1, "telemetry never displaces this Activity event");
        drop(dependencies);
        let reopened = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        assert_eq!(
            reopened
                .run(|connection| outbox::pending(connection, outbox::OutboxKind::TelemetrySample, 500))
                .await
                .unwrap()
                .len(),
            120
        );
    }

    #[test]
    fn counters_are_sums_over_the_minute_and_reset() {
        let mut accumulator = Accumulator::default();
        let playing =
            TelemetryTick { bound: true, connected: true, renderer_connected: true, playing: true, healthy: true };
        for _ in 0..30 {
            accumulator.observe(playing);
        }
        for _ in 0..10 {
            accumulator.observe(TelemetryTick { connected: false, healthy: false, ..playing });
        }
        accumulator.observe(TelemetryTick { renderer_connected: false, ..playing });
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
