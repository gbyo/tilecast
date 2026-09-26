//! Audio on Tilecast Edge (M9): the session bridge's PipeWire inventory, and
//! the Noise Meter's host-measured levels (docs/tilecast-edge.md §4.4).
//!
//! PipeWire is a per-user service, so `tilecast-session-bridge` runs in the
//! tilecast account's session and connects here with the `session_bridge`
//! role. It sends what PipeWire offers (`audio.inventory`) and, only while
//! this module asks (`capture.set`), one RMS value per 60 ms
//! (`audio.level`). No audio sample crosses the socket: the events carry a
//! number in `[0, 1]` and a state token, and strict decoding refuses anything
//! else.
//!
//! The microphone opens only while all three hold:
//!
//! 1. the current server presentation carries a `noise_meter` plugin;
//! 2. a ready renderer shows it;
//! 3. the runtime's Noise Meter wants readings. With `host-levels` the
//!    runtime reports `active` when it starts listening and `inactive` when
//!    it stops (outside the meter's window, or while the screen sleeps), as
//!    the reference player opens and closes its microphone.
//!
//! Levels go to the renderer at most [`MAX_LEVEL_RATE_HZ`] times a second.
//! The runtime turns them into the bar and ten-second history buckets; this
//! module stores completed buckets in SQLite and the heartbeat carries them
//! to the server, which acknowledges what it stored.

use std::sync::Arc;
use std::time::{Duration, Instant};

use edge_ipc::SessionHandle;
use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortToken, Token};
use edge_protocol::capability::{AttributeValue, Capability, CapabilityId, CapabilityState, ids};
use edge_protocol::ipc::event::{
    AudioInventory, AudioLevel, CaptureSet, CaptureState, Event, NoiseReport, NoiseStatus, PipewireState,
};
use edge_state::repo::noise_history::{self, Bucket};
use serde_json::{Value, json};

use crate::daemon::DaemonContext;

/// The bridge measures every 60 ms; anything faster is dropped.
pub const MAX_LEVEL_RATE_HZ: u64 = 20;
const MIN_LEVEL_INTERVAL: Duration = Duration::from_millis(1_000 / MAX_LEVEL_RATE_HZ - 5);
/// A bridge that keeps sending far faster than it should is disconnected.
const FLOOD_WINDOW: Duration = Duration::from_secs(10);
const FLOOD_LIMIT: u32 = 200;
/// While readings are wanted but none can arrive, the runtime hears so this
/// often, so its meter reports itself unavailable instead of freezing.
const UNAVAILABLE_INTERVAL: Duration = Duration::from_secs(1);
const TICK: Duration = Duration::from_millis(500);
/// A renderer that stores buckets faster than one per this is misbehaving.
const MIN_BUCKET_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Default)]
struct State {
    bridge: Option<SessionHandle>,
    inventory: Option<AudioInventory>,
    /// The bridge's last reported capture state.
    capture: Option<CaptureState>,
    /// What this module last told the bridge.
    requested: Option<bool>,
    /// The runtime's last Noise Meter report.
    runtime_status: Option<NoiseStatus>,
    runtime_level: Option<f64>,
    last_forward: Option<Instant>,
    last_unavailable: Option<Instant>,
    flood_started: Option<Instant>,
    flood_count: u32,
    last_bucket: Option<Instant>,
}

#[derive(Debug, Default)]
pub struct Audio {
    state: std::sync::Mutex<State>,
}

/// What a level event led to.
#[derive(Debug, Clone, PartialEq)]
pub enum LevelOutcome {
    /// Forward this reading to the renderer.
    Forward(Option<f64>),
    /// Dropped: nothing asked for it, or it came too soon.
    Dropped,
    /// The bridge broke the contract; close its session with this reason.
    Violation(&'static str),
}

impl Audio {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn bridge_connected(&self, session: SessionHandle) {
        let mut state = self.state();
        state.bridge = Some(session);
        state.capture = None;
        state.requested = None;
        tracing::info!(component = "audio", event = "bridge_connected");
    }

    pub fn bridge_disconnected(&self, session: &SessionHandle) {
        let mut state = self.state();
        if state.bridge.as_ref().is_some_and(|bridge| bridge.id() == session.id()) {
            state.bridge = None;
            state.capture = None;
            state.requested = None;
            tracing::info!(component = "audio", event = "bridge_disconnected");
        }
    }

    pub fn bridge_is_connected(&self) -> bool {
        self.state().bridge.as_ref().is_some_and(|bridge| !bridge.is_closed())
    }

