//! The fixed command handlers of the Windows player.
//!
//! Each supported command type maps to one typed handler with the reference
//! player's result codes, because the server and Studio read those codes
//! (for example `playback_disabled` updates the screen's status). A result
//! says what the player did; where only the renderer can show the effect,
//! the result says the request was delivered and a missing renderer is a
//! failure, not a success.
//!
//! Command types whose feature arrives in a later stage are settled with
//! `unsupported_command` and the stage that brings them.

use player_client::player_api::ServerCommand;
use player_core::{Handlers, Plan};
use player_state::repo::commands::CommandResult;
use player_state::repo::playback;
use std::sync::Arc;
use std::time::Duration;

use crate::daemon::DaemonContext;

/// Longest a `sync_now` waits for the server link to finish its pass.
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(45);

/// Why a known command type is not available on Windows yet.
pub fn unsupported_reason(command_type: &str) -> Option<&'static str> {
    Some(match command_type {
        // Power Assist is the Android player's device sleep; the reference
        // Linux player answers it the same way. The Windows player holds
        // display sleep off while it presents but does not control
        // display power.
        "power_assist_sleep" | "power_assist_wake" => {
            "Power Assist is an Android feature. The Windows player does not control display power."
        }
        "prepare_airplay_session" | "stop_airplay_session" | "test_airplay_support" => {
            "AirPlay is not available on the Windows player."
        }
        "install_autostart" | "remove_autostart" => {
            "The Windows player starts from its installed shortcut and service, which the installer manages."
        }
        "provision_presentation_network" | "test_presentation_network" => {
            "Presentation networking is not available on the Windows player."
        }
        _ => return None,
    })
}

#[derive(Clone)]
pub struct DaemonHandlers {
    context: Arc<DaemonContext>,
}

impl std::fmt::Debug for DaemonHandlers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonHandlers").finish_non_exhaustive()
    }
}

impl DaemonHandlers {
    pub fn new(context: &Arc<DaemonContext>) -> Self {
        Self { context: Arc::clone(context) }
    }

    async fn set_playback_disabled(&self, disabled: bool) -> Result<(), CommandResult> {
        let db = self.context.db().ok_or_else(|| CommandResult::failed("state_unavailable", ""))?;
        let now = self.context.now();
        db.run(move |c| {
            let mut state = playback::get(c)?;
            state.playback_disabled = disabled;
            playback::put(c, &state, now)
        })
        .await
        .map_err(|error| CommandResult::failed("state_unavailable", error.reason_code()))?;
        self.context.manifest_wake.notify_one();
        Ok(())
    }

