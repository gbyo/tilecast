//! Verified manifest content preparation and pin identities.
use crate::{AssetPolicy, ManifestAsset, NativeManifest, OriginBlobSource, StreamClaim, StreamReason};
use player_cas::{BlobSource, CasError, ContentStore, FetchError, FetchObserver, FetchRequest, Fetcher, IngestMeta};
use player_client::AuthenticatedServer;
use player_state::repo::cas::{Domain, SourceKind};
use player_types::Sha256Digest;
use std::collections::BTreeSet;
use std::sync::Arc;

/// What preparation settled on: verified CAS digests to pin, plus videos
/// the renderer reads through bounded authenticated range fetches.
/// Stream claims are never pinned and never written to the store.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreparedContent {
    pub verified: Vec<Sha256Digest>,
    pub streams: Vec<StreamClaim>,
}

fn is_video(asset: &ManifestAsset) -> bool {
    asset.mime_type.starts_with("video/")
}

/// The deterministic delivery partition, shared by prepare, verify, and
/// host diagnostics: the same (manifest, threshold) always settles the
/// same way. Only videos stream: `download` assets and every non-video
/// must be verified before activation, and a mid-fetch quota failure
/// fails preparation visibly instead of silently changing guarantees.
fn stream_claim(asset: &ManifestAsset, threshold: u64) -> Option<StreamClaim> {
    if !is_video(asset) {
        return None;
    }
    let reason = match asset.policy {
        AssetPolicy::Download => return None,
        AssetPolicy::Stream => StreamReason::Explicit,
        AssetPolicy::Automatic if asset.size_bytes > threshold => StreamReason::Oversize,
        AssetPolicy::Automatic => return None,
    };
    Some(StreamClaim {
        digest: asset.digest,
        size_bytes: asset.size_bytes,
        mime_type: asset.mime_type.clone(),
        download_path: asset.download_path.clone(),
        reason,
    })
}

/// The manifest's stream-backed videos at this store's threshold, for
/// host diagnostics and media-grant backends. Pure: preparation settles
/// identically, one claim per digest.
pub fn stream_claims(candidate: &NativeManifest, threshold: u64) -> Vec<StreamClaim> {
    let mut seen = BTreeSet::new();
    candidate
        .required_downloads
        .iter()
        .filter_map(|asset| stream_claim(asset, threshold))
        .filter(|claim| seen.insert(claim.digest))
        .collect()
}

pub(crate) async fn verify_content(
    store: &ContentStore,
    candidate: &NativeManifest,
) -> Result<Vec<Sha256Digest>, ManifestPreparationError> {
    let threshold = store.download_threshold_bytes();
    let mut digests = BTreeSet::new();
    for asset in &candidate.required_downloads {
        if stream_claim(asset, threshold).is_some() {
            continue;
        }
        let Some((_, record)) = store.open_verified(&asset.digest).await? else {
            return Err(ManifestPreparationError::Missing);
        };
        if record.size_bytes != asset.size_bytes {
            return Err(ManifestPreparationError::SizeMismatch);
        }
        digests.insert(asset.digest);
    }
    for bundle in &candidate.required_bundles {
        let Some((_, record)) = store.open_verified(&bundle.digest).await? else {
            return Err(ManifestPreparationError::Missing);
        };
        if record.size_bytes != bundle.size_bytes {
            return Err(ManifestPreparationError::SizeMismatch);
        }
        digests.insert(bundle.digest);
    }
    Ok(digests.into_iter().collect())
}

pub fn manifest_pin_holder(manifest: &Sha256Digest) -> String {
    format!("{MANIFEST_PIN_PREFIX}{}", manifest.to_hex())
}

pub const MANIFEST_PIN_PREFIX: &str = "manifest-";

