//! Android platform command handlers for the shared command coordinator.
//!
//! Core owns delivery: polling, idempotency, crash recovery, and result
//! reporting. This module owns what each command does. Pure-state
//! commands run here in Rust; anything that touches the renderer, the
//! OS, or the update installer crosses JNI as one
//! `ExecutePlatformCommand` message and completes with a result
//! envelope, so Core never embeds Android behavior.
//!
//! The last executed command is projected into the heartbeat with the
//! same in-memory semantics the Kotlin player had: a restart clears
//! it. PR3 wires the real Kotlin platform executor as the old brain
//! is removed; until then the production executor answers
//! `platform_unavailable`, which is unreachable because the command
//! driver only runs in Core-only mode.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use player_cas::ContentStore;
use player_client::player_api::ServerCommand;
use player_state::StateDb;
use player_state::repo::commands::CommandResult;
use player_types::time::SharedClock;

use crate::config_host::AndroidConfigHost;
use crate::jvm::Jvm;
use crate::server_link::LinkSignals;

/// Longest a `sync_now` waits for the server link to finish its pass.
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(45);

/// The last executed command, for the heartbeat's `lastCommand*`
/// fields. In-memory, as the Kotlin player kept it.
#[derive(Debug, Clone, Default)]
pub struct LastCommand {
    pub id: String,
    pub state: String,
    pub result: String,
    pub completed_at: String,
}

/// Shared handle between the handlers that record and the heartbeat
/// that reports.
pub type CommandStatus = Arc<Mutex<Option<LastCommand>>>;

/// One platform-owned command execution over JNI. The request is
/// `{"type": str, "payload": object}`; the answer is the result
/// envelope `{"ok": bool, "code": str, "message": str}`.
pub trait PlatformCommands: Send + Sync + std::fmt::Debug {
    fn execute(&self, request_json: &str) -> Result<String, PlatformError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PlatformError {
    #[error("the platform executor is unavailable")]
    Unavailable,
}

/// Calls `CoreBridgeHandler.executePlatformCommand` on a Tokio worker
/// thread. The Kotlin side must never block it on the UI thread.
#[derive(Debug)]
pub struct JvmPlatformCommands {
    jvm: Arc<Jvm>,
}

impl JvmPlatformCommands {
    pub fn new(jvm: Arc<Jvm>) -> Self {
        Self { jvm }
    }
}

impl PlatformCommands for JvmPlatformCommands {
    fn execute(&self, request_json: &str) -> Result<String, PlatformError> {
        self.jvm
            .call_string(crate::jvm::method::execute_platform_command(), Some(request_json))
            .ok()
            .flatten()
            .ok_or(PlatformError::Unavailable)
    }
}

/// In-memory platform executor for host tests: records requests and
/// answers from a scripted result.
#[derive(Debug, Default)]
pub struct MemPlatformCommands {
    requests: Mutex<Vec<String>>,
    result: Mutex<String>,
}

impl MemPlatformCommands {
    pub fn with_result(result: &str) -> Self {
        Self { requests: Mutex::new(Vec::new()), result: Mutex::new(result.to_owned()) }
    }

    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }
}

impl PlatformCommands for MemPlatformCommands {
    fn execute(&self, request_json: &str) -> Result<String, PlatformError> {
        self.requests.lock().unwrap_or_else(|error| error.into_inner()).push(request_json.to_owned());
        Ok(self.result.lock().unwrap_or_else(|error| error.into_inner()).clone())
    }
}

/// Parses a platform result envelope leniently. Anything unreadable is
/// a platform failure, never a success.
fn platform_result(answer: &str) -> CommandResult {
    let value: serde_json::Value = serde_json::from_str(answer).unwrap_or(serde_json::Value::Null);
    let ok = value.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let code = value.get("code").and_then(serde_json::Value::as_str).unwrap_or("platform_failed");
    let message = value.get("message").and_then(serde_json::Value::as_str).unwrap_or_default();
    CommandResult::new(ok, code, message)
}