    /// Asks the server link for a full reconciliation and waits for it.
    async fn synchronize(&self) -> CommandResult {
        let mut done = self.context.sync_done.subscribe();
        let generation = self.context.sync_request.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
        self.context.server_wake.notify_one();
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
                let reason = self.context.link_state.lock().unwrap_or_else(|e| e.into_inner()).reason_code();
                CommandResult::failed("sync_failed", reason.unwrap_or("server_link_unavailable"))
            }
            Err(_) => CommandResult::failed("sync_timeout", "The server link did not finish in time."),
        }
    }

    async fn clear_media_cache(&self) -> CommandResult {
        let Some(cas) = self.context.cas.as_ref() else {
            return CommandResult::failed("cache_unavailable", "The content store is not open.");
        };
        // Eviction never removes pinned objects: a pending presentation and
        // staged artifacts stay.
        match cas.evict(u64::MAX).await {
            Ok(freed) => CommandResult::ok("cache_cleared", &format!("Released {freed} bytes of unpinned media.")),
            Err(error) => CommandResult::failed("cache_clear_failed", &error.to_string()),
        }
    }

    fn engine(&self) -> std::sync::MutexGuard<'_, crate::presentation::PresentationEngine> {
        self.context.presentation.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    async fn identify(&self, command: &ServerCommand) -> CommandResult {
        let duration = command.payload.get("durationSeconds").and_then(serde_json::Value::as_f64).unwrap_or(15.0);
        let duration = duration.clamp(5.0, 120.0) as u32;
        let config = crate::config_sync::effective(&self.context);
        let screen_name = match self.context.db() {
            Some(db) => {
                db.run(|c| player_state::repo::binding::get(c)).await.ok().flatten().and_then(|bound| bound.screen_name)
            }
            None => None,
        }
        .unwrap_or_else(|| "Tilecast Player".to_owned());
        let location = if config.runtime.playback.identify_shows_location {
            config.runtime.playback.screen_location.as_str()
        } else {
            ""
        };
        let name = if location.is_empty() { screen_name } else { format!("{screen_name} · {location}") };
        if self.engine().identify(&name, duration) {
            CommandResult::ok("identified", "")
        } else {
            CommandResult::failed("renderer_not_connected", "No display renderer is connected.")
        }
    }

    async fn renderer_command(&self, command: player_core::SemanticRendererCommand, code: &str) -> CommandResult {
        if self.engine().renderer_command(command) {
            CommandResult::ok(code, "")
        } else {
            CommandResult::failed("renderer_not_connected", "No display renderer is connected.")
        }
    }

    async fn restart_renderer(&self, code: &str) -> CommandResult {
        if self.engine().restart_renderer("command") {
            CommandResult::ok(code, "")
        } else {
            CommandResult::failed("renderer_not_connected", "No display renderer is connected.")
        }
    }

    async fn clear_website_data(&self) -> CommandResult {
        let Some(pending) = self.engine().request_remote_clear() else {
            return CommandResult::failed("renderer_not_connected", "No display renderer is connected.");
        };
        let cleared = tokio::time::timeout(player_core::WEBSITE_DATA_CLEAR_TIMEOUT, pending)
            .await
            .ok()
            .and_then(|result| result.ok())
            .unwrap_or(false);
        if cleared {
            CommandResult::ok("website_data_cleared", "")
        } else {
            CommandResult::failed("website_data_clear_failed", "Remote website data could not be cleared.")
        }
    }

    async fn self_test(&self) -> CommandResult {
        let mut results = Vec::new();
        let state_ok = match self.context.db() {
            Some(db) => db.run(|c| Ok(c.execute_batch("SELECT 1")?)).await.is_ok(),
            None => false,
        };
        results.push(if state_ok { "state:ok" } else { "state:failed" });
        let cache_ok = match self.context.cas.as_ref() {
            Some(cas) => cas.usage().await.is_ok(),
            None => false,
        };
        results.push(if cache_ok { "cache:ok" } else { "cache:failed" });
        let renderer_ready = self.engine().renderer_is_ready();
        results.push(if renderer_ready { "renderer:ready" } else { "renderer:disconnected" });
        let link = self.context.link_state.lock().unwrap_or_else(|e| e.into_inner()).state_token();
        results.push(match link {
            "connected" => "server:connected",
            "retrying" => "server:retrying",
            _ => "server:stopped",
        });
        results.push(if crate::config_sync::accepted_revision(&self.context).is_some() {
            "config:ok"
        } else {
            "config:none"
        });
        let failed = results.iter().any(|result| result.ends_with(":failed"));
        CommandResult::new(!failed, if failed { "self_test_failed" } else { "self_test_passed" }, &results.join(" "))
    }
}

#[async_trait::async_trait]
impl Handlers for DaemonHandlers {
    fn plan(&self, command: &ServerCommand) -> Plan {
        match command.command_type.as_str() {
            "restart_player_process" => Plan::Disruptive,
            "sync_now"
            | "resynchronize_player"
            | "reload_playback"
            | "identify_screen"
            | "clear_media_cache"
            | "disable_playback"
            | "enable_playback"
            | "retry_current_item"
            | "skip_current_item"
            | "clear_website_data"
            | "recreate_renderer"
            | "recreate_playback_session"
            | "restart_activity"
            | "retry_player_recovery"
            | "exit_safe_mode"
            | "run_player_self_test"
            | "install_player_update" => Plan::Run,
            other => Plan::Settle(CommandResult::failed(
                "unsupported_command",
                unsupported_reason(other).unwrap_or("This command type is not supported by the Windows player."),
            )),
        }
    }

