//! Remote web commands and the `renderer.remote_web` capability
//! (docs/tilecast-edge-remote-web-threat-review.md §8, §16).
//!
//! `tilecastd` never opens the isolated helper's website data. It asks the
//! renderer with the closed `clear_website_data` renderer command and waits
//! for the renderer's typed `renderer.command_result`; the renderer asks
//! the helper. A renderer that disconnects or does not answer in time is a
//! truthful failure, never a success.

use std::sync::Mutex;

use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortToken};
use edge_protocol::capability::{Capability, CapabilityId, CapabilityState, ids};
use edge_protocol::ipc::event::{RemoteWebStatus, RendererCommandKind, RendererCommandResult};
use edge_state::repo::commands::CommandResult;
use player_core::{
    RendererCommandBroker, RendererCommandError, SemanticRendererCommandResult, StartupWebsiteClear as StartupClear,
};

use crate::daemon::DaemonContext;

pub use player_core::WEBSITE_DATA_CLEAR_TIMEOUT as CLEAR_TIMEOUT;

/// Edge wire conversion around shared renderer command coordination.
#[derive(Debug, Default)]
pub struct Waiters {
    commands: RendererCommandBroker,
    startup_clear: Mutex<StartupClear>,
}

impl Waiters {
    pub fn complete(&self, result: RendererCommandResult) {
        self.commands.complete(SemanticRendererCommandResult {
            command_id: result.command_id,
            success: result.success,
            code: result.code,
        });
    }

    pub fn renderer_disconnected(&self) {
        self.commands.renderer_disconnected();
    }
}

/// Clears the helper's website data through the renderer.
pub async fn clear_website_data(context: &DaemonContext) -> CommandResult {
    let answer = context
        .renderer_commands
        .commands
        .request(CLEAR_TIMEOUT, |id| async move {
            context.presentation.lock().await.renderer_command_with_id(id, RendererCommandKind::ClearWebsiteData)
        })
        .await;
    match answer {
        Ok(result) if result.success => CommandResult::ok("website_data_cleared", ""),
        Ok(result) => CommandResult::failed(
            result.code.as_str(),
            match result.code.as_str() {
                "remote_web_unavailable" => "The remote web renderer is not running.",
                "remote_web_helper_restarted" => "The remote web renderer restarted before it finished.",
                _ => "Website data could not be cleared.",
            },
        ),
        Err(RendererCommandError::Busy) => {
            CommandResult::failed("remote_web_busy", "Too many website data requests are pending.")
        }
        Err(RendererCommandError::NotConnected) => {
            CommandResult::failed("renderer_not_connected", "No display renderer is connected.")
        }
        Err(RendererCommandError::Disconnected) => {
            CommandResult::failed("renderer_disconnected", "The display renderer disconnected.")
        }
        Err(RendererCommandError::Timeout) => {
            CommandResult::failed("renderer_timeout", "The display renderer did not answer in time.")
        }
    }
}

/// Whether this `renderer.ready` should start the startup clear.
fn should_clear_at_start(status: Option<&RemoteWebStatus>, clear_on_restart: bool, state: &mut StartupClear) -> bool {
    state.begin(status.is_some_and(|status| status.available), clear_on_restart)
}

/// Record what the startup clear did. Only the renderer's success answer
/// completes it; anything else (a disconnect, a timeout, the helper being
/// gone) leaves it idle so recovery retries. Manual `clear_website_data`
/// commands never touch this state.
fn note_startup_clear_result(state: &mut StartupClear, result: &CommandResult) {
    state.finish(result.success);
}

/// `website.clearOnRestart`: once per daemon start, when a renderer with
/// remote web is ready (the reference player clears at startup). The
/// renderer re-sends `renderer.ready` after a reconnect and when the helper
/// appears later, so a failed startup clear retries on recovery; a
/// successful one never runs again for this process.
pub fn clear_at_start_if_configured(context: &std::sync::Arc<DaemonContext>, status: Option<&RemoteWebStatus>) {
    let clear_on_restart = crate::config_sync::effective(context).runtime.website.clear_on_restart;
    {
        let mut state = context.renderer_commands.startup_clear.lock().unwrap_or_else(|e| e.into_inner());
        if !should_clear_at_start(status, clear_on_restart, &mut state) {
            return;
        }
    }
    let context = std::sync::Arc::clone(context);
    tokio::spawn(async move {
        let result = clear_website_data(&context).await;
        {
            let mut state = context.renderer_commands.startup_clear.lock().unwrap_or_else(|e| e.into_inner());
            note_startup_clear_result(&mut state, &result);
        }
        tracing::info!(component = "remote_web", event = "website_data_cleared_at_start", code = result.code.as_str());
    });
}

