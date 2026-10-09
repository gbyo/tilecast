//! The daemon's link to the Tilecast Server.
//!
//! One task, one owner of the device credential. Each pass:
//!
//! 1. Requires a server binding and the stored credential (from pairing or
//!    the one-time legacy import). Without them the player is idle: nothing
//!    is sent anywhere.
//! 2. Reads public installation identity and requires the bound
//!    installation ID before the credential is sent (the identity gate is a
//!    type in `edge_server::client`). A mismatch stops the link until an
//!    explicit reset; the credential is never sent to the other server.
//! 3. Holds the ordinary player WebSocket and sends status on it, falling
//!    back to `POST /player/heartbeat` while the socket is unavailable. A
//!    server ping samples the clock and is answered; pushes only wake the
//!    next reconciliation.
//! 4. Reconciles player configuration (`config_sync`) on connection, on a
//!    `config.changed` push and at the manifest interval, and the manifest
//!    through the ordinary manifest endpoint (`manifest_sync`), keeping one
//!    abortable preparation on its target.
//! 5. Publishes the verified server to the command task (`commands`), which
//!    polls on its own cadence; a `commands.available` push wakes that task.
//!
//! The server is the only authority, and this task is the only way its
//! state reaches the player. Playback never waits for it: while the server
//! is unreachable the player keeps showing already-reconciled local state
//! from SQLite and the content store.
//!
//! The credential is deleted only when the server says it is invalid or
//! revoked (the legacy player's rule); network errors, 5xx and disabled
//! screens retry with backoff.

use crate::daemon::{DaemonContext, VERSION};
use crate::manifest::OriginSources;
use crate::manifest_sync::{self, Prepared};
use edge_protocol::Timestamp;
use edge_server::AuthenticatedServer;
use edge_state::repo::{
    binding,
    manifests::{self, Binding as ManifestBinding, Stage, Target},
    playback,
};
#[cfg(test)]
use player_core::refined_server_offset as refined_offset;
use std::sync::Arc;

pub use player_core::{
    SERVER_CONTACT_INTERVAL as CONTACT_INTERVAL, SERVER_IDLE_INTERVAL as IDLE_INTERVAL,
    SERVER_MANIFEST_INTERVAL as MANIFEST_INTERVAL, SERVER_MAX_RETRY as MAX_RETRY_INTERVAL,
    SERVER_RETRY_BASE as RETRY_BASE, SERVER_SOCKET_LIVENESS_TIMEOUT as SOCKET_LIVENESS_TIMEOUT,
    ServerLinkState as LinkState, server_retry_delay as retry_delay,
};

/// A random number in `[0, 1)` for retry jitter.
fn jitter_unit() -> f64 {
    use ring::rand::SecureRandom as _;
    let mut bytes = [0_u8; 4];
    if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
        return 0.5;
    }
    f64::from(u32::from_le_bytes(bytes)) / (f64::from(u32::MAX) + 1.0)
}

struct PreparationHost {
    context: Arc<DaemonContext>,
    server: AuthenticatedServer,
}

#[async_trait::async_trait]
impl player_core::ManifestWorkerHost for PreparationHost {
    async fn content_intact(&self, target: &Target) -> bool {
        match crate::manifest::Candidate::prepare_candidate(target.document.clone(), target.binding.screen_id) {
            Ok(candidate) => crate::manifest::verify_cached(&self.context, &candidate).await.is_ok(),
            // Preserve the existing committed/pending policy: projection failure
            // cannot replace that document with another preparation of itself.
            Err(_) => true,
        }
    }

    async fn prepare(&self, target: &Target) -> Result<Prepared, player_core::ManifestWorkerFailure> {
        let plan = OriginSources { server: &self.server };
        manifest_sync::prepare_target(&self.context, &plan, target).await.map_err(|error| {
            let kind = match &error {
                manifest_sync::PrepareError::Manifest(crate::manifest::ManifestError::Incompatible(_)) =>
                    player_core::ManifestFailureKind::Incompatible,
                error if error.is_final() => player_core::ManifestFailureKind::Invalid,
                _ => player_core::ManifestFailureKind::Retryable,
            };
            tracing::warn!(component = "manifest", event = "preparation_failed", manifest = %target.digest.short(),
                state = match kind { player_core::ManifestFailureKind::Incompatible => "incompatible",
                    player_core::ManifestFailureKind::Invalid => "invalid", player_core::ManifestFailureKind::Retryable => "failed" },
                reason = error.reason_code(), error = %error);
            player_core::ManifestWorkerFailure { kind, reason: error.reason_code() }
        })
    }
}

struct Host(Arc<DaemonContext>);

#[async_trait::async_trait]
impl player_core::ConfigurationHost for Host {
    type Projection = crate::player_config::PlayerConfig;
    fn prepare_configuration(
        &self,
        document: &serde_json::Value,
        native: &player_core::NativeConfiguration,
    ) -> Result<Self::Projection, &'static str> {
        crate::player_config::PlayerConfig::project(document, native.clone()).map_err(|error| error.reason_code())
    }
    async fn install_configuration(&self, projection: Option<Self::Projection>) {
        crate::config_sync::install(&self.0, projection).await;
    }
}

