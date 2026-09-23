//! Validation boundary for the existing server-compiled player manifest.
//!
//! The server remains the presentation compiler. This module checks the
//! identities and download claims that Edge will use before any candidate can
//! enter the CAS preparation and activation path.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use edge_cas::{BlobSource, CasError, FetchError, FetchRequest, Fetcher, IngestMeta};
use edge_protocol::bounded::{SafeText, ShortToken};
use edge_protocol::ipc::presentation::{
    ContentRef, ItemKind, PresentationDocument, PresentationItem, StatusSurface, content_uri,
};
use edge_protocol::{ScreenId, Sha256Digest};
use edge_server::AuthenticatedServer;
use edge_server::origin::OriginBlobSource;
use edge_state::repo::cas::{Domain, SourceKind};
use serde::Deserialize;
use serde_json::Value;

use crate::daemon::DaemonContext;
use crate::fabric;
use crate::schedule::{self, Selection, Source};

const SCHEMA_VERSION: u32 = 11;
const MAX_ASSETS: usize = 1024;
const MAX_PLAYLISTS: usize = 128;
const MAX_ITEMS: usize = 4096;
const AUTOMATIC_VIDEO_LIMIT_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_ACTIVATION_GRACE_SECONDS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub asset_id: uuid::Uuid,
    pub variant_id: uuid::Uuid,
    pub digest: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: String,
    pub download_path: String,
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub document: Value,
    pub version: i64,
    pub screen_id: ScreenId,
    pub assets: Vec<Asset>,
    /// Exact variants that must be verified before this candidate may activate.
    pub required_downloads: Vec<Asset>,
    /// Media with a server stream policy. WPE currently has no verified
    /// streaming path; a later activation must reject these until it does.
    pub streaming_assets: Vec<Asset>,
}

#[derive(Debug, Clone)]
pub struct ResolvedPresentation {
    pub document: PresentationDocument,
    pub content: Vec<ContentRef>,
    pub selection: Selection,
    pub next_transition_ms: Option<i64>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("manifest structure is invalid")]
    Structure,
    #[error("manifest schema is unsupported")]
    Schema,
    #[error("manifest targets another screen")]
    Screen,
    #[error("manifest exceeds the supported item or asset bound")]
    Bound,
    #[error("manifest contains an invalid media asset")]
    Asset,
    #[error("manifest references an unavailable or ambiguous media variant")]
    Reference,
    #[error("manifest has an unsupported delivery policy")]
    DeliveryPolicy,
    #[error("manifest schedule is invalid")]
    Schedule,
    #[error("the selected presentation is not supported by this Edge renderer")]
    UnsupportedPresentation,
}

fn availability_window(value: &Value) -> Result<(Option<i64>, Option<i64>), ManifestError> {
    let parse = |key: &str| -> Result<Option<i64>, ManifestError> {
        match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => edge_protocol::Timestamp::parse(text)
                .map(|value| Some(value.unix_millis()))
                .map_err(|_| ManifestError::Structure),
            _ => Err(ManifestError::Structure),
        }
    };
    let from = parse("availableFrom")?;
    let until = parse("expiresAt")?;
    if from.zip(until).is_some_and(|(from, until)| from >= until) {
        return Err(ManifestError::Structure);
    }
    Ok((from, until))
}

fn available_at(value: &Value, now_ms: i64) -> Result<bool, ManifestError> {
    let (from, until) = availability_window(value)?;
    Ok(from.is_none_or(|from| now_ms >= from) && until.is_none_or(|until| now_ms < until))
}

fn next_availability_transition(document: &Value, now_ms: i64) -> Result<Option<i64>, ManifestError> {
    let mut next = None;
    let mut observe = |value: &Value| -> Result<(), ManifestError> {
        let (from, until) = availability_window(value)?;
        for boundary in [from, until].into_iter().flatten().filter(|at| *at > now_ms) {
            next = Some(next.map_or(boundary, |current: i64| current.min(boundary)));
        }
        Ok(())
    };
    if let Some(assets) = document.get("assets").and_then(Value::as_array) {
        for asset in assets {
            observe(asset)?;
        }
    }
    for playlist in ["playlist", "directFallbackPlaylist"]
        .into_iter()
        .filter_map(|key| document.get(key))
        .chain(document.get("playlists").and_then(Value::as_array).into_iter().flatten())
    {
        if let Some(items) = playlist.get("items").and_then(Value::as_array) {
            for item in items {
                observe(item)?;
            }
        }
    }
    Ok(next)
}

