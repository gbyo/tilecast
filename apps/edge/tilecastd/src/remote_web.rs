//! Remote web commands and the `renderer.remote_web` capability
//! (docs/tilecast-edge-remote-web-threat-review.md §8, §16).
//!
//! `tilecastd` never opens the isolated helper's website data. It asks the
//! renderer with the closed `clear_website_data` renderer command and waits
//! for the renderer's typed `renderer.command_result`; the renderer asks
//! the helper. A renderer that disconnects or does not answer in time is a
//! truthful failure, never a success.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortToken};
use edge_protocol::capability::{Capability, CapabilityId, CapabilityState, ids};
use edge_protocol::ipc::event::{RemoteWebStatus, RendererCommandKind, RendererCommandResult};
use edge_state::repo::commands::CommandResult;
use tokio::sync::oneshot;

use crate::daemon::DaemonContext;

/// Longer than the renderer's own 30 s bound on a helper clear.
pub const CLEAR_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_PENDING: usize = 8;

/// `website.clearOnRestart` for this daemon start. Only a successful clear
/// completes it: any failure returns to `Idle` so the next
/// `renderer.ready` (a reconnect, or the helper appearing later) retries.
/// Event-driven retries only; there is no loop and nothing to go busy.
#[derive(Debug, Default, PartialEq, Eq)]
enum StartupClear {
    #[default]
    Idle,
    /// A startup clear is running; further `renderer.ready` events wait.
    InFlight,
    /// A startup clear succeeded; never clear again for this process.
    Done,
}

impl StartupClear {
    /// Claim the single startup-clear slot. `false` means one already runs
    /// or one already succeeded: no duplicate simultaneous clears.
    fn begin(&mut self) -> bool {
        if *self == StartupClear::Idle {
            *self = StartupClear::InFlight;
            true
        } else {
            false
        }
    }

    /// Record the outcome. Only success completes the startup clear; a
    /// disconnect, a timeout, or a helper failure leaves it idle to retry.
    fn finish(&mut self, ok: bool) {
        *self = if ok { StartupClear::Done } else { StartupClear::Idle };
    }
}

/// Renderer commands waiting for a result.
#[derive(Debug, Default)]
pub struct Waiters {
    pending: Mutex<HashMap<uuid::Uuid, oneshot::Sender<RendererCommandResult>>>,
    startup_clear: Mutex<StartupClear>,
}

impl Waiters {
    fn register(&self, id: uuid::Uuid) -> Option<oneshot::Receiver<RendererCommandResult>> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.retain(|_, sender| !sender.is_closed());
        if pending.len() >= MAX_PENDING {
            return None;
        }
        pending.insert(id, tx);
        Some(rx)
    }

    /// The renderer's answer. An answer nobody asked for is ignored.
    pub fn complete(&self, result: RendererCommandResult) {
        if let Some(sender) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&result.command_id) {
            let _ = sender.send(result);
        }
    }

    /// The renderer went away: nothing it was asked will be answered.
    pub fn renderer_disconnected(&self) {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

/// Clears the helper's website data through the renderer.
pub async fn clear_website_data(context: &DaemonContext) -> CommandResult {
    let id = uuid::Uuid::new_v4();
    let Some(answer) = context.renderer_commands.register(id) else {
        return CommandResult::failed("remote_web_busy", "Too many website data requests are pending.");
    };
    if !context.presentation.lock().await.renderer_command_with_id(id, RendererCommandKind::ClearWebsiteData) {
        return CommandResult::failed("renderer_not_connected", "No display renderer is connected.");
    }
    match tokio::time::timeout(CLEAR_TIMEOUT, answer).await {
        Ok(Ok(result)) if result.success => CommandResult::ok("website_data_cleared", ""),
        Ok(Ok(result)) => CommandResult::failed(
            result.code.as_str(),
            match result.code.as_str() {
                "remote_web_unavailable" => "The remote web renderer is not running.",
                "remote_web_helper_restarted" => "The remote web renderer restarted before it finished.",
                _ => "Website data could not be cleared.",
            },
        ),
        Ok(Err(_)) => CommandResult::failed("renderer_disconnected", "The display renderer disconnected."),
        Err(_) => CommandResult::failed("renderer_timeout", "The display renderer did not answer in time."),
    }
}

/// Whether this `renderer.ready` should start the startup clear.
fn should_clear_at_start(status: Option<&RemoteWebStatus>, clear_on_restart: bool, state: &mut StartupClear) -> bool {
    status.is_some_and(|status| status.available) && clear_on_restart && state.begin()
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
    let clear_on_restart = crate::config_sync::effective(context).website.clear_on_restart;
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

    #[test]
    fn a_result_nobody_waits_for_is_ignored_and_pending_is_bounded() {
        let waiters = Waiters::default();
        let mut answers = Vec::new();
        for _ in 0..MAX_PENDING {
            answers.push(waiters.register(uuid::Uuid::new_v4()).expect("slot"));
        }
        assert!(waiters.register(uuid::Uuid::new_v4()).is_none());
        waiters.complete(RendererCommandResult {
            command_id: uuid::Uuid::new_v4(),
            success: true,
            code: ShortToken::new("website_data_cleared").expect("token"),
        });
        waiters.renderer_disconnected();
        for mut answer in answers {
            assert!(answer.try_recv().is_err());
        }
    }
}
