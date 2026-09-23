//! Validation boundary for the existing server-compiled player manifest.
//!
//! The server remains the presentation compiler. This module checks the
//! identities and download claims that Edge will use before any candidate can
//! enter the CAS preparation and activation path.

use std::collections::{BTreeMap, BTreeSet};

use edge_protocol::{ScreenId, Sha256Digest};
use edge_server::origin::OriginBlobSource;
use serde::Deserialize;
use serde_json::Value;

const SCHEMA_VERSION: u32 = 11;
const MAX_ASSETS: usize = 1024;
const MAX_PLAYLISTS: usize = 128;
const MAX_ITEMS: usize = 4096;
const AUTOMATIC_VIDEO_LIMIT_BYTES: u64 = 256 * 1024 * 1024;

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
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: &str = "c791e841-b6ab-4e3f-a9f5-3b763cb47bd9";
    const ASSET: &str = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
    const VARIANT: &str = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";
    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn candidate() -> Value {
        serde_json::json!({
            "schemaVersion": 11, "manifestVersion": 8, "screenId": SCREEN, "mode": "presentation",
            "assets": [{"assetId": ASSET, "variantId": VARIANT, "sha256": DIGEST,
                "fileSize": 100, "mimeType": "image/png",
                "downloadPath": format!("/api/v1/player/assets/{ASSET}/variants/{VARIANT}")}],
            "playlist": {"items": [{"assetId": ASSET, "variantId": VARIANT,
                "assetType": "image", "deliveryPolicy": "automatic"}]},
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
}
