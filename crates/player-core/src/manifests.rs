//! Binding-scoped manifest reconciliation. Runtime payloads remain opaque.
use async_trait::async_trait;
use player_client::client::{MAX_MANIFEST_BYTES, ManifestFetch};
use player_client::{AuthenticatedServer, ServerError};
use player_state::repo::manifests::{self, Binding, Target};
use player_types::Sha256Digest;
use serde_json::Value;

use crate::{Dependencies, NativeManifest, NativeManifestError, server_link::sample_server_clock};

#[derive(Debug, thiserror::Error)]
pub enum ManifestSyncError {
    #[error(transparent)]
    Server(#[from] ServerError),
    #[error("the server manifest is invalid: {0}")]
    Invalid(NativeManifestError),
    #[error("the server manifest version is older than the committed presentation")]
    Regressed,
    #[error("local state failed")]
    State,
    #[error("the server manifest exceeds its size bound")]
    Bound,
}

impl ManifestSyncError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Server(error) => error.reason_code(),
            Self::Invalid(error) => error.reason_code(),
            Self::Regressed => "manifest_version_regressed",
            Self::State => "state_error",
            Self::Bound => "manifest_bound_exceeded",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManifestCoordinator {
    dependencies: Dependencies,
}

impl ManifestCoordinator {
    pub fn new(dependencies: Dependencies) -> Self {
        Self { dependencies }
    }

    pub async fn persisted_target(&self, binding: &Binding) -> Option<Target> {
        let binding = binding.clone();
        self.dependencies.state.run(move |connection| manifests::target(connection, &binding)).await.ok().flatten()
    }

    pub async fn reconcile(
        &self,
        server: &AuthenticatedServer,
        binding: &Binding,
    ) -> Result<Option<Target>, ManifestSyncError> {
        self.reconcile_with(server, binding).await
    }

    async fn reconcile_with(
        &self,
        server: &impl ManifestApi,
        binding: &Binding,
    ) -> Result<Option<Target>, ManifestSyncError> {
        let target_binding = binding.clone();
        let current = self
            .dependencies
            .state
            .run(move |connection| manifests::target(connection, &target_binding))
            .await
            .map_err(|_| ManifestSyncError::State)?;
        let fetched = server.player_manifest(current.as_ref().map(|target| target.etag.as_str())).await?;
        let ManifestFetch::Modified { document, etag } = fetched else { return Ok(current) };
        if serde_json::to_vec(&document).map_or(true, |encoded| encoded.len() > MAX_MANIFEST_BYTES) {
            return Err(ManifestSyncError::Bound);
        }
        if let Some(server_time) = document.get("serverTime").and_then(Value::as_str) {
            sample_server_clock(&self.dependencies, server_time).await;
        }
        let digest = manifest_digest(&document);
        if current.as_ref().is_some_and(|target| target.digest == digest) {
            return Ok(current);
        }
        let version = NativeManifest::parse(document.clone(), binding.screen_id, digest)
            .map_err(ManifestSyncError::Invalid)?
            .version;
        let target = Target {
            binding: binding.clone(),
            digest,
            version,
            etag,
            document,
            fetched_at: self.dependencies.clock.now(),
        };
        let stored = target.clone();
        self.dependencies
            .state
            .run(move |connection| manifests::put_target(connection, &stored))
            .await
            .map_err(|_| ManifestSyncError::Regressed)?;
        tracing::info!(component = "manifest", event = "target", manifest = %digest.short(), version);
        Ok(Some(target))
    }
}

pub fn manifest_digest(document: &Value) -> Sha256Digest {
    let mut stable = document.clone();
    if let Some(members) = stable.as_object_mut() {
        members.remove("serverTime");
        members.remove("generatedAt");
    }
    Sha256Digest::of(&serde_json::to_vec(&stable).unwrap_or_default())
}

#[async_trait]
trait ManifestApi: Send + Sync {
    async fn player_manifest(&self, etag: Option<&str>) -> Result<ManifestFetch, ServerError>;
}

#[async_trait]
impl ManifestApi for AuthenticatedServer {
    async fn player_manifest(&self, etag: Option<&str>) -> Result<ManifestFetch, ServerError> {
        AuthenticatedServer::player_manifest(self, etag).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_state::repo::manifests::StoredManifest;
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, ScreenId, Timestamp, time::ManualClock};
    use serde_json::json;
    use std::sync::Mutex;

    struct Api {
        result: Result<ManifestFetch, ServerError>,
        validators: Mutex<Vec<Option<String>>>,
    }

    impl Api {
        fn modified(document: Value, etag: &str) -> Self {
            Self { result: Ok(ManifestFetch::Modified { document, etag: etag.into() }), validators: Mutex::new(vec![]) }
        }
    }

    #[async_trait]
    impl ManifestApi for Api {
        async fn player_manifest(&self, etag: Option<&str>) -> Result<ManifestFetch, ServerError> {
            self.validators.lock().unwrap().push(etag.map(str::to_owned));
            self.result.clone()
        }
    }

