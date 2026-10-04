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

use std::sync::Arc;

use edge_protocol::Sha256Digest;
use edge_server::AuthenticatedServer;
use edge_state::repo::cas::PinReason;
use edge_state::repo::manifests::{self, Binding, Stage, StoredManifest, Target};

use crate::daemon::DaemonContext;
use crate::manifest::{self, Candidate, ManifestError, PreparationError, SourcePlan};

pub use player_core::ManifestSyncError as SyncError;

fn coordinator(context: &DaemonContext) -> Option<player_core::ManifestCoordinator> {
    let db = context.db()?;
    Some(
        player_core::PlayerCore::new(player_core::Dependencies { state: db.clone(), clock: context.clock.clone() })
            .manifests(),
    )
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
    /// outcome, so the player waits for a new target.
    pub fn is_final(&self) -> bool {
        matches!(self, Self::Manifest(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prepared {
    /// Already the active or pending manifest, with its content intact.
    Current,
    /// Already the active or pending manifest, whose lost objects were
    /// downloaded and verified again.
    Repaired,
    /// Stored as pending and pinned.
    Pending,
    /// A newer target superseded this one during preparation.
    Superseded,
}

/// Verifies compatibility and prepares every object the target needs.
/// Nothing becomes pending unless the manifest is still the target at the
/// moment it is stored.
pub async fn prepare_target<P: SourcePlan>(
    context: &DaemonContext,
    plan: &P,
    target: &Target,
) -> Result<Prepared, PrepareError> {
    let db = context.db().ok_or(PrepareError::State)?;
    let store = context.cas.clone().ok_or(PrepareError::Fetch(PreparationError::StoreUnavailable))?;
    let binding = target.binding.clone();
    let candidate = Candidate::prepare_candidate(target.document.clone(), binding.screen_id)?;
    for stage in [Stage::Active, Stage::Pending] {
        let stage_binding = binding.clone();
        let stored =
            db.run(move |c| manifests::get_for(c, stage, &stage_binding)).await.map_err(|_| PrepareError::State)?;
        if stored.is_some_and(|stored| stored.digest == target.digest) {
            if manifest::verify_cached(context, &candidate).await.is_ok() {
                return Ok(Prepared::Current);
            }
            // An object this manifest needs failed its re-check (a damaged
            // file after an unclean stop, say) and was removed. Fetch and
            // verify it again; the stage is unchanged, and activation pins
            // and shows the manifest once it is whole.
            let digests = manifest::prepare(&store, plan, &candidate).await?;
            let reason =
                if stage == Stage::Active { PinReason::ActivePresentation } else { PinReason::PendingPresentation };
            store
                .replace_pins(reason, &manifest::pin_holder(&candidate.digest), digests)
                .await
                .map_err(PreparationError::from)?;
            tracing::info!(component = "manifest", event = "repaired", manifest = %candidate.digest.short());
            context.manifest_wake.notify_one();
            return Ok(Prepared::Repaired);
        }
    }
    let digests = manifest::prepare(&store, plan, &candidate).await?;
    let holder = manifest::pin_holder(&candidate.digest);
    store.replace_pins(PinReason::PendingPresentation, &holder, digests).await.map_err(PreparationError::from)?;
    let stored = StoredManifest {
        binding,
        digest: candidate.digest,
        version: candidate.version,
        document: candidate.document.clone(),
        stored_at: context.now(),
    };
    let accepted =
        db.run(move |c| manifests::put_pending_for_target(c, &stored)).await.map_err(|_| PrepareError::State)?;
    if !accepted {
        let _ = store.replace_pins(PinReason::PendingPresentation, &holder, Vec::new()).await;
        tracing::info!(component = "manifest", event = "preparation_superseded", manifest = %candidate.digest.short());
        return Ok(Prepared::Superseded);
    }
    tracing::info!(
        component = "manifest",
        event = "prepared",
        manifest = %candidate.digest.short(),
        version = candidate.version
    );
    context.manifest_wake.notify_one();
    Ok(Prepared::Pending)
}

/// Shared view of what preparation is doing, for status and heartbeat.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreparationStatus {
    pub target: Option<Sha256Digest>,
    pub state: &'static str,
    pub reason: Option<String>,
}

pub type SharedPreparationStatus = Arc<std::sync::Mutex<PreparationStatus>>;
