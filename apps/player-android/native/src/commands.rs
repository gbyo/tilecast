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
    ) -> Self {
        Self { state, clock, cas, config, signals, platform, status }
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

    async fn platform(&self, command: &ServerCommand) -> CommandResult {
        let request = serde_json::json!({"type": command.command_type, "payload": command.payload});
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

    async fn self_test(&self) -> CommandResult {
        let mut results = Vec::new();
        let state_ok = self.state.run(|connection| Ok(connection.execute_batch("SELECT 1")?)).await.is_ok();
        results.push(if state_ok { "state:ok" } else { "state:failed" });
        results.push(if self.cas.usage().await.is_ok() { "cache:ok" } else { "cache:failed" });
        // No renderer adapter exists until PR2b-5c; the probe names that.
        results.push("renderer:unconnected");
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
        let request = serde_json::json!({"type": command.command_type, "payload": command.payload}).to_string();
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
    ) -> (AndroidCommandHandlers, Arc<MemPlatformCommands>, CommandStatus) {
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
        let handlers = AndroidCommandHandlers::new(
            db,
            clock,
            store,
            config,
            Arc::new(LinkSignals::default()),
            platform.clone(),
            status.clone(),
        );
        (handlers, platform, status)
    }

    #[tokio::test]
    async fn plan_routes_disruptive_runnable_and_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, _, _) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
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
        let (handlers, platform, status) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
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
        let (handlers, platform, status) =
            scratch(dir.path(), r#"{"ok":true,"code":"screen_identified","message":"shown"}"#).await;
        let mut identify = command("identify_screen");
        identify.payload.insert("durationSeconds".to_owned(), serde_json::json!(30));
        let result = handlers.run(&identify).await;
        assert!(result.success);
        assert_eq!(result.code, "screen_identified");
        let requests = platform.requests();
        assert_eq!(requests.len(), 1);
        let request: serde_json::Value = serde_json::from_str(&requests[0]).expect("request json");
        assert_eq!(request["type"], "identify_screen");
        assert_eq!(request["payload"]["durationSeconds"], 30);
        let last = status.lock().expect("lock").clone().expect("recorded");
        assert_eq!(last.result, "screen_identified");
    }

    #[tokio::test]
    async fn unreadable_platform_answers_fail_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, _, _) = scratch(dir.path(), "not json").await;
        let result = handlers.run(&command("identify_screen")).await;
        assert!(!result.success);
        assert_eq!(result.code, "platform_failed");
    }

    #[tokio::test]
    async fn self_test_names_state_cache_and_link() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (handlers, _, _) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
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
        let (handlers, _, _) = scratch(dir.path(), r#"{"ok":true,"code":"ok","message":""}"#).await;
        let initiated = handlers.prepare_disruption(&command("restart_player_process")).await.expect("restart");
        assert_eq!(initiated.code, "process_restart_requested");
        assert!(handlers.prepare_disruption(&command("sync_now")).await.is_err());
    }
}
