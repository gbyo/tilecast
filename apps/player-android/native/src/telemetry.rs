//! Bounded player telemetry from Android measurements.
//!
//! Core owns the sampling cadence, the counters, and the bounded
//! offline queue; the Activity driver uploads the queued samples.
//! This module only supplies the host side: the [`AndroidTelemetryHost`]
//! implementation and the [`AndroidClocks`] the Activity driver stamps
//! events with.
//!
//! A measurement Android cannot make is omitted, never sent as zero.
//! Nothing here names a host, an address, a URL, or a credential.
//! Renderer-attached gauges (current item, progress, renderer state)
//! arrive with the renderer adapter in PR2b-5c; until then the samples
//! carry store, storage, uptime, clock, and display measurements.

use std::path::PathBuf;
use std::sync::Arc;

use player_cas::ContentStore;
use player_cas::space::SpaceProbe as _;
use player_core::{ServerLinkState, TelemetryGauges, TelemetryHost, TelemetryTick};
use player_state::StateDb;
use player_types::Timestamp;
use player_types::time::SharedClock;

use crate::host::StatvfsProbe;
use crate::pairing_host::MetadataSource;
use crate::server_link::LinkSignals;

/// The Activity driver's clocks: process monotonic time for durations
/// and the shared wall clock for timestamps.
#[derive(Debug, Clone)]
pub struct AndroidClocks {
    started: std::time::Instant,
    clock: SharedClock,
}

impl AndroidClocks {
    pub fn new(clock: SharedClock) -> Self {
        Self { started: std::time::Instant::now(), clock }
    }
}

impl player_core::ActivityClocks for AndroidClocks {
    fn mono_ms(&self) -> i64 {
        self.started.elapsed().as_millis().min(i64::MAX as u128) as i64
    }

    fn wall_ms(&self) -> i64 {
        self.clock.now().unix_millis()
    }

    fn uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// The player's time zone from device facts, as the Electron player
/// reports it. Facts are read once when the drivers are built; a
/// restart picks up a zone change.
pub fn player_timezone(meta: &Arc<dyn MetadataSource>) -> String {
    meta.device_metadata_json()
        .ok()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|facts| facts.get("timezone").and_then(|zone| zone.as_str()).map(str::to_owned))
        .map(|zone| zone.chars().filter(|c| !c.is_control()).take(80).collect::<String>())
        .filter(|zone| !zone.is_empty())
        .unwrap_or_else(|| "UTC".to_owned())
}

/// Android's [`TelemetryHost`]: link and store measurements Core
/// samples once a second and uploads once a minute.
#[derive(Debug, Clone)]
pub struct AndroidTelemetryHost {
    state: StateDb,
    cas: ContentStore,
    signals: Arc<LinkSignals>,
    meta: Arc<dyn MetadataSource>,
    renderer: Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>,
    state_dir: PathBuf,
    started_at: Timestamp,
}

impl AndroidTelemetryHost {
    pub fn new(
        state: StateDb,
        cas: ContentStore,
        signals: Arc<LinkSignals>,
        meta: Arc<dyn MetadataSource>,
        renderer: Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>,
        state_dir: PathBuf,
        started_at: Timestamp,
    ) -> Self {
        Self { state, cas, signals, meta, renderer, state_dir, started_at }
    }

    fn display(&self) -> Option<(u64, u64)> {
        let facts: serde_json::Value =
            self.meta.device_metadata_json().ok().and_then(|json| serde_json::from_str(&json).ok())?;
        let width = facts.get("screenWidth")?.as_u64()?;
        let height = facts.get("screenHeight")?.as_u64()?;
        (width > 0 && height > 0).then_some((width, height))
    }
}

#[async_trait::async_trait]
impl TelemetryHost for AndroidTelemetryHost {
    fn new_sample_id(&self) -> uuid::Uuid {
        uuid::Uuid::new_v4()
    }

    async fn observe(&self) -> TelemetryTick {
        let link = self.signals.link_state.lock().unwrap_or_else(|error| error.into_inner()).clone();
        let renderer = self.renderer.lock().unwrap_or_else(|error| error.into_inner()).clone();
        TelemetryTick {
            bound: !matches!(link, ServerLinkState::Unbound),
            connected: matches!(link, ServerLinkState::Connected),
            // A live WebView instance is connected; only a playing
            // presentation with content evidence counts as playing.
            renderer_connected: renderer.connected,
            playing: renderer.playing && renderer.evidence,
            healthy: renderer.state == "healthy",
        }
    }