    pub fn inventory(&self, inventory: AudioInventory) -> bool {
        let mut state = self.state();
        let changed = state.inventory.as_ref() != Some(&inventory);
        state.inventory = Some(inventory);
        changed
    }

    /// Validates, rate-limits and records one level. Returns what to do.
    pub fn level(&self, level: AudioLevel, now: Instant) -> LevelOutcome {
        if !level.is_consistent() {
            return LevelOutcome::Violation("audio_level_inconsistent");
        }
        let mut state = self.state();
        if state.flood_started.is_none_or(|started| now.duration_since(started) >= FLOOD_WINDOW) {
            state.flood_started = Some(now);
            state.flood_count = 0;
        }
        state.flood_count += 1;
        if state.flood_count > FLOOD_LIMIT {
            return LevelOutcome::Violation("audio_level_rate_exceeded");
        }
        state.capture = Some(level.state);
        if state.requested != Some(true) {
            // A reading nobody asked for is never forwarded.
            return LevelOutcome::Dropped;
        }
        if level.rms.is_some() && state.last_forward.is_some_and(|at| now.duration_since(at) < MIN_LEVEL_INTERVAL) {
            return LevelOutcome::Dropped;
        }
        state.last_forward = Some(now);
        LevelOutcome::Forward(level.rms)
    }

    /// Records the runtime's report. Returns a bucket to store, if any.
    pub fn noise_report(&self, report: NoiseReport, now: Instant) -> Option<Bucket> {
        let mut state = self.state();
        state.runtime_status = Some(report.status);
        state.runtime_level = report.level;
        let bucket = report.bucket?;
        if state.last_bucket.is_some_and(|at| now.duration_since(at) < MIN_BUCKET_INTERVAL) {
            tracing::warn!(component = "audio", event = "noise_bucket_too_soon");
            return None;
        }
        state.last_bucket = Some(now);
        Some(Bucket {
            started_at_ms: bucket.started_at.unix_millis(),
            average_level: bucket.average_level,
            peak_level: bucket.peak_level,
            monitored_ms: bucket.monitored_ms,
            warning_ms: bucket.warning_ms,
            loud_ms: bucket.loud_ms,
            trigger_count: bucket.trigger_count,
        })
    }

    /// A new or reloaded runtime starts without a Noise Meter.
    pub fn renderer_reset(&self) {
        let mut state = self.state();
        state.runtime_status = None;
        state.runtime_level = None;
    }

    fn runtime_wants_readings(state: &State) -> bool {
        matches!(
            state.runtime_status,
            Some(NoiseStatus::Active | NoiseStatus::Normal | NoiseStatus::Loud | NoiseStatus::Unavailable)
        )
    }

    /// Tells the bridge to open or release the microphone when that changed.
    /// `plugin_active`: a ready renderer shows a `noise_meter` plugin.
    pub fn reconcile_capture(&self, plugin_active: bool) -> bool {
        let mut state = self.state();
        let wanted = plugin_active && Self::runtime_wants_readings(&state);
        if !plugin_active {
            state.runtime_status = None;
            state.runtime_level = None;
        }
        let Some(bridge) = state.bridge.clone() else { return wanted };
        if state.requested != Some(wanted)
            && bridge.send_event(Event::CaptureSet(CaptureSet { enabled: wanted })).is_ok()
        {
            tracing::info!(component = "audio", event = "capture_requested", enabled = wanted);
            state.requested = Some(wanted);
            if !wanted {
                state.capture = Some(CaptureState::Idle);
            }
        }
        wanted
    }

    /// Whether the runtime should hear `rms: null` now: readings are wanted
    /// but the bridge is absent or not capturing.
    pub fn unavailable_due(&self, wanted: bool, now: Instant) -> bool {
        let mut state = self.state();
        let capturing = state.bridge.is_some() && state.capture == Some(CaptureState::Capturing);
        if !wanted || capturing {
            state.last_unavailable = None;
            return false;
        }
        if state.last_unavailable.is_some_and(|at| now.duration_since(at) < UNAVAILABLE_INTERVAL) {
            return false;
        }
        state.last_unavailable = Some(now);
        true
    }

    /// The heartbeat `noiseMeter` status and level, as the reference player
    /// reports them; `None` while inactive with nothing queued.
    fn heartbeat_status(&self) -> (NoiseStatus, Option<f64>) {
        let state = self.state();
        (state.runtime_status.unwrap_or(NoiseStatus::Inactive), state.runtime_level)
    }

