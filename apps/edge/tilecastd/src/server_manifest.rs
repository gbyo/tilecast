//! Activates the server-compiled manifest from the local cache.
//!
//! Download and validation happen in `server_link`; this task handles offline
//! startup, playlist/schedule reevaluation, item-boundary activation, and the
//! renderer-evidence-gated pending-to-active transition.

use std::sync::Arc;
use std::time::Duration;

use edge_protocol::ipc::presentation::PresentationDocument;
use edge_state::repo::binding::{self, CredentialState};
use edge_state::repo::cas::PinReason;
use edge_state::repo::manifests::{self, Binding, Stage, StoredManifest};
use edge_state::repo::playback;

use crate::daemon::DaemonContext;
use crate::manifest::{self, Candidate};
use crate::presentation::ActivationSource;
use crate::schedule::Source;

const MAX_SLEEP: Duration = Duration::from_secs(30);
const IDLE_SLEEP: Duration = Duration::from_secs(60);
const MANIFEST_PIN_PREFIX: &str = "server-manifest-v";

fn should_activate_pending(
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
    pinned_active_version: Option<i64>,
    pinned_pending_version: Option<i64>,
    pending_error_version: Option<i64>,
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

async fn tick(context: &DaemonContext, state: &mut ActivationLoop, item_boundary: bool) -> Option<i64> {
    let db = context.db()?;
    let bound = db.run(|connection| binding::get(connection)).await.ok().flatten()?;
    if bound.credential_state != CredentialState::Stored {
        state.binding = None;
        state.pinned_active_version = None;
        state.pinned_pending_version = None;
        return None;
    }
    let screen_id = bound.screen_id?;
    let binding = Binding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url };
    if state.binding.as_ref() != Some(&binding) {
        state.binding = Some(binding.clone());
        state.pinned_active_version = None;
        state.pinned_pending_version = None;
        state.pending_error_version = None;
    }

    let active_binding = binding.clone();
    let Ok(active) = db.run(move |connection| manifests::get_for(connection, Stage::Active, &active_binding)).await
    else {
        return None;
    };
    let pending_binding = binding.clone();
    let Ok(pending) = db.run(move |connection| manifests::get_for(connection, Stage::Pending, &pending_binding)).await
    else {
        return None;
    };

    let local_now_ms = context.now().unix_millis();
    let offset_ms = db
        .run(|connection| playback::get(connection))
        .await
        .ok()
        .and_then(|state| state.server_clock_offset_ms)
        .unwrap_or_default();
    let presentation_now_ms = local_now_ms.saturating_add(offset_ms);

    let active_candidate = active.as_ref().and_then(|stored| match Candidate::parse(stored.document.clone(), screen_id) {
        Ok(candidate) => Some(candidate),
        Err(error) => {
            tracing::warn!(component = "manifest", event = "active_invalid", version = stored.version, error = %error);
            None
        }
    });
    let pending_candidate = pending.as_ref().and_then(|stored| match Candidate::parse(stored.document.clone(), screen_id) {
        Ok(candidate) => Some(candidate),
        Err(error) => {
            if state.pending_error_version != Some(stored.version) {
                tracing::warn!(component = "manifest", event = "pending_invalid", version = stored.version, error = %error);
                state.pending_error_version = Some(stored.version);
            }
            None
        }
    });

    if let Some(candidate) = active_candidate.as_ref()
        && state.pinned_active_version != Some(candidate.version)
        && manifest::verify_cached(context, candidate).await.is_ok()
        && pin_candidate(context, PinReason::ActivePresentation, candidate).await.is_ok()
    {
        state.pinned_active_version = Some(candidate.version);
    }
    if let Some(candidate) = pending_candidate.as_ref()
        && state.pinned_pending_version != Some(candidate.version)
    {
        match manifest::verify_cached(context, candidate).await {
            Ok(_) => {
                if pin_candidate(context, PinReason::PendingPresentation, candidate).await.is_ok() {
                    state.pinned_pending_version = Some(candidate.version);
                    state.pending_error_version = None;
                }
            }
            Err(error) => {
                if state.pending_error_version != Some(candidate.version) {
                    tracing::warn!(component = "manifest", event = "pending_cache_unavailable", version = candidate.version, error = %error);
                    state.pending_error_version = Some(candidate.version);
                }
            }
        }
    }

    let current = {
        let engine = context.presentation.lock().await;
        engine.current().map(|activation| {
            (
                activation.source,
                activation.manifest_version,
                activation.document.clone(),
                activation.content.clone(),
                engine.current_is_accepted(),
                engine.current_has_activation_evidence(),
            )
        })
    };

    if let (Some(stored), Some(candidate)) = (pending.as_ref(), pending_candidate.as_ref())
        && state.pinned_pending_version == Some(candidate.version)
    {
        let is_current = current.as_ref().is_some_and(|(source, version, ..)| {
            *source == ActivationSource::ServerManifest && *version == Some(candidate.version)
        });
        if is_current {
            let confirmed = current.as_ref().is_some_and(|(_, _, _, _, accepted, meaningful)| *accepted && *meaningful);
            if confirmed {
                if promote(context, &binding, stored, candidate).await {
                    state.pinned_active_version = Some(candidate.version);
                    state.pinned_pending_version = None;
                    state.pending_error_version = None;
                    return Some(local_now_ms.saturating_add(50));
                }
                return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
            }
        } else {
            let resolved = match candidate.presentation(presentation_now_ms) {
                Ok(resolved) => resolved,
                Err(error) => {
                    if state.pending_error_version != Some(candidate.version) {
                        tracing::warn!(component = "manifest", event = "pending_selection_failed", version = candidate.version, error = %error);
                        state.pending_error_version = Some(candidate.version);
                    }
                    return None;
                }
            };
            let takeover = matches!(resolved.selection.source, Source::Takeover | Source::QuickPresent);
            let current_is_playing = current.as_ref().is_some_and(|(source, _, document, ..)| {
                *source == ActivationSource::ServerManifest
                    && matches!(document, PresentationDocument::Playing { items, .. } if !items.is_empty())
            });
            let grace_at =
                stored.stored_at.unix_millis().saturating_add(manifest::activation_grace_ms(&stored.document));
            if should_activate_pending(current_is_playing, takeover, item_boundary, local_now_ms, grace_at) {
                if manifest::verify_cached(context, candidate).await.is_err() {
                    return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
                }
                if pin_candidate(context, PinReason::ActivePresentation, candidate).await.is_err() {
                    return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
                }
                let result = context.presentation.lock().await.activate_server_manifest(
                    candidate.version,
                    resolved.document,
                    resolved.content,
                    local_now_ms,
                );
                match result {
                    Ok(reference) => tracing::info!(
                        component = "manifest",
                        event = "activation_started",
                        version = candidate.version,
                        generation = reference.generation,
                        boundary = item_boundary,
                        grace_expired = local_now_ms >= grace_at,
                        takeover
                    ),
                    Err(error) => {
                        tracing::warn!(component = "manifest", event = "activation_rejected", version = candidate.version, error = %error);
                        return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
                    }
                }
            }
            return Some(grace_at);
        }
    }

    // A pending activation takes precedence while the renderer tests it. Keep
    // the prior active document live if preparation or renderer evidence fails.
    let pending_is_current = pending.as_ref().is_some_and(|stored| {
        current.as_ref().is_some_and(|(source, version, ..)| {
            *source == ActivationSource::ServerManifest && *version == Some(stored.version)
        })
    });
    if pending_is_current {
        return Some(local_now_ms.saturating_add(MAX_SLEEP.as_millis() as i64));
    }

    let active_version = active.as_ref().map(|stored| stored.version);
    let current_is_uncommitted_server_manifest = current
        .as_ref()
        .is_some_and(|(source, version, ..)| *source == ActivationSource::ServerManifest && *version != active_version);
    if current_is_uncommitted_server_manifest && let Some(stored) = pending.as_ref() {
        return Some(stored.stored_at.unix_millis().saturating_add(manifest::activation_grace_ms(&stored.document)));
    }

    let (stored, candidate) = active.as_ref().zip(active_candidate.as_ref())?;
    let Ok(_) = manifest::verify_cached(context, candidate).await else { return None };
    let resolved = match candidate.presentation(presentation_now_ms) {
        Ok(resolved) => resolved,
        Err(error) => {
            tracing::warn!(component = "manifest", event = "active_selection_failed", version = candidate.version, error = %error);
            return None;
        }
    };
    let current_matches = current.as_ref().is_some_and(|(source, version, document, content, ..)| {
        *source == ActivationSource::ServerManifest
            && *version == Some(candidate.version)
            && *document == resolved.document
            && *content == resolved.content
    });
    if !current_matches {
        if pin_candidate(context, PinReason::ActivePresentation, candidate).await.is_err() {
            return resolved.next_transition_ms.map(|at| at.saturating_sub(offset_ms));
        }
        if let Err(error) = context.presentation.lock().await.activate_server_manifest(
            candidate.version,
            resolved.document,
            resolved.content,
            local_now_ms,
        ) {
            tracing::warn!(component = "manifest", event = "active_activation_rejected", version = candidate.version, error = %error);
        }
    }
    let _ = stored;
    resolved.next_transition_ms.map(|at| at.saturating_sub(offset_ms))
}

