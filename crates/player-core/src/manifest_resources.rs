//! Native manifest identity and resource claims; presentation fields remain opaque.
use crate::OriginBlobSource;
use player_types::{ScreenId, Sha256Digest};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const NATIVE_MANIFEST_SCHEMAS: std::ops::RangeInclusive<u32> = 11..=16;
const MAX_ASSETS: usize = 1024;
const MAX_PLAYLISTS: usize = 128;
const MAX_ITEMS: usize = 4096;
const MAX_LAYOUTS: usize = 128;
const MAX_WIDGETS: usize = 256;
const MAX_DATA_SOURCES: usize = 256;
const MAX_PLUGINS: usize = 64;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestAsset {
    pub asset_id: uuid::Uuid,
    pub variant_id: uuid::Uuid,
    pub digest: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: String,
    pub download_path: String,
}

#[derive(Debug, Clone)]
pub struct NativeManifest {
    /// SHA-256 of the manifest's stable encoding ([`crate::manifest_digest`]).
    pub digest: Sha256Digest,
    pub document: Value,
    pub version: i64,
    pub screen_id: ScreenId,
    pub assets: Vec<ManifestAsset>,
    /// Every declared variant must be verified before this candidate is pending.
    pub required_downloads: Vec<ManifestAsset>,
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum NativeManifestError {
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
}

impl NativeManifestError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Structure => "manifest_structure_invalid",
            Self::Schema => "manifest_schema_unsupported",
            Self::Screen => "manifest_wrong_screen",
            Self::Bound => "manifest_bound_exceeded",
            Self::Asset => "manifest_asset_invalid",
            Self::Reference => "manifest_reference_invalid",
            Self::DeliveryPolicy => "manifest_delivery_policy_invalid",
            Self::Schedule => "manifest_schedule_invalid",
        }
    }
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
    #[serde(default)]
    layouts: Vec<Value>,
    #[serde(default)]
    widgets: Vec<Value>,
    #[serde(default)]
    data_sources: Vec<Value>,
    #[serde(default)]
    plugins: Vec<Value>,
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
) -> Result<Option<usize>, NativeManifestError> {
    let Some(asset) = value.get(asset_key).filter(|value| !value.is_null()) else { return Ok(None) };
    let asset: uuid::Uuid =
        asset.as_str().ok_or(NativeManifestError::Reference)?.parse().map_err(|_| NativeManifestError::Reference)?;
    let variant: uuid::Uuid = value
        .get(variant_key)
        .and_then(Value::as_str)
        .ok_or(NativeManifestError::Reference)?
        .parse()
        .map_err(|_| NativeManifestError::Reference)?;
    catalog.get(&(asset, variant)).copied().map(Some).ok_or(NativeManifestError::Reference)
}

fn check_layout(
    layout: &Value,
    catalog: &BTreeMap<(uuid::Uuid, uuid::Uuid), usize>,
) -> Result<(), NativeManifestError> {
    let document = layout.get("document").ok_or(NativeManifestError::Structure)?;
    layout.get("id").and_then(Value::as_str).ok_or(NativeManifestError::Structure)?;
    if let Some(canvas) = document.get("canvas") {
        exact_asset(canvas, "backgroundAssetId", "backgroundVariantId", catalog)?;
    }
    if let Some(placements) = document.get("placements") {
        let placements = placements.as_array().ok_or(NativeManifestError::Structure)?;
        if placements.len() > MAX_ITEMS {
            return Err(NativeManifestError::Bound);
        }
        for placement in placements {
            if placement.get("type").and_then(Value::as_str) == Some("asset") {
                exact_asset(placement, "assetId", "variantId", catalog)?;
            }
        }
    }
    Ok(())
}

impl NativeManifest {
    pub async fn verify_content(
        &self,
        store: &player_cas::ContentStore,
    ) -> Result<Vec<Sha256Digest>, crate::ManifestPreparationError> {
        crate::manifest_content::verify_content(store, self).await
    }

