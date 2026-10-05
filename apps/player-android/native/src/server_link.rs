//! The Android host's link to the Tilecast Server.
//!
//! One task, one owner of the device credential, driven by Core's
//! `drive_server_link`: the identity gate, the player WebSocket with
//! fallback heartbeats, configuration and manifest reconciliation, and
//! publication of the verified server to the command task. This module
//! only supplies the host side: the [`AndroidServerLinkHost`]
//! implementation, the owned [`LinkSignals`] bundle, and the Android
//! heartbeat projection.
//!
//! The heartbeat reports only values with a real Core-side or device
//! source today: device facts, uptime, the packaged presentation
//! profile, manifest versions, configuration state, store usage, and
//! the preparation outcome. Renderer, website, widget, command,
//! update, reliability, and commissioning fields arrive with the
//! drivers that own them (PR2b-5) and the PR3 cutover, which must
//! audit the final payload against the Kotlin `HeartbeatRequest` it
//! replaces; nothing here is fabricated to fill the shape.

use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64},
};

use player_cas::ContentStore;
use player_cas::space::SpaceProbe as _;
use player_client::AuthenticatedServer;
use player_core::{
    ActivityEvent, ActivityHandle, ActivitySignal, ConfigurationHost, LiveFrame, NativeConfiguration, ServerLinkState,
    SharedManifestPreparationStatus,
};
use player_state::StateDb;
use player_types::Timestamp;
use tokio::sync::{Notify, mpsc, watch};

use crate::commands::CommandStatus;
use crate::config_host::{AndroidConfigHost, AndroidPlayerConfig};
use crate::host::StatvfsProbe;
use crate::manifest_host::AndroidManifestHost;
use crate::pairing_host::MetadataSource;

/// A random number in `[0, 1)` for retry jitter.
fn jitter_unit() -> f64 {
    use ring::rand::SecureRandom as _;
    let mut bytes = [0_u8; 4];
    if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
        return 0.5;
    }
    f64::from(u32::from_le_bytes(bytes)) / (f64::from(u32::MAX) + 1.0)
}

/// The owned server-link signals. Core borrows these for the drive;
/// the host owns their storage, as the trait contract requires.
#[derive(Debug)]
pub struct LinkSignals {
    pub server_wake: Arc<Notify>,
    pub manifest_wake: Arc<Notify>,
    pub preparation: SharedManifestPreparationStatus,
    pub link_state: Arc<Mutex<ServerLinkState>>,
    pub last_server_contact: Arc<Mutex<Option<Timestamp>>>,
    pub command_wake: Arc<Notify>,
    pub command_server: watch::Sender<Option<AuthenticatedServer>>,
    pub sync_request: Arc<AtomicU64>,
    pub sync_done: watch::Sender<(u64, bool)>,
    pub live_stream_wake: Arc<Notify>,
    pub live_frames: watch::Sender<Option<LiveFrame>>,
    pub status_due: Arc<AtomicBool>,
    pub manifest_item_boundary: Arc<AtomicBool>,
    /// The selection gate in force, published by the selection driver:
    /// Core's rest (off-hours) or disabled policy surface.
    pub gate: GateObservation,
    /// Validated platform observations from Kotlin, merged into the
    /// heartbeat projection.
    pub observations: crate::observations::PlatformObservations,
    /// Staged-manifest facts, written by preparation and read by the
    /// heartbeat and status.
    pub manifest_facts: crate::manifest_host::SharedManifestFacts,
}

/// The active selection gate, if the driver is showing one instead of
/// content. Read by the status snapshot and the heartbeat projection.
pub type GateObservation = Arc<Mutex<Option<GateState>>>;

/// Which gate the driver shows and when (wall ms) it took effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateState {
    pub gate: ActivationGateName,
    pub at_ms: i64,
}

/// The Core gates the Android driver can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationGateName {
    Rest,
    Disabled,
}

impl Default for LinkSignals {
    fn default() -> Self {
        Self {
            server_wake: Arc::new(Notify::new()),
            manifest_wake: Arc::new(Notify::new()),
            preparation: Arc::new(Mutex::new(player_core::ManifestPreparationStatus::default())),
            link_state: Arc::new(Mutex::new(ServerLinkState::Unbound)),
            last_server_contact: Arc::new(Mutex::new(None)),
            command_wake: Arc::new(Notify::new()),
            command_server: watch::Sender::new(None),
            sync_request: Arc::new(AtomicU64::new(0)),
            sync_done: watch::Sender::new((0, false)),
            live_stream_wake: Arc::new(Notify::new()),
            live_frames: watch::Sender::new(None),
            status_due: Arc::new(AtomicBool::new(false)),
            manifest_item_boundary: Arc::new(AtomicBool::new(false)),
            gate: Arc::new(Mutex::new(None)),
            observations: crate::observations::slot(),
            manifest_facts: Arc::new(Mutex::new(crate::manifest_host::ManifestFacts::default())),
        }
    }
}

