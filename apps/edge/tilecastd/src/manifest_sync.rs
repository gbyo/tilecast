//! Manifest reconciliation and preparation (docs/tilecast-edge.md §8.3–8.4).
//!
//! The server is the only authority, reached through the ordinary player
//! manifest endpoint:
//!
//! ```text
//! GET /player/manifest (If-None-Match: target ETag)
//!   →  structure, screen and media-claim validation
//!   →  target (the server's latest valid answer, persisted)
//!   →  renderer compatibility
//!   →  every referenced object through the verified CAS
//!   →  pending, only while it is still the target
//! ```
//!
//! A WebSocket push only makes this run sooner. A malformed answer never
//! becomes the target; a failed or incompatible preparation never replaces
//! the committed presentation. Only one preparation runs at a time, on the
//! target; a newer target aborts an obsolete one, and the pending write
//! re-checks the target, so an obsolete manifest can never become pending.

use edge_server::AuthenticatedServer;
use edge_state::repo::manifests::{Binding, Target};

use crate::daemon::DaemonContext;
use crate::manifest::{Candidate, ManifestError, PreparationError, SourcePlan};

pub use player_core::ManifestSyncError as SyncError;

fn coordinator(context: &DaemonContext) -> Option<player_core::ManifestCoordinator> {
    Some(context.core.as_ref()?.manifests())
}

/// Core records the latest validated manifest as the binding's target.
pub async fn reconcile(
    context: &DaemonContext,
    server: &AuthenticatedServer,
    binding: &Binding,
) -> Result<Option<Target>, SyncError> {
    let core = coordinator(context).ok_or(SyncError::State)?;
    core.reconcile(server, binding).await
}

/// The persisted target, for restarts before the server is reachable.
pub async fn persisted_target(context: &DaemonContext, binding: &Binding) -> Option<Target> {
    coordinator(context)?.persisted_target(binding).await
}

#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    #[error(transparent)]
    Fetch(#[from] PreparationError),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error("local state failed")]
    State,
}

impl PrepareError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Fetch(error) => error.reason_code(),
            Self::Manifest(error) => error.reason_code(),
            Self::State => "state_error",
        }
    }

    /// Deterministic for this exact manifest: retrying cannot change the
    /// outcome, so the player waits for a new target. A missing or
    /// corrupt frame names exact bytes the origin cannot serve, so it
    /// waits too; transport trouble retries.
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            Self::Manifest(_) | Self::Fetch(PreparationError::FrameMissing | PreparationError::FrameDigestInvalid)
        )
    }
}

pub use player_core::ManifestPrepared as Prepared;

/// Edge checks renderer compatibility; Core owns verified preparation and pins.
pub async fn prepare_target<P: SourcePlan>(
    context: &DaemonContext,
    plan: &P,
    target: &Target,
) -> Result<Prepared, PrepareError> {
    let core = coordinator(context).ok_or(PrepareError::State)?;
    let store = context.cas.as_ref().ok_or(PrepareError::Fetch(PreparationError::StoreUnavailable))?;
    let candidate = Candidate::prepare_candidate(target.document.clone(), target.binding.screen_id)?;
    let prepared = core.prepare_target(store, plan, target, &candidate).await.map_err(|error| match error {
        PreparationError::State => PrepareError::State,
        other => PrepareError::Fetch(other),
    })?;
    if matches!(prepared, Prepared::Repaired | Prepared::Pending) {
        context.manifest_wake.notify_one();
    }
    Ok(prepared)
}

pub use player_core::SharedManifestPreparationStatus as SharedPreparationStatus;