#[derive(Debug, thiserror::Error)]
pub enum ManifestPreparationError {
    #[error("local state failed")]
    State,
    #[error("the content store is unavailable")]
    StoreUnavailable,
    #[error("a manifest download path is invalid")]
    InvalidDownloadPath,
    #[error("the content store failed: {0}")]
    Store(#[from] CasError),
    #[error("a required object could not be fetched: {0}")]
    Fetch(#[from] FetchError),
    #[error("a cached object has the wrong size")]
    SizeMismatch,
    #[error("a required object is not in the content store")]
    Missing,
    /// A download the partition requires does not fit the store's
    /// cache/free-space policy. Explicit `download` never falls back to
    /// streaming; the operator raises the cache limit or picks `stream`.
    #[error("a required download does not fit the content store policy")]
    CacheTooSmall,
}

impl ManifestPreparationError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::State => "state_error",
            Self::StoreUnavailable => "content_store_unavailable",
            Self::InvalidDownloadPath => "download_path_invalid",
            Self::Store(_) => "content_store_failed",
            Self::Fetch(_) => "media_fetch_failed",
            Self::SizeMismatch => "media_size_mismatch",
            Self::Missing => "media_missing",
            Self::CacheTooSmall => "media_cache_too_small",
        }
    }
}

/// Where preparation obtains verified bytes. Production uses the
/// authenticated origin (docs/tilecast-edge.md §9.2); tests substitute
/// failing or corrupt sources. Every source feeds the same `Fetcher`, and the
/// content store verifies every byte.
pub trait ManifestSourcePlan: Send + Sync {
    fn sources(
        &self,
        digest: Sha256Digest,
        size: u64,
        origin_path: &str,
    ) -> impl std::future::Future<Output = Result<Vec<Arc<dyn BlobSource>>, ManifestPreparationError>> + Send;
    fn observer(&self, digest: Sha256Digest) -> Option<Box<dyn FetchObserver + '_>>;
}

/// The authenticated Tilecast Server origin.
#[derive(Debug)]
pub struct ManifestOriginSources<'a> {
    pub server: &'a AuthenticatedServer,
}

impl ManifestSourcePlan for ManifestOriginSources<'_> {
    async fn sources(
        &self,
        _digest: Sha256Digest,
        _size: u64,
        origin_path: &str,
    ) -> Result<Vec<Arc<dyn BlobSource>>, ManifestPreparationError> {
        let origin = OriginBlobSource::new(self.server.clone(), origin_path)
            .map_err(|_| ManifestPreparationError::InvalidDownloadPath)?;
        Ok(vec![Arc::new(origin) as Arc<dyn BlobSource>])
    }

    fn observer(&self, _digest: Sha256Digest) -> Option<Box<dyn FetchObserver + '_>> {
        None
    }
}

/// Fetches one object into the CAS through the verified `Fetcher`.
async fn fetch_object<P: ManifestSourcePlan>(
    store: &ContentStore,
    plan: &P,
    digest: Sha256Digest,
    size_bytes: u64,
    origin_path: &str,
    meta: IngestMeta,
) -> Result<(), ManifestPreparationError> {
    if let Some((_, record)) = store.open_verified(&digest).await? {
        if record.size_bytes != size_bytes {
            return Err(ManifestPreparationError::SizeMismatch);
        }
        return Ok(());
    }
    let request = FetchRequest { digest, size_bytes, meta };
    let sources = plan.sources(digest, size_bytes, origin_path).await?;
    let observer = plan.observer(digest);
    let record = Fetcher::new(store.clone(), 2).fetch(&request, &sources, observer.as_deref()).await?;
    if record.size_bytes != size_bytes {
        return Err(ManifestPreparationError::SizeMismatch);
    }
    Ok(())
}