/// Android's [`player_core::ServerLinkHost`]: configuration ownership
/// plus the authenticated origin, the heartbeat projection, and the
/// activity sink the Activity driver drains in PR2b-5.
#[derive(Debug, Clone)]
pub struct AndroidServerLinkHost {
    core: player_core::PlayerCore,
    state: StateDb,
    config: Arc<AndroidConfigHost>,
    cas: ContentStore,
    meta: Arc<dyn MetadataSource>,
    activity: ActivityHandle,
    preparation: SharedManifestPreparationStatus,
    commands: CommandStatus,
    renderer: Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>,
    engine: Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>,
    last_server_contact: Arc<std::sync::Mutex<Option<player_types::Timestamp>>>,
    gate: GateObservation,
    observations: crate::observations::PlatformObservations,
    manifest_facts: crate::manifest_host::SharedManifestFacts,
    clock: player_types::time::SharedClock,
    state_dir: PathBuf,
    started_at: std::time::Instant,
}

fn renderer_snapshot(
    renderer: &Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>,
) -> crate::renderer::RendererSnapshot {
    renderer.lock().unwrap_or_else(|error| error.into_inner()).clone()
}

/// The heartbeat `selectionSource` for a selection, in the server's shared
/// status vocabulary (`takeover`, `quick_present`, `schedule`,
/// `direct_fallback`, `none`); the server discards a whole status with any
/// other value. A direct assignment is reported as `direct_fallback`, as the
/// legacy player did. Mirrors Edge's `heartbeat_selection_source`.
pub fn heartbeat_selection_source(source: &str) -> Option<&'static str> {
    match source {
        "takeover" => Some("takeover"),
        "quick_present" => Some("quick_present"),
        "schedule" => Some("schedule"),
        "direct" => Some("direct_fallback"),
        "none" => Some("none"),
        _ => None,
    }
}

/// The heartbeat `currentItemId` for a renderer item key: playlist items
/// carry their manifest UUID, a directly shown layout's key is translated
/// back to the layout UUID, and anything else is omitted rather than sent,
/// because the server rejects a whole heartbeat over one malformed
/// identifier. Mirrors Edge's `heartbeat_item_id`.
pub fn heartbeat_item_id(key: &str) -> Option<String> {
    let candidate = key.strip_prefix("layout-").unwrap_or(key);
    uuid::Uuid::parse_str(candidate).ok().filter(|id| id.to_string() == candidate).map(|id| id.to_string())
}

/// The legacy playback-state vocabulary: safe mode first, then what the
/// current presentation document says it is. A playing presentation only
/// counts once content evidence proves it is really on screen.
fn playback_state(renderer: &crate::renderer::RendererSnapshot, presentation_state: Option<&str>) -> &'static str {
    if renderer.safe_mode {
        "safe_mode"
    } else {
        match presentation_state {
            Some("sleep") => "off_hours",
            Some("disabled") => "disabled",
            _ if renderer.playing && renderer.evidence => "playing",
            _ if renderer.playing => "starting",
            _ => "idle",
        }
    }
}