/// `renderer.remote_web`, from the connected renderer's `renderer.ready` and
/// health.
pub fn capability(
    ready: Option<&RemoteWebStatus>,
    connected: bool,
    helper_restarting: bool,
    observed_at: Timestamp,
) -> Option<Capability> {
    let (state, reason, detail) = match ready {
        _ if !connected => (
            CapabilityState::Supported,
            Some("renderer_not_connected"),
            "Remote web needs the WPE renderer, which is not connected.",
        ),
        None => (
            CapabilityState::Unsupported,
            Some("renderer_without_remote_web"),
            "The connected renderer has no remote web support.",
        ),
        Some(status) if !status.available => (
            CapabilityState::Blocked,
            Some(status.reason.as_ref().map_or("remote_web_helper_unavailable", ShortToken::as_str)),
            "tilecast-web-renderer.service did not answer the renderer.",
        ),
        Some(_) if helper_restarting => (
            CapabilityState::Degraded,
            Some("remote_web_helper_restarting"),
            "The remote web helper restarted; Websites fail over until it is back.",
        ),
        Some(status) if !status.accelerated => (
            CapabilityState::Degraded,
            Some("remote_web_software_frames"),
            "Websites render without a GPU: at most 30 frames a second, with a CPU copy.",
        ),
        Some(_) => (CapabilityState::Available, None, ""),
    };
    let mut capability = Capability::new(CapabilityId::new(ids::RENDERER_REMOTE_WEB).ok()?, state, observed_at);
    capability.provider = ShortToken::new("tilecast-web-renderer-wpe").ok();
    capability.reason_code = reason.and_then(|reason| ShortToken::new(reason).ok());
    if !detail.is_empty() {
        capability.detail = Some(DetailText::lossy(detail));
    }
    Some(capability)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(available: bool, accelerated: bool) -> RemoteWebStatus {
        RemoteWebStatus { available, accelerated, reason: None }
    }

    #[test]
    fn capability_says_why_remote_web_does_not_work() {
        let now = Timestamp::from_unix_millis(0).expect("time");
        let state = |ready: Option<&RemoteWebStatus>, connected, restarting| {
            let capability = capability(ready, connected, restarting, now).expect("capability");
            (capability.state, capability.reason_code.map(|r| r.as_str().to_owned()))
        };
        assert_eq!(state(None, false, false), (CapabilityState::Supported, Some("renderer_not_connected".into())));
        assert_eq!(
            state(None, true, false),
            (CapabilityState::Unsupported, Some("renderer_without_remote_web".into()))
        );
        assert_eq!(
            state(Some(&status(false, false)), true, false),
            (CapabilityState::Blocked, Some("remote_web_helper_unavailable".into()))
        );
        assert_eq!(
            state(Some(&status(true, true)), true, true),
            (CapabilityState::Degraded, Some("remote_web_helper_restarting".into()))
        );
        assert_eq!(
            state(Some(&status(true, false)), true, false),
            (CapabilityState::Degraded, Some("remote_web_software_frames".into()))
        );
        assert_eq!(state(Some(&status(true, true)), true, false), (CapabilityState::Available, None));
    }

    fn ready(available: bool) -> RemoteWebStatus {
        status(available, true)
    }

    fn failed(code: &str) -> CommandResult {
        CommandResult::failed(code, "not cleared")
    }

    #[test]
    fn startup_clear_completes_only_after_success() {
        // A successful first clear runs once; later ready events do nothing.
        let mut state = StartupClear::default();
        assert!(should_clear_at_start(Some(&ready(true)), true, &mut state));
        assert_eq!(state, StartupClear::InFlight);
        // No duplicate simultaneous clear while one runs.
        assert!(!should_clear_at_start(Some(&ready(true)), true, &mut state));
        note_startup_clear_result(&mut state, &CommandResult::ok("website_data_cleared", ""));
        assert_eq!(state, StartupClear::Done);
        assert!(!should_clear_at_start(Some(&ready(true)), true, &mut state));
    }

    #[test]
    fn startup_clear_waits_for_the_helper_then_runs_once() {
        // Helper unavailable at first ready: nothing starts.
        let mut state = StartupClear::default();
        assert!(!should_clear_at_start(Some(&ready(false)), true, &mut state));
        assert!(!should_clear_at_start(None, true, &mut state));
        assert!(!should_clear_at_start(Some(&ready(true)), false, &mut state));
        assert_eq!(state, StartupClear::Idle);
        // Recovery (the helper appears, ready re-sent): the clear runs.
        assert!(should_clear_at_start(Some(&ready(true)), true, &mut state));
        note_startup_clear_result(&mut state, &CommandResult::ok("website_data_cleared", ""));
        assert_eq!(state, StartupClear::Done);
        assert!(!should_clear_at_start(Some(&ready(true)), true, &mut state));
    }

    #[test]
    fn startup_clear_retries_after_disconnect_timeout_or_helper_failure() {
        // Renderer disconnect during the clear.
        let mut state = StartupClear::default();
        assert!(should_clear_at_start(Some(&ready(true)), true, &mut state));
        note_startup_clear_result(&mut state, &failed("renderer_disconnected"));
        assert_eq!(state, StartupClear::Idle);
        // Timeout waiting for the answer.
        assert!(should_clear_at_start(Some(&ready(true)), true, &mut state));
        note_startup_clear_result(&mut state, &failed("renderer_timeout"));
        assert_eq!(state, StartupClear::Idle);
        // Helper restarted or unavailable mid-clear.
        assert!(should_clear_at_start(Some(&ready(true)), true, &mut state));
        note_startup_clear_result(&mut state, &failed("remote_web_helper_restarted"));
        assert_eq!(state, StartupClear::Idle);
        assert!(should_clear_at_start(Some(&ready(true)), true, &mut state));
        note_startup_clear_result(&mut state, &failed("remote_web_unavailable"));
        assert_eq!(state, StartupClear::Idle);
        // Recovery finally succeeds: done, exactly once.
        assert!(should_clear_at_start(Some(&ready(true)), true, &mut state));
        note_startup_clear_result(&mut state, &CommandResult::ok("website_data_cleared", ""));
        assert_eq!(state, StartupClear::Done);
        assert!(!should_clear_at_start(Some(&ready(true)), true, &mut state));
    }
}
