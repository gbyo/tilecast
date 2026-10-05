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
    state_dir: PathBuf,
    started_at: std::time::Instant,
}

fn renderer_snapshot(
    renderer: &Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>,
) -> crate::renderer::RendererSnapshot {
    renderer.lock().unwrap_or_else(|error| error.into_inner()).clone()
}

/// The legacy playback-state vocabulary from the renderer snapshot.
/// Off-hours and disabled selection arrive with the 5d selection
/// driver; until then anything unresolved is idle.
fn playback_state(renderer: &crate::renderer::RendererSnapshot) -> &'static str {
    if renderer.safe_mode {
        "safe_mode"
    } else if renderer.playing && renderer.evidence {
        "playing"
    } else {
        "idle"
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

        let native: serde_json::Map<String, serde_json::Value> = crate::manifest_host::profile::native_capabilities()
            .into_iter()
            .chain(crate::manifest_host::profile::WIDGET_COMPONENTS.iter().copied())
            .map(|(name, version)| (name.to_owned(), serde_json::json!(version)))
            .collect();
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
            "playbackState": playback_state(&renderer_snapshot(&self.renderer)),
            "presentationSchemaVersions": crate::manifest_host::profile::PRESENTATION_SCHEMAS,
            "nativePresentationCapabilities": native,
            // The remote host provides web.remote only while a renderer
            // is live to show it, as Edge reports it.
            "webRuntimeVersion": if renderer_snapshot(&self.renderer).ready {
                crate::manifest_host::WEB_RUNTIME_VERSION
            } else {
                0
            },
        });
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
            if let Some(offset) = state.server_clock_offset_ms {
                heartbeat["deviceClockOffsetSeconds"] = serde_json::json!(offset / 1000);
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
            let renderer = self.renderer.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(item) = renderer.current_item_id.as_deref() {
                heartbeat["currentItemId"] = serde_json::json!(item);
            }
            if let Some(error) = renderer.last_error.as_deref() {
                heartbeat["lastPlaybackError"] = serde_json::json!(error);
            }
            heartbeat["safeMode"] = serde_json::json!(renderer.safe_mode);
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
        Arc::new(AndroidManifestHost::new(self.core.clone(), self.cas.clone(), server.clone()))
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
    use player_cas::{LruByDomain, StorePolicy};
    use player_state::{OpenOptions, StateDb};

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
        let host = AndroidServerLinkHost::new(
            core,
            db,
            config,
            store,
            Arc::new(crate::pairing_host::MemMetadataSource::with_facts(facts).with_uptime(5208)),
            activity,
            signals.preparation.clone(),
            commands.clone(),
            renderer.clone(),
            dir.to_path_buf(),
        );
        (host, signals, commands, renderer)
    }

    #[tokio::test]
    async fn bare_heartbeat_reports_real_sources_and_omits_unseeded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, _, _) = scratch(dir.path(), FACTS).await;
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["screenWidth"], 1920);
        assert_eq!(heartbeat["screenHeight"], 1080);
        assert_eq!(heartbeat["playerVersion"], "0.25.0");
        assert_eq!(heartbeat["playerFamily"], "android");
        assert_eq!(heartbeat["playerArchitecture"], std::env::consts::ARCH);
        assert_eq!(heartbeat["playbackState"], "idle");
        assert_eq!(heartbeat["presentationSchemaVersions"], serde_json::json!([1, 2]));
        assert_eq!(heartbeat["webRuntimeVersion"], 0);
        assert_eq!(heartbeat["safeMode"], false);
        assert_eq!(heartbeat["androidSdk"], 34);
        assert_eq!(heartbeat["playerVersionCode"], 25);
        assert_eq!(heartbeat["installerSource"], "com.android.vending");
        assert_eq!(heartbeat["installPermissionStatus"], "granted");
        let native = heartbeat["nativePresentationCapabilities"].as_object().expect("native caps");
        assert!(native.contains_key("content.text"), "{}", heartbeat);
        assert!(native.contains_key("web.remote"), "{}", heartbeat);
        assert!(native.contains_key("widget.tilecast.clock"), "{}", heartbeat);
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
        let (host, _signals, _, renderer) = scratch(dir.path(), FACTS).await;
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
        assert_eq!(heartbeat["currentItemId"], "item-9");
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
        let (host, _signals, _, _) = scratch(dir.path(), FACTS).await;
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
        let (host, signals, _, _) = scratch(dir.path(), FACTS).await;
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
        let (host, _signals, _, _) = scratch(dir.path(), "not json").await;
        let heartbeat = host.build_heartbeat().await;
        assert_eq!(heartbeat["screenWidth"], 0);
        assert_eq!(heartbeat["screenHeight"], 0);
        assert_eq!(heartbeat["playerVersion"], "");
        assert!(heartbeat.get("androidSdk").is_none(), "{}", heartbeat);
    }

    #[tokio::test]
    async fn last_command_projects_into_the_heartbeat() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (host, _signals, commands, _) = scratch(dir.path(), FACTS).await;
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
    fn jitter_stays_in_unit_range() {
        for _ in 0..100 {
            let unit = jitter_unit();
            assert!((0.0..1.0).contains(&unit), "{unit}");
        }
    }
}
