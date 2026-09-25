//! `linuxKiosk.preventDisplaySleep` through a systemd-logind inhibitor lock
//! (M9).
//!
//! While the effective setting is on (the operator's
//! `renderer.prevent_display_sleep` and the server's `preventDisplaySleep`),
//! the daemon holds one `idle` lock from
//! `org.freedesktop.login1.Manager.Inhibit` in `block` mode, and closes its
//! file descriptor when the setting turns off. logind refuses its idle
//! action while the lock is held, and sessions that follow logind's idle
//! hint do the same. There is no `xset`, no input simulation and no timer.
//!
//! Only `idle` is requested: the default polkit policy grants an idle lock
//! to any caller, while a `sleep` lock needs authorization that a system
//! service without a session does not have. A failure blocks only the
//! `system.idle_inhibit` capability, never playback.

use std::sync::Arc;
use std::time::Duration;

use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortToken};
use edge_protocol::capability::{Capability, CapabilityId, CapabilityState, ids};

use crate::daemon::DaemonContext;

const RETRY_INTERVAL: Duration = Duration::from_secs(300);
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

#[zbus::proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Login {
    fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> zbus::Result<zbus::zvariant::OwnedFd>;
}

/// The lock's state, for the capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockState {
    /// The configuration does not ask for it.
    NotRequested,
    Held,
    /// logind is not on the system bus.
    LogindUnavailable,
    /// logind (polkit) refused the lock.
    Denied,
    Failed,
}

/// Why logind did not give the lock.
pub fn classify(error: &zbus::Error) -> LockState {
    match error {
        zbus::Error::MethodError(name, _, _) => match name.as_str() {
            "org.freedesktop.DBus.Error.AccessDenied"
            | "org.freedesktop.DBus.Error.InteractiveAuthorizationRequired" => LockState::Denied,
            "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner" => {
                LockState::LogindUnavailable
            }
            _ => LockState::Failed,
        },
        zbus::Error::InputOutput(_) | zbus::Error::Address(_) => LockState::LogindUnavailable,
        _ => LockState::Failed,
    }
}

pub fn capability(state: LockState, now: Timestamp) -> Option<Capability> {
    let (capability_state, reason, detail) = match state {
        LockState::Held => (CapabilityState::Available, None, None),
        LockState::NotRequested => (
            CapabilityState::Supported,
            Some("not_requested"),
            Some("The display may sleep: preventDisplaySleep is off."),
        ),
        LockState::LogindUnavailable => {
            (CapabilityState::Blocked, Some("logind_unavailable"), Some("systemd-logind is not reachable."))
        }
        LockState::Denied => (
            CapabilityState::Blocked,
            Some("inhibit_denied"),
            Some("systemd-logind refused the idle inhibitor lock; check that polkit is installed."),
        ),
        LockState::Failed => (CapabilityState::Degraded, Some("inhibit_failed"), None),
    };
    let mut capability = Capability::new(CapabilityId::new(ids::SYSTEM_IDLE_INHIBIT).ok()?, capability_state, now);
    capability.provider = ShortToken::new("systemd-logind").ok();
    capability.reason_code = reason.and_then(|reason| ShortToken::new(reason).ok());
    capability.detail = detail.map(DetailText::lossy);
    Some(capability)
}

async fn take_lock() -> Result<zbus::zvariant::OwnedFd, LockState> {
    let call = async {
        let connection = zbus::Connection::system().await?;
        LoginProxy::new(&connection)
            .await?
            .inhibit("idle", "Tilecast Edge", "Signage display (linuxKiosk.preventDisplaySleep)", "block")
            .await
    };
    match tokio::time::timeout(CALL_TIMEOUT, call).await {
        Ok(Ok(fd)) => Ok(fd),
        Ok(Err(error)) => Err(classify(&error)),
        Err(_) => Err(LockState::LogindUnavailable),
    }
}

/// Whether the configuration in force asks the display to stay awake.
fn wanted(context: &DaemonContext) -> bool {
    context.config.dev.idle_inhibit != Some(false)
        && context.config.renderer.prevent_display_sleep
        && crate::config_sync::effective(context).linux_kiosk.prevent_display_sleep
}

pub async fn run(context: Arc<DaemonContext>) {
    let mut lock: Option<zbus::zvariant::OwnedFd> = None;
    loop {
        let previous = *context.idle_lock.lock().unwrap_or_else(|poison| poison.into_inner());
        let state = match (wanted(&context), lock.is_some()) {
            (false, _) => {
                if lock.take().is_some() {
                    tracing::info!(component = "idle", event = "inhibitor_released");
                }
                LockState::NotRequested
            }
            (true, true) => LockState::Held,
            (true, false) => match take_lock().await {
                Ok(fd) => {
                    tracing::info!(component = "idle", event = "inhibitor_taken");
                    lock = Some(fd);
                    LockState::Held
                }
                Err(state) => {
                    if state != previous {
                        tracing::warn!(component = "idle", event = "inhibitor_unavailable", state = ?state);
                    }
                    state
                }
            },
        };
        *context.idle_lock.lock().unwrap_or_else(|poison| poison.into_inner()) = state;
        if state != previous {
            crate::capabilities::refresh(&context).await;
        }
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = context.idle_wake.notified() => {}
            () = tokio::time::sleep(RETRY_INTERVAL) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logind_answers_become_typed_reasons() {
        let denied = zbus::Error::MethodError(
            zbus::names::OwnedErrorName::try_from("org.freedesktop.DBus.Error.AccessDenied").unwrap(),
            None,
            zbus::message::Message::method_call("/", "Ping").unwrap().build(&()).unwrap(),
        );
        assert_eq!(classify(&denied), LockState::Denied);
        let now = Timestamp::parse("2026-09-25T12:00:00Z").unwrap();
        for (state, expected, reason) in [
            (LockState::Held, CapabilityState::Available, None),
            (LockState::NotRequested, CapabilityState::Supported, Some("not_requested")),
            (LockState::LogindUnavailable, CapabilityState::Blocked, Some("logind_unavailable")),
            (LockState::Denied, CapabilityState::Blocked, Some("inhibit_denied")),
            (LockState::Failed, CapabilityState::Degraded, Some("inhibit_failed")),
        ] {
            let capability = capability(state, now).unwrap();
            assert_eq!(capability.state, expected);
            assert_eq!(capability.reason_code.as_ref().map(|r| r.as_str()), reason);
        }
    }
}