async fn pin_candidate(context: &DaemonContext, reason: PinReason, candidate: &Candidate) -> anyhow::Result<()> {
    let digests = manifest::verify_cached(context, candidate).await?;
    let cas = context.cas.as_ref().ok_or_else(|| anyhow::anyhow!("CAS is unavailable"))?;
    cas.replace_pins(reason, &manifest::pin_holder(candidate.version), digests).await?;
    Ok(())
}

async fn promote(context: &DaemonContext, binding: &Binding, pending: &StoredManifest, candidate: &Candidate) -> bool {
    let Some(db) = context.db() else { return false };
    if pin_candidate(context, PinReason::ActivePresentation, candidate).await.is_err() {
        return false;
    }
    let promote_binding = binding.clone();
    let version = candidate.version;
    let Ok(promoted) =
        db.run(move |connection| manifests::promote_pending(connection, &promote_binding, version)).await
    else {
        return false;
    };
    if !promoted {
        return false;
    }

    // The new version is active only after the renderer has accepted it and
    // reported playback evidence. Now the previous and any abandoned trial
    // pins can drain safely.
    let clear_pending = db
        .run(|connection| {
            edge_state::repo::cas::clear_holder_prefix(
                connection,
                PinReason::PendingPresentation,
                MANIFEST_PIN_PREFIX,
                None,
            )
        })
        .await;
    let keep = manifest::pin_holder(candidate.version);
    let clear_active = db
        .run(move |connection| {
            edge_state::repo::cas::clear_holder_prefix(
                connection,
                PinReason::ActivePresentation,
                MANIFEST_PIN_PREFIX,
                Some(&keep),
            )
        })
        .await;
    let cas = context.cas.as_ref();
    let clear_migration = if let Some(cas) = cas {
        cas.replace_pins(PinReason::Migration, "legacy-import", Vec::new()).await.map(|_| ())
    } else {
        Ok(())
    };
    if clear_pending.is_err() || clear_active.is_err() || clear_migration.is_err() {
        tracing::warn!(component = "manifest", event = "old_pin_drain_incomplete", version = candidate.version);
    }
    tracing::info!(
        component = "manifest",
        event = "activated",
        version = candidate.version,
        previous = pending.version
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