    /// `audio.pipewire`, `audio.input`, `audio.output` and
    /// `audio.noise_meter`.
    pub fn capabilities(&self, now: Timestamp) -> Vec<Capability> {
        let state = self.state();
        let connected = state.bridge.as_ref().is_some_and(|bridge| !bridge.is_closed());
        let mut out = Vec::new();
        let no_bridge = (CapabilityState::Blocked, Some("session_bridge_not_connected"));
        let pipewire = match (&state.inventory, connected) {
            (_, false) => no_bridge,
            (Some(inventory), true) if inventory.pipewire == PipewireState::Available => {
                (CapabilityState::Available, None)
            }
            (Some(_), true) => (CapabilityState::Unsupported, Some("pipewire_unavailable")),
            (None, true) => (CapabilityState::Supported, Some("inventory_pending")),
        };
        out.extend(capability(ids::AUDIO_PIPEWIRE, pipewire, &[], now));
        type Side = fn(&AudioInventory) -> (u16, bool);
        let endpoint = |side: Side, missing: &'static str, no_default: &'static str| {
            match (&state.inventory, connected) {
                (_, false) => no_bridge,
                (None, true) => (CapabilityState::Supported, Some("inventory_pending")),
                (Some(inventory), true) if inventory.pipewire != PipewireState::Available => {
                    (CapabilityState::Blocked, Some("pipewire_unavailable"))
                }
                (Some(inventory), true) => match side(inventory) {
                    (0, _) => (CapabilityState::Unsupported, Some(missing)),
                    (_, true) => (CapabilityState::Available, None),
                    // Devices exist, but the session manager routes to none.
                    (_, false) => (CapabilityState::Degraded, Some(no_default)),
                },
            }
        };
        let attributes = |side: Side| {
            state
                .inventory
                .as_ref()
                .map(|inventory| {
                    let (count, default) = side(inventory);
                    vec![
                        ("devices", AttributeValue::Integer(i64::from(count))),
                        ("defaultPresent", AttributeValue::Bool(default)),
                    ]
                })
                .unwrap_or_default()
        };
        let input: Side = |i| (i.sources, i.default_source);
        let output: Side = |i| (i.sinks, i.default_sink);
        out.extend(capability(
            ids::AUDIO_INPUT,
            endpoint(input, "no_microphone", "no_default_source"),
            &attributes(input),
            now,
        ));
        out.extend(capability(
            ids::AUDIO_OUTPUT,
            endpoint(output, "no_audio_output", "no_default_sink"),
            &attributes(output),
            now,
        ));
        let noise = if !connected {
            no_bridge
        } else {
            match state.capture {
                Some(CaptureState::Capturing) => (CapabilityState::Available, None),
                Some(CaptureState::Starting) => (CapabilityState::Supported, Some("capture_starting")),
                Some(CaptureState::NoMicrophone) => (CapabilityState::Unsupported, Some("no_microphone")),
                Some(CaptureState::PipewireUnavailable) => (CapabilityState::Blocked, Some("pipewire_unavailable")),
                Some(CaptureState::PermissionDenied) => (CapabilityState::Blocked, Some("permission_denied")),
                Some(CaptureState::CaptureFailed) => (CapabilityState::Degraded, Some("capture_failed")),
                Some(CaptureState::Recovering) => (CapabilityState::Degraded, Some("capture_recovering")),
                Some(CaptureState::Idle) | None => match &state.inventory {
                    Some(inventory) if inventory.pipewire != PipewireState::Available => {
                        (CapabilityState::Blocked, Some("pipewire_unavailable"))
                    }
                    Some(inventory) if inventory.sources == 0 => (CapabilityState::Unsupported, Some("no_microphone")),
                    _ => (CapabilityState::Supported, Some("capture_not_requested")),
                },
            }
        };
        out.extend(capability(
            ids::AUDIO_NOISE_METER,
            noise,
            &[("measurement", AttributeValue::Text(edge_protocol::bounded::ShortText::lossy("host-levels")))],
            now,
        ));
        out
    }
}

fn detail(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "session_bridge_not_connected" => {
            "tilecast-session-bridge is not connected; check the tilecast account's user session and lingering."
        }
        "pipewire_unavailable" => "PipeWire or its GStreamer element is not available in the tilecast session.",
        "inventory_pending" => "The session bridge has not reported its audio devices yet.",
        "no_microphone" => "PipeWire offers no audio input.",
        "no_audio_output" => "PipeWire offers no audio output.",
        "no_default_source" => "WirePlumber has no default audio input.",
        "no_default_sink" => "WirePlumber has no default audio output.",
        "permission_denied" => "PipeWire refused access to the microphone.",
        "capture_failed" => "Microphone capture failed.",
        "capture_recovering" => "Microphone capture failed and is being retried.",
        "capture_starting" => "Microphone capture is starting.",
        "capture_not_requested" => "The microphone is closed until a Noise Meter asks for readings.",
        _ => return None,
    })
}