    pub async fn prepare_content<P: crate::ManifestSourcePlan>(
        &self,
        store: &player_cas::ContentStore,
        plan: &P,
    ) -> Result<Vec<Sha256Digest>, crate::ManifestPreparationError> {
        crate::manifest_content::prepare_content(store, plan, self).await
    }
    /// Re-validates a stored document (offline start, activation).
    pub fn parse(
        document: Value,
        expected_screen: ScreenId,
        digest: Sha256Digest,
    ) -> Result<Self, NativeManifestError> {
        if serde_json::to_vec(&document).map_or(true, |bytes| bytes.len() > player_client::client::MAX_MANIFEST_BYTES) {
            return Err(NativeManifestError::Bound);
        }
        let wire: WireManifest =
            serde_json::from_value(document.clone()).map_err(|_| NativeManifestError::Structure)?;
        if !NATIVE_MANIFEST_SCHEMAS.contains(&wire.schema_version)
            || wire.mode != "presentation"
            || wire.manifest_version < 0
        {
            return Err(NativeManifestError::Schema);
        }
        if wire.screen_id != expected_screen {
            return Err(NativeManifestError::Screen);
        }
        if wire.assets.len() > MAX_ASSETS
            || wire.playlists.len() > MAX_PLAYLISTS
            || wire.layouts.len() > MAX_LAYOUTS
            || wire.widgets.len() > MAX_WIDGETS
            || wire.data_sources.len() > MAX_DATA_SOURCES
            || wire.plugins.len() > MAX_PLUGINS
        {
            return Err(NativeManifestError::Bound);
        }
        let mut assets = Vec::with_capacity(wire.assets.len());
        let mut by_variant = BTreeMap::new();
        let mut by_digest = BTreeMap::new();
        for source in wire.assets {
            let digest =
                Sha256Digest::parse_legacy_case_insensitive(&source.sha256).map_err(|_| NativeManifestError::Asset)?;
            let size_bytes = u64::try_from(source.file_size).map_err(|_| NativeManifestError::Asset)?;
            if size_bytes == 0
                || source.mime_type.is_empty()
                || source.mime_type.len() > 127
                || !source.mime_type.is_ascii()
                || source.mime_type.bytes().any(|byte| byte.is_ascii_control())
                || OriginBlobSource::validate_path(&source.download_path).is_err()
                || by_variant.insert((source.asset_id, source.variant_id), assets.len()).is_some()
                || by_digest.insert(digest, size_bytes).is_some_and(|old| old != size_bytes)
            {
                return Err(NativeManifestError::Asset);
            }
            assets.push(ManifestAsset {
                asset_id: source.asset_id,
                variant_id: source.variant_id,
                digest,
                size_bytes,
                mime_type: source.mime_type,
                download_path: source.download_path,
            });
        }
        let widget_ids: BTreeSet<uuid::Uuid> = wire
            .widgets
            .iter()
            .filter_map(|widget| widget.get("assetId").and_then(Value::as_str).and_then(|id| id.parse().ok()))
            .collect();
        let layout_ids: BTreeSet<uuid::Uuid> = document
            .get("layouts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(["layout", "directFallbackLayout"].into_iter().filter_map(|key| document.get(key)))
            .filter_map(|layout| layout.get("id").and_then(Value::as_str).and_then(|id| id.parse().ok()))
            .collect();
        let mut item_count = 0;
        for playlist in wire.playlist.into_iter().chain(wire.direct_fallback_playlist).chain(wire.playlists) {
            item_count += playlist.items.len();
            if item_count > MAX_ITEMS {
                return Err(NativeManifestError::Bound);
            }
            for item in playlist.items {
                if !matches!(item.delivery_policy.as_str(), "download" | "stream" | "automatic") {
                    return Err(NativeManifestError::DeliveryPolicy);
                }
                if let Some(layout) = item.layout_id {
                    if !layout_ids.contains(&layout) {
                        return Err(NativeManifestError::Reference);
                    }
                    continue;
                }
                match item.asset_type.as_str() {
                    "widget" => {
                        if !widget_ids.contains(&item.asset_id) {
                            return Err(NativeManifestError::Reference);
                        }
                        continue;
                    }
                    "website" => continue,
                    _ => {}
                }
                let Some(variant) = item.variant_id else { return Err(NativeManifestError::Reference) };
                by_variant.get(&(item.asset_id, variant)).ok_or(NativeManifestError::Reference)?;
            }
        }
        if let Some(branding) = document.get("branding").filter(|value| !value.is_null()) {
            exact_asset(branding, "logoAssetId", "logoVariantId", &by_variant)?;
        }
        if let Some(websites) = document.get("websites") {
            for website in websites.as_array().ok_or(NativeManifestError::Structure)? {
                exact_asset(website, "fallbackImageAssetId", "fallbackVariantId", &by_variant)?;
            }
        }
        for key in ["layout", "directFallbackLayout"] {
            if let Some(layout) = document.get(key).filter(|value| !value.is_null()) {
                check_layout(layout, &by_variant)?;
            }
        }
        for layout in &wire.layouts {
            check_layout(layout, &by_variant)?;
        }
        for plugin in &wire.plugins {
            if plugin.get("type").and_then(Value::as_str) == Some("brand_bug")
                && let Some(config) = plugin.get("config")
            {
                exact_asset(config, "imageAssetId", "imageVariantId", &by_variant)?;
            }
        }
        crate::resolve(&document, 0).map_err(|_| NativeManifestError::Schedule)?;
        crate::resolve_display_policy(&document, 0).map_err(|_| NativeManifestError::Schedule)?;
        let required_downloads = assets.clone();
        Ok(Self {
            digest,
            document,
            version: wire.manifest_version,
            screen_id: wire.screen_id,
            assets,
            required_downloads,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn presentation_options_are_opaque_while_resource_claims_remain_validated() {
        let screen = ScreenId::from_uuid(uuid::Uuid::from_u128(1));
        let asset = uuid::Uuid::from_u128(2);
        let variant = uuid::Uuid::from_u128(3);
        let layout = uuid::Uuid::from_u128(4);
        let digest = Sha256Digest::of(b"verified bytes");
        let document = json!({
            "schemaVersion":11, "manifestVersion":1, "screenId":screen, "mode":"presentation",
            "assets":[{"assetId":asset,"variantId":variant,"sha256":digest,"fileSize":14,
                "mimeType":"image/png","downloadPath":format!("/api/v1/player/assets/{asset}/variants/{variant}")}],
            "playlist":{"id":uuid::Uuid::from_u128(5),"items":[{"id":uuid::Uuid::from_u128(6),
                "assetId":asset,"variantId":variant,"assetType":"image","deliveryPolicy":"download",
                "transition":"future-transition","fitMode":"future-fit","durationMs":1000}]},
            "playlists":[],"schedules":[],"widgets":[],"dataSources":[],"plugins":[],
            "websites":[{"futureWebsiteOption":{"value":true},"fallbackImageAssetId":asset,"fallbackVariantId":variant}],
            "layouts":[{"id":layout,"document":{"unknownLayoutProperty":{"nested":[1,2,3]},
                "canvas":{"backgroundAssetId":asset,"backgroundVariantId":variant},
                "placements":[{"type":"asset","assetId":asset,"variantId":variant,"futureVisualOption":true}]}}]
        });
        let identity = crate::manifest_digest(&document);
        let prepared = NativeManifest::parse(document.clone(), screen, identity).unwrap();
        assert_eq!(prepared.document, document);
        assert_eq!(prepared.required_downloads.len(), 1);
        assert_eq!(prepared.required_downloads[0].digest, digest);
        let mut invalid = document;
        invalid["layouts"][0]["document"]["canvas"]["backgroundVariantId"] = json!(uuid::Uuid::from_u128(99));
        assert!(matches!(NativeManifest::parse(invalid, screen, identity), Err(NativeManifestError::Reference)));
    }
}