impl AndroidServerLinkHost {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        core: player_core::PlayerCore,
        state: StateDb,
        config: Arc<AndroidConfigHost>,
        cas: ContentStore,
        meta: Arc<dyn MetadataSource>,
        activity: ActivityHandle,
        preparation: SharedManifestPreparationStatus,
        commands: CommandStatus,
        renderer: Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>,
        engine: Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>,
        last_server_contact: Arc<std::sync::Mutex<Option<player_types::Timestamp>>>,
        gate: GateObservation,
        observations: crate::observations::PlatformObservations,
        manifest_facts: crate::manifest_host::SharedManifestFacts,
        clock: player_types::time::SharedClock,
        state_dir: PathBuf,
    ) -> Self {
        Self {
            core,
            state,
            config,
            cas,
            meta,
            activity,
            preparation,
            commands,
            renderer,
            engine,
            last_server_contact,
            gate,
            observations,
            manifest_facts,
            clock,
            state_dir,
            started_at: std::time::Instant::now(),
        }
    }

    /// Ordinary player status, sent on the socket or as the fallback
    /// heartbeat. Every field has a real source; fields owned by
    /// drivers that have not landed yet are omitted, never invented.
    pub async fn build_heartbeat(&self) -> serde_json::Value {
        let (facts, device_uptime) = tokio::task::spawn_blocking({
            let meta = self.meta.clone();
            move || (meta.device_metadata_json().ok(), meta.device_uptime_seconds())
        })
        .await
        .ok()
        .map(|(facts, uptime)| {
            let facts = facts
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .unwrap_or(serde_json::Value::Null);
            (facts, uptime)
        })
        .unwrap_or((serde_json::Value::Null, None));
        let number = |key: &str| facts.get(key).and_then(serde_json::Value::as_u64);
        let text = |key: &str| facts.get(key).and_then(serde_json::Value::as_str).unwrap_or_default();

        let snapshot = renderer_snapshot(&self.renderer);
        let locked = self.engine.lock().await;
        let current = locked.current_activation();
        // Capability advertisement follows the live renderer's ready
        // report; before any renderer proves itself the fresh-process
        // fallback (schema 1, legacy table) applies, as the legacy
        // player reported it. An unsupported runtime advertises nothing.
        let advertised = locked.advertised_support().unwrap_or_else(crate::manifest_host::fresh_connected);
        drop(locked);
        let mut native: serde_json::Map<String, serde_json::Value> = advertised
            .declarative_capabilities()
            .into_iter()
            .map(|(name, version)| (name, serde_json::json!(version)))
            .collect();
        // The heartbeat carries one table; Widget components overlay the
        // declarative names, as the legacy merge did.
        for (name, version) in advertised.widget_components() {
            native.insert(name, serde_json::json!(version));
        }
        let schemas = advertised.presentation_schemas();
        let presentation_state =
            current.as_ref().and_then(|active| active.presentation.get("state")).and_then(serde_json::Value::as_str);
        let mut heartbeat = serde_json::json!({
            "screenWidth": number("screenWidth").unwrap_or(0),
            "screenHeight": number("screenHeight").unwrap_or(0),
            "playerVersion": text("playerVersion"),
            "playerFamily": "android",
            "playerArchitecture": std::env::consts::ARCH,
            // Device uptime since boot, as the legacy player reported
            // it; process uptime is only the fallback.
            "uptimeSeconds": device_uptime
                .unwrap_or_else(|| self.started_at.elapsed().as_secs() as i64),
            // The legacy vocabulary: playing only once a playing
            // presentation proves itself with content evidence.
            "playbackState": playback_state(&snapshot, presentation_state),
            "presentationSchemaVersions": schemas,
            "nativePresentationCapabilities": native,
            // The remote host provides web.remote only while a renderer
            // is live to show it, as Edge reports it.
            "webRuntimeVersion": if snapshot.ready {
                crate::manifest_host::WEB_RUNTIME_VERSION
            } else {
                0
            },
        });
        // What the renderer is actually showing and why, as Edge
        // reports it: the committed selection, its schedule and
        // takeover, and the next transition. An active takeover also
        // drives the server's takeover screen states.
        if let Some(active) = current.as_ref() {
            if let Some(identity) = active.identity.as_ref() {
                if let Some(source) = heartbeat_selection_source(&identity.selection_source) {
                    heartbeat["selectionSource"] = serde_json::json!(source);
                }
                if let Some(playlist) = identity.playlist_id {
                    heartbeat["currentPlaylistId"] = serde_json::json!(playlist.to_string());
                }
                if let Some(schedule) = identity.schedule_id {
                    heartbeat["currentScheduleId"] = serde_json::json!(schedule.to_string());
                }
                if let Some(takeover) = identity.takeover_id {
                    heartbeat["activeTakeoverId"] = serde_json::json!(takeover.to_string());
                    heartbeat["takeoverState"] = serde_json::json!("active");
                }
                if let Some(next) = identity.next_transition_ms.and_then(player_types::Timestamp::from_unix_millis) {
                    heartbeat["nextTransitionAt"] = serde_json::json!(next.to_string());
                }
            }
            if let Some(asset) = active.content.first() {
                heartbeat["currentAssetId"] = serde_json::json!(asset.asset_id.to_string());
            }
        }
        if snapshot.playing
            && snapshot.evidence
            && !snapshot.safe_mode
            && let Some(progress_at) = snapshot.last_progress_at
        {
            heartbeat["lastHealthyPlaybackAt"] = serde_json::json!(progress_at.to_string());
        }
        if let Some(activated_at) = snapshot.last_activation_at {
            heartbeat["lastPlaylistTransitionAt"] = serde_json::json!(activated_at.to_string());
        }
        if let Some(contact) = *self.last_server_contact.lock().unwrap_or_else(|error| error.into_inner()) {
            heartbeat["lastServerConnectionAt"] = serde_json::json!(contact.to_string());
        }
        // What preparation staged: the assigned fallback playlist, whether
        // its presentation is on disk, and when the sync succeeded. The
        // server clears the assignment when it is absent, so a null here
        // unassigns rather than preserving a stale playlist.
        let staged = self.manifest_facts.lock().unwrap_or_else(|error| error.into_inner()).clone();
        heartbeat["assignedPlaylistId"] =
            staged.assigned_playlist_id.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null);
        heartbeat["cachedFallbackAvailable"] = serde_json::json!(staged.cached_fallback_available);
        if let Some(synced) = staged.last_successful_sync {
            heartbeat["lastSuccessfulSyncAt"] = serde_json::json!(synced.to_string());
        }
        // The rest gate is off-hours; anything else (including the
        // disabled gate, which has its own playback signal) is active.
        let gated_rest = self
            .gate
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some_and(|state| state.gate == ActivationGateName::Rest);
        heartbeat["activeHoursState"] = serde_json::json!(if gated_rest { "off_hours" } else { "active" });
        // Platform observations fill only what Core did not set.
        crate::observations::merge_observations(&mut heartbeat, &self.observations);
        if let Some(sdk) = number("androidSdk") {
            heartbeat["androidSdk"] = serde_json::json!(sdk);
        }
        if let Some(code) = number("playerVersionCode") {
            heartbeat["playerVersionCode"] = serde_json::json!(code);
        }
        for key in ["installerSource", "installPermissionStatus"] {
            if !text(key).is_empty() {
                heartbeat[key] = serde_json::json!(text(key));
            }
        }
        if let Ok(usage) = self.cas.usage().await {
            heartbeat["cacheUsedBytes"] = serde_json::json!(usage.used_bytes);
            heartbeat["cacheLimitBytes"] = serde_json::json!(self.cas.policy().limit_bytes);
        }
        if let Ok(available) = StatvfsProbe.available_bytes(&self.state_dir) {
            heartbeat["availableStorageBytes"] = serde_json::json!(available);
        }
        if let Ok(state) = self.state.run(|connection| player_state::repo::playback::get(connection)).await {
            heartbeat["playbackDisabled"] = serde_json::json!(state.playback_disabled);
            // The server refuses the whole heartbeat outside ±7 days; a
            // wild clock must degrade one reading, not the heartbeat.
            if let Some(offset) = state.server_clock_offset_ms.map(|offset| offset / 1000)
                && (-604_800..=604_800).contains(&offset)
            {
                heartbeat["deviceClockOffsetSeconds"] = serde_json::json!(offset);
            }
        }
        if let Ok(Some(bound)) = self.state.run(|connection| player_state::repo::binding::get(connection)).await
            && let Some(screen_id) = bound.screen_id
        {
            let binding = player_state::repo::manifests::Binding {
                installation_id: bound.installation_id,
                screen_id,
                server_url: bound.server_url,
            };
            for (stage, field) in [
                (player_state::repo::manifests::Stage::Active, "activeManifestVersion"),
                (player_state::repo::manifests::Stage::Pending, "pendingManifestVersion"),
            ] {
                let stage_binding = binding.clone();
                if let Ok(Some(stored)) = self
                    .state
                    .run(move |connection| player_state::repo::manifests::get_for(connection, stage, &stage_binding))
                    .await
                {
                    heartbeat[field] = serde_json::json!(stored.version);
                }
            }
        }
        if let Some(revision) = self.config.accepted_revision() {
            heartbeat["activeConfigRevision"] = serde_json::json!(revision);
        }
        {
            if let Some(item) = snapshot.current_item_id.as_deref().and_then(heartbeat_item_id) {
                heartbeat["currentItemId"] = serde_json::json!(item);
            }
            if let Some(error) = snapshot.last_error.as_deref() {
                heartbeat["lastPlaybackError"] = serde_json::json!(error);
            }
            heartbeat["safeMode"] = serde_json::json!(snapshot.safe_mode);
        }
        if let Ok(status) = self.state.run(|connection| player_state::repo::config::status(connection)).await
            && let Some(code) = status.last_error_code
        {
            heartbeat["configurationError"] = serde_json::json!(code);
        }
        let preparation = self.preparation.lock().unwrap_or_else(|error| error.into_inner()).clone();
        if let Some(reason) =
            preparation.reason.filter(|_| matches!(preparation.state, "failed" | "incompatible" | "invalid"))
        {
            heartbeat["lastSynchronizationError"] = serde_json::json!(reason.chars().take(240).collect::<String>());
        }
        if let Some(last) = self.commands.lock().unwrap_or_else(|error| error.into_inner()).clone() {
            heartbeat["lastCommandId"] = serde_json::json!(last.id);
            heartbeat["lastCommandState"] = serde_json::json!(last.state);
            heartbeat["lastCommandResult"] = serde_json::json!(last.result);
            heartbeat["lastCommandCompletedAt"] = serde_json::json!(last.completed_at);
        }
        heartbeat
    }
}