fn capability(
    id: &str,
    (state, reason): (CapabilityState, Option<&str>),
    attributes: &[(&str, AttributeValue)],
    now: Timestamp,
) -> Option<Capability> {
    let mut capability = Capability::new(CapabilityId::new(id).ok()?, state, now);
    capability.provider = ShortToken::new("tilecast-session-bridge").ok();
    capability.reason_code = reason.and_then(|reason| ShortToken::new(reason).ok());
    capability.detail = reason.and_then(detail).map(DetailText::lossy);
    for (name, value) in attributes {
        if let Ok(key) = Token::<48>::new(*name) {
            capability.attributes.insert(key, value.clone());
        }
    }
    Some(capability)
}

/// The plugin's history retention (`config.historyRetentionDays`, 1–30).
fn retention_days(plugin: Option<&Value>) -> u32 {
    plugin
        .and_then(|plugin| plugin.get("config"))
        .and_then(|config| config.get("historyRetentionDays"))
        .and_then(Value::as_u64)
        .filter(|days| (1..=30).contains(days))
        .map_or(noise_history::DEFAULT_RETENTION_DAYS, |days| days as u32)
}

/// Stores one completed bucket from the runtime.
pub async fn store_bucket(context: &DaemonContext, bucket: Bucket) {
    let Some(db) = context.db() else { return };
    let retention = retention_days(context.presentation.lock().await.noise_meter_plugin());
    let now_ms = context.now().unix_millis();
    let Some(clean) = noise_history::sanitize(&bucket, now_ms, retention) else {
        tracing::warn!(component = "audio", event = "noise_bucket_rejected");
        return;
    };
    match db.run(move |c| noise_history::add(c, &clean, now_ms, retention)).await {
        Ok(pruned) if pruned > 0 => tracing::warn!(component = "audio", event = "noise_history_pruned", pruned),
        Ok(_) => {}
        Err(error) => tracing::warn!(component = "audio", event = "noise_history_store_failed", error = %error),
    }
}

/// Queued history records, for the choice between socket and HTTP.
pub async fn history_pending(context: &DaemonContext) -> bool {
    match context.db() {
        Some(db) => db.run(|c| noise_history::count(c)).await.is_ok_and(|count| count > 0),
        None => false,
    }
}

/// Adds the heartbeat `noiseMeter` section. With `include_history` it
/// carries the oldest queued batch and returns the keys it carried, which
/// only an acknowledgement may remove.
pub async fn heartbeat(context: &DaemonContext, heartbeat: &mut Value, include_history: bool) -> Vec<i64> {
    let pending = match (include_history, context.db()) {
        (true, Some(db)) => db.run(|c| noise_history::peek(c, noise_history::BATCH)).await.unwrap_or_default(),
        _ => Vec::new(),
    };
    let (status, level) = context.audio.heartbeat_status();
    if status == NoiseStatus::Inactive && pending.is_empty() {
        return Vec::new();
    }
    let mut section = json!({"status": status.as_str()});
    if let Some(level) = level {
        section["currentLevel"] = json!((level * 10.0).round() / 10.0);
    }
    if !pending.is_empty() {
        section["pendingHistory"] = Value::Array(
            pending
                .iter()
                .filter_map(|bucket| {
                    Some(json!({
                        "startedAt": Timestamp::from_unix_millis(bucket.started_at_ms)?.to_string(),
                        "averageLevel": bucket.average_level,
                        "peakLevel": bucket.peak_level,
                        "monitoredMs": bucket.monitored_ms,
                        "warningMs": bucket.warning_ms,
                        "loudMs": bucket.loud_ms,
                        "triggerCount": bucket.trigger_count,
                    }))
                })
                .collect(),
        );
    }
    heartbeat["noiseMeter"] = section;
    pending.iter().map(|bucket| bucket.started_at_ms).collect()
}

/// Removes what the server said it stored, and only that.
pub async fn acknowledge(context: &DaemonContext, sent: Vec<i64>, accepted: Option<u64>) {
    let (Some(db), Some(accepted)) = (context.db(), accepted.filter(|n| *n > 0)) else { return };
    if sent.is_empty() {
        return;
    }
    if let Err(error) = db.run(move |c| noise_history::acknowledge(c, &sent, accepted)).await {
        tracing::warn!(component = "audio", event = "noise_history_ack_failed", error = %error);
    }
}