    async fn run(&self, command: &ServerCommand) -> CommandResult {
        let now_ms = self.context.now().unix_millis();
        match command.command_type.as_str() {
            "sync_now" | "resynchronize_player" => self.synchronize().await,
            "reload_playback" => {
                if self.engine().reload_current(now_ms) {
                    CommandResult::ok("playback_reloaded", "")
                } else {
                    CommandResult::failed("nothing_to_reload", "No presentation is active.")
                }
            }
            "identify_screen" => self.identify(command).await,
            "clear_media_cache" => self.clear_media_cache().await,
            "disable_playback" => match self.set_playback_disabled(true).await {
                Ok(()) => CommandResult::ok("playback_disabled", ""),
                Err(result) => result,
            },
            "enable_playback" => match self.set_playback_disabled(false).await {
                Ok(()) => CommandResult::ok("playback_enabled", ""),
                Err(result) => result,
            },
            "retry_current_item" => {
                self.renderer_command(player_core::SemanticRendererCommand::RetryItem, "retried").await
            }
            "skip_current_item" => {
                self.renderer_command(player_core::SemanticRendererCommand::SkipItem, "skipped").await
            }
            "clear_website_data" => self.clear_website_data().await,
            "recreate_renderer" => self.restart_renderer("renderer_recreated").await,
            "recreate_playback_session" => self.restart_renderer("playback_session_recreated").await,
            "restart_activity" => self.restart_renderer("activity_restarted").await,
            "retry_player_recovery" => {
                let action = self.engine().retry_recovery(now_ms);
                CommandResult::ok("recovery_retried", &format!("{action:?}"))
            }
            "exit_safe_mode" => {
                let was = self.engine().clear_safe_mode(now_ms);
                self.context.manifest_wake.notify_one();
                CommandResult::ok("safe_mode_cleared", if was { "" } else { "Safe mode was not active." })
            }
            "run_player_self_test" => self.self_test().await,
            // Records a durable job and returns; the update coordinator
            // downloads, verifies, and deploys it.
            "install_player_update" => {
                let result = crate::update::accept(&self.context.paths, command, crate::update::own_version_code());
                self.context.update_wake.notify_one();
                result
            }
            other => CommandResult::failed(
                "unsupported_command",
                unsupported_reason(other).unwrap_or("This command type is not supported by the Windows player."),
            ),
        }
    }

    async fn prepare_disruption(&self, command: &ServerCommand) -> Result<CommandResult, CommandResult> {
        match command.command_type.as_str() {
            "restart_player_process" => Ok(CommandResult::ok("restart_initiated", "")),
            other => Err(CommandResult::failed(
                "unsupported_command",
                unsupported_reason(other).unwrap_or("This command type is not supported by the Windows player."),
            )),
        }
    }

    fn disrupt(&self, command: &ServerCommand) {
        if command.command_type.as_str() == "restart_player_process" {
            // The process shuts down cleanly and the entry point starts a
            // fresh copy of itself; crashes are covered separately by
            // RegisterApplicationRestart.
            tracing::warn!(component = "commands", event = "restart_requested");
            self.context.restart_requested.store(true, std::sync::atomic::Ordering::Release);
            self.context.shutdown.cancel();
        }
    }
}

/// The player's command task.
pub async fn run(context: Arc<DaemonContext>) {
    let Some(core) = context.core.as_ref() else { return };
    let coordinator = core.commands(DaemonHandlers::new(&context));
    if let Err(error) = coordinator.recover().await {
        tracing::error!(component = "commands", event = "recovery_failed", reason = error.reason_code());
        return;
    }
    let server = context.command_server.subscribe();
    core.run_commands(&coordinator, server, &context.command_wake, &context.shutdown, |outcome| {
        if outcome == player_core::PassOutcome::CredentialRejected {
            // The server link owns the credential and deletes it only on its
            // own explicit rejection; wake it to confirm.
            context.command_server.send_replace(None);
            context.server_wake.notify_one();
        }
    })
    .await;
}
