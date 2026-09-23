//! Activates prepared manifests from the local cache.
//!
//! Preparation (`manifest_sync`) stores a manifest as pending only after every
//! object it needs is verified and only while it is the target: the server's
//! latest valid manifest answer. This task decides what the renderer shows:
//!
//! * the committed (active) presentation, re-resolved at every schedule and
//!   availability boundary at the corrected clock, with or without a server;
//! * a pending presentation, activated at an item boundary, after its bounded
//!   grace period, immediately for a takeover or Quick Present, or when
//!   nothing is playing;
//! * promotion of that pending presentation to active only after the current
//!   renderer accepted exactly its activation and reported meaningful content
//!   evidence for it, and only while it is still the target.
//!
//! A pending manifest superseded by a newer target is discarded and never
//! promoted; if it was being tried on screen, the committed presentation
//! returns until the newer one is ready. Pins follow the same rule: only the
//! active, pending and on-screen manifests keep theirs.

use std::sync::Arc;
use std::time::Duration;

use edge_protocol::Sha256Digest;
use edge_protocol::ipc::presentation::PresentationDocument;
use edge_state::repo::binding::{self, CredentialState};
use edge_state::repo::cas::PinReason;
use edge_state::repo::manifests::{self, Binding, Stage, StoredManifest};
use edge_state::repo::playback;

use crate::daemon::DaemonContext;
use crate::manifest::{self, Candidate, ResolvedPresentation};
use crate::presentation::{ActivationSource, PlaybackIdentity, ServerExtras};
use crate::schedule::Source;

const MAX_SLEEP: Duration = Duration::from_secs(30);
const IDLE_SLEEP: Duration = Duration::from_secs(60);

pub fn should_activate_pending(
    current_is_playing: bool,
    takeover: bool,
    item_boundary: bool,
    now_ms: i64,
    grace_at_ms: i64,
) -> bool {
    !current_is_playing || takeover || item_boundary || now_ms >= grace_at_ms
}

#[derive(Debug, Default)]
struct ActivationLoop {
    binding: Option<Binding>,
    invalid_pending: Option<Sha256Digest>,
}

pub async fn run(context: Arc<DaemonContext>) {
    // The development fixture is an explicit local presentation source.
    if context.config.dev.fixture.is_some() {
        return;
    }
    let mut state = ActivationLoop::default();
    loop {
        let boundary = context.manifest_item_boundary.swap(false, std::sync::atomic::Ordering::Relaxed);
        let next_at = tick(&context, &mut state, boundary).await;
        let now_ms = context.now().unix_millis();
        let delay = next_at
            .map(|at| Duration::from_millis(at.saturating_sub(now_ms).max(50) as u64).min(MAX_SLEEP))
            .unwrap_or(IDLE_SLEEP);
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            _ = context.manifest_wake.notified() => {},
            () = tokio::time::sleep(delay) => {},
        }
    }
}

fn identity(candidate: &Candidate, resolved: &ResolvedPresentation) -> PlaybackIdentity {
    let selection = &resolved.selection;
    PlaybackIdentity {
        manifest: candidate.digest,
        manifest_version: candidate.version,
        selection_source: match selection.source {
            Source::Takeover => "takeover",
            Source::QuickPresent => "quick_present",
            Source::Schedule => "schedule",
            Source::Direct => "direct",
            Source::None => "none",
        },
        playlist_id: selection.playlist_id,
        layout_id: selection.layout_id,
        schedule_id: selection.schedule_id,
        takeover_id: selection.takeover_id,
        next_transition_ms: resolved.next_transition_ms,
    }
}

fn extras(resolved: &ResolvedPresentation) -> ServerExtras {
    ServerExtras {
        projection: resolved.projection.clone(),
        plugins: resolved.plugins.clone(),
        plugin_aliases: resolved.plugin_aliases.clone(),
    }
}

