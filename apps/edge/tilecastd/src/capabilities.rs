//! Daemon-owned capabilities and the refresh cycle.
//!
//! Platform providers probe the machine; this module adds capabilities that
//! only the daemon knows from live state (is a renderer connected and
//! ready, is the state store healthy) and persists the combined snapshot,
//! whose revision moves only on material change.

use std::sync::atomic::Ordering;

use edge_protocol::bounded::{DetailText, ShortToken};
use edge_protocol::capability::{Capability, CapabilityId, CapabilityState, ids};

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
    drop(renderer);

    let (state, reason) = match &context.state {
        StateMode::Normal(_) => (CapabilityState::Available, None),
        StateMode::Recovery { reason } => (CapabilityState::Blocked, Some(*reason)),
    };
    out.extend(live(ids::SYSTEM_STATE_STORE, state, "sqlite", reason, None, context));
    let mesh = context.mesh_state.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let (state, detail) = match mesh.state {
        "available" => (CapabilityState::Available, None),
        "disabled" => (CapabilityState::Supported, Some("The Edge mesh is disabled on this node.")),
        "starting" => (CapabilityState::Supported, None),
        _ => (CapabilityState::Blocked, Some("The Edge mesh cannot run on this node right now.")),
    };
    out.extend(live(ids::MESH_ZENOH, state, "zenoh", mesh.reason, detail, context));
    out.extend(live(ids::MESH_PEER_CACHE, state, "edge-cdn", mesh.reason, detail, context));
    out
}

/// Probes, persists and returns whether the revision changed.
pub async fn refresh(context: &DaemonContext) -> bool {
    let now = context.now();
    let mut capabilities = context.capabilities.lock().await.probe_all(now).await;
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