/// Why a known command type is not available on Android.
pub fn unsupported_reason(command_type: &str) -> Option<&'static str> {
    Some(match command_type {
        // Linux players control the display through Display Control;
        // Android power behavior stays with Power Assist and the OS.
        kind if player_core::DISPLAY_COMMANDS.contains(&kind) => {
            "Display Control is a Linux feature. Android power behavior stays with Power Assist."
        }
        "provision_presentation_network" | "test_presentation_network" => {
            "Presentation networking is a Tilecast Edge feature."
        }
        "install_autostart" | "remove_autostart" => {
            "Android starts from the launcher and boot receiver, which the installer manages."
        }
        _ => return None,
    })
}

/// Android's [`player_core::Handlers`]: pure-state commands in Rust,
/// platform commands over JNI.
#[derive(Debug, Clone)]
pub struct AndroidCommandHandlers {
    state: StateDb,
    clock: SharedClock,
    cas: ContentStore,
    config: Arc<AndroidConfigHost>,
    signals: Arc<LinkSignals>,
    platform: Arc<dyn PlatformCommands>,
    status: CommandStatus,
    engine: Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>,
    renderer: Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>,
}

impl AndroidCommandHandlers {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        state: StateDb,
        clock: SharedClock,
        cas: ContentStore,
        config: Arc<AndroidConfigHost>,
        signals: Arc<LinkSignals>,
        platform: Arc<dyn PlatformCommands>,
        status: CommandStatus,
        engine: Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>,
        renderer: Arc<std::sync::Mutex<crate::renderer::RendererSnapshot>>,
    ) -> Self {
        Self { state, clock, cas, config, signals, platform, status, engine, renderer }
    }

    fn record(&self, id: &str, state: &str, result: &str, completed_at: &str) {
        *self.status.lock().unwrap_or_else(|error| error.into_inner()) = Some(LastCommand {
            id: id.to_owned(),
            state: state.to_owned(),
            result: result.to_owned(),
            completed_at: completed_at.to_owned(),
        });
    }

    async fn set_playback_disabled(&self, disabled: bool) -> Result<(), CommandResult> {
        let now = self.clock.now();
        self.state
            .run(move |connection| {
                let mut state = player_state::repo::playback::get(connection)?;
                state.playback_disabled = disabled;
                player_state::repo::playback::put(connection, &state, now)
            })
            .await
            .map_err(|_| CommandResult::failed("state_unavailable", ""))?;
        self.signals.manifest_wake.notify_one();
        Ok(())
    }

    /// Asks the server link for a full reconciliation and waits for it.
    async fn synchronize(&self) -> CommandResult {
        let mut done = self.signals.sync_done.subscribe();
        let generation = self.signals.sync_request.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
        self.signals.server_wake.notify_one();
        let waited = tokio::time::timeout(SYNC_TIMEOUT, async {
            loop {
                let (completed, succeeded) = *done.borrow_and_update();
                if completed >= generation {
                    return succeeded;
                }
                if done.changed().await.is_err() {
                    return false;
                }
            }
        })
        .await;
        match waited {
            Ok(true) => CommandResult::ok("synchronized", ""),
            Ok(false) => {
                let reason = self.signals.link_state.lock().unwrap_or_else(|error| error.into_inner()).reason_code();
                CommandResult::failed("sync_failed", reason.unwrap_or("server_link_unavailable"))
            }
            Err(_) => CommandResult::failed("sync_timeout", "The server link did not finish in time."),
        }
    }

    async fn clear_media_cache(&self) -> CommandResult {
        // Eviction never removes pinned objects: the presentation on
        // screen, a pending one and staged artifacts stay.
        match self.cas.evict(u64::MAX).await {
            Ok(freed) => CommandResult::ok("cache_cleared", &format!("Released {freed} bytes of unpinned media.")),
            Err(error) => CommandResult::failed("cache_clear_failed", &error.to_string()),
        }
    }

    /// Sends a playback command to a ready renderer. The renderer's
    /// evidence, not this answer, shows its effect.
    async fn renderer_command(
        &self,
        command: player_core::SemanticRendererCommand,
        code: &'static str,
        message: &'static str,
    ) -> CommandResult {
        if self.engine.lock().await.renderer_command(command) {
            CommandResult::ok(code, message)
        } else {
            CommandResult::failed("renderer_not_ready", "No renderer is connected.")
        }
    }

    async fn platform(&self, command: &ServerCommand) -> CommandResult {
        let request = serde_json::json!({"id": command.id, "type": command.command_type, "payload": command.payload});
        let platform = self.platform.clone();
        let answer = tokio::task::spawn_blocking(move || platform.execute(&request.to_string()))
            .await
            .ok()
            .and_then(|result| result.ok())
            .unwrap_or_default();
        if answer.is_empty() {
            return CommandResult::failed("platform_unavailable", "The platform executor did not answer.");
        }
        platform_result(&answer)
    }

    /// Whether the current activation is a takeover: Power Assist
    /// sleep and update installation defer while one is on screen.
    async fn takeover_active(&self) -> bool {
        self.engine
            .lock()
            .await
            .current_activation()
            .and_then(|active| active.identity)
            .is_some_and(|identity| identity.takeover_id.is_some())
    }

    /// The identify overlay text: the screen name, its configured
    /// location, and the short screen id, as the legacy player showed.
    async fn identify_text(&self) -> String {
        let bound = self.state.run(|connection| player_state::repo::binding::get(connection)).await.ok().flatten();
        let playback = self.config.effective().map(|config| config.runtime.playback.clone()).unwrap_or_default();
        let mut text =
            bound.as_ref().and_then(|bound| bound.screen_name.clone()).unwrap_or_else(|| "Tilecast screen".to_owned());
        if playback.identify_shows_location && !playback.screen_location.is_empty() {
            text.push('\n');
            text.push_str(&playback.screen_location);
        }
        if let Some(id) = bound.as_ref().and_then(|bound| bound.screen_id.map(|id| id.to_string())) {
            // Canonical UUIDs are ASCII; the short id is the last 8 chars.
            let short = id.get(id.len().saturating_sub(8)..).unwrap_or(&id);
            text.push('\n');
            text.push_str(short);
        }
        text
    }

    async fn self_test(&self) -> CommandResult {
        let mut results = Vec::new();
        let state_ok = self.state.run(|connection| Ok(connection.execute_batch("SELECT 1")?)).await.is_ok();
        results.push(if state_ok { "state:ok" } else { "state:failed" });
        results.push(if self.cas.usage().await.is_ok() { "cache:ok" } else { "cache:failed" });
        let snapshot = self.renderer.lock().unwrap_or_else(|error| error.into_inner()).clone();
        results.push(if snapshot.connected && snapshot.ready { "renderer:connected" } else { "renderer:unconnected" });
        let link = self.signals.link_state.lock().unwrap_or_else(|error| error.into_inner()).state_token();
        results.push(match link {
            "connected" => "server:connected",
            "retrying" => "server:retrying",
            _ => "server:stopped",
        });
        results.push(if self.config.accepted_revision().is_some() { "config:ok" } else { "config:none" });
        let failed = results.iter().any(|result| result.ends_with(":failed"));
        CommandResult::new(!failed, if failed { "self_test_failed" } else { "self_test_passed" }, &results.join(" "))
    }
}