    async fn gauges(&self, now: Timestamp) -> TelemetryGauges {
        let uptime = tokio::task::spawn_blocking({
            let meta = self.meta.clone();
            move || meta.device_uptime_seconds()
        })
        .await
        .ok()
        .flatten();
        let usage = self.cas.usage().await.ok();
        let offset = self
            .state
            .run(|connection| player_state::repo::playback::get(connection))
            .await
            .ok()
            .and_then(|flags| flags.server_clock_offset_ms);
        let display = self.display();
        let renderer = self.renderer.lock().unwrap_or_else(|error| error.into_inner()).clone();
        TelemetryGauges {
            current_item_id: renderer.current_item_id,
            item_started_at: None,
            last_meaningful_progress_at: None,
            renderer_state: (!renderer.state.is_empty()).then_some(renderer.state),
            cache_used_bytes: usage.as_ref().map(|usage| usage.used_bytes),
            cache_limit_bytes: Some(self.cas.policy().limit_bytes),
            free_storage_bytes: StatvfsProbe.available_bytes(&self.state_dir).ok(),
            process_uptime_seconds: Some((now.unix_millis() - self.started_at.unix_millis()).max(0) / 1000),
            device_uptime_seconds: uptime,
            clock_offset_seconds: offset.map(|ms| (ms as f64 / 1000.0).round() as i64),
            display_connected: display.map(|_| true),
            display_resolution: display.map(|(width, height)| format!("{width}x{height}")),
            display_refresh_hz: None,
        }
    }