fn token_or(value: Option<&str>, fallback: &str) -> Result<ShortToken, ManifestError> {
    ShortToken::new(value.unwrap_or(fallback).to_owned()).map_err(|_| ManifestError::Structure)
}

fn status_surface(title: &str, message: &str, status: &str) -> Result<PresentationDocument, ManifestError> {
    Ok(PresentationDocument::Idle(StatusSurface {
        title: SafeText::new(title.to_owned()).map_err(|_| ManifestError::Structure)?,
        message: SafeText::new(message.to_owned()).map_err(|_| ManifestError::Structure)?,
        background_color: None,
        text_color: None,
        logo_src: None,
        footer_text: None,
        status: Some(SafeText::new(status.to_owned()).map_err(|_| ManifestError::Structure)?),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireManifest {
    schema_version: u32,
    manifest_version: i64,
    screen_id: ScreenId,
    mode: String,
    assets: Vec<WireAsset>,
    playlist: Option<WirePlaylist>,
    direct_fallback_playlist: Option<WirePlaylist>,
    playlists: Vec<WirePlaylist>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAsset {
    asset_id: uuid::Uuid,
    variant_id: uuid::Uuid,
    sha256: String,
    file_size: i64,
    mime_type: String,
    download_path: String,
}

#[derive(Deserialize)]
struct WirePlaylist {
    items: Vec<WireItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireItem {
    asset_id: uuid::Uuid,
    variant_id: Option<uuid::Uuid>,
    asset_type: String,
    layout_id: Option<uuid::Uuid>,
    delivery_policy: String,
}

fn exact_asset(
    value: &Value,
    asset_key: &str,
    variant_key: &str,
    catalog: &BTreeMap<(uuid::Uuid, uuid::Uuid), usize>,
) -> Result<Option<usize>, ManifestError> {
    let Some(asset) = value.get(asset_key).filter(|value| !value.is_null()) else { return Ok(None) };
    let asset: uuid::Uuid =
        asset.as_str().ok_or(ManifestError::Reference)?.parse().map_err(|_| ManifestError::Reference)?;
    let variant: uuid::Uuid = value
        .get(variant_key)
        .and_then(Value::as_str)
        .ok_or(ManifestError::Reference)?
        .parse()
        .map_err(|_| ManifestError::Reference)?;
    catalog.get(&(asset, variant)).copied().map(Some).ok_or(ManifestError::Reference)
}

fn required_from_layout(
    layout: &Value,
    catalog: &BTreeMap<(uuid::Uuid, uuid::Uuid), usize>,
    required: &mut BTreeSet<usize>,
) -> Result<(), ManifestError> {
    let document = layout.get("document").ok_or(ManifestError::Structure)?;
    if let Some(canvas) = document.get("canvas")
        && let Some(index) = exact_asset(canvas, "backgroundAssetId", "backgroundVariantId", catalog)?
    {
        required.insert(index);
    }
    if let Some(placements) = document.get("placements") {
        let placements = placements.as_array().ok_or(ManifestError::Structure)?;
        for placement in placements {
            if placement.get("type").and_then(Value::as_str) == Some("asset")
                && let Some(index) = exact_asset(placement, "assetId", "variantId", catalog)?
            {
                required.insert(index);
            }
        }
    }
    Ok(())
}

impl Candidate {
    pub fn parse(document: Value, expected_screen: ScreenId) -> Result<Self, ManifestError> {
        let wire: WireManifest = serde_json::from_value(document.clone()).map_err(|_| ManifestError::Structure)?;
        if wire.schema_version != SCHEMA_VERSION || wire.mode != "presentation" || wire.manifest_version < 0 {
            return Err(ManifestError::Schema);
        }
        if wire.screen_id != expected_screen {
            return Err(ManifestError::Screen);
        }
        if wire.assets.len() > MAX_ASSETS || wire.playlists.len() > MAX_PLAYLISTS {
            return Err(ManifestError::Bound);
        }
        let mut assets = Vec::with_capacity(wire.assets.len());
        let mut by_variant = BTreeMap::new();
        let mut by_digest = BTreeMap::new();
        for source in wire.assets {
            let digest =
                Sha256Digest::parse_legacy_case_insensitive(&source.sha256).map_err(|_| ManifestError::Asset)?;
            let size_bytes = u64::try_from(source.file_size).map_err(|_| ManifestError::Asset)?;
            if size_bytes == 0
                || source.mime_type.is_empty()
                || source.mime_type.len() > 128
                || !source.mime_type.is_ascii()
                || source.mime_type.bytes().any(|byte| byte.is_ascii_control())
                || OriginBlobSource::validate_path(&source.download_path).is_err()
                || by_variant.insert((source.asset_id, source.variant_id), assets.len()).is_some()
                || by_digest.insert(digest, size_bytes).is_some_and(|old| old != size_bytes)
            {
                return Err(ManifestError::Asset);
            }
            assets.push(Asset {
                asset_id: source.asset_id,
                variant_id: source.variant_id,
                digest,
                size_bytes,
                mime_type: source.mime_type,
                download_path: source.download_path,
            });
        }
        let mut item_count = 0;
        let mut required = BTreeSet::new();
        let mut streaming = BTreeSet::new();
        for playlist in wire.playlist.into_iter().chain(wire.direct_fallback_playlist).chain(wire.playlists) {
            item_count += playlist.items.len();
            if item_count > MAX_ITEMS {
                return Err(ManifestError::Bound);
            }
            for item in playlist.items {
                if item.layout_id.is_some() || matches!(item.asset_type.as_str(), "website" | "widget") {
                    continue;
                }
                let Some(variant) = item.variant_id else { return Err(ManifestError::Reference) };
                let index = *by_variant.get(&(item.asset_id, variant)).ok_or(ManifestError::Reference)?;
                let asset = &assets[index];
                match item.delivery_policy.as_str() {
                    "download" => {
                        required.insert(index);
                    }
                    "stream" => {
                        streaming.insert(index);
                    }
                    "automatic"
                        if !asset.mime_type.starts_with("video/")
                            || asset.size_bytes <= AUTOMATIC_VIDEO_LIMIT_BYTES =>
                    {
                        required.insert(index);
                    }
                    "automatic" => {
                        streaming.insert(index);
                    }
                    _ => return Err(ManifestError::DeliveryPolicy),
                }
            }
        }
        if let Some(branding) = document.get("branding").filter(|value| !value.is_null())
            && let Some(index) = exact_asset(branding, "logoAssetId", "logoVariantId", &by_variant)?
        {
            required.insert(index);
        }
        if let Some(websites) = document.get("websites") {
            for website in websites.as_array().ok_or(ManifestError::Structure)? {
                if let Some(index) = exact_asset(website, "fallbackImageAssetId", "fallbackVariantId", &by_variant)? {
                    required.insert(index);
                }
            }
        }
        for key in ["layout", "directFallbackLayout"] {
            if let Some(layout) = document.get(key).filter(|value| !value.is_null()) {
                required_from_layout(layout, &by_variant, &mut required)?;
            }
        }
        if let Some(layouts) = document.get("layouts") {
            for layout in layouts.as_array().ok_or(ManifestError::Structure)? {
                required_from_layout(layout, &by_variant, &mut required)?;
            }
        }
        if let Some(plugins) = document.get("plugins") {
            for plugin in plugins.as_array().ok_or(ManifestError::Structure)? {
                if plugin.get("type").and_then(Value::as_str) == Some("brand_bug")
                    && let Some(config) = plugin.get("config")
                    && let Some(index) = exact_asset(config, "imageAssetId", "imageVariantId", &by_variant)?
                {
                    required.insert(index);
                }
            }
        }
        let required_downloads = required.into_iter().map(|index| assets[index].clone()).collect();
        let streaming_assets = streaming.into_iter().map(|index| assets[index].clone()).collect();
        Ok(Self {
            document,
            version: wire.manifest_version,
            screen_id: wire.screen_id,
            assets,
            required_downloads,
            streaming_assets,
        })
    }

    /// Resolves the server-compiled manifest at one corrected server instant.
    /// The server remains the compiler: this selects the already-compiled
    /// playlist and projects its ready image/video variants into the shared
    /// renderer contract.
    pub fn presentation(&self, now_ms: i64) -> Result<ResolvedPresentation, ManifestError> {
        let selection = schedule::resolve(&self.document, now_ms).map_err(|_| ManifestError::Schedule)?;
        let availability = next_availability_transition(&self.document, now_ms)?;
        let next_transition_ms = match (selection.next_transition_ms, availability) {
            (Some(schedule), Some(content)) => Some(schedule.min(content)),
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        };

        let Some(playlist_id) = selection.playlist_id else {
            if selection.layout_id.is_some() {
                return Err(ManifestError::UnsupportedPresentation);
            }
            return Ok(ResolvedPresentation {
                document: status_surface("Tilecast", "No content assigned.", "no_content")?,
                content: Vec::new(),
                selection,
                next_transition_ms,
            });
        };
        let playlist = ["playlist", "directFallbackPlaylist"]
            .into_iter()
            .filter_map(|key| self.document.get(key))
            .chain(self.document.get("playlists").and_then(Value::as_array).into_iter().flatten())
            .find(|playlist| playlist.get("id").and_then(Value::as_str) == Some(&playlist_id.to_string()))
            .ok_or(ManifestError::Reference)?;
        let source_items = playlist.get("items").and_then(Value::as_array).ok_or(ManifestError::Structure)?;
        let asset_values = self.document.get("assets").and_then(Value::as_array).ok_or(ManifestError::Structure)?;
        let mut items = Vec::with_capacity(source_items.len());
        let mut content_by_digest = BTreeMap::new();
        for item in source_items {
            if !available_at(item, now_ms)? {
                continue;
            }
            if item.get("layoutId").is_some_and(|id| !id.is_null()) {
                return Err(ManifestError::UnsupportedPresentation);
            }
            let asset_id: uuid::Uuid = item
                .get("assetId")
                .and_then(Value::as_str)
                .ok_or(ManifestError::Reference)?
                .parse()
                .map_err(|_| ManifestError::Reference)?;
            let variant_id: uuid::Uuid = item
                .get("variantId")
                .and_then(Value::as_str)
                .ok_or(ManifestError::Reference)?
                .parse()
                .map_err(|_| ManifestError::Reference)?;
            let asset = self
                .assets
                .iter()
                .find(|asset| asset.asset_id == asset_id && asset.variant_id == variant_id)
                .ok_or(ManifestError::Reference)?;
            let asset_value = asset_values
                .iter()
                .find(|value| {
                    value.get("assetId").and_then(Value::as_str) == Some(&asset_id.to_string())
                        && value.get("variantId").and_then(Value::as_str) == Some(&variant_id.to_string())
                })
                .ok_or(ManifestError::Reference)?;
            if !available_at(asset_value, now_ms)? {
                continue;
            }
            let kind = if asset.mime_type.starts_with("image/") {
                ItemKind::Image
            } else if asset.mime_type.starts_with("video/") {
                ItemKind::Video
            } else {
                return Err(ManifestError::UnsupportedPresentation);
            };
            let item_id = item.get("id").and_then(Value::as_str).ok_or(ManifestError::Structure)?;
            let duration_ms = match item.get("durationMs") {
                Some(Value::Number(value)) => value.as_u64(),
                None | Some(Value::Null) => None,
                _ => return Err(ManifestError::Structure),
            }
            .or_else(|| (kind == ItemKind::Image).then_some(10_000));
            let fit_mode = item
                .get("fitMode")
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "contain" | "cover" | "stretch"))
                .unwrap_or("contain");
            let transition = item
                .get("transition")
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "fade" | "crossfade"))
                .unwrap_or("none");
            let volume = item.get("volume").and_then(Value::as_f64).unwrap_or(0.5).clamp(0.0, 1.0);
            let audio_enabled = item.get("audioEnabled").and_then(Value::as_bool).unwrap_or(true);
            let item_id = SafeText::new(item_id.to_owned()).map_err(|_| ManifestError::Structure)?;
            let src = SafeText::new(content_uri(&asset.digest)).map_err(|_| ManifestError::Structure)?;
            let mime_type = SafeText::new(asset.mime_type.clone()).map_err(|_| ManifestError::Asset)?;
            content_by_digest.entry(asset.digest).or_insert(ContentRef {
                sha256: asset.digest,
                size_bytes: asset.size_bytes,
                mime_type,
            });
            let number = |key: &str| -> Result<Option<u64>, ManifestError> {
                match item.get(key) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::Number(value)) => value.as_u64().map(Some).ok_or(ManifestError::Structure),
                    _ => Err(ManifestError::Structure),
                }
            };
            items.push(PresentationItem {
                id: item_id,
                kind,
                src,
                duration_ms,
                fit_mode: token_or(Some(fit_mode), "contain")?,
                transition: Some(token_or(Some(transition), "none")?),
                audio_enabled,
                volume,
                video_start_offset_ms: number("videoStartOffsetMs")?,
                video_end_offset_ms: number("videoEndOffsetMs")?,
                viewport: self.document.get("viewport").cloned(),
                website: None,
                widget: None,
                layout: None,
            });
        }
        if items.is_empty() {
            return Ok(ResolvedPresentation {
                document: PresentationDocument::Unavailable(StatusSurface {
                    title: SafeText::new("Content unavailable".to_owned()).map_err(|_| ManifestError::Structure)?,
                    message: SafeText::new("Assigned content is not currently available.".to_owned())
                        .map_err(|_| ManifestError::Structure)?,
                    background_color: None,
                    text_color: None,
                    logo_src: None,
                    footer_text: None,
                    status: Some(SafeText::new("unavailable".to_owned()).map_err(|_| ManifestError::Structure)?),
                }),
                content: Vec::new(),
                selection,
                next_transition_ms,
            });
        }
        let document = PresentationDocument::Playing {
            items,
            takeover: selection.source == Source::Takeover,
            generation: self.version as u64,
            synchronized: false,
        };
        let content = content_by_digest.into_values().collect();
        Ok(ResolvedPresentation { document, content, selection, next_transition_ms })
    }
}