struct Current {
    source: ActivationSource,
    manifest: Option<Sha256Digest>,
    identity: Option<PlaybackIdentity>,
    document: PresentationDocument,
    content: Vec<edge_protocol::ipc::presentation::ContentRef>,
    accepted: bool,
    evidence: bool,
}

async fn current(context: &DaemonContext) -> Option<Current> {
    let engine = context.presentation.lock().await;
    engine.current().map(|activation| Current {
        source: activation.source,
        manifest: activation.manifest(),
        identity: activation.identity.clone(),
        document: activation.document.clone(),
        content: activation.content.clone(),
        accepted: engine.current_is_accepted(),
        evidence: engine.current_has_activation_evidence(),
    })
}

async fn tick(context: &DaemonContext, state: &mut ActivationLoop, item_boundary: bool) -> Option<i64> {
    let db = context.db()?;
    let bound = db.run(|connection| binding::get(connection)).await.ok().flatten()?;
    if bound.credential_state != CredentialState::Stored {
        state.binding = None;
        return None;
    }
    let screen_id = bound.screen_id?;
    let binding = Binding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url };
    if state.binding.as_ref() != Some(&binding) {
        state.binding = Some(binding.clone());
        state.invalid_pending = None;
    }
    let read = |stage: Stage| {
        let binding = binding.clone();
        async move { db.run(move |c| manifests::get_for(c, stage, &binding)).await }
    };
    let (Ok(active), Ok(mut pending)) = (read(Stage::Active).await, read(Stage::Pending).await) else {
        return None;
    };
    let target_binding = binding.clone();
    let target = db.run(move |c| manifests::target(c, &target_binding)).await.ok().flatten().map(|t| t.digest);

    let local_now_ms = context.now().unix_millis();
    let offset_ms = db
        .run(|connection| playback::get(connection))
        .await
        .ok()
        .and_then(|state| state.server_clock_offset_ms)
        .unwrap_or_default();
    context.presentation.lock().await.set_clock_offset(offset_ms);
    let presentation_now_ms = local_now_ms.saturating_add(offset_ms);
    let current = current(context).await;

    // A pending manifest that is no longer the target can never be promoted.
    if let Some(stale) = pending.as_ref().filter(|p| target != Some(p.digest)) {
        let (discard_binding, digest) = (binding.clone(), stale.digest);
        if db.run(move |c| manifests::discard_pending(c, &discard_binding, &digest)).await.is_ok() {
            tracing::info!(component = "activation", event = "pending_superseded", manifest = %digest.short());
        }
        pending = None;
    }
    sweep_pins(context, &active, &pending, current.as_ref().and_then(|c| c.manifest)).await;

    if let Some(stored) = pending.as_ref() {
        let candidate = match Candidate::parse(stored.document.clone(), screen_id, stored.digest) {
            Ok(candidate) => candidate,
            Err(error) => {
                if state.invalid_pending != Some(stored.digest) {
                    tracing::warn!(component = "activation", event = "pending_invalid", reason = error.reason_code());
                    state.invalid_pending = Some(stored.digest);
                }
                return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
            }
        };
        let trial = current.as_ref().is_some_and(|c| c.manifest == Some(stored.digest));
        if trial {
            let current = current.as_ref()?;
            if current.accepted && current.evidence {
                if promote(context, &binding, stored, &candidate).await {
                    return Some(local_now_ms.saturating_add(50));
                }
                return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
            }
            // The trial follows schedule boundaries like any presentation.
            return show(context, &candidate, current, presentation_now_ms, local_now_ms, offset_ms).await;
        }
        let resolved = match candidate.presentation(presentation_now_ms) {
            Ok(resolved) => resolved,
            Err(error) => {
                if state.invalid_pending != Some(stored.digest) {
                    tracing::warn!(
                        component = "activation",
                        event = "pending_selection_failed",
                        reason = error.reason_code()
                    );
                    state.invalid_pending = Some(stored.digest);
                }
                return None;
            }
        };
        let takeover = matches!(resolved.selection.source, Source::Takeover | Source::QuickPresent);
        let current_is_playing = current.as_ref().is_some_and(|c| {
            c.source == ActivationSource::ServerManifest
                && matches!(&c.document, PresentationDocument::Playing { items, .. } if !items.is_empty())
        });
        let grace_at = stored.stored_at.unix_millis().saturating_add(manifest::activation_grace_ms(&stored.document));
        if should_activate_pending(current_is_playing, takeover, item_boundary, local_now_ms, grace_at) {
            if manifest::verify_cached(context, &candidate).await.is_err() {
                return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
            }
            let identity = identity(&candidate, &resolved);
            let extras = extras(&resolved);
            let result = context.presentation.lock().await.activate_server_presentation(
                identity,
                resolved.document,
                resolved.content,
                extras,
                local_now_ms,
            );
            match result {
                Ok(reference) => tracing::info!(
                    component = "activation",
                    event = "activation_started",
                    manifest = %stored.digest.short(),
                    version = stored.version,
                    generation = reference.generation,
                    boundary = item_boundary,
                    grace_expired = local_now_ms >= grace_at,
                    takeover
                ),
                Err(error) => {
                    tracing::warn!(component = "activation", event = "activation_rejected", error = %error);
                    return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
                }
            }
            return Some(local_now_ms.saturating_add(250));
        }
        return Some(grace_at);
    }

    let Some(stored) = active.as_ref() else {
        // Nothing committed yet. An uncommitted trial whose pending state was
        // superseded leaves the screen for the waiting surface.
        if current.as_ref().is_some_and(|c| c.source == ActivationSource::ServerManifest) {
            let surface = crate::daemon::status_surface_for(context, true);
            let _ = context.presentation.lock().await.activate(
                surface,
                Vec::new(),
                None,
                ActivationSource::StatusSurface,
                local_now_ms,
            );
        }
        return None;
    };
    let candidate = match Candidate::parse(stored.document.clone(), screen_id, stored.digest) {
        Ok(candidate) => candidate,
        Err(error) => {
            tracing::warn!(component = "activation", event = "active_invalid", reason = error.reason_code());
            return None;
        }
    };
    if manifest::verify_cached(context, &candidate).await.is_err() {
        tracing::warn!(component = "activation", event = "active_cache_unavailable", manifest = %stored.digest.short());
        return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
    }
    let current = current.unwrap_or(Current {
        source: ActivationSource::StatusSurface,
        manifest: None,
        identity: None,
        document: PresentationDocument::Setup {},
        content: Vec::new(),
        accepted: false,
        evidence: false,
    });
    show(context, &candidate, &current, presentation_now_ms, local_now_ms, offset_ms).await
}

