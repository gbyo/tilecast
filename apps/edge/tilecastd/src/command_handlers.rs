//! The fixed command handlers of Tilecast Edge.
//!
//! Each supported command type maps to one typed handler with the reference
//! Linux player's result codes (`apps/player-linux/src/core/player.ts`
//! `buildCommandHandlers`), because the server and Studio read those codes
//! (for example `playback_disabled` updates the screen's status). A result
//! says what the daemon did; where only the renderer can show the effect,
//! the result says the request was delivered and a missing renderer is a
//! failure, not a success.
//!
//! Command types whose feature arrives in a later milestone are settled with
//! `unsupported_command` and the milestone that brings them.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::ipc::event::RendererCommandKind;
use edge_server::player_api::ServerCommand;
use edge_state::repo::commands::CommandResult;
use edge_state::repo::{binding, playback};

use crate::commands::{Handlers, Plan};
use crate::daemon::DaemonContext;

/// Longest a `sync_now` waits for the server link to finish its pass.
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(45);

/// Why a known command type is not available on Edge yet.
pub fn unsupported_reason(command_type: &str) -> Option<&'static str> {
    Some(match command_type {
        "install_player_update" => "Signed Tilecast Edge updates arrive in milestone M10.",
        "clear_website_data" => "Website playback on Tilecast Edge arrives with website isolation (M11).",
        "power_assist_sleep" | "power_assist_wake" => "Display power assist on Tilecast Edge arrives in M9.",
        "display_power_on"
        | "display_power_off"
        | "display_set_input"
        | "display_set_volume"
        | "display_mute"
        | "display_unmute"
        | "display_set_brightness"
        | "display_probe" => "Display Control on Tilecast Edge arrives in M9.",
        "provision_presentation_network" | "test_presentation_network" => {
            "Presentation Networks on Tilecast Edge arrive in M9."
        }
        "prepare_airplay_session" | "stop_airplay_session" | "test_airplay_support" => {
            "AirPlay is not available on Tilecast Edge."
        }
        "install_autostart" | "remove_autostart" => {
            "Tilecast Edge starts from its system service, which the installer manages."
        }
        _ => return None,
    })
}

#[derive(Debug, Clone)]
pub struct DaemonHandlers {
    context: Arc<DaemonContext>,
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

    async fn identify(&self, command: &ServerCommand) -> CommandResult {
        let duration = command.payload.get("durationSeconds").and_then(serde_json::Value::as_f64).unwrap_or(15.0);
        let duration = duration.clamp(5.0, 120.0) as u32;
        let config = crate::config_sync::effective(&self.context);
        let screen_name = match self.context.db() {
            Some(db) => db.run(|c| binding::get(c)).await.ok().flatten().and_then(|bound| bound.screen_name),
            None => None,
        }
        .unwrap_or_else(|| "Tilecast Player".to_owned());
        let location =
            if config.playback.identify_shows_location { config.playback.screen_location.as_str() } else { "" };
        // IPC text carries no control characters, so the reference player's
        // two-line form is joined with a visible separator.
        let name = if location.is_empty() { screen_name } else { format!("{screen_name} · {location}") };
        if self.context.presentation.lock().await.identify(&name, duration) {
            CommandResult::ok("identified", "")
        } else {
            CommandResult::failed("renderer_not_connected", "No display renderer is connected.")
        }
    }

    async fn renderer_command(&self, kind: RendererCommandKind, code: &str) -> CommandResult {
        if self.context.presentation.lock().await.renderer_command(kind) {
            CommandResult::ok(code, "")
        } else {
            CommandResult::failed("renderer_not_connected", "No display renderer is connected.")
        }
    }

    async fn restart_renderer(&self, code: &str) -> CommandResult {
        if self.context.presentation.lock().await.restart_renderer("command") {
            CommandResult::ok(code, "")
        } else {
            CommandResult::failed("renderer_not_connected", "No display renderer is connected.")
        }
    }