#[async_trait::async_trait]
impl ConfigurationHost for AndroidServerLinkHost {
    type Projection = AndroidPlayerConfig;

    fn prepare_configuration(
        &self,
        document: &serde_json::Value,
        native: &NativeConfiguration,
    ) -> Result<Self::Projection, &'static str> {
        ConfigurationHost::prepare_configuration(&*self.config, document, native)
    }

    async fn install_configuration(&self, projection: Option<Self::Projection>) {
        ConfigurationHost::install_configuration(&*self.config, projection).await;
    }
}

#[async_trait::async_trait]
impl player_core::ServerLinkHost for AndroidServerLinkHost {
    type Preparation = AndroidManifestHost;

    fn preparation_host(&self, server: &AuthenticatedServer) -> Arc<AndroidManifestHost> {
        Arc::new(AndroidManifestHost::new(
            self.core.clone(),
            self.cas.clone(),
            server.clone(),
            self.engine.clone(),
            self.clock.clone(),
            self.manifest_facts.clone(),
        ))
    }

    fn native_configuration(&self) -> NativeConfiguration {
        self.config.native_configuration()
    }

    fn jitter_unit(&self) -> f64 {
        jitter_unit()
    }

    fn record_activity(&self, event: ActivityEvent) {
        self.activity.record(event);
    }

    async fn heartbeat(&self) -> serde_json::Value {
        self.build_heartbeat().await
    }

    async fn presentation_protected(&self) -> bool {
        // No Watch Live producer exists until PR2b-5, so nothing is ever
        // protected yet. The renderer slice owns the real answer.
        false
    }
}