#[async_trait::async_trait]
impl player_core::ServerLinkHost for Host {
    type Preparation = PreparationHost;
    fn preparation_host(&self, server: &AuthenticatedServer) -> Arc<PreparationHost> {
        Arc::new(PreparationHost { context: self.0.clone(), server: server.clone() })
    }
    fn native_configuration(&self) -> player_core::NativeConfiguration {
        crate::config_sync::effective(&self.0).native.clone()
    }
    fn jitter_unit(&self) -> f64 {
        jitter_unit()
    }
    fn record_activity(&self, event: player_core::ActivityEvent) {
        self.0.activity.record(event);
    }
    async fn identity_mismatch(&self, expected: &str, actual: &str) {
        crate::mismatch::note_mismatch(&self.0, expected, actual).await;
    }
    async fn heartbeat(&self) -> serde_json::Value {
        // A heartbeat is built after the pass verified the installation, so
        // a recorded mismatch observed here is stale (the server recovered
        // its old installation) and clears.
        if self.0.installation_mismatch.lock().unwrap_or_else(|poison| poison.into_inner()).is_some() {
            crate::mismatch::clear_mismatch(&self.0).await;
        }
        build_heartbeat(&self.0).await
    }
    async fn presentation_protected(&self) -> bool {
        crate::live_stream::presentation_protected(&self.0).await
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    let (Some(core), Some(relationship)) = (context.core.as_ref(), context.server_relationship.as_ref()) else {
        context.shutdown.cancelled().await;
        return;
    };
    let host = Host(context.clone());
    let user_agent = format!("tilecastd/{}", edge_platform::RELEASE_VERSION);
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
            preview_wake: &context.preview_wake,
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
        let _ = edge_server::FileCredentialStore::remove_at(&context.paths.identity_dir());
    }
    context.command_server.send_replace(None);
}

/// The heartbeat `currentItemId` for a renderer item key: playlist items
/// carry their manifest UUID, a directly shown Layout's key is translated back
/// to the Layout UUID, and anything else is omitted rather than sent, because
/// the server rejects a whole heartbeat over one malformed identifier
/// (reference: `core/identifiers.ts`).
pub fn heartbeat_item_id(key: &str) -> Option<String> {
    let candidate = key.strip_prefix("layout-").unwrap_or(key);
    edge_protocol::ids::parse_canonical_uuid(candidate).ok().map(|id| id.to_string())
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
    Timestamp::from_unix_millis(ms).map(|at| at.to_string())
}