/// Shows `candidate` resolved at `presentation_now_ms`, re-activating only
/// when what should be on screen differs from what is.
async fn show(
    context: &DaemonContext,
    candidate: &Candidate,
    current: &Current,
    presentation_now_ms: i64,
    local_now_ms: i64,
    offset_ms: i64,
) -> Option<i64> {
    let resolved = match candidate.presentation(presentation_now_ms) {
        Ok(resolved) => resolved,
        Err(error) => {
            tracing::warn!(component = "activation", event = "selection_failed", reason = error.reason_code());
            return None;
        }
    };
    let identity = identity(candidate, &resolved);
    let matches = current.source == ActivationSource::ServerManifest
        && current.manifest == Some(candidate.digest)
        && current.document == resolved.document
        && current.content == resolved.content
        && current.identity.as_ref().map(|i| (i.playlist_id, i.layout_id, i.schedule_id, i.takeover_id))
            == Some((identity.playlist_id, identity.layout_id, identity.schedule_id, identity.takeover_id));
    if !matches {
        if pin(context, PinReason::ActivePresentation, candidate).await.is_err() {
            return resolved.next_transition_ms.map(|at| at.saturating_sub(offset_ms));
        }
        let extras = extras(&resolved);
        let next = resolved.next_transition_ms;
        if let Err(error) = context.presentation.lock().await.activate_server_presentation(
            identity,
            resolved.document,
            resolved.content,
            extras,
            local_now_ms,
        ) {
            tracing::warn!(component = "activation", event = "activation_rejected", error = %error);
        }
        return next.map(|at| at.saturating_sub(offset_ms));
    }
    resolved.next_transition_ms.map(|at| at.saturating_sub(offset_ms))
}

