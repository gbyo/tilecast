//! The server link: Core drives the socket, heartbeat fallback, push
//! handling, and reconciliation loop; the host supplies preparation,
//! configuration, activity recording, jitter, and the heartbeat payload.
//!
//! The heartbeat reports what the renderer is actually showing: the
//! playback state, safe mode, capabilities, and the current selection
//! identity. The screen size stays zero until stage 6 qualifies the real
//! window geometry.

use player_client::AuthenticatedServer;
use player_core::ActivityEvent;
pub use player_core::{
    SERVER_CONTACT_INTERVAL as CONTACT_INTERVAL, SERVER_IDLE_INTERVAL as IDLE_INTERVAL,
    SERVER_MANIFEST_INTERVAL as MANIFEST_INTERVAL, SERVER_MAX_RETRY as MAX_RETRY_INTERVAL,
    SERVER_RETRY_BASE as RETRY_BASE, SERVER_SOCKET_LIVENESS_TIMEOUT as SOCKET_LIVENESS_TIMEOUT,
    ServerLinkState as LinkState, server_retry_delay as retry_delay,
};
use player_state::repo::manifests::{Binding as ManifestBinding, Stage, get_for};
use player_state::repo::{binding, playback};
use std::sync::Arc;

use crate::daemon::{DaemonContext, VERSION};
use crate::manifest::PreparationHost;

struct Host(Arc<DaemonContext>);

#[async_trait::async_trait]
impl player_core::ConfigurationHost for Host {
    type Projection = crate::player_config::WindowsPlayerConfig;
    fn prepare_configuration(
        &self,
        document: &serde_json::Value,
        native: &player_core::NativeConfiguration,
    ) -> Result<Self::Projection, &'static str> {
        crate::player_config::WindowsPlayerConfig::project(document, native.clone())
            .map_err(|error| error.reason_code())
    }
    async fn install_configuration(&self, projection: Option<Self::Projection>) {
        crate::config_sync::install(&self.0, projection).await;
    }
}