    async fn clear_media_cache(&self) -> CommandResult {
        let Some(cas) = self.context.cas.as_ref() else {
            return CommandResult::failed("cache_unavailable", "The content store is not open.");
        };
        // Eviction never removes pinned objects: the presentation on screen,
        // a pending one and staged artifacts stay.
        match cas.evict(u64::MAX).await {
            Ok(freed) => CommandResult::ok("cache_cleared", &format!("Released {freed} bytes of unpinned media.")),
            Err(error) => CommandResult::failed("cache_clear_failed", &error.to_string()),
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
        let renderer_ready = self.context.presentation.lock().await.renderer_is_ready();
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

#[async_trait]
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
            | "recreate_renderer"
            | "recreate_playback_session"
            | "restart_activity"
            | "retry_player_recovery"
            | "exit_safe_mode"
            | "run_player_self_test" => Plan::Run,
            other => Plan::Settle(CommandResult::failed(
                "unsupported_command",
                unsupported_reason(other).unwrap_or("This command type is not supported by Tilecast Edge."),
            )),
        }
    }

    async fn run(&self, command: &ServerCommand) -> CommandResult {
        let now_ms = self.context.now().unix_millis();
        match command.command_type.as_str() {
            "sync_now" => self.synchronize().await,
            "resynchronize_player" => {
                let result = self.synchronize().await;
                self.context.presentation.lock().await.reload_current(self.context.now().unix_millis());
                result
            }
            "reload_playback" => {
                if self.context.presentation.lock().await.reload_current(now_ms) {
                    CommandResult::ok("playback_reloaded", "")
                } else {
                    CommandResult::failed("nothing_to_reload", "No presentation is active.")
                }
            }
            "identify_screen" => self.identify(command).await,
            "clear_media_cache" => self.clear_media_cache().await,
            "disable_playback" => match self.set_playback_disabled(true).await {
                Ok(()) => CommandResult::ok("playback_disabled", ""),
                Err(failure) => failure,
            },
            "enable_playback" => match self.set_playback_disabled(false).await {
                Ok(()) => CommandResult::ok("playback_enabled", ""),
                Err(failure) => failure,
            },
            "retry_current_item" => self.renderer_command(RendererCommandKind::RetryItem, "retried").await,
            "skip_current_item" => self.renderer_command(RendererCommandKind::SkipItem, "skipped").await,
            // The display renderer is a separate process: recreating it is a
            // renderer restart that systemd completes, not a daemon restart.
            "recreate_renderer" => self.restart_renderer("renderer_recreated").await,
            "recreate_playback_session" => self.restart_renderer("playback_session_recreated").await,
            "restart_activity" => self.restart_renderer("activity_restarted").await,
            "retry_player_recovery" => {
                let action = self.context.presentation.lock().await.retry_recovery(now_ms);
                CommandResult::ok("recovery_retried", &format!("{action:?}"))
            }
            "exit_safe_mode" => {
                let was = self.context.presentation.lock().await.clear_safe_mode(now_ms);
                self.context.manifest_wake.notify_one();
                CommandResult::ok("safe_mode_cleared", if was { "" } else { "Safe mode was not active." })
            }
            "run_player_self_test" => self.self_test().await,
            other => CommandResult::failed(
                "unsupported_command",
                unsupported_reason(other).unwrap_or("This command type is not supported by Tilecast Edge."),
            ),
        }
    }

    async fn prepare_disruption(&self, command: &ServerCommand) -> Result<CommandResult, CommandResult> {
        match command.command_type.as_str() {
            // systemd (`Restart=always`) starts the daemon again; the renderer
            // keeps its last frame and reconnects.
            "restart_player_process" if self.context.db().is_some() => {
                Ok(CommandResult::ok("initiated", "restart_player_process initiated"))
            }
            "restart_player_process" => Err(CommandResult::failed("state_unavailable", "")),
            other => Err(CommandResult::failed(
                "unsupported_command",
                unsupported_reason(other).unwrap_or("This command type is not supported by Tilecast Edge."),
            )),
        }
    }

    fn disrupt(&self, command: &ServerCommand) {
        if command.command_type == "restart_player_process" {
            tracing::warn!(component = "commands", event = "restart_requested");
            self.context.restart_requested.store(true, std::sync::atomic::Ordering::Release);
            self.context.shutdown.cancel();
        }
    }
}