#[async_trait::async_trait]
impl player_core::Handlers for AndroidCommandHandlers {
    fn plan(&self, command: &ServerCommand) -> player_core::Plan {
        match command.command_type.as_str() {
            "restart_player_process" => player_core::Plan::Disruptive,
            "sync_now"
            | "resynchronize_player"
            | "reload_playback"
            | "identify_screen"
            | "clear_media_cache"
            | "clear_website_data"
            | "disable_playback"
            | "enable_playback"
            | "retry_current_item"
            | "skip_current_item"
            | "recreate_renderer"
            | "recreate_playback_session"
            | "restart_activity"
            | "retry_player_recovery"
            | "exit_safe_mode"
            | "run_player_self_test"
            | "power_assist_sleep"
            | "power_assist_wake"
            | "install_player_update" => player_core::Plan::Run,
            other => player_core::Plan::Settle(CommandResult::failed(
                "unsupported_command",
                unsupported_reason(other).unwrap_or("This command type is not supported by the Android player."),
            )),
        }
    }

    async fn run(&self, command: &ServerCommand) -> CommandResult {
        self.record(&command.id.to_string(), "running", "", "");
        // Renderer commands run against the engine: only true OS
        // effects (power, updates, restarts) cross to Kotlin.
        let result = match command.command_type.as_str() {
            "sync_now" | "resynchronize_player" => self.synchronize().await,
            "disable_playback" => match self.set_playback_disabled(true).await {
                Ok(()) => CommandResult::ok("playback_disabled", ""),
                Err(failure) => failure,
            },
            "enable_playback" => match self.set_playback_disabled(false).await {
                Ok(()) => CommandResult::ok("playback_enabled", ""),
                Err(failure) => failure,
            },
            "clear_media_cache" => self.clear_media_cache().await,
            "run_player_self_test" => self.self_test().await,
            "reload_playback" | "recreate_playback_session" => {
                let code = if command.command_type == "reload_playback" {
                    "playback_reloaded"
                } else {
                    "playback_session_recreated"
                };
                let now = self.clock.now();
                if self.engine.lock().await.reload_current(now).await {
                    CommandResult::ok(code, "")
                } else {
                    CommandResult::failed("reload_failed", "No presentation is active.")
                }
            }
            "retry_current_item" => {
                self.renderer_command(
                    player_core::SemanticRendererCommand::RetryItem,
                    "current_item_retried",
                    "The current item was restarted.",
                )
                .await
            }
            "skip_current_item" => {
                self.renderer_command(
                    player_core::SemanticRendererCommand::SkipItem,
                    "current_item_skipped",
                    "The player advanced to the next item.",
                )
                .await
            }
            "clear_website_data" => {
                self.renderer_command(
                    player_core::SemanticRendererCommand::ClearWebsiteData,
                    "website_data_cleared",
                    "Website data was cleared.",
                )
                .await
            }
            "recreate_renderer" => {
                if self.engine.lock().await.restart_renderer("command") {
                    CommandResult::ok("renderer_recreated", "The playback renderer is being recreated.")
                } else {
                    CommandResult::failed("renderer_not_ready", "No renderer is connected.")
                }
            }
            "retry_player_recovery" => {
                let now = self.clock.now();
                let action = self.engine.lock().await.retry_recovery(now).await;
                CommandResult::ok("player_recovery_retried", &format!("Recovery ran: {action:?}."))
            }
            "exit_safe_mode" => {
                let now = self.clock.now();
                let was = self.engine.lock().await.clear_safe_mode(now);
                CommandResult::ok(
                    "safe_mode_exited",
                    if was { "Safe mode was cleared." } else { "Safe mode was not active." },
                )
            }
            "identify_screen" => {
                let seconds = command
                    .payload
                    .get("durationSeconds")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(30)
                    .clamp(1, 300) as u32;
                let name = self.identify_text().await;
                if self.engine.lock().await.identify(&name, seconds) {
                    CommandResult::ok("screen_identified", "Identification is showing on screen.")
                } else {
                    CommandResult::failed("renderer_not_ready", "No renderer is connected.")
                }
            }
            "power_assist_sleep" => {
                if self.takeover_active().await {
                    CommandResult::failed(
                        "power_assist_deferred_takeover",
                        "Power Assist sleep was delayed by takeover playback.",
                    )
                } else {
                    self.platform(command).await
                }
            }
            _ => self.platform(command).await,
        };
        let completed_at = self.clock.now().to_string();
        self.record(
            &command.id.to_string(),
            if result.success { "succeeded" } else { "failed" },
            &result.code,
            &completed_at,
        );
        result
    }