/// Fetches every variant and Widget bundle the candidate needs. The caller
/// persists and pins a candidate only after this succeeds, so a manifest
/// whose bundle cannot be fetched never activates: the Player keeps its
/// last known playable presentation.
pub(crate) async fn prepare_content<P: ManifestSourcePlan>(
    store: &ContentStore,
    plan: &P,
    candidate: &NativeManifest,
) -> Result<PreparedContent, ManifestPreparationError> {
    let threshold = store.download_threshold_bytes();
    let mut digests = BTreeSet::new();
    let mut seen_stream = BTreeSet::new();
    let mut streams = Vec::new();
    for asset in &candidate.required_downloads {
        if let Some(claim) = stream_claim(asset, threshold) {
            if seen_stream.insert(claim.digest) {
                streams.push(claim);
            }
            continue;
        }
        let meta = IngestMeta {
            domain: Domain::Media,
            content_type: Some(asset.mime_type.clone()),
            source: SourceKind::Origin,
        };
        fetch_object(store, plan, asset.digest, asset.size_bytes, &asset.download_path, meta).await.map_err(
            |error| match &error {
                // The partition requires this download and the store
                // cannot fit it: fail visibly, never stream silently.
                ManifestPreparationError::Fetch(FetchError::Store(
                    CasError::OverLimit | CasError::InsufficientSpace { .. },
                ))
                | ManifestPreparationError::Store(CasError::OverLimit | CasError::InsufficientSpace { .. }) => {
                    ManifestPreparationError::CacheTooSmall
                }
                _ => error,
            },
        )?;
        digests.insert(asset.digest);
    }
    for bundle in &candidate.required_bundles {
        let meta = IngestMeta {
            domain: Domain::WidgetBundle,
            content_type: Some("text/javascript".to_owned()),
            source: SourceKind::Origin,
        };
        fetch_object(store, plan, bundle.digest, bundle.size_bytes, &bundle.download_path, meta).await?;
        digests.insert(bundle.digest);
    }
    for digest in &digests {
        if store.verified_path(digest).await?.is_none() {
            return Err(ManifestPreparationError::Missing);
        }
    }
    Ok(PreparedContent { verified: digests.into_iter().collect(), streams })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;

    #[derive(Debug)]
    struct UnlimitedSpace;

    impl player_cas::space::SpaceProbe for UnlimitedSpace {
        fn available_bytes(&self, _path: &Path) -> std::io::Result<u64> {
            Ok(u64::MAX)
        }
    }

    #[derive(Debug)]
    struct TestOpener;

    impl player_cas::SecureOpener for TestOpener {
        fn open_regular(&self, path: &Path, max_bytes: u64) -> std::io::Result<player_cas::RegularOpen> {
            use player_cas::RegularOpen;
            if path.symlink_metadata().is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Ok(RegularOpen::Refused);
            }
            match std::fs::File::open(path) {
                Ok(file) => {
                    let meta = file.metadata()?;
                    if !meta.is_file() || meta.len() > max_bytes {
                        Ok(RegularOpen::Refused)
                    } else {
                        Ok(RegularOpen::Opened(file, meta.len()))
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RegularOpen::Missing),
                Err(error) => Err(error),
            }
        }
    }

    async fn test_store(dir: &Path, limit_bytes: u64) -> ContentStore {
        let db = player_state::StateDb::open(dir.join("state.db"), player_state::OpenOptions::default()).unwrap();
        let clock = player_types::time::ManualClock::new(player_types::Timestamp::from_unix_millis(0).unwrap());
        ContentStore::open(
            dir.join("cas"),
            dir.join("partial"),
            db,
            clock,
            std::sync::Arc::new(UnlimitedSpace),
            std::sync::Arc::new(TestOpener),
            player_cas::StorePolicy { limit_bytes, reserved_free_bytes: 0 },
            std::sync::Arc::new(player_cas::LruByDomain),
        )
        .await
        .unwrap()
    }

    #[derive(Debug)]
    struct StaticSource {
        bytes: Vec<u8>,
    }

    #[async_trait::async_trait]
    impl BlobSource for StaticSource {
        fn kind(&self) -> player_cas::SourceKind {
            player_cas::SourceKind::Local
        }

        fn label(&self) -> String {
            "test".into()
        }

        async fn open(
            &self,
            _digest: &Sha256Digest,
            size: u64,
            _offset: u64,
        ) -> Result<player_cas::SourceStream, player_cas::SourceError> {
            use futures_util::stream::StreamExt as _;
            let body = futures_util::stream::iter([Ok::<bytes::Bytes, player_cas::SourceError>(bytes::Bytes::from(
                self.bytes.clone(),
            ))])
            .boxed();
            Ok(player_cas::SourceStream { start: 0, total_length: Some(size), body })
        }
    }

    struct StaticPlan {
        files: HashMap<Sha256Digest, Vec<u8>>,
        calls: Mutex<Vec<Sha256Digest>>,
    }

    impl ManifestSourcePlan for StaticPlan {
        async fn sources(
            &self,
            digest: Sha256Digest,
            _size: u64,
            _origin_path: &str,
        ) -> Result<Vec<Arc<dyn BlobSource>>, ManifestPreparationError> {
            self.calls.lock().unwrap().push(digest);
            let bytes = self.files.get(&digest).cloned().ok_or(ManifestPreparationError::Missing)?;
            Ok(vec![Arc::new(StaticSource { bytes }) as Arc<dyn BlobSource>])
        }

        fn observer(&self, _digest: Sha256Digest) -> Option<Box<dyn FetchObserver + '_>> {
            None
        }
    }

    fn video_asset(asset: uuid::Uuid, variant: uuid::Uuid, digest: Sha256Digest, size: u64) -> serde_json::Value {
        serde_json::json!({
            "assetId": asset, "variantId": variant, "sha256": digest.to_hex(),
            "fileSize": size, "mimeType": "video/mp4",
            "downloadPath": format!("/api/v1/player/assets/{asset}/variants/{variant}"),
        })
    }

    fn image_asset(asset: uuid::Uuid, variant: uuid::Uuid, digest: Sha256Digest, size: u64) -> serde_json::Value {
        let mut value = video_asset(asset, variant, digest, size);
        value["mimeType"] = serde_json::json!("image/png");
        value
    }

    fn item(asset: uuid::Uuid, variant: uuid::Uuid, policy: &str) -> serde_json::Value {
        serde_json::json!({
            "id": uuid::Uuid::new_v4(), "assetId": asset, "variantId": variant,
            "assetType": "video", "deliveryPolicy": policy,
        })
    }

    fn candidate(assets: Vec<serde_json::Value>, items: Vec<serde_json::Value>) -> NativeManifest {
        let screen = player_types::ScreenId::from_uuid(uuid::Uuid::from_u128(1));
        let document = serde_json::json!({
            "schemaVersion": 11, "manifestVersion": 1, "screenId": screen, "mode": "presentation",
            "assets": assets,
            "playlist": {"id": uuid::Uuid::from_u128(5), "items": items},
            "playlists": [], "schedules": [], "widgets": [], "dataSources": [], "plugins": [],
        });
        let digest = crate::manifest_digest(&document);
        NativeManifest::parse(document, screen, digest).unwrap()
    }

    fn asset_ids(n: u128) -> (uuid::Uuid, uuid::Uuid) {
        (uuid::Uuid::from_u128(n), uuid::Uuid::from_u128(n + 1))
    }

    #[tokio::test]
    async fn prepare_partitions_downloads_and_streams() {
        let dir = tempfile::tempdir().unwrap();
        // Threshold 1000: the 100-byte video downloads, the 2000-byte one streams.
        let store = test_store(dir.path(), 2000).await;
        assert_eq!(store.download_threshold_bytes(), 1000);
        let small_bytes = vec![7u8; 100];
        let small_digest = Sha256Digest::of(&small_bytes);
        let big_digest = Sha256Digest::of(b"a video far too large to cache");
        let (sa, sv) = asset_ids(100);
        let (ba, bv) = asset_ids(200);
        let manifest = candidate(
            vec![video_asset(sa, sv, small_digest, 100), video_asset(ba, bv, big_digest, 2000)],
            vec![item(sa, sv, "automatic"), item(ba, bv, "automatic")],
        );
        let plan = StaticPlan { files: [(small_digest, small_bytes)].into_iter().collect(), calls: Mutex::new(vec![]) };
        let prepared = manifest.prepare_content(&store, &plan).await.unwrap();
        assert_eq!(prepared.verified, vec![small_digest]);
        assert_eq!(prepared.streams.len(), 1);
        assert_eq!(prepared.streams[0].digest, big_digest);
        assert_eq!(prepared.streams[0].reason, crate::StreamReason::Oversize);
        // The oversize video was never fetched; verify accepts the partition.
        assert_eq!(*plan.calls.lock().unwrap(), vec![small_digest]);
        assert!(store.open_verified(&small_digest).await.unwrap().is_some());
        assert!(store.open_verified(&big_digest).await.unwrap().is_none());
        assert_eq!(manifest.verify_content(&store).await.unwrap(), vec![small_digest]);
    }

    #[tokio::test]
    async fn explicit_stream_never_fetches() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store(dir.path(), 1 << 20).await;
        let digest = Sha256Digest::of(b"a small explicit stream");
        let (asset, variant) = asset_ids(300);
        let manifest = candidate(vec![video_asset(asset, variant, digest, 24)], vec![item(asset, variant, "stream")]);
        struct Refuse;
        impl ManifestSourcePlan for Refuse {
            async fn sources(
                &self,
                _digest: Sha256Digest,
                _size: u64,
                _origin_path: &str,
            ) -> Result<Vec<Arc<dyn BlobSource>>, ManifestPreparationError> {
                panic!("stream claims must not fetch")
            }

            fn observer(&self, _digest: Sha256Digest) -> Option<Box<dyn FetchObserver + '_>> {
                None
            }
        }
        let prepared = manifest.prepare_content(&store, &Refuse).await.unwrap();
        assert!(prepared.verified.is_empty());
        assert_eq!(prepared.streams.len(), 1);
        assert_eq!(prepared.streams[0].reason, crate::StreamReason::Explicit);
        assert!(manifest.verify_content(&store).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn explicit_download_beyond_cache_fails_visibly() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store(dir.path(), 100).await;
        let bytes = vec![9u8; 2000];
        let digest = Sha256Digest::of(&bytes);
        let (asset, variant) = asset_ids(400);
        let manifest =
            candidate(vec![video_asset(asset, variant, digest, 2000)], vec![item(asset, variant, "download")]);
        let plan = StaticPlan { files: [(digest, bytes)].into_iter().collect(), calls: Mutex::new(vec![]) };
        let error = manifest.prepare_content(&store, &plan).await.unwrap_err();
        assert!(matches!(error, ManifestPreparationError::CacheTooSmall));
        assert_eq!(error.reason_code(), "media_cache_too_small");
    }

    #[tokio::test]
    async fn stream_policy_images_still_download() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store(dir.path(), 1 << 20).await;
        let bytes = vec![3u8; 64];
        let digest = Sha256Digest::of(&bytes);
        let (asset, variant) = asset_ids(500);
        let manifest = candidate(vec![image_asset(asset, variant, digest, 64)], vec![item(asset, variant, "stream")]);
        let plan = StaticPlan { files: [(digest, bytes)].into_iter().collect(), calls: Mutex::new(vec![]) };
        let prepared = manifest.prepare_content(&store, &plan).await.unwrap();
        assert_eq!(prepared.verified, vec![digest]);
        assert!(prepared.streams.is_empty());
    }

    #[tokio::test]
    async fn verify_reports_missing_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store(dir.path(), 1 << 20).await;
        let digest = Sha256Digest::of(b"never fetched");
        let (asset, variant) = asset_ids(600);
        let manifest = candidate(vec![video_asset(asset, variant, digest, 13)], vec![item(asset, variant, "download")]);
        assert!(matches!(manifest.verify_content(&store).await.unwrap_err(), ManifestPreparationError::Missing));
    }
}