/// A stored candidate is usable offline only while every required object is
/// still present and verified. Opening a suspect CAS record re-hashes it.
pub async fn verify_cached(
    context: &DaemonContext,
    candidate: &Candidate,
) -> Result<Vec<Sha256Digest>, PreparationError> {
    let store = context.cas.clone().ok_or(PreparationError::StoreUnavailable)?;
    let mut digests = BTreeSet::new();
    for asset in &candidate.required_downloads {
        let Some((_, record)) = store.open_verified(&asset.digest).await? else {
            return Err(PreparationError::SizeMismatch);
        };
        if record.size_bytes != asset.size_bytes {
            return Err(PreparationError::SizeMismatch);
        }
        digests.insert(asset.digest);
    }
    Ok(digests.into_iter().collect())
}

pub fn pin_holder(version: i64) -> String {
    format!("server-manifest-v{version}")
}

pub fn activation_grace_ms(document: &Value) -> i64 {
    let seconds = document
        .get("activationGraceSeconds")
        .and_then(Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .unwrap_or(DEFAULT_ACTIVATION_GRACE_SECONDS)
        .clamp(1, 3_600);
    (seconds * 1_000) as i64
}

#[derive(Debug, thiserror::Error)]
pub enum PreparationError {
    #[error("the content store is unavailable")]
    StoreUnavailable,
    #[error("the manifest requires verified streaming, which this renderer cannot provide")]
    StreamingUnsupported,
    #[error("a manifest download path is invalid")]
    InvalidDownloadPath,
    #[error("the content store failed: {0}")]
    Store(#[from] CasError),
    #[error("a required media variant could not be fetched: {0}")]
    Fetch(#[from] FetchError),
    #[error("a cached media variant has the wrong size")]
    SizeMismatch,
}

/// Fetches the exact variants needed before activation. Peer claims choose
/// only the source order; the CAS verifies every byte before returning it.
/// The caller persists and pins a candidate only after this succeeds.
pub async fn prepare(
    context: &DaemonContext,
    server: &AuthenticatedServer,
    candidate: &Candidate,
) -> Result<Vec<Sha256Digest>, PreparationError> {
    if !candidate.streaming_assets.is_empty() {
        return Err(PreparationError::StreamingUnsupported);
    }
    let store = context.cas.clone().ok_or(PreparationError::StoreUnavailable)?;
    let fetcher = Fetcher::new(store.clone(), 2);
    let mut digests = BTreeSet::new();
    for asset in &candidate.required_downloads {
        if let Some((_, record)) = store.open_verified(&asset.digest).await? {
            if record.size_bytes != asset.size_bytes {
                return Err(PreparationError::SizeMismatch);
            }
            digests.insert(asset.digest);
            continue;
        }
        let request = FetchRequest {
            digest: asset.digest,
            size_bytes: asset.size_bytes,
            meta: IngestMeta {
                domain: Domain::Media,
                content_type: Some(asset.mime_type.clone()),
                // A signed delivery policy must authorize peer serving before
                // this local reference can be advertised to other screens.
                peerable: false,
                source: SourceKind::Origin,
            },
        };
        let mut sources = fabric::peer_sources(context, &asset.digest, asset.size_bytes).await;
        let origin = OriginBlobSource::new(server.clone(), &asset.download_path)
            .map_err(|_| PreparationError::InvalidDownloadPath)?;
        sources.push(Arc::new(origin) as Arc<dyn BlobSource>);
        let observer = fabric::peer_observer(context, asset.digest);
        let record = fetcher.fetch(&request, &sources, Some(&observer)).await?;
        if record.size_bytes != asset.size_bytes {
            return Err(PreparationError::SizeMismatch);
        }
        digests.insert(asset.digest);
    }
    for digest in &digests {
        if store.verified_path(digest).await?.is_none() {
            return Err(PreparationError::SizeMismatch);
        }
    }
    Ok(digests.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: &str = "c791e841-b6ab-4e3f-a9f5-3b763cb47bd9";
    const ASSET: &str = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
    const VARIANT: &str = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";
    const ITEM: &str = "ca48c671-8e48-4bad-ab75-6125064d0f5c";
    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn candidate() -> Value {
        serde_json::json!({
            "schemaVersion": 11, "manifestVersion": 8, "screenId": SCREEN, "mode": "presentation",
            "assets": [{"assetId": ASSET, "variantId": VARIANT, "sha256": DIGEST,
                "fileSize": 100, "mimeType": "image/png",
                "downloadPath": format!("/api/v1/player/assets/{ASSET}/variants/{VARIANT}")}],
            "playlist": {"id": "e719e602-3b8f-4a2f-bec5-24b16e14725f", "items": [{
                "id": ITEM, "assetId": ASSET, "variantId": VARIANT,
                "assetType": "image", "deliveryPolicy": "automatic", "durationMs": 10000,
                "fitMode": "cover", "transition": "fade", "audioEnabled": true, "volume": 0.8
            }]},
            "playlists": []
        })
    }

    #[test]
    fn accepts_exact_server_asset_identity() {
        let parsed = Candidate::parse(candidate(), SCREEN.parse().unwrap()).unwrap();
        assert_eq!(parsed.version, 8);
        assert_eq!(parsed.assets[0].digest.to_hex(), DIGEST);
        assert_eq!(parsed.required_downloads, parsed.assets);
        assert!(parsed.streaming_assets.is_empty());
    }

    #[test]
    fn resolves_server_playlist_into_shared_renderer_contract() {
        let candidate = Candidate::parse(candidate(), SCREEN.parse().unwrap()).unwrap();
        let resolved = candidate.presentation(1_000).unwrap();
        let PresentationDocument::Playing { items, takeover, generation, .. } = resolved.document else {
            panic!("assigned playlist should produce a playing presentation");
        };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id.as_str(), ITEM);
        assert_eq!(items[0].kind, ItemKind::Image);
        assert_eq!(items[0].src.as_str(), format!("tcmedia://sha256/{DIGEST}"));
        assert_eq!(items[0].duration_ms, Some(10_000));
        assert_eq!(items[0].fit_mode.as_str(), "cover");
        assert_eq!(items[0].transition.as_ref().unwrap().as_str(), "fade");
        assert!(!takeover);
        assert_eq!(generation, 8);
        assert_eq!(resolved.content.len(), 1);
        assert_eq!(resolved.content[0].sha256.to_hex(), DIGEST);
    }

    #[test]
    fn availability_is_half_open_and_rechecks_at_its_boundary() {
        let mut value = candidate();
        value["playlist"]["items"][0]["availableFrom"] = serde_json::json!("1970-01-01T00:00:02Z");
        let candidate = Candidate::parse(value, SCREEN.parse().unwrap()).unwrap();
        let before = candidate.presentation(1_000).unwrap();
        assert!(matches!(before.document, PresentationDocument::Unavailable(_)));
        assert_eq!(before.next_transition_ms, Some(2_000));
        let at_boundary = candidate.presentation(2_000).unwrap();
        assert!(matches!(at_boundary.document, PresentationDocument::Playing { .. }));
    }

    #[test]
    fn rejects_wrong_target_and_missing_variant() {
        assert_eq!(Candidate::parse(candidate(), ScreenId::new_random()).unwrap_err(), ManifestError::Screen);
        let mut value = candidate();
        value["playlist"]["items"][0]["variantId"] = Value::Null;
        assert_eq!(Candidate::parse(value, SCREEN.parse().unwrap()).unwrap_err(), ManifestError::Reference);
    }

    #[test]
    fn rejects_untrusted_download_paths_and_conflicting_hash_claims() {
        let mut value = candidate();
        value["assets"][0]["downloadPath"] = serde_json::json!("https://other.example/media");
        assert_eq!(Candidate::parse(value, SCREEN.parse().unwrap()).unwrap_err(), ManifestError::Asset);

        let mut value = candidate();
        let mut second = value["assets"][0].clone();
        second["variantId"] = serde_json::json!("473f4f7b-2ac9-47a3-8872-f0a309ecae83");
        second["fileSize"] = serde_json::json!(101);
        value["assets"].as_array_mut().unwrap().push(second);
        assert_eq!(Candidate::parse(value, SCREEN.parse().unwrap()).unwrap_err(), ManifestError::Asset);
    }

    #[test]
    fn stream_policy_is_explicit_and_required_fallbacks_are_exact() {
        let mut value = candidate();
        value["playlist"]["items"][0]["deliveryPolicy"] = serde_json::json!("stream");
        value["branding"] = serde_json::json!({"logoAssetId": ASSET, "logoVariantId": VARIANT});
        let parsed = Candidate::parse(value, SCREEN.parse().unwrap()).unwrap();
        assert_eq!(parsed.required_downloads.len(), 1, "branding is cached independently of the item policy");
        assert_eq!(parsed.streaming_assets.len(), 1);

        let mut value = candidate();
        value["branding"] = serde_json::json!({"logoAssetId": ASSET});
        assert_eq!(Candidate::parse(value, SCREEN.parse().unwrap()).unwrap_err(), ManifestError::Reference);
    }

    #[test]
    fn automatic_video_uses_the_existing_download_threshold() {
        let mut value = candidate();
        value["assets"][0]["mimeType"] = serde_json::json!("video/mp4");
        value["assets"][0]["fileSize"] = serde_json::json!(AUTOMATIC_VIDEO_LIMIT_BYTES + 1);
        let parsed = Candidate::parse(value, SCREEN.parse().unwrap()).unwrap();
        assert!(parsed.required_downloads.is_empty());
        assert_eq!(parsed.streaming_assets.len(), 1);

        let mut value = candidate();
        value["assets"][0]["mimeType"] = serde_json::json!("video/mp4");
        value["assets"][0]["fileSize"] = serde_json::json!(AUTOMATIC_VIDEO_LIMIT_BYTES);
        let parsed = Candidate::parse(value, SCREEN.parse().unwrap()).unwrap();
        assert_eq!(parsed.required_downloads.len(), 1);
        assert!(parsed.streaming_assets.is_empty());
    }

    #[test]
    fn activation_grace_uses_server_default_and_clamps_to_the_player_bounds() {
        assert_eq!(activation_grace_ms(&serde_json::json!({})), 30_000);
        assert_eq!(activation_grace_ms(&serde_json::json!({"activationGraceSeconds": 0})), 30_000);
        assert_eq!(activation_grace_ms(&serde_json::json!({"activationGraceSeconds": 0.5})), 30_000);
        assert_eq!(activation_grace_ms(&serde_json::json!({"activationGraceSeconds": 9_000})), 3_600_000);
        assert_eq!(activation_grace_ms(&serde_json::json!({"activationGraceSeconds": 1})), 1_000);
    }
}