async fn pin(context: &DaemonContext, reason: PinReason, candidate: &Candidate) -> anyhow::Result<()> {
    let digests = manifest::verify_cached(context, candidate).await?;
    let cas = context.cas.as_ref().ok_or_else(|| anyhow::anyhow!("CAS is unavailable"))?;
    cas.replace_pins(reason, &manifest::pin_holder(&candidate.digest), digests).await?;
    Ok(())
}

/// Releases presentation pins nobody needs any more. The active, pending and
/// on-screen manifests keep theirs; everything else (a superseded
/// preparation, the previous active presentation once replaced, a withdrawn
/// trial) drains.
async fn sweep_pins(
    context: &DaemonContext,
    active: &Option<StoredManifest>,
    pending: &Option<StoredManifest>,
    on_screen: Option<Sha256Digest>,
) {
    let Some(db) = context.db() else { return };
    let keep: Vec<String> = active
        .iter()
        .chain(pending.iter())
        .map(|stored| stored.digest)
        .chain(on_screen)
        .map(|digest| manifest::pin_holder(&digest))
        .collect();
    let result = db
        .run(move |c| {
            let mut released = 0;
            for reason in [PinReason::ActivePresentation, PinReason::PendingPresentation] {
                released += edge_state::repo::cas::retain_holders(c, reason, manifest::PIN_PREFIX, &keep)?;
            }
            Ok(released)
        })
        .await;
    if let Ok(released) = result
        && released > 0
    {
        tracing::info!(component = "activation", event = "pins_drained", released);
    }
}

async fn promote(context: &DaemonContext, binding: &Binding, pending: &StoredManifest, candidate: &Candidate) -> bool {
    let Some(db) = context.db() else { return false };
    if pin(context, PinReason::ActivePresentation, candidate).await.is_err() {
        return false;
    }
    let promote_binding = binding.clone();
    let digest = candidate.digest;
    let Ok(promoted) =
        db.run(move |connection| manifests::promote_pending(connection, &promote_binding, &digest)).await
    else {
        return false;
    };
    if !promoted {
        return false;
    }
    // The new presentation is committed only now, after renderer acceptance
    // and meaningful evidence. Its pending pins, the previous presentation's
    // pins and the one-time migration pins can drain.
    let holder = manifest::pin_holder(&digest);
    if let Some(cas) = context.cas.as_ref() {
        let pending_cleared = cas.replace_pins(PinReason::PendingPresentation, &holder, Vec::new()).await;
        let migration_cleared = cas.replace_pins(PinReason::Migration, "legacy-import", Vec::new()).await;
        if pending_cleared.is_err() || migration_cleared.is_err() {
            tracing::warn!(component = "activation", event = "old_pin_drain_incomplete", manifest = %digest.short());
        }
    }
    let active = Some(pending.clone());
    sweep_pins(context, &active, &None, Some(digest)).await;
    tracing::info!(
        component = "activation",
        event = "activated",
        manifest = %digest.short(),
        manifest_version = pending.version
    );
    context.manifest_wake.notify_one();
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_activation_waits_for_a_boundary_unless_grace_or_takeover_applies() {
        assert!(!should_activate_pending(true, false, false, 999, 1_000));
        assert!(should_activate_pending(true, false, true, 999, 1_000));
        assert!(should_activate_pending(true, false, false, 1_000, 1_000));
        assert!(should_activate_pending(true, true, false, 999, 1_000));
        assert!(should_activate_pending(false, false, false, 999, 1_000));
    }
}