/// Ordinary player status, sent on the socket or as the fallback heartbeat.
/// Playback identifiers have the reference Linux player's meaning: the
/// committed and pending manifest versions, and what the renderer is actually
/// showing and why.
pub async fn build_heartbeat(context: &DaemonContext) -> serde_json::Value {
    let (renderer, current, current_item, remote_web_available, recovery) = {
        let presentation = context.presentation.lock().await;
        let (remote_web, connected, restarting) = presentation.remote_web();
        (
            presentation.status(),
            presentation.current().cloned(),
            presentation.current_item(),
            connected && !restarting && remote_web.is_some_and(|status| status.available),
            presentation.recovery_report(),
        )
    };
    let healthy = renderer.state.as_str() == "healthy"
        && current
            .as_ref()
            .is_some_and(|active| active.source == crate::presentation::ActivationSource::ServerManifest)
        && current.as_ref().is_some_and(|active| {
            matches!(active.document, edge_protocol::ipc::presentation::PresentationDocument::Playing { .. })
        });
    // The reference player reports what is on screen: `playing`, or the
    // surface's state (`sleep`, `disabled`, `safe-mode`, `idle`, ...).
    let playback_state = if healthy {
        "playing"
    } else {
        current.as_ref().map_or("idle", |active| match active.document.state_name() {
            "playing" => "starting",
            other => other,
        })
    };
    let uptime = ((context.now().unix_millis() - context.started_at.unix_millis()).max(0) / 1000) as u64;
    let native: serde_json::Map<String, serde_json::Value> = crate::manifest::profile::NATIVE_CAPABILITIES
        .iter()
        .chain(crate::widget_capabilities::WIDGET_COMPONENTS)
        .chain(std::iter::once(&("media-streaming", 1)))
        .map(|(name, version)| ((*name).to_owned(), serde_json::json!(version)))
        .collect();
    let mut heartbeat = serde_json::json!({
        "screenWidth": 0,
        "screenHeight": 0,
        "playerVersion": VERSION,
        "playerVersionCode": crate::update::own_version_code(),
        // The Player release family: Edge releases reach only Edge screens
        // of this architecture (docs/tilecast-edge.md §15).
        "playerFamily": edge_release::envelope::PLAYER_FAMILY,
        "playerArchitecture": std::env::consts::ARCH,
        "uptimeSeconds": uptime,
        "playbackState": playback_state,
        "safeMode": renderer.state.as_str() == "safe_mode",
        // Linux parity: the supervisor's escalation step and ladder runs,
        // so Studio can tell a first stall from repeated recovery.
        "recoveryLevel": recovery.snapshot.escalation_step,
        "recoveryCount": recovery.snapshot.ladder_runs,
        "rendererRestartCount": recovery.restart_count,
        "presentationSchemaVersions": crate::manifest::profile::PRESENTATION_SCHEMAS,
        "nativePresentationCapabilities": native,
        "webRuntimeVersion": if remote_web_available { crate::manifest::profile::WEB_RUNTIME_VERSION } else { 0 },
    });
    // `lastMeaningfulProgressAt` is a telemetry field, not a heartbeat one:
    // the server's strict HTTP heartbeat decoding refuses the whole message
    // for it (gbyo/tilecast#674).
    if let Some(progress_at) = renderer.last_progress_at
        && healthy
    {
        heartbeat["lastHealthyPlaybackAt"] = serde_json::Value::String(progress_at.to_string());
    }
    // Categorized renderer facts. Each is omitted when unknown: the server
    // tells "not reported" apart from a zero or empty value.
    if let Some(code) = renderer.last_error_code.as_ref() {
        heartbeat["lastRendererFailure"] = serde_json::Value::String(code.as_str().to_owned());
    }
    if let Some((reason, at)) = recovery.last_restart.as_ref() {
        heartbeat["lastRendererRestartReason"] = serde_json::Value::String(reason.as_str().to_owned());
        heartbeat["lastRendererRestartAt"] = serde_json::Value::String(at.to_string());
    }
    if let Some(reason) = recovery.safe_mode_reason.as_ref() {
        heartbeat["safeModeReason"] = serde_json::Value::String(reason.to_string());
    }
    if let Some(active) = current.as_ref() {
        // Stream-backed videos of this activation: content the player did
        // not fully cache, with reduced offline guarantees. Omitted
        // without an activation; legacy players never send it.
        heartbeat["streamBackedAssetCount"] = serde_json::json!(active.extras.streams.len());
        if let Some(identity) = active.identity.as_ref() {
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
                if let Ok(Some(stored)) = db.run(move |c| manifests::get_for(c, stage, &stage_binding)).await {
                    heartbeat[field] = serde_json::json!(stored.version);
                }
            }
        }
    }
    if let Some(revision) = crate::config_sync::accepted_revision(context) {
        heartbeat["activeConfigRevision"] = serde_json::json!(revision);
    }
    if let Some(db) = context.db()
        && let Ok(status) = db.run(|c| edge_state::repo::config::status(c)).await
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
    context.display.heartbeat(&mut heartbeat);
    let (helper, network) = context.network.status();
    let helper_ok = helper.as_ref().is_some_and(|h| h.helper_state == "ok");
    let wired = (!helper_ok).then(|| {
        let sys = context.config.dev.hardware_sys_dir.clone().unwrap_or_else(|| std::path::PathBuf::from("/sys"));
        crate::presentation_network::wired_interface_up(&sys)
    });
    crate::presentation_network::heartbeat(&mut heartbeat, helper.as_ref(), &network, wired);
    heartbeat
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_whole_second_sample_corrects_only_what_it_can_resolve() {
        // Precise samples: 250 ms or more, or a stale offset, replace it.
        assert_eq!(player_core::refined_server_offset(None, -40, false, false), Some(-40));
        assert_eq!(refined_offset(Some(-40), 100, false, false), None);
        assert_eq!(refined_offset(Some(-40), 300, false, false), Some(300));
        assert_eq!(refined_offset(Some(-40), 100, false, true), Some(100));
        // A whole-second ping 797 ms "behind" agrees with a precise -40 ms
        // offset and must not replace it (the real-server two-player case).
        assert_eq!(refined_offset(Some(-40), -837, true, true), None);
        // Nothing better known: the interval's middle.
        assert_eq!(refined_offset(None, -837, true, false), Some(-337));
        // Outside its interval: a whole-second sample still fixes a large error.
        assert_eq!(refined_offset(Some(90_000), -837, true, false), Some(-337));
    }

    #[test]
    fn retry_delay_matches_the_reference_player_backoff() {
        // backoff.ts: floor = base / 2, ceiling = base * 2^(failures - 1).
        assert_eq!(retry_delay(1, 0.0), Duration::from_secs(1));
        assert_eq!(retry_delay(1, 0.999_999), Duration::from_millis(1_999));
        assert_eq!(retry_delay(3, 0.0), Duration::from_secs(1));
        assert_eq!(retry_delay(3, 0.5), Duration::from_millis(4_500));
        assert_eq!(retry_delay(9, 1.0), MAX_RETRY_INTERVAL);
        assert_eq!(retry_delay(40, 1.0), MAX_RETRY_INTERVAL);
        assert!(retry_delay(u32::MAX, 0.3) <= MAX_RETRY_INTERVAL);
        for _ in 0..100 {
            let unit = jitter_unit();
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
        assert_eq!(heartbeat_selection_source("none"), Some("none"));
        assert_eq!(heartbeat_selection_source("quick_present"), Some("quick_present"));
        assert_eq!(heartbeat_selection_source("emergency"), None);
    }
}
