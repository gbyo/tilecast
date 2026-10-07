//! Binding-scoped manifest reconciliation. Runtime payloads remain opaque.
use async_trait::async_trait;
use player_client::client::{MAX_MANIFEST_BYTES, ManifestFetch};
use player_client::{AuthenticatedServer, ServerError};
use player_state::repo::cas::PinReason;
use player_state::repo::manifests::{self, Binding, Target};
use player_state::repo::manifests::{Stage, StoredManifest};
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
        let accepted = self
            .dependencies
            .state
            .run(move |connection| manifests::put_target(connection, &stored))
            .await
            .map_err(|_| ManifestSyncError::State)?;
        if !accepted {
            return Err(ManifestSyncError::Regressed);
        }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestPrepared {
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

impl ManifestCoordinator {
    pub async fn prepare_target<P: crate::ManifestSourcePlan>(
        &self,
        store: &player_cas::ContentStore,
        plan: &P,
        target: &Target,
        candidate: &NativeManifest,
    ) -> Result<ManifestPrepared, crate::ManifestPreparationError> {
        let db = &self.dependencies.state;
        if candidate.digest != target.digest || candidate.screen_id != target.binding.screen_id {
            return Err(crate::ManifestPreparationError::State);
        }
        let binding = target.binding.clone();

        for stage in [Stage::Active, Stage::Pending] {
            let stage_binding = binding.clone();
            let stored = db
                .run(move |c| manifests::get_for(c, stage, &stage_binding))
                .await
                .map_err(|_| crate::ManifestPreparationError::State)?;
            if stored.is_some_and(|stored| stored.digest == target.digest) {
                if candidate.verify_content(store).await.is_ok() {
                    return Ok(ManifestPrepared::Current);
                }
                // An object this manifest needs failed its re-check (a damaged
                // file after an unclean stop, say) and was removed. Fetch and
                // verify it again; the stage is unchanged, and activation pins
                // and shows the manifest once it is whole.
                let digests = candidate.prepare_content(store, plan).await?;
                let reason =
                    if stage == Stage::Active { PinReason::ActivePresentation } else { PinReason::PendingPresentation };
                store
                    .replace_pins(reason, &crate::manifest_pin_holder(&candidate.digest), digests)
                    .await
                    .map_err(crate::ManifestPreparationError::from)?;
                tracing::info!(component = "manifest", event = "repaired", manifest = %candidate.digest.short());
                return Ok(ManifestPrepared::Repaired);
            }
        }
        let digests = candidate.prepare_content(store, plan).await?;
        let holder = crate::manifest_pin_holder(&candidate.digest);
        store
            .replace_pins(PinReason::PendingPresentation, &holder, digests)
            .await
            .map_err(crate::ManifestPreparationError::from)?;
        let stored = StoredManifest {
            binding,
            digest: candidate.digest,
            version: candidate.version,
            document: candidate.document.clone(),
            stored_at: self.dependencies.clock.now(),
        };
        let accepted = db
            .run(move |c| manifests::put_pending_for_target(c, &stored))
            .await
            .map_err(|_| crate::ManifestPreparationError::State)?;
        if !accepted {
            let _ = store.replace_pins(PinReason::PendingPresentation, &holder, Vec::new()).await;
            tracing::info!(component = "manifest", event = "preparation_superseded", manifest = %candidate.digest.short());
            return Ok(ManifestPrepared::Superseded);
        }
        tracing::info!(
            component = "manifest",
            event = "prepared",
            manifest = %candidate.digest.short(),
            version = candidate.version
        );
        Ok(ManifestPrepared::Pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_state::repo::manifests::StoredManifest;
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, ScreenId, Timestamp, time::ManualClock};
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::Mutex;

    #[derive(Debug)]
    struct Space;

    impl player_cas::space::SpaceProbe for Space {
        fn available_bytes(&self, _: &std::path::Path) -> std::io::Result<u64> {
            Ok(1 << 40)
        }
    }

    #[derive(Debug, Default)]
    struct TestOpener;
    impl player_cas::SecureOpener for TestOpener {
        fn open_regular(&self, path: &std::path::Path, max_bytes: u64) -> std::io::Result<player_cas::RegularOpen> {
            use player_cas::RegularOpen;
            let metadata = match std::fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(RegularOpen::Missing);
                }
                Err(error) => return Err(error),
            };
            if metadata.file_type().is_symlink() {
                return Ok(RegularOpen::Refused);
            }
            let file = std::fs::File::open(path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.len() > max_bytes {
                return Ok(RegularOpen::Refused);
            }
            Ok(RegularOpen::Opened(file, metadata.len()))
        }
    }

    struct Sources {
        path: std::path::PathBuf,
        supersede: Option<(StateDb, Target)>,
    }

    impl crate::ManifestSourcePlan for Sources {
        async fn sources(
            &self,
            _: Sha256Digest,
            _: u64,
            _: &str,
        ) -> Result<Vec<Arc<dyn player_cas::BlobSource>>, crate::ManifestPreparationError> {
            if let Some((state, target)) = &self.supersede {
                let target = target.clone();
                assert!(state.run(move |connection| manifests::put_target(connection, &target)).await.unwrap());
            }
            Ok(vec![Arc::new(player_cas::fetch::LocalFileSource { path: self.path.clone() })])
        }
        fn observer(&self, _: Sha256Digest) -> Option<Box<dyn player_cas::FetchObserver + '_>> {
            None
        }
    }

    async fn content_store(dir: &tempfile::TempDir, core: &ManifestCoordinator) -> player_cas::ContentStore {
        player_cas::ContentStore::open(
            dir.path().join("cas"),
            dir.path().join("partial"),
            core.dependencies.state.clone(),
            core.dependencies.clock.clone(),
            Arc::new(Space),
            Arc::new(TestOpener),
            player_cas::StorePolicy { limit_bytes: 1 << 30, reserved_free_bytes: 0 },
            Arc::new(player_cas::LruByDomain),
        )
        .await
        .unwrap()
    }

    fn with_media(binding: &Binding, version: i64, bytes: &[u8]) -> Value {
        let mut value = document(binding, version);
        let asset = uuid::Uuid::from_u128(7);
        let variant = uuid::Uuid::from_u128(8);
        value["assets"] = json!([{"assetId":asset,"variantId":variant,"sha256":Sha256Digest::of(bytes),
            "fileSize":bytes.len(),"mimeType":"image/png","downloadPath":format!("/api/v1/player/assets/{asset}/variants/{variant}")}]);
        value
    }

    fn with_bundle(binding: &Binding, version: i64, bytes: &[u8]) -> Value {
        let mut value = document(binding, version);
        value["schemaVersion"] = json!(18);
        let widget = uuid::Uuid::from_u128(10);
        value["widgets"] = json!([{"assetId":widget,"name":"Scores","provider":"acme.athletics.scoreboard",
            "presentation":{"schemaVersion":3,"kind":"component",
                "requiredCapabilities":{"widget.external-runtime":1},
                "component":{"type":"acme.athletics.scoreboard","version":2,
                    "config":{},"dataSources":[],"media":[],"empty":"render",
                    "package":{"packageId":"acme.athletics",
                        "digest":format!("sha256:{}", Sha256Digest::of(b"package").to_hex()),
                        "sha256":Sha256Digest::of(bytes),"fileSize":bytes.len(),
                        "downloadPath":"/api/v1/player/packages/acme.athletics/widgets/scoreboard"}}}}]);
        value
    }

    #[tokio::test]
    async fn verified_preparation_fetches_required_widget_bundles() {
        let (dir, core, binding) = fixture();
        let store = content_store(&dir, &core).await;
        let bytes = b"widget bundle fixture";
        let path = dir.path().join("source");
        std::fs::write(&path, bytes).unwrap();
        let sources = Sources { path, supersede: None };
        let target = core
            .reconcile_with(&Api::modified(with_bundle(&binding, 1, bytes), "one"), &binding)
            .await
            .unwrap()
            .unwrap();
        let candidate = NativeManifest::parse(target.document.clone(), binding.screen_id, target.digest).unwrap();
        assert_eq!(
            core.prepare_target(&store, &sources, &target, &candidate).await.unwrap(),
            ManifestPrepared::Pending
        );
        let pending = core
            .dependencies
            .state
            .run({
                let lookup = binding.clone();
                move |connection| manifests::get_for(connection, Stage::Pending, &lookup)
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.digest, target.digest);
        assert_eq!(pending.document, target.document);
        let digest = candidate.required_bundles[0].digest;
        assert!(store.verified_path(&digest).await.unwrap().is_some());
        assert!(
            core.dependencies
                .state
                .run(move |connection| player_state::repo::cas::is_pinned(connection, &digest))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn failed_bundle_fetch_keeps_the_previous_pending_manifest() {
        let (dir, core, binding) = fixture();
        let store = content_store(&dir, &core).await;
        let bytes = b"playable widget bundle";
        let path = dir.path().join("source");
        std::fs::write(&path, bytes).unwrap();
        let first = core
            .reconcile_with(&Api::modified(with_bundle(&binding, 1, bytes), "one"), &binding)
            .await
            .unwrap()
            .unwrap();
        let first_candidate = NativeManifest::parse(first.document.clone(), binding.screen_id, first.digest).unwrap();
        let sources = Sources { path: dir.path().join("source"), supersede: None };
        assert_eq!(
            core.prepare_target(&store, &sources, &first, &first_candidate).await.unwrap(),
            ManifestPrepared::Pending
        );
        let missing = Sources { path: dir.path().join("absent"), supersede: None };
        let next = core
            .reconcile_with(&Api::modified(with_bundle(&binding, 2, b"unreachable bundle"), "two"), &binding)
            .await
            .unwrap()
            .unwrap();
        let candidate = NativeManifest::parse(next.document.clone(), binding.screen_id, next.digest).unwrap();
        assert!(core.prepare_target(&store, &missing, &next, &candidate).await.is_err());
        let pending = core
            .dependencies
            .state
            .run({
                let lookup = binding.clone();
                move |connection| manifests::get_for(connection, Stage::Pending, &lookup)
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.digest, first.digest);
    }

    #[tokio::test]
    async fn verified_preparation_repairs_content_without_changing_the_persisted_stage() {
        let (dir, core, binding) = fixture();
        let store = content_store(&dir, &core).await;
        let bytes = b"verified image fixture";
        let path = dir.path().join("source");
        std::fs::write(&path, bytes).unwrap();
        let sources = Sources { path, supersede: None };
        let target = core
            .reconcile_with(&Api::modified(with_media(&binding, 1, bytes), "one"), &binding)
            .await
            .unwrap()
            .unwrap();
        let candidate = NativeManifest::parse(target.document.clone(), binding.screen_id, target.digest).unwrap();
        assert_eq!(
            core.prepare_target(&store, &sources, &target, &candidate).await.unwrap(),
            ManifestPrepared::Pending
        );
        assert_eq!(
            core.prepare_target(&store, &sources, &target, &candidate).await.unwrap(),
            ManifestPrepared::Current
        );
        let digest = candidate.required_downloads[0].digest;
        let verified = store.verified_path(&digest).await.unwrap().unwrap();
        // A damaged cached object must be verified again, with the stage retained.
        std::fs::write(&verified, b"truncated").unwrap();
        assert_eq!(
            core.prepare_target(&store, &sources, &target, &candidate).await.unwrap(),
            ManifestPrepared::Repaired
        );
        assert_eq!(std::fs::read(store.verified_path(&digest).await.unwrap().unwrap()).unwrap(), bytes);
        let lookup = binding.clone();
        let pending = core
            .dependencies
            .state
            .run(move |connection| manifests::get_for(connection, Stage::Pending, &lookup))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.digest, target.digest);
        assert_eq!(pending.document, target.document);
        assert!(
            core.dependencies
                .state
                .run(move |connection| player_state::repo::cas::is_pinned(connection, &digest))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn a_target_changed_during_fetch_cannot_become_pending_or_keep_its_pins() {
        let (dir, core, binding) = fixture();
        let store = content_store(&dir, &core).await;
        let bytes = b"verified replacement image";
        let path = dir.path().join("source");
        std::fs::write(&path, bytes).unwrap();
        let target = core
            .reconcile_with(&Api::modified(with_media(&binding, 1, bytes), "one"), &binding)
            .await
            .unwrap()
            .unwrap();
        let candidate = NativeManifest::parse(target.document.clone(), binding.screen_id, target.digest).unwrap();
        let mut next = target.clone();
        next.document["manifestVersion"] = json!(2);
        next.version = 2;
        next.etag = "two".into();
        next.digest = manifest_digest(&next.document);
        let sources = Sources { path, supersede: Some((core.dependencies.state.clone(), next.clone())) };
        assert_eq!(
            core.prepare_target(&store, &sources, &target, &candidate).await.unwrap(),
            ManifestPrepared::Superseded
        );
        let lookup = binding.clone();
        assert!(
            core.dependencies
                .state
                .run(move |connection| manifests::get_for(connection, Stage::Pending, &lookup))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(core.persisted_target(&binding).await.unwrap().digest, next.digest);
        let digest = candidate.required_downloads[0].digest;
        assert!(store.verified_path(&digest).await.unwrap().is_some());
        assert!(
            !core
                .dependencies
                .state
                .run(move |connection| player_state::repo::cas::is_pinned(connection, &digest))
                .await
                .unwrap()
        );
    }

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
    async fn storage_failures_are_state_errors_not_version_regressions() {
        let (_dir, core, binding) = fixture();
        let oversized_etag = "e".repeat(201);
        assert!(matches!(
            core.reconcile_with(&Api::modified(document(&binding, 1), &oversized_etag), &binding).await,
            Err(ManifestSyncError::State)
        ));
        assert!(core.persisted_target(&binding).await.is_none());
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