    async fn prepare_disruption(&self, command: &ServerCommand) -> Result<CommandResult, CommandResult> {
        if command.command_type == "restart_player_process" {
            Ok(CommandResult::ok("process_restart_requested", "Controlled player process restart was requested."))
        } else {
            Err(CommandResult::failed("unsupported_command", "This command type cannot disrupt."))
        }
    }

    fn disrupt(&self, command: &ServerCommand) {
        // The result is durable; the process restart is the execution.
        // A missed upcall still restarts nothing twice: the coordinator
        // never calls disrupt twice for one idempotency key.
        let request =
            serde_json::json!({"id": command.id, "type": command.command_type, "payload": command.payload}).to_string();
        let _ = self.platform.execute(&request);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::{LruByDomain, StorePolicy};
    use player_core::Handlers as _;
    use player_state::{OpenOptions, StateDb};

    fn command(command_type: &str) -> ServerCommand {
        ServerCommand {
            id: uuid::Uuid::from_u128(0xC0FFEE),
            command_type: command_type.to_owned(),
            idempotency_key: "5c0b1f0e-8f1a-4c55-9a53-27f2f0b2f0aa".to_owned(),
            payload: serde_json::Map::new(),
        }
    }

    async fn scratch(
        dir: &std::path::Path,
        platform_result: &str,
    ) -> (
        AndroidCommandHandlers,
        Arc<MemPlatformCommands>,
        CommandStatus,
        Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>,
    ) {
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
        let config = Arc::new(AndroidConfigHost::new(dir.join("installed-config.json"), store.clone()));
        let platform = Arc::new(MemPlatformCommands::with_result(platform_result));
        let status: CommandStatus = Arc::new(Mutex::new(None));
        let snapshot = Arc::new(Mutex::new(crate::renderer::RendererSnapshot::default()));
        let engine = Arc::new(tokio::sync::Mutex::new(crate::renderer::PresentationEngine::new(
            crate::renderer::AndroidRendererPort::new(
                Arc::new(crate::renderer::MemRendererPlatform::default()),
                store.clone(),
            ),
            std::sync::Arc::new(crate::host::SystemClock),
            snapshot.clone(),
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            player_types::Timestamp::from_unix_millis(1_700_000_000_000).expect("test clock"),
        )));
        let handlers = AndroidCommandHandlers::new(
            db,
            clock,
            store,
            config,
            Arc::new(LinkSignals::default()),
            platform.clone(),
            status.clone(),
            engine.clone(),
            snapshot,
        );
        (handlers, platform, status, engine)
    }

    #[tokio::test]
    async fn plan_routes_disruptive_runnable_and_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, _, _, _) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
        assert!(matches!(handlers.plan(&command("restart_player_process")), player_core::Plan::Disruptive));
        for known in [
            "sync_now",
            "resynchronize_player",
            "reload_playback",
            "identify_screen",
            "clear_media_cache",
            "clear_website_data",
            "disable_playback",
            "enable_playback",
            "retry_current_item",
            "skip_current_item",
            "recreate_renderer",
            "recreate_playback_session",
            "restart_activity",
            "retry_player_recovery",
            "exit_safe_mode",
            "run_player_self_test",
            "power_assist_sleep",
            "power_assist_wake",
            "install_player_update",
        ] {
            assert!(matches!(handlers.plan(&command(known)), player_core::Plan::Run), "{known}");
        }
        match handlers.plan(&command("provision_presentation_network")) {
            player_core::Plan::Settle(result) => {
                assert!(!result.success);
                assert_eq!(result.code, "unsupported_command");
                assert!(result.message.contains("Edge"), "{}", result.message);
            }
            other => panic!("expected settle, got {other:?}"),
        }
        match handlers.plan(&command("self_destruct")) {
            player_core::Plan::Settle(result) => assert_eq!(result.code, "unsupported_command"),
            other => panic!("expected settle, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn playback_disable_round_trip_persists_and_records() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, platform, status, _) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
        let disabled = handlers.run(&command("disable_playback")).await;
        assert!(disabled.success);
        assert_eq!(disabled.code, "playback_disabled");
        let state =
            handlers.state.run(|connection| player_state::repo::playback::get(connection)).await.expect("playback");
        assert!(state.playback_disabled);
        let enabled = handlers.run(&command("enable_playback")).await;
        assert_eq!(enabled.code, "playback_enabled");
        assert!(platform.requests().is_empty(), "pure-state commands never cross JNI");
        let last = status.lock().expect("lock").clone().expect("recorded");
        assert_eq!(last.state, "succeeded");
        assert_eq!(last.result, "playback_enabled");
        assert!(!last.completed_at.is_empty());
    }

    #[tokio::test]
    async fn platform_commands_cross_with_type_and_payload() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, platform, status, _) =
            scratch(dir.path(), r#"{"ok":true,"code":"wake_sent","message":"sent"}"#).await;
        let result = handlers.run(&command("power_assist_wake")).await;
        assert!(result.success);
        assert_eq!(result.code, "wake_sent");
        let requests = platform.requests();
        assert_eq!(requests.len(), 1);
        let request: serde_json::Value = serde_json::from_str(&requests[0]).expect("request json");
        assert_eq!(request["type"], "power_assist_wake");
        let last = status.lock().expect("lock").clone().expect("recorded");
        assert_eq!(last.result, "wake_sent");
    }

