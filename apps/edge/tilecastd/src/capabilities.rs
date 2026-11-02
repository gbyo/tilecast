//! Daemon-owned capabilities and the refresh cycle.
//!
//! Platform providers probe the machine; this module adds capabilities that
//! only the daemon knows from live state (is a renderer connected and
//! ready, is the state store healthy) and persists the combined snapshot,
//! whose revision moves only on material change.

use std::sync::atomic::Ordering;

use edge_protocol::bounded::{DetailText, ShortToken};
use edge_protocol::capability::{Capability, CapabilityId, CapabilityState, ids};
use edge_protocol::ipc::event::RendererPlatform;

use crate::daemon::{DaemonContext, StateMode};

fn live(
    id: &str,
    state: CapabilityState,
    provider: &str,
    reason: Option<&str>,
    detail: Option<&str>,
    context: &DaemonContext,
) -> Option<Capability> {
    let mut capability = Capability::new(CapabilityId::new(id).ok()?, state, context.now());
    capability.provider = ShortToken::new(provider).ok();
    capability.reason_code = reason.and_then(|r| ShortToken::new(r).ok());
    capability.detail = detail.map(DetailText::lossy);
    Some(capability)
}

async fn daemon_capabilities(context: &DaemonContext) -> Vec<Capability> {
    let mut out = Vec::new();
    let renderer = context.presentation.lock().await;
    let status = renderer.status();
    let (state, reason, detail) = match status.state.as_str() {
        "healthy" | "waiting_for_progress" => (CapabilityState::Available, None, None),
        "incompatible" => (
            CapabilityState::Degraded,
            Some("presentation_incompatible"),
            status.incompatible_reason.as_ref().map(|r| r.as_str().to_owned()),
        ),
        "safe_mode" => (CapabilityState::Degraded, Some("safe_mode"), None),
        "starting" => (CapabilityState::Supported, Some("renderer_starting"), None),
        _ => (
            CapabilityState::Supported,
            Some("renderer_not_connected"),
            Some("The WPE renderer is not connected to tilecastd.".to_owned()),
        ),
    };
    let mut wpe = live(ids::RENDERER_WPE, state, "tilecast-renderer-wpe", reason, detail.as_deref(), context);
    if let (Some(capability), Some(version)) = (wpe.as_mut(), renderer.renderer_version()) {
        capability.provider_version = Some(version);
    }
    out.extend(wpe);
    let (remote_web, connected, restarting) = renderer.remote_web();
    out.extend(crate::remote_web::capability(remote_web.as_ref(), connected, restarting, context.now()));
    drop(renderer);

    let (state, reason) = match &context.state {
        StateMode::Normal(_) => (CapabilityState::Available, None),
        StateMode::Recovery { reason } => (CapabilityState::Blocked, Some(*reason)),
    };
    out.extend(live(ids::SYSTEM_STATE_STORE, state, "sqlite", reason, None, context));
    out.extend(crate::preview::capability(
        &context.preview_health.lock().unwrap_or_else(|e| e.into_inner()),
        context.now(),
    ));
    out.extend(context.display.capabilities(context.now()));
    let idle = *context.idle_lock.lock().unwrap_or_else(|poison| poison.into_inner());
    out.extend(crate::idle_inhibit::capability(idle, context.now()));
    let (helper, network) = context.network.status();
    out.extend(crate::presentation_network::capability(helper.as_ref(), &network, context.now()));
    out
}

/// Applies what the connected renderer reports about its own platform.
///
/// The daemon cannot open the display devices: its sandbox excludes them on
/// purpose. A renderer that initialized a backend has proved that backend
/// works, so the daemon records it as available and never contradicts the
/// renderer with its own weaker probe.
fn apply_renderer_platform(
    capabilities: &mut [Capability],
    platform: Option<RendererPlatform>,
    now: edge_protocol::Timestamp,
) {
    let id = match platform {
        Some(RendererPlatform::Drm) => ids::RENDERER_WPE_DRM,
        Some(RendererPlatform::Wayland) => ids::RENDERER_WPE_WAYLAND,
        Some(RendererPlatform::Headless) | None => return,
    };
    let Some(capability) = capabilities.iter_mut().find(|capability| capability.id.as_str() == id) else {
        return;
    };
    let mut reported = Capability::new(capability.id.clone(), CapabilityState::Available, now);
    reported.provider = ShortToken::new("tilecast-renderer-wpe").ok();
    reported.detail = Some(DetailText::lossy("Reported by the connected renderer."));
    *capability = reported;
}

/// Probes, persists and returns whether the revision changed.
pub async fn refresh(context: &DaemonContext) -> bool {
    let now = context.now();
    let mut capabilities = context.capabilities.lock().await.probe_all(now).await;
    let platform = context.presentation.lock().await.ready_info().map(|ready| ready.renderer.platform);
    apply_renderer_platform(&mut capabilities, platform, now);
    for capability in daemon_capabilities(context).await {
        if !capabilities.iter().any(|c| c.id == capability.id) {
            capabilities.push(capability);
        }
    }
    let Some(db) = context.db() else {
        return false;
    };
    match db.run(move |c| edge_state::repo::capabilities::replace(c, capabilities, now)).await {
        Ok((snapshot, changed)) => {
            context.capability_revision.store(snapshot.revision, Ordering::Relaxed);
            if changed {
                tracing::info!(component = "capabilities", event = "revision_changed", revision = snapshot.revision);
            }
            changed
        }
        Err(error) => {
            tracing::warn!(component = "capabilities", event = "persist_failed", error = %error);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> edge_protocol::Timestamp {
        edge_protocol::Timestamp::from_unix_seconds(1_000).expect("time")
    }

    /// What the daemon's own probe reported on beta.4 for a renderer that was
    /// rendering on DRM.
    fn probed() -> Vec<Capability> {
        let mut drm =
            Capability::new(CapabilityId::new(ids::RENDERER_WPE_DRM).unwrap(), CapabilityState::Blocked, now());
        drm.reason_code = ShortToken::new("drm_permission_denied").ok();
        let wayland =
            Capability::new(CapabilityId::new(ids::RENDERER_WPE_WAYLAND).unwrap(), CapabilityState::Supported, now());
        vec![drm, wayland]
    }

    #[test]
    fn a_renderer_running_on_drm_is_never_blocked_by_the_daemons_probe() {
        let mut capabilities = probed();
        apply_renderer_platform(&mut capabilities, Some(RendererPlatform::Drm), now());
        let drm = &capabilities[0];
        assert_eq!(drm.state, CapabilityState::Available);
        assert_eq!(drm.reason_code, None);
        assert_eq!(drm.provider.as_ref().map(|p| p.as_str()), Some("tilecast-renderer-wpe"));
        assert_eq!(capabilities[1].state, CapabilityState::Supported, "other backends are untouched");
    }

    #[test]
    fn a_renderer_on_wayland_marks_wayland_only() {
        let mut capabilities = probed();
        apply_renderer_platform(&mut capabilities, Some(RendererPlatform::Wayland), now());
        assert_eq!(capabilities[1].state, CapabilityState::Available);
        assert_eq!(capabilities[0].state, CapabilityState::Blocked);
    }

    #[test]
    fn without_a_renderer_report_the_probe_stands() {
        for platform in [None, Some(RendererPlatform::Headless)] {
            let mut capabilities = probed();
            apply_renderer_platform(&mut capabilities, platform, now());
            assert_eq!(capabilities, probed());
        }
    }
}