#[async_trait::async_trait]
impl player_core::ServerLinkHost for Host {
    type Preparation = PreparationHost;
    fn preparation_host(&self, server: &AuthenticatedServer) -> Arc<PreparationHost> {
        Arc::new(PreparationHost::new(self.0.clone(), server.clone()))
    }
    fn native_configuration(&self) -> player_core::NativeConfiguration {
        crate::config_sync::effective(&self.0).native.clone()
    }
    fn jitter_unit(&self) -> f64 {
        crate::clock::jitter_unit()
    }
    fn record_activity(&self, event: ActivityEvent) {
        self.0.activity.record(event);
    }
    async fn heartbeat(&self) -> serde_json::Value {
        build_heartbeat(&self.0).await
    }
    async fn presentation_protected(&self) -> bool {
        crate::capture::presentation_protected(&self.0)
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    let (Some(core), Some(relationship)) = (context.core.as_ref(), context.server_relationship.as_ref()) else {
        context.shutdown.cancelled().await;
        return;
    };
    let host = Host(context.clone());
    let user_agent = crate::user_agent();
    core.run_server_link(player_core::ServerLinkServices {
        relationship,
        host: &host,
        user_agent: &user_agent,
        player_version: VERSION,
        shutdown: &context.shutdown,
        signals: player_core::ServerLinkSignals {
            server_wake: &context.server_wake,
            manifest_wake: &context.manifest_wake,
            preparation: &context.preparation,
            link_state: &context.link_state,
            last_server_contact: &context.last_server_contact,
            command_wake: &context.command_wake,
            command_server: &context.command_server,
            sync_request: &context.sync_request,
            sync_done: &context.sync_done,
            live_stream_wake: &context.live_stream_wake,
            live_frames: &context.live_frames,
            status_due: &context.status_due,
        },
    })
    .await;
}

pub async fn reject_credential(context: &DaemonContext) {
    if let Some(relationship) = &context.server_relationship {
        relationship.reject_credential().await;
    } else {
        // Preserve private-file cleanup in local-state recovery mode.
        let _ = crate::credential::SealedCredentialStore::remove_at(&context.paths.identity_dir());
    }
    context.command_server.send_replace(None);
}

/// A heartbeat item id is a canonical UUID, optionally behind the layout
/// item prefix; anything else is absent, as the server requires.
pub fn heartbeat_item_id(key: &str) -> Option<String> {
    let candidate = key.strip_prefix("layout-").unwrap_or(key);
    player_types::ids::parse_canonical_uuid(candidate).ok().map(|id| id.to_string())
}

/// The heartbeat `selectionSource` for a selection, in the server's shared
/// status vocabulary (`takeover`, `quick_present`, `schedule`,
/// `direct_fallback`, `none`); the server discards a whole status with any
/// other value. A direct assignment is reported as `direct_fallback`, as the
/// Android player does.
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

fn iso(ms: i64) -> Option<String> {
    player_types::Timestamp::from_unix_millis(ms).map(|at| at.to_string())
}

/// Ordinary player status, sent on the socket or as the fallback heartbeat.
/// Playback identifiers have the reference Linux player's meaning: the
/// committed and pending manifest versions, and what the renderer is actually
/// showing and why.
pub async fn build_heartbeat(context: &DaemonContext) -> serde_json::Value {
    let (current, current_item, progress_at, safe_mode, ready) = {
        let engine = context.presentation.lock().unwrap_or_else(|poison| poison.into_inner());
        (
            engine.current().cloned(),
            engine.current_item(),
            engine.last_progress_at(),
            engine.is_safe_mode(),
            engine.renderer_is_ready(),
        )
    };
    let healthy = ready
        && progress_at.is_some()
        && current.as_ref().is_some_and(|active| {
            active.source == player_core::ActivationSource::ServerManifest
                && active.document.get("state").and_then(|state| state.as_str()) == Some("playing")
        });
    // The reference player reports what is on screen: `playing`, or the
    // surface's state (`sleep`, `disabled`, `safe-mode`, `idle`, ...).
    let playback_state = if healthy {
        "playing"
    } else {
        current.as_ref().map_or("idle", |active| match active.document.get("state").and_then(|state| state.as_str()) {
            Some("playing") => "starting",
            Some(other) => other,
            None => "idle",
        })
    };
    let uptime = ((context.now().unix_millis() - context.started_at.unix_millis()).max(0) / 1000) as u64;
    let native: serde_json::Map<String, serde_json::Value> = crate::renderer_adapter::profile::NATIVE_CAPABILITIES
        .iter()
        .chain(crate::widget_capabilities::WIDGET_COMPONENTS)
        .chain(std::iter::once(&(
            player_types::frames::EXTERNAL_RUNTIME_CAPABILITY,
            player_types::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
        )))
        .map(|(name, version)| ((*name).to_owned(), serde_json::json!(version)))
        .collect();
    let (screen_width, screen_height) = crate::device::display_size(None);
    let mut heartbeat = serde_json::json!({
        "screenWidth": screen_width,
        "screenHeight": screen_height,
        "playerVersion": VERSION,
        "playerVersionCode": crate::update::own_version_code(),
        // The Player release family: Windows releases reach only Windows
        // screens of this architecture (docs/player-updates.md).
        "playerFamily": crate::PLAYER_FAMILY,
        "playerArchitecture": std::env::consts::ARCH,
        "uptimeSeconds": uptime,
        "playbackState": playback_state,
        "safeMode": safe_mode,
        "presentationSchemaVersions": crate::renderer_adapter::profile::PRESENTATION_SCHEMAS,
        "nativePresentationCapabilities": native,
        // The remote web environment serves surfaces once the UI thread
        // starts; its process events maintain the flag.
        "webRuntimeVersion": i32::from(context.remote_web_available.load(std::sync::atomic::Ordering::Acquire)),
    });
    // `lastMeaningfulProgressAt` is a telemetry field, not a heartbeat one:
    // the server's strict HTTP heartbeat decoding refuses the whole message
    // for it (gbyo/tilecast#674).
    if let Some(progress_at) = progress_at
        && healthy
    {
        heartbeat["lastHealthyPlaybackAt"] = serde_json::Value::String(progress_at.to_string());
    }
    if let Some(identity) = current.as_ref().and_then(|activation| activation.identity.as_ref()) {
        if let Some(source) = heartbeat_selection_source(identity.selection_source) {
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
        if let Some(next) = identity.next_transition_ms.and_then(iso) {
            heartbeat["nextTransitionAt"] = serde_json::json!(next);
        }
        if let Some((item, _)) = current_item.as_ref()
            && let Some(item) = heartbeat_item_id(item)
        {
            // The item's start time is not a heartbeat field: the server's
            // strict HTTP heartbeat decoding refuses the whole message for
            // it. It travels in the telemetry sample (`itemStartedAt`).
            heartbeat["currentItemId"] = serde_json::json!(item);
        }
    }
    if let Ok(available) = context.space.available_bytes(&context.paths.state_dir) {
        heartbeat["availableStorageBytes"] = serde_json::json!(available);
    }
    if let Some(cas) = &context.cas
        && let Ok(usage) = cas.usage().await
    {
        heartbeat["cacheUsedBytes"] = serde_json::json!(usage.used_bytes);
        heartbeat["cacheLimitBytes"] = serde_json::json!(cas.policy().limit_bytes);
    }
    if let Some(db) = context.db() {
        if let Ok(state) = db.run(|c| playback::get(c)).await {
            heartbeat["playbackDisabled"] = serde_json::json!(state.playback_disabled);
            if let Some(offset) = state.server_clock_offset_ms {
                heartbeat["deviceClockOffsetSeconds"] = serde_json::json!(offset / 1000);
            }
        }
        if let Ok(Some(bound)) = db.run(|c| binding::get(c)).await
            && let Some(screen_id) = bound.screen_id
        {
            let binding =
                ManifestBinding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url };
            for (stage, field) in [(Stage::Active, "activeManifestVersion"), (Stage::Pending, "pendingManifestVersion")]
            {
                let stage_binding = binding.clone();
                if let Ok(Some(stored)) = db.run(move |c| get_for(c, stage, &stage_binding)).await {
                    heartbeat[field] = serde_json::json!(stored.version);
                }
            }
        }
    }
    if let Some(revision) = crate::config_sync::accepted_revision(context) {
        heartbeat["activeConfigRevision"] = serde_json::json!(revision);
    }
    if let Some(db) = context.db()
        && let Ok(status) = db.run(|c| player_state::repo::config::status(c)).await
        && let Some(code) = status.last_error_code
    {
        heartbeat["configurationError"] = serde_json::json!(code);
    }
    let preparation = context.preparation.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(reason) =
        preparation.reason.filter(|_| matches!(preparation.state, "failed" | "incompatible" | "invalid"))
    {
        heartbeat["lastSynchronizationError"] = serde_json::json!(reason.chars().take(240).collect::<String>());
    }
    heartbeat
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_matches_the_reference_player_backoff() {
        // backoff.ts: floor = base / 2, ceiling = base * 2^(failures - 1).
        assert_eq!(retry_delay(1, 0.0), std::time::Duration::from_secs(1));
        assert_eq!(retry_delay(1, 0.999_999), std::time::Duration::from_millis(1_999));
        assert_eq!(retry_delay(3, 0.0), std::time::Duration::from_secs(1));
        assert_eq!(retry_delay(3, 0.5), std::time::Duration::from_millis(4_500));
        assert_eq!(retry_delay(9, 1.0), MAX_RETRY_INTERVAL);
        assert_eq!(retry_delay(40, 1.0), MAX_RETRY_INTERVAL);
        assert!(retry_delay(u32::MAX, 0.3) <= MAX_RETRY_INTERVAL);
        for _ in 0..100 {
            let unit = crate::clock::jitter_unit();
            assert!((0.0..1.0).contains(&unit), "{unit}");
        }
    }

    #[test]
    fn stopped_states_name_their_reason() {
        assert_eq!(LinkState::Connected.state_token(), "connected");
        assert_eq!(LinkState::Connected.reason_code(), None);
        assert_eq!(
            LinkState::IdentityMismatch { expected: "expected".into(), actual: "actual".into() }.state_token(),
            "stopped"
        );
        assert_eq!(LinkState::Retrying("server_unreachable").reason_code(), Some("server_unreachable"));
    }

    #[test]
    fn heartbeat_item_ids_are_uuids_or_absent() {
        let item = "ca48c671-8e48-4bad-ab75-6125064d0f5c";
        assert_eq!(heartbeat_item_id(item).as_deref(), Some(item));
        assert_eq!(heartbeat_item_id(&format!("layout-{item}")).as_deref(), Some(item));
        assert_eq!(heartbeat_item_id("item-image"), None);
        assert_eq!(heartbeat_item_id("layout-not-a-uuid"), None);
        assert_eq!(heartbeat_item_id(&item.to_uppercase()), None);
    }

    #[test]
    fn selection_source_uses_the_server_status_vocabulary() {
        assert_eq!(heartbeat_selection_source("direct"), Some("direct_fallback"));
        assert_eq!(heartbeat_selection_source("schedule"), Some("schedule"));
        assert_eq!(heartbeat_selection_source("takeover"), Some("takeover"));
        assert_eq!(heartbeat_selection_source("quick_present"), Some("quick_present"));
        assert_eq!(heartbeat_selection_source("none"), Some("none"));
        assert_eq!(heartbeat_selection_source("unknown"), None);
    }

    #[test]
    fn link_intervals_are_reexported() {
        assert!(CONTACT_INTERVAL > std::time::Duration::ZERO);
        assert!(IDLE_INTERVAL > std::time::Duration::ZERO);
        assert!(MANIFEST_INTERVAL > std::time::Duration::ZERO);
        assert!(RETRY_BASE > std::time::Duration::ZERO);
        assert!(SOCKET_LIVENESS_TIMEOUT > std::time::Duration::ZERO);
    }
}
