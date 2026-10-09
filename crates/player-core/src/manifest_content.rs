//! Verified manifest content preparation and pin identities.
use crate::{NativeManifest, OriginBlobSource};
use player_cas::{BlobSource, CasError, ContentStore, FetchError, FetchObserver, FetchRequest, Fetcher, IngestMeta};
use player_client::AuthenticatedServer;
use player_state::repo::cas::{Domain, SourceKind};
use player_types::Sha256Digest;
use std::collections::BTreeSet;
use std::sync::Arc;

pub(crate) async fn verify_content(
    store: &ContentStore,
    candidate: &NativeManifest,
) -> Result<Vec<Sha256Digest>, ManifestPreparationError> {
    let mut digests = BTreeSet::new();
    for asset in &candidate.required_downloads {
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
    for frame in &candidate.required_frames {
        let Some((_, record)) = store.open_verified(&frame.digest).await? else {
            return Err(ManifestPreparationError::Missing);
        };
        if record.size_bytes != frame.size_bytes {
            return Err(ManifestPreparationError::SizeMismatch);
        }
        digests.insert(frame.digest);
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

/// Fetches every variant, Widget bundle, and Widget frame the candidate
/// needs. The caller persists and pins a candidate only after this
/// succeeds, so a manifest whose bundle or frame cannot be fetched
/// never activates: the Player keeps its last known playable
/// presentation.
pub(crate) async fn prepare_content<P: ManifestSourcePlan>(
    store: &ContentStore,
    plan: &P,
    candidate: &NativeManifest,
) -> Result<Vec<Sha256Digest>, ManifestPreparationError> {
    let mut digests = BTreeSet::new();
    for asset in &candidate.required_downloads {
        let meta = IngestMeta {
            domain: Domain::Media,
            content_type: Some(asset.mime_type.clone()),
            source: SourceKind::Origin,
        };
        fetch_object(store, plan, asset.digest, asset.size_bytes, &asset.download_path, meta).await?;
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
    for frame in &candidate.required_frames {
        let meta = IngestMeta {
            domain: Domain::WidgetFrame,
            content_type: Some("text/html".to_owned()),
            source: SourceKind::Origin,
        };
        fetch_object(store, plan, frame.digest, frame.size_bytes, &frame.download_path, meta).await?;
        digests.insert(frame.digest);
    }
    for digest in &digests {
        if store.verified_path(digest).await?.is_none() {
            return Err(ManifestPreparationError::Missing);
        }
    }
    Ok(digests.into_iter().collect())
}