/// Creates the bounded activity channel. The host records into the
/// handle from the server link today; the Activity driver drains the
/// receiver in PR2b-5.
pub fn activity_channel() -> (ActivityHandle, mpsc::Receiver<ActivitySignal>) {
    ActivityHandle::channel()
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::{IngestMeta, LruByDomain, StorePolicy};
    use player_state::repo::cas::{Domain, SourceKind};
    use player_state::{OpenOptions, StateDb};
    use player_types::Sha256Digest;

    const FACTS: &str = r#"{
        "platform": "android-tv", "manufacturer": "test", "model": "test",
        "osRelease": "14", "playerVersion": "0.25.0",
        "screenWidth": 1920, "screenHeight": 1080,
        "locale": "en-US", "timezone": "UTC",
        "androidSdk": 34, "playerVersionCode": 25,
        "installerSource": "com.android.vending",
        "installPermissionStatus": "granted"
    }"#;

    async fn scratch(
        dir: &std::path::Path,
        facts: &str,
    ) -> (
        AndroidServerLinkHost,
        LinkSignals,
        crate::commands::CommandStatus,
        Arc<Mutex<crate::renderer::RendererSnapshot>>,
        Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>,
        ContentStore,
    ) {
        std::fs::create_dir_all(dir).expect("scratch dir");
        let db = StateDb::open(dir.join("state.db"), OpenOptions::default()).expect("state");
        let clock = std::sync::Arc::new(crate::host::SystemClock);
        let core = player_core::PlayerCore::new(player_core::Dependencies { state: db.clone(), clock: clock.clone() });
        let store = ContentStore::open(
            dir.join("cas"),
            dir.join("partial"),
            db.clone(),
            clock,
            std::sync::Arc::new(crate::host::StatvfsProbe),
            std::sync::Arc::new(crate::host::AndroidSecureOpener),
            StorePolicy { limit_bytes: 8 * 1024 * 1024, reserved_free_bytes: 0 },
            std::sync::Arc::new(LruByDomain),
        )
        .await
        .expect("store open");
        let config = Arc::new(AndroidConfigHost::new(dir.join("installed-config.json"), store.clone()));
        let signals = LinkSignals::default();
        let commands: crate::commands::CommandStatus = Arc::new(Mutex::new(None));
        let (activity, _rx) = activity_channel();
        let renderer = Arc::new(Mutex::new(crate::renderer::RendererSnapshot::default()));
        let clock: player_types::time::SharedClock = std::sync::Arc::new(crate::host::SystemClock);
        let engine = Arc::new(tokio::sync::Mutex::new(crate::renderer::PresentationEngine::new(
            crate::renderer::AndroidRendererPort::new(
                Arc::new(crate::renderer::MemRendererPlatform::default()),
                store.clone(),
            ),
            clock.clone(),
            renderer.clone(),
            Arc::new(Notify::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Timestamp::from_unix_millis(1_700_000_000_000).expect("test clock"),
        )));
        let host = AndroidServerLinkHost::new(
            core,
            db,
            config,
            store.clone(),
            Arc::new(crate::pairing_host::MemMetadataSource::with_facts(facts).with_uptime(5208)),
            activity,
            signals.preparation.clone(),
            commands.clone(),
            renderer.clone(),
            engine.clone(),
            signals.last_server_contact.clone(),
            signals.gate.clone(),
            signals.observations.clone(),
            signals.manifest_facts.clone(),
            clock,
            dir.to_path_buf(),
        );
        (host, signals, commands, renderer, engine, store)
    }

    #[tokio::test]
    async fn bare_heartbeat_reports_real_sources_and_omits_unseeded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, _, _, _, _) = scratch(dir.path(), FACTS).await;
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["screenWidth"], 1920);
        assert_eq!(heartbeat["screenHeight"], 1080);
        assert_eq!(heartbeat["playerVersion"], "0.25.0");
        assert_eq!(heartbeat["playerFamily"], "android");
        assert_eq!(heartbeat["playerArchitecture"], std::env::consts::ARCH);
        assert_eq!(heartbeat["playbackState"], "idle");
        // No renderer connected: the fresh-process fallback (schema 1,
        // legacy table, no Widget components), as the legacy player
        // reported it.
        assert_eq!(heartbeat["presentationSchemaVersions"], serde_json::json!([1]));
        assert_eq!(heartbeat["webRuntimeVersion"], 0);
        assert_eq!(heartbeat["safeMode"], false);
        assert_eq!(heartbeat["androidSdk"], 34);
        assert_eq!(heartbeat["playerVersionCode"], 25);
        assert_eq!(heartbeat["installerSource"], "com.android.vending");
        assert_eq!(heartbeat["installPermissionStatus"], "granted");
        let native = heartbeat["nativePresentationCapabilities"].as_object().expect("native caps");
        assert!(native.contains_key("content.text"), "{}", heartbeat);
        assert!(native.contains_key("web.remote"), "{}", heartbeat);
        assert!(!native.contains_key("widget.tilecast.clock"), "{}", heartbeat);
        // No preparation yet: no assignment, no staged fallback, no sync time.
        assert!(heartbeat["assignedPlaylistId"].is_null(), "{}", heartbeat);
        assert_eq!(heartbeat["cachedFallbackAvailable"], false);
        assert!(heartbeat.get("lastSuccessfulSyncAt").is_none(), "{}", heartbeat);
        assert_eq!(heartbeat["uptimeSeconds"], 5208);
        assert!(heartbeat.get("cacheUsedBytes").and_then(serde_json::Value::as_u64).is_some());
        assert_eq!(heartbeat["cacheLimitBytes"], 8 * 1024 * 1024);
        assert!(heartbeat.get("availableStorageBytes").and_then(serde_json::Value::as_u64).is_some());
        // Nothing seeded: versions, revision, and errors stay absent.
        for key in [
            "activeManifestVersion",
            "pendingManifestVersion",
            "activeConfigRevision",
            "configurationError",
            "lastSynchronizationError",
            "deviceClockOffsetSeconds",
            "currentItemId",
            "lastPlaybackError",
        ] {
            assert!(heartbeat.get(key).is_none(), "{key}: {}", heartbeat);
        }
    }

    #[tokio::test]
    async fn seeded_renderer_reports_playback_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, _, renderer, _, _) = scratch(dir.path(), FACTS).await;
        {
            let mut snapshot = renderer.lock().expect("lock");
            snapshot.ready = true;
            snapshot.playing = true;
            snapshot.evidence = true;
            snapshot.current_item_id = Some("item-9".to_owned());
            snapshot.last_error = Some("decode_failed".to_owned());
        }
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["webRuntimeVersion"], crate::manifest_host::WEB_RUNTIME_VERSION);
        assert_eq!(heartbeat["playbackState"], "playing");
        // `item-9` is a renderer key, not a manifest UUID: honestly absent.
        assert!(heartbeat.get("currentItemId").is_none());
        renderer.lock().expect("lock").current_item_id = Some("ca48c671-8e48-4bad-ab75-6125064d0f5c".to_owned());
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["currentItemId"], "ca48c671-8e48-4bad-ab75-6125064d0f5c");
        assert_eq!(heartbeat["lastPlaybackError"], "decode_failed");
        assert_eq!(heartbeat["safeMode"], false);
        renderer.lock().expect("lock").safe_mode = true;
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["playbackState"], "safe_mode");
        assert_eq!(heartbeat["safeMode"], true);
    }

    #[tokio::test]
    async fn seeded_binding_reports_manifest_versions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, _, _, _, _) = scratch(dir.path(), FACTS).await;
        let installation: player_types::InstallationId =
            "39e0c9bd-0e84-4e4d-a1f9-4cdbc1e96035".parse().expect("installation");
        let screen: player_types::ScreenId = "c791e841-b6ab-4e3f-a9f5-3b763cb47bd9".parse().expect("screen");
        let now = player_types::Timestamp::from_unix_millis(1_789_000_000_000).expect("now");
        host.state
            .run(move |connection| {
                player_state::repo::binding::put(
                    connection,
                    &player_state::repo::binding::ServerBinding {
                        server_url: "http://127.0.0.1:9".to_owned(),
                        installation_id: installation,
                        organization_name: None,
                        screen_id: Some(screen),
                        screen_name: None,
                        credential_state: player_state::repo::binding::CredentialState::Stored,
                        identity_verified_at: None,
                        bound_at: now,
                    },
                    now,
                )
            })
            .await
            .expect("bind");
        let document = serde_json::json!({"schemaVersion": 11, "manifestVersion": 8});
        let digest = player_types::Sha256Digest::of(&serde_json::to_vec(&document).expect("encode"));
        host.state
            .run(move |connection| {
                let binding = player_state::repo::manifests::Binding {
                    installation_id: installation,
                    screen_id: screen,
                    server_url: "http://127.0.0.1:9".to_owned(),
                };
                let target = player_state::repo::manifests::Target {
                    binding: binding.clone(),
                    digest,
                    version: 8,
                    etag: "\"seed\"".to_owned(),
                    document: document.clone(),
                    fetched_at: now,
                };
                // A pending write only lands while its digest is the target.
                assert!(player_state::repo::manifests::put_target(connection, &target).expect("target"));
                let stored = player_state::repo::manifests::StoredManifest {
                    binding,
                    digest,
                    version: 8,
                    document,
                    stored_at: now,
                };
                player_state::repo::manifests::put_pending_for_target(connection, &stored).map(|_| ())
            })
            .await
            .expect("pending");
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["pendingManifestVersion"], 8);
        assert!(heartbeat.get("activeManifestVersion").is_none(), "{}", heartbeat);
    }

    #[tokio::test]
    async fn preparation_failure_surfaces_a_truncated_reason() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, signals, _, _, _, _) = scratch(dir.path(), FACTS).await;
        {
            let mut preparation = signals.preparation.lock().expect("lock");
            preparation.state = "incompatible";
            preparation.reason = Some("x".repeat(300));
        }
        let heartbeat = host.build_heartbeat().await;
        let reason = heartbeat["lastSynchronizationError"].as_str().expect("reason");
        assert_eq!(reason.len(), 240);
        {
            let mut preparation = signals.preparation.lock().expect("lock");
            preparation.state = "current";
        }
        let heartbeat = host.build_heartbeat().await;
        assert!(heartbeat.get("lastSynchronizationError").is_none(), "{}", heartbeat);
    }

    #[tokio::test]
    async fn missing_facts_default_safely() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, _, _, _, _) = scratch(dir.path(), "not json").await;
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["screenWidth"], 0);
        assert_eq!(heartbeat["screenHeight"], 0);
        assert_eq!(heartbeat["playerVersion"], "");
        assert!(heartbeat.get("androidSdk").is_none(), "{}", heartbeat);
    }

    #[tokio::test]
    async fn last_command_projects_into_the_heartbeat() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, commands, _, _, _) = scratch(dir.path(), FACTS).await;
        *commands.lock().expect("lock") = Some(crate::commands::LastCommand {
            id: "0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa".to_owned(),
            state: "succeeded".to_owned(),
            result: "playback_disabled".to_owned(),
            completed_at: "2026-10-05T00:00:00Z".to_owned(),
        });
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["lastCommandId"], "0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa");
        assert_eq!(heartbeat["lastCommandState"], "succeeded");
        assert_eq!(heartbeat["lastCommandResult"], "playback_disabled");
        assert_eq!(heartbeat["lastCommandCompletedAt"], "2026-10-05T00:00:00Z");
    }

    #[test]
    fn heartbeat_vocabulary_matches_the_server_contract() {
        assert_eq!(heartbeat_selection_source("takeover"), Some("takeover"));
        assert_eq!(heartbeat_selection_source("quick_present"), Some("quick_present"));
        assert_eq!(heartbeat_selection_source("schedule"), Some("schedule"));
        assert_eq!(heartbeat_selection_source("direct"), Some("direct_fallback"));
        assert_eq!(heartbeat_selection_source("none"), Some("none"));
        assert_eq!(heartbeat_selection_source("bogus"), None);
        let item = "ca48c671-8e48-4bad-ab75-6125064d0f5c";
        assert_eq!(heartbeat_item_id(item).as_deref(), Some(item));
        assert_eq!(heartbeat_item_id(&format!("layout-{item}")).as_deref(), Some(item));
        assert_eq!(heartbeat_item_id("item-1"), None);
        assert_eq!(heartbeat_item_id("layout-bogus"), None);
        assert_eq!(heartbeat_item_id("CA48C671-8E48-4BAD-AB75-6125064D0F5C"), None);
    }

    const HEARTBEAT_ASSET: &str = "11111111-1111-1111-1111-111111111111";
    const HEARTBEAT_VARIANT: &str = "22222222-2222-2222-2222-222222222222";
    const HEARTBEAT_PLAYLIST: &str = "33333333-3333-3333-3333-333333333333";
    const HEARTBEAT_SCHEDULE: &str = "44444444-4444-4444-4444-444444444444";
    const HEARTBEAT_TAKEOVER: &str = "55555555-5555-5555-5555-555555555555";

    fn heartbeat_request(digest: &Sha256Digest, size: u64, identity: serde_json::Value) -> String {
        let src = ["tcmedia:", HEARTBEAT_ASSET, "/", HEARTBEAT_VARIANT].concat();
        serde_json::json!({
            "envelope": {
                "presentation": {
                    "state": "playing",
                    "items": [{"id": "item-1", "kind": "image", "src": src}],
                },
            },
            "content": [{
                "assetId": HEARTBEAT_ASSET,
                "variantId": HEARTBEAT_VARIANT,
                "digest": digest.to_hex(),
                "sizeBytes": size,
                "mimeType": "image/png",
            }],
            "source": "server_manifest",
            "identity": identity,
            "clockOffsetMs": 0,
        })
        .to_string()
    }

    fn heartbeat_ready() -> serde_json::Value {
        serde_json::json!({
            "features": ["status-surfaces-v1", "image", "video", "render-tree-v1", "layout-v1",
                "synchronized-playback-v1", "span-viewport-v1", "plugin.countdown_bar",
                "plugin.alert_ticker", "remote-web-v1", "website", "youtube"],
            "support": {
                "presentationSchemas": [1, 2],
                "declarativeCapabilities": {"content.text": 1},
                "widgetComponents": {},
            },
        })
    }

    #[tokio::test]
    async fn heartbeat_reports_the_committed_selection_takeover_and_progress() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, signals, _, _, engine, store) = scratch(dir.path(), FACTS).await;
        let bytes = b"heartbeat-image";
        let digest = Sha256Digest::of(bytes);
        let mut session = store
            .begin_write(
                digest,
                bytes.len() as u64,
                IngestMeta { domain: Domain::Media, content_type: None, source: SourceKind::Local },
            )
            .await
            .expect("begin")
            .expect("fresh");
        session.write(bytes).expect("write");
        session.commit().await.expect("commit");
        let at = Timestamp::from_unix_millis(1_700_000_000_000).expect("time");
        let ready = heartbeat_ready();
        let outcome = {
            let mut locked = engine.lock().await;
            locked.renderer_connected(1, at);
            assert!(locked.renderer_ready(1, &ready).await);
            locked
                .activate(
                    &heartbeat_request(
                        &digest,
                        bytes.len() as u64,
                        serde_json::json!({
                            "manifest": Sha256Digest::of(b"manifest").to_hex(),
                            "manifestVersion": 8,
                            "selectionSource": "schedule",
                            "playlistId": HEARTBEAT_PLAYLIST,
                            "scheduleId": HEARTBEAT_SCHEDULE,
                            "nextTransitionMs": 1_700_000_060_000_i64,
                        }),
                    ),
                    at,
                )
                .await
                .expect("activate")
        };
        {
            let mut locked = engine.lock().await;
            assert!(locked.accepted(1, &outcome.activation_id, outcome.generation));
            let progress_at = Timestamp::from_unix_millis(1_700_000_005_000).expect("time");
            let (current, meaningful) = locked.progress(
                1,
                &outcome.activation_id,
                outcome.generation,
                "image-shown",
                Some("item-1"),
                None,
                progress_at,
            );
            assert!(current && meaningful);
        }
        *signals.last_server_contact.lock().expect("contact") = Some(at);

        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["playbackState"], "playing");
        assert_eq!(heartbeat["selectionSource"], "schedule");
        assert_eq!(heartbeat["currentPlaylistId"], HEARTBEAT_PLAYLIST);
        assert_eq!(heartbeat["currentScheduleId"], HEARTBEAT_SCHEDULE);
        assert_eq!(heartbeat["currentAssetId"], HEARTBEAT_ASSET);
        assert_eq!(heartbeat["nextTransitionAt"], "2023-11-14T22:14:20Z");
        assert_eq!(heartbeat["lastHealthyPlaybackAt"], "2023-11-14T22:13:25Z");
        assert_eq!(heartbeat["lastPlaylistTransitionAt"], "2023-11-14T22:13:20Z");
        assert_eq!(heartbeat["lastServerConnectionAt"], "2023-11-14T22:13:20Z");
        assert!(heartbeat.get("activeTakeoverId").is_none());
        assert!(heartbeat.get("takeoverState").is_none());
        // `item-1` is a renderer key, not a manifest UUID: honestly absent.
        assert!(heartbeat.get("currentItemId").is_none());
        // Capability advertisement follows the ready report: schemas
        // [1, 2], the reported declarative table, no Widget components.
        assert_eq!(heartbeat["presentationSchemaVersions"], serde_json::json!([1, 2]));
        let native = heartbeat["nativePresentationCapabilities"].as_object().expect("native caps");
        assert_eq!(native.len(), 1, "{}", heartbeat);
        assert_eq!(native["content.text"], 1);

        // A takeover activation replaces the schedule in the heartbeat and
        // drives the server's takeover screen states.
        let takeover_at = Timestamp::from_unix_millis(1_700_000_120_000).expect("time");
        {
            let mut locked = engine.lock().await;
            locked
                .activate(
                    &heartbeat_request(
                        &digest,
                        bytes.len() as u64,
                        serde_json::json!({
                            "manifest": Sha256Digest::of(b"manifest").to_hex(),
                            "manifestVersion": 8,
                            "selectionSource": "takeover",
                            "playlistId": HEARTBEAT_PLAYLIST,
                            "takeoverId": HEARTBEAT_TAKEOVER,
                        }),
                    ),
                    takeover_at,
                )
                .await
                .expect("takeover activates");
        }
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["selectionSource"], "takeover");
        assert_eq!(heartbeat["activeTakeoverId"], HEARTBEAT_TAKEOVER);
        assert_eq!(heartbeat["takeoverState"], "active");
        assert!(heartbeat.get("currentScheduleId").is_none());
        assert!(heartbeat.get("nextTransitionAt").is_none());
        assert_eq!(heartbeat["lastPlaylistTransitionAt"], "2023-11-14T22:15:20Z");
    }

    #[tokio::test]
    async fn rest_gate_reports_off_hours() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, signals, _, _, _, _) = scratch(dir.path(), FACTS).await;
        assert_eq!(host.build_heartbeat().await["activeHoursState"], "active");
        *signals.gate.lock().expect("gate") =
            Some(GateState { gate: ActivationGateName::Rest, at_ms: 1_700_000_000_000 });
        assert_eq!(host.build_heartbeat().await["activeHoursState"], "off_hours");
        // The disabled gate is not an hours state: playback reports it.
        *signals.gate.lock().expect("gate") =
            Some(GateState { gate: ActivationGateName::Disabled, at_ms: 1_700_000_000_000 });
        assert_eq!(host.build_heartbeat().await["activeHoursState"], "active");
    }

    #[test]
    fn jitter_stays_in_unit_range() {
        for _ in 0..100 {
            let unit = jitter_unit();
            assert!((0.0..1.0).contains(&unit), "{unit}");
        }
    }

    #[tokio::test]
    async fn unsupported_runtime_advertises_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, _, _, engine, _) = scratch(dir.path(), FACTS).await;
        engine.lock().await.renderer_unsupported();
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["presentationSchemaVersions"], serde_json::json!([]));
        let native = heartbeat["nativePresentationCapabilities"].as_object().expect("native caps");
        assert!(native.is_empty(), "{}", heartbeat);
    }

    #[tokio::test]
    async fn heartbeat_reports_the_staged_manifest_facts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, signals, _, _, _, _) = scratch(dir.path(), FACTS).await;
        *signals.manifest_facts.lock().expect("facts") = crate::manifest_host::ManifestFacts {
            assigned_playlist_id: Some("f001ba11-0000-4000-8000-000000000001".to_owned()),
            cached_fallback_available: true,
            last_successful_sync: Timestamp::from_unix_millis(1_700_000_000_000),
        };
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["assignedPlaylistId"], "f001ba11-0000-4000-8000-000000000001");
        assert_eq!(heartbeat["cachedFallbackAvailable"], true);
        assert_eq!(heartbeat["lastSuccessfulSyncAt"], "2023-11-14T22:13:20Z");
    }
}
