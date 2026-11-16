//! Manifest preparation. Native identity and resource-claim validation is
//! shared ([`player_core::NativeManifest`]); the host adds its renderer
//! compatibility check — which, without a renderer yet, every natively
//! valid manifest passes — and drives Core's verified preparation into the
//! content store.

use player_cas::ContentStore;
use player_client::AuthenticatedServer;
use player_core::{
    ManifestFailureKind, ManifestOriginSources, ManifestPreparationError, ManifestPrepared, NativeManifest,
    NativeManifestError, manifest_digest,
};
use player_state::repo::manifests::Target;
use player_types::ScreenId;
use std::sync::Arc;

use crate::daemon::DaemonContext;

#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    #[error(transparent)]
    Fetch(#[from] ManifestPreparationError),
    #[error("manifest is invalid: {0}")]
    Manifest(&'static str),
    #[error("local state failed")]
    State,
}

impl PrepareError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Fetch(error) => error.reason_code(),
            Self::Manifest(reason) => reason,
            Self::State => "state_error",
        }
    }

    /// Deterministic for this exact manifest: retrying cannot change the
    /// outcome, so the player waits for a new target.
    pub fn is_final(&self) -> bool {
        matches!(self, Self::Manifest(_))
    }
}

/// A natively valid manifest, ready for verified preparation. Stage 3 adds
/// the renderer compatibility check here; until then the host prepares what
/// Core accepts and refuses to activate it.
pub struct Candidate(NativeManifest);

impl std::fmt::Debug for Candidate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Candidate").field("digest", &self.0.digest.short()).finish_non_exhaustive()
    }
}

impl std::ops::Deref for Candidate {
    type Target = NativeManifest;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Candidate {
    pub fn prepare_candidate(document: serde_json::Value, expected_screen: ScreenId) -> Result<Self, PrepareError> {
        let digest = manifest_digest(&document);
        NativeManifest::parse(document, expected_screen, digest)
            .map(Self)
            .map_err(|error: NativeManifestError| PrepareError::Manifest(error.reason_code()))
    }
}

/// Verifies the candidate's cached content without fetching.
pub async fn verify_cached(
    cas: &ContentStore,
    candidate: &Candidate,
) -> Result<Vec<player_types::Sha256Digest>, ManifestPreparationError> {
    candidate.verify_content(cas).await
}

/// Core-owned verified preparation and pins, from the authenticated server.
pub async fn prepare_target(
    context: &DaemonContext,
    server: &AuthenticatedServer,
    target: &Target,
) -> Result<ManifestPrepared, PrepareError> {
    let core = context.core.as_ref().map(player_core::PlayerCore::manifests).ok_or(PrepareError::State)?;
    let store = context.cas.as_ref().ok_or(ManifestPreparationError::StoreUnavailable)?;
    let candidate = Candidate::prepare_candidate(target.document.clone(), target.binding.screen_id)?;
    let plan = ManifestOriginSources { server };
    let prepared = core.prepare_target(store, &plan, target, &candidate).await.map_err(|error| match error {
        ManifestPreparationError::State => PrepareError::State,
        other => PrepareError::Fetch(other),
    })?;
    if matches!(prepared, ManifestPrepared::Repaired | ManifestPrepared::Pending) {
        context.manifest_wake.notify_one();
    }
    Ok(prepared)
}

pub fn worker_failure(error: &PrepareError) -> player_core::ManifestWorkerFailure {
    let kind = match error {
        PrepareError::Manifest(_) => ManifestFailureKind::Invalid,
        error if error.is_final() => ManifestFailureKind::Invalid,
        _ => ManifestFailureKind::Retryable,
    };
    player_core::ManifestWorkerFailure { kind, reason: error.reason_code() }
}

/// The host end of [`player_core::ManifestWorkerHost`].
pub struct PreparationHost {
    context: Arc<DaemonContext>,
    server: AuthenticatedServer,
}

impl std::fmt::Debug for PreparationHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparationHost").finish_non_exhaustive()
    }
}

impl PreparationHost {
    pub fn new(context: Arc<DaemonContext>, server: AuthenticatedServer) -> Self {
        Self { context, server }
    }
}

#[async_trait::async_trait]
impl player_core::ManifestWorkerHost for PreparationHost {
    async fn content_intact(&self, target: &Target) -> bool {
        let candidate = match Candidate::prepare_candidate(target.document.clone(), target.binding.screen_id) {
            Ok(candidate) => candidate,
            // A candidate that cannot even parse cannot replace the
            // committed document with another preparation of itself.
            Err(_) => return true,
        };
        match self.context.cas.as_ref() {
            Some(store) => verify_cached(store, &candidate).await.is_ok(),
            None => false,
        }
    }

    async fn prepare(&self, target: &Target) -> Result<ManifestPrepared, player_core::ManifestWorkerFailure> {
        prepare_target(&self.context, &self.server, target).await.map_err(|error| {
            tracing::warn!(
                component = "manifest",
                event = "preparation_failed",
                manifest = %target.digest.short(),
                reason = error.reason_code(),
                error = %error
            );
            worker_failure(&error)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(screen: &str) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 11,
            "manifestVersion": 7,
            "screenId": screen,
            "mode": "presentation",
            "assets": [],
            "playlists": [],
        })
    }

    #[test]
    fn candidates_bind_to_their_screen() {
        let screen = ScreenId::from_uuid(uuid::Uuid::new_v4());
        let other = ScreenId::from_uuid(uuid::Uuid::new_v4());
        let candidate = Candidate::prepare_candidate(document(&screen.to_string()), screen).expect("parses");
        assert_eq!(candidate.screen_id, screen);
        assert_eq!(
            Candidate::prepare_candidate(document(&screen.to_string()), other).expect_err("screen").reason_code(),
            "manifest_wrong_screen"
        );
        let mut wrong_mode = document(&screen.to_string());
        wrong_mode["mode"] = serde_json::json!("slideshow");
        assert!(Candidate::prepare_candidate(wrong_mode, screen).is_err());
    }

    #[test]
    fn final_failures_wait_for_a_new_target() {
        let failure = worker_failure(&PrepareError::Manifest("manifest_invalid"));
        assert_eq!(failure.kind, ManifestFailureKind::Invalid);
        assert_eq!(failure.reason, "manifest_invalid");
        let failure = worker_failure(&PrepareError::State);
        assert_eq!(failure.kind, ManifestFailureKind::Retryable);
    }
}