    fn fixture() -> (tempfile::TempDir, ManifestCoordinator, Binding) {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let clock = ManualClock::new(Timestamp::parse("2026-10-04T12:00:00Z").unwrap());
        let core = ManifestCoordinator::new(Dependencies { state, clock });
        let binding = Binding {
            installation_id: InstallationId::from_uuid(uuid::Uuid::from_u128(1)),
            screen_id: ScreenId::from_uuid(uuid::Uuid::from_u128(2)),
            server_url: "https://signs.example.org".into(),
        };
        (dir, core, binding)
    }

    fn document(binding: &Binding, version: i64) -> Value {
        json!({"schemaVersion":11,"mode":"presentation","screenId":binding.screen_id,"manifestVersion":version,
            "assets":[],"playlists":[],"schedules":[],"widgets":[],"dataSources":[],"plugins":[],
            "playlist":{"id":uuid::Uuid::from_u128(4),"items":[],"newTransition":"future","websiteOption":{"custom":true}},
            "layouts":[{"id":uuid::Uuid::from_u128(5),"document":{"unknownVisualProperty":[1,2,3],"placements":[]}}]})
    }

    #[tokio::test]
    async fn runtime_fields_are_preserved_and_response_clocks_do_not_change_identity() {
        let (dir, core, binding) = fixture();
        let first = document(&binding, 1);
        let target = core.reconcile_with(&Api::modified(first.clone(), "one"), &binding).await.unwrap().unwrap();
        assert_eq!(target.document, first);
        let mut duplicate = first.clone();
        duplicate["serverTime"] = json!("2026-10-04T12:00:00.125Z");
        duplicate["generatedAt"] = json!("second response");
        let api = Api::modified(duplicate, "second");
        let same = core.reconcile_with(&api, &binding).await.unwrap().unwrap();
        assert_eq!(same.digest, target.digest);
        assert_eq!(same.document, first);
        assert_eq!(same.etag, "one");
        assert_eq!(*api.validators.lock().unwrap(), vec![Some("one".into())]);
        let reopened = ManifestCoordinator::new(Dependencies {
            state: StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap(),
            clock: core.dependencies.clock.clone(),
        });
        assert_eq!(reopened.persisted_target(&binding).await.unwrap().document, first);
        let state =
            reopened.dependencies.state.run(|connection| player_state::repo::playback::get(connection)).await.unwrap();
        assert_eq!(state.server_clock_offset_ms, Some(125));
    }

    #[tokio::test]
    async fn invalid_bounded_and_regressed_answers_keep_the_last_target() {
        let (_dir, core, binding) = fixture();
        let first = document(&binding, 10);
        let target = core.reconcile_with(&Api::modified(first.clone(), "ten"), &binding).await.unwrap().unwrap();
        let stored = StoredManifest {
            binding: binding.clone(),
            digest: target.digest,
            version: 10,
            document: first,
            stored_at: core.dependencies.clock.now(),
        };
        core.dependencies
            .state
            .run(move |connection| {
                assert!(manifests::put_pending_for_target(connection, &stored)?);
                assert!(manifests::promote_pending(connection, &stored.binding, &stored.digest)?);
                Ok(())
            })
            .await
            .unwrap();
        assert!(matches!(
            core.reconcile_with(&Api::modified(json!({"manifestVersion":11}), "invalid"), &binding).await,
            Err(ManifestSyncError::Invalid(_))
        ));
        assert!(matches!(
            core.reconcile_with(&Api::modified(document(&binding, 9), "old"), &binding).await,
            Err(ManifestSyncError::Regressed)
        ));
        let oversized = json!({"unknown":"x".repeat(MAX_MANIFEST_BYTES)});
        assert!(matches!(
            core.reconcile_with(&Api::modified(oversized, "large"), &binding).await,
            Err(ManifestSyncError::Bound)
        ));
        assert_eq!(core.persisted_target(&binding).await.unwrap().digest, target.digest);
    }

    #[tokio::test]
    async fn target_lookup_and_conditional_fetch_are_bound_to_the_relationship() {
        let (_dir, core, binding) = fixture();
        core.reconcile_with(&Api::modified(document(&binding, 1), "one"), &binding).await.unwrap();
        let mut other = binding.clone();
        other.installation_id = InstallationId::from_uuid(uuid::Uuid::from_u128(3));
        assert!(core.persisted_target(&other).await.is_none());
        let api = Api { result: Ok(ManifestFetch::NotModified), validators: Mutex::new(vec![]) };
        assert!(core.reconcile_with(&api, &other).await.unwrap().is_none());
        assert_eq!(*api.validators.lock().unwrap(), vec![None]);
        let api = Api { result: Err(ServerError::Network), validators: Mutex::new(vec![]) };
        assert!(matches!(
            core.reconcile_with(&api, &binding).await,
            Err(ManifestSyncError::Server(ServerError::Network))
        ));
        assert_eq!(*api.validators.lock().unwrap(), vec![Some("one".into())]);
        assert!(core.persisted_target(&binding).await.is_some());
    }
}