/// Keeps the bridge's capture in step with the Noise Meter and tells the
/// runtime when no reading can come.
pub async fn run(context: Arc<DaemonContext>) {
    let mut ticker = tokio::time::interval(TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_capabilities = Vec::new();
    loop {
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = context.audio_wake.notified() => {}
            _ = ticker.tick() => {}
        }
        let engine = context.presentation.lock().await;
        let plugin_active = engine.noise_meter_plugin().is_some();
        let wanted = context.audio.reconcile_capture(plugin_active);
        if context.audio.unavailable_due(wanted, Instant::now()) {
            engine.send_noise_level(None);
        }
        drop(engine);
        let now = context.now();
        let capabilities = context.audio.capabilities(now);
        if edge_protocol::capability::CapabilitySnapshot::materially_differs(&last_capabilities, &capabilities) {
            last_capabilities = capabilities;
            crate::capabilities::refresh(&context).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64, base: Instant) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn levels_flow_only_when_asked_and_at_a_bounded_rate() {
        let audio = Audio::default();
        let base = Instant::now();
        let reading = |rms| AudioLevel { rms: Some(rms), state: CaptureState::Capturing };
        assert_eq!(audio.level(reading(0.1), base), LevelOutcome::Dropped, "nobody asked for it");
        audio.state().requested = Some(true);
        assert_eq!(audio.level(reading(0.1), at(1, base)), LevelOutcome::Forward(Some(0.1)));
        assert_eq!(audio.level(reading(0.2), at(20, base)), LevelOutcome::Dropped, "faster than 20 Hz");
        assert_eq!(audio.level(reading(0.3), at(61, base)), LevelOutcome::Forward(Some(0.3)));
        let silent = AudioLevel { rms: None, state: CaptureState::NoMicrophone };
        assert_eq!(audio.level(silent, at(62, base)), LevelOutcome::Forward(None), "a state change is never held back");
        let inconsistent = AudioLevel { rms: Some(0.1), state: CaptureState::Idle };
        assert_eq!(audio.level(inconsistent, at(200, base)), LevelOutcome::Violation("audio_level_inconsistent"));
        let mut outcome = LevelOutcome::Dropped;
        for index in 0..=FLOOD_LIMIT {
            outcome = audio.level(reading(0.1), at(300 + u64::from(index), base));
        }
        assert_eq!(outcome, LevelOutcome::Violation("audio_level_rate_exceeded"));
    }

    #[test]
    fn the_microphone_is_wanted_only_while_the_runtime_listens_to_a_shown_plugin() {
        let audio = Audio::default();
        let report = |status| NoiseReport { status, level: None, bucket: None };
        assert!(!audio.reconcile_capture(true), "a plugin alone does not open the microphone");
        audio.noise_report(report(NoiseStatus::Active), Instant::now());
        assert!(audio.reconcile_capture(true));
        assert!(!audio.reconcile_capture(false), "no shown plugin, no capture");
        assert!(!audio.reconcile_capture(true), "and the old report does not revive it");
        audio.noise_report(report(NoiseStatus::Loud), Instant::now());
        assert!(audio.reconcile_capture(true));
        audio.noise_report(report(NoiseStatus::Inactive), Instant::now());
        assert!(!audio.reconcile_capture(true), "outside its window the runtime stops listening");
    }

    #[test]
    fn capabilities_name_every_reason() {
        let audio = Audio::default();
        let now = Timestamp::parse("2026-09-25T12:00:00Z").expect("time");
        let find = |caps: &[Capability], id: &str| {
            let capability = caps.iter().find(|c| c.id.as_str() == id).expect(id).clone();
            (capability.state, capability.reason_code.map(|r| r.as_str().to_owned()))
        };
        let caps = audio.capabilities(now);
        assert_eq!(
            find(&caps, "audio.noise_meter"),
            (CapabilityState::Blocked, Some("session_bridge_not_connected".into()))
        );
        assert_eq!(
            find(&caps, "audio.pipewire"),
            (CapabilityState::Blocked, Some("session_bridge_not_connected".into()))
        );
        assert_eq!(caps.len(), 4);
    }

    #[test]
    fn retention_follows_the_plugin_and_stays_in_range() {
        assert_eq!(retention_days(None), 7);
        assert_eq!(retention_days(Some(&json!({"config": {"historyRetentionDays": 14}}))), 14);
        assert_eq!(retention_days(Some(&json!({"config": {"historyRetentionDays": 90}}))), 7);
    }
}