    #[tokio::test]
    async fn renderer_commands_never_reach_the_platform() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, platform, _, _) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
        // No renderer is connected and nothing is active: every
        // renderer command answers from the engine, honestly refused.
        for (command_type, code) in [
            ("retry_current_item", "renderer_not_ready"),
            ("skip_current_item", "renderer_not_ready"),
            ("identify_screen", "renderer_not_ready"),
            ("clear_website_data", "renderer_not_ready"),
            ("reload_playback", "reload_failed"),
            ("recreate_playback_session", "reload_failed"),
            ("recreate_renderer", "renderer_not_ready"),
        ] {
            let result = handlers.run(&command(command_type)).await;
            assert!(!result.success, "{command_type}");
            assert_eq!(result.code, code, "{command_type}");
        }
        // Recovery controls always answer: safe mode simply was not on.
        let retried = handlers.run(&command("retry_player_recovery")).await;
        assert!(retried.success);
        assert_eq!(retried.code, "player_recovery_retried");
        let exited = handlers.run(&command("exit_safe_mode")).await;
        assert!(exited.success);
        assert_eq!(exited.code, "safe_mode_exited");
        assert!(platform.requests().is_empty(), "no platform upcalls");
    }

    #[tokio::test]
    async fn takeover_defers_power_assist_sleep() {
        use player_types::Sha256Digest;
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, platform, _, engine) =
            scratch(dir.path(), r#"{"ok":true,"code":"sleep_sent","message":"sent"}"#).await;
        // No takeover: sleep crosses to the platform.
        let awake = handlers.run(&command("power_assist_sleep")).await;
        assert!(awake.success);
        assert_eq!(awake.code, "sleep_sent");
        // A takeover activation defers sleep without an upcall.
        let request = serde_json::json!({
            "envelope": {"presentation": {"state": "playing", "items": []}},
            "content": [],
            "source": "server_manifest",
            "identity": {
                "manifest": Sha256Digest::of(b"manifest").to_hex(),
                "manifestVersion": 8,
                "selectionSource": "takeover",
                "playlistId": "33333333-3333-3333-3333-333333333333",
                "takeoverId": "55555555-5555-5555-5555-555555555555",
            },
            "clockOffsetMs": 0,
        });
        let now = player_types::Timestamp::from_unix_millis(1_700_000_000_000).expect("time");
        engine.lock().await.activate(&request.to_string(), now).await.expect("activate");
        let deferred = handlers.run(&command("power_assist_sleep")).await;
        assert!(!deferred.success);
        assert_eq!(deferred.code, "power_assist_deferred_takeover");
        assert_eq!(platform.requests().len(), 1, "only the first sleep crossed");
    }

    #[tokio::test]
    async fn unreadable_platform_answers_fail_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, _, _, _) = scratch(dir.path(), "not json").await;
        let result = handlers.run(&command("power_assist_wake")).await;
        assert!(!result.success);
        assert_eq!(result.code, "platform_failed");
    }

    #[tokio::test]
    async fn self_test_names_state_cache_and_link() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, _, _, _) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
        let result = handlers.run(&command("run_player_self_test")).await;
        assert!(result.success, "{result:?}");
        assert_eq!(result.code, "self_test_passed");
        assert!(result.message.contains("state:ok"), "{}", result.message);
        assert!(result.message.contains("cache:ok"), "{}", result.message);
        assert!(result.message.contains("server:stopped"), "{}", result.message);
        assert!(result.message.contains("config:none"), "{}", result.message);
    }

    #[tokio::test]
    async fn disruption_prepares_only_the_process_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, _, _, _) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
        let initiated = handlers.prepare_disruption(&command("restart_player_process")).await.expect("restart");
        assert_eq!(initiated.code, "process_restart_requested");
        assert!(handlers.prepare_disruption(&command("sync_now")).await.is_err());
    }
}