    fn has_authenticated_server(&self) -> bool {
        self.signals.command_server.borrow().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::{LruByDomain, StorePolicy};
    use player_core::ActivityClocks as _;
    use player_state::{OpenOptions, StateDb};
    use player_types::time::WallClock as _;

    const FACTS: &str = r#"{"screenWidth": 1920, "screenHeight": 1080, "timezone": "Europe/Berlin"}"#;

    async fn scratch(
        dir: &std::path::Path,
    ) -> (AndroidTelemetryHost, Arc<LinkSignals>, Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>) {
        std::fs::create_dir_all(dir).expect("scratch dir");
        let db = StateDb::open(dir.join("state.db"), OpenOptions::default()).expect("state");
        let clock = std::sync::Arc::new(crate::host::SystemClock);
        let store = ContentStore::open(
            dir.join("cas"),
            dir.join("partial"),
            db.clone(),
            clock.clone(),
            std::sync::Arc::new(crate::host::StatvfsProbe),
            std::sync::Arc::new(crate::host::AndroidSecureOpener),
            StorePolicy { limit_bytes: 8 * 1024 * 1024, reserved_free_bytes: 0 },
            std::sync::Arc::new(LruByDomain),
        )
        .await
        .expect("store open");
        let signals = Arc::new(LinkSignals::default());
        let renderer = Arc::new(std::sync::Mutex::new(crate::renderer::RendererSnapshot::default()));
        let host = AndroidTelemetryHost::new(
            db,
            store,
            signals.clone(),
            Arc::new(crate::pairing_host::MemMetadataSource::with_facts(FACTS).with_uptime(5208)),
            renderer.clone(),
            dir.to_path_buf(),
            clock.now(),
        );
        (host, signals, renderer)
    }

    #[tokio::test]
    async fn unbound_tick_reports_link_state_honestly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, signals, renderer) = scratch(dir.path()).await;
        let tick = host.observe().await;
        assert!(!tick.bound);
        assert!(!tick.connected);
        assert!(!tick.renderer_connected);
        assert!(!tick.playing);
        assert!(!tick.healthy);
        assert!(!host.has_authenticated_server());
        *signals.link_state.lock().expect("lock") = ServerLinkState::Connected;
        let tick = host.observe().await;
        assert!(tick.bound);
        assert!(tick.connected);
        {
            let mut snapshot = renderer.lock().expect("lock");
            snapshot.connected = true;
            snapshot.playing = true;
            snapshot.evidence = true;
            snapshot.state = "healthy".to_owned();
        }
        let tick = host.observe().await;
        assert!(tick.renderer_connected);
        assert!(tick.playing);
        assert!(tick.healthy);
    }

    #[tokio::test]
    async fn gauges_carry_store_storage_uptime_and_display() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, renderer) = scratch(dir.path()).await;
        let now = Timestamp::from_unix_millis(1_789_000_060_000).expect("now");
        let gauges = host.gauges(now).await;
        assert_eq!(gauges.cache_used_bytes, Some(0));
        assert_eq!(gauges.cache_limit_bytes, Some(8 * 1024 * 1024));
        assert!(gauges.free_storage_bytes.is_some_and(|free| free > 0));
        assert!(gauges.process_uptime_seconds.is_some_and(|up| up >= 0));
        assert_eq!(gauges.device_uptime_seconds, Some(5208));
        assert_eq!(gauges.display_connected, Some(true));
        assert_eq!(gauges.display_resolution.as_deref(), Some("1920x1080"));
        assert!(gauges.display_refresh_hz.is_none());
        // An uninitialized renderer snapshot reports nothing.
        assert!(gauges.current_item_id.is_none());
        assert!(gauges.item_started_at.is_none());
        assert!(gauges.last_meaningful_progress_at.is_none());
        assert!(gauges.renderer_state.is_none());
        assert!(gauges.clock_offset_seconds.is_none());
        {
            let mut snapshot = renderer.lock().expect("lock");
            snapshot.state = "healthy".to_owned();
            snapshot.current_item_id = Some("item-3".to_owned());
        }
        let gauges = host.gauges(now).await;
        assert_eq!(gauges.renderer_state.as_deref(), Some("healthy"));
        assert_eq!(gauges.current_item_id.as_deref(), Some("item-3"));
    }

    #[test]
    fn timezone_reads_facts_and_defaults_to_utc() {
        let meta: Arc<dyn MetadataSource> = Arc::new(crate::pairing_host::MemMetadataSource::with_facts(FACTS));
        assert_eq!(player_timezone(&meta), "Europe/Berlin");
        let meta: Arc<dyn MetadataSource> = Arc::new(crate::pairing_host::MemMetadataSource::with_facts("{}"));
        assert_eq!(player_timezone(&meta), "UTC");
        let meta: Arc<dyn MetadataSource> =
            Arc::new(crate::pairing_host::MemMetadataSource::with_facts(r#"{"timezone": ""}"#));
        assert_eq!(player_timezone(&meta), "UTC");
    }

    #[test]
    fn clocks_supply_monotonic_wall_and_uuids() {
        let clocks = AndroidClocks::new(Arc::new(crate::host::SystemClock));
        assert!(clocks.mono_ms() >= 0);
        assert!(clocks.wall_ms() > 0);
        assert_ne!(clocks.uuid(), clocks.uuid());
    }

    /// The outbox keeps two hours of telemetry and evicts the oldest
    /// first, counting every drop: an offline player never grows
    /// without bound and never loses the newest samples.
    #[test]
    fn telemetry_outbox_evicts_oldest_and_counts_drops() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).expect("state");
        let clock = crate::host::SystemClock;
        let now = player_types::time::WallClock::now(&clock);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        for index in 0..150 {
            let id = format!("00000000-0000-0000-0000-{index:012}");
            runtime
                .block_on(
                    db.run(move |connection| player_state::repo::outbox::enqueue_telemetry(connection, &id, "{}", now)),
                )
                .expect("enqueue");
        }
        let stats =
            runtime.block_on(db.run(|connection| player_state::repo::outbox::stats(connection))).expect("stats");
        assert_eq!(stats.queued_telemetry, 120);
        assert_eq!(stats.dropped_telemetry, 30);
        let oldest: String = runtime
            .block_on(db.run(|connection| {
                Ok::<_, player_state::StateError>(connection.query_row(
                    "SELECT event_id FROM outbox WHERE kind = 'telemetry_sample' ORDER BY id ASC LIMIT 1",
                    [],
                    |row| row.get(0),
                )?)
            }))
            .expect("oldest");
        assert_eq!(oldest, "00000000-0000-0000-0000-000000000030");
    }
}
