//! Native manifest identity and resource claims; presentation fields remain opaque.
use crate::OriginBlobSource;
use player_types::{ScreenId, Sha256Digest};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const NATIVE_MANIFEST_SCHEMAS: std::ops::RangeInclusive<u32> = 11..=18;
const MAX_ASSETS: usize = 1024;
const MAX_PLAYLISTS: usize = 128;
const MAX_ITEMS: usize = 4096;
const MAX_LAYOUTS: usize = 128;
const MAX_WIDGETS: usize = 256;
const MAX_DATA_SOURCES: usize = 256;
const MAX_PLUGINS: usize = 64;
/// Server bundle cap (`MaxWidgetPayloadBytes`); a larger claim is corrupt.
const MAX_BUNDLE_BYTES: u64 = 1 << 20;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestAsset {
    pub asset_id: uuid::Uuid,
    pub variant_id: uuid::Uuid,
    pub digest: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: String,
    pub download_path: String,
}

/// One external Widget player bundle claim: the verified package digest
/// it was built from plus the bundle hash, size, and download path the
/// Player verifies before activation. Presentation fields stay opaque;
/// only this explicit resource metadata is extracted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestBundle {
    pub package_id: String,
    pub package_digest: Sha256Digest,
    pub digest: Sha256Digest,
    pub size_bytes: u64,
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
    /// Every claimed Widget bundle must be verified alongside the variants.
    pub required_bundles: Vec<ManifestBundle>,
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
    #[error("manifest contains an invalid Widget bundle claim")]
    Bundle,
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
            Self::Bundle => "manifest_bundle_invalid",
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

fn valid_package_id(value: &str) -> bool {
    // Mirrors the server's qualified package identity loosely: bounded,
    // dotted, dotless segments. The exact registry is the server's; Core
    // only refuses what is structurally unusable as evidence.
    if value.len() < 3 || value.len() > 128 || !value.contains('.') {
        return false;
    }
    value.split('.').all(|segment| {
        !segment.is_empty()
            && segment.len() <= 64
            && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            && segment.bytes().next().is_some_and(|byte| byte.is_ascii_alphanumeric())
    })
}

/// Extracts one Widget's external bundle claim, if it carries a package
/// block. Everything else about the presentation stays opaque. A
/// malformed claim fails the manifest: a Player must never activate a
/// component it cannot verify.
fn extract_bundle(widget: &Value) -> Result<Option<ManifestBundle>, NativeManifestError> {
    let Some(package) = widget.pointer("/presentation/component/package").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let object = package.as_object().ok_or(NativeManifestError::Bundle)?;
    let package_id = object.get("packageId").and_then(Value::as_str).ok_or(NativeManifestError::Bundle)?;
    if !valid_package_id(package_id) {
        return Err(NativeManifestError::Bundle);
    }
    let package_digest = object
        .get("digest")
        .and_then(Value::as_str)
        .and_then(|value| value.strip_prefix("sha256:"))
        .ok_or(NativeManifestError::Bundle)
        .and_then(|hex| Sha256Digest::parse(hex).map_err(|_| NativeManifestError::Bundle))?;
    let digest = object
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or(NativeManifestError::Bundle)
        .and_then(|hex| Sha256Digest::parse(hex).map_err(|_| NativeManifestError::Bundle))?;
    let size_bytes = u64::try_from(object.get("fileSize").and_then(Value::as_i64).ok_or(NativeManifestError::Bundle)?)
        .map_err(|_| NativeManifestError::Bundle)?;
    if size_bytes == 0 || size_bytes > MAX_BUNDLE_BYTES {
        return Err(NativeManifestError::Bundle);
    }
    let download_path = object.get("downloadPath").and_then(Value::as_str).ok_or(NativeManifestError::Bundle)?;
    if crate::OriginBlobSource::validate_path(download_path).is_err() {
        return Err(NativeManifestError::Bundle);
    }
    Ok(Some(ManifestBundle {
        package_id: package_id.to_owned(),
        package_digest,
        digest,
        size_bytes,
        download_path: download_path.to_owned(),
    }))
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
        // Package blocks exist only from v18. An older document carrying
        // one is corrupt: no released server emits that combination.
        if wire.schema_version < 18
            && wire.widgets.iter().any(|widget| widget.pointer("/presentation/component/package").is_some())
        {
            return Err(NativeManifestError::Schema);
        }
        let mut required_bundles = Vec::new();
        let mut seen_bundle = BTreeSet::new();
        for widget in &wire.widgets {
            let Some(bundle) = extract_bundle(widget)? else { continue };
            // One CAS object per bundle digest; the package digest is
            // activation evidence, not a second fetch.
            if !seen_bundle.insert(bundle.digest) {
                continue;
            }
            required_bundles.push(bundle);
        }
        let required_downloads = assets.clone();
        Ok(Self {
            digest,
            document,
            version: wire.manifest_version,
            screen_id: wire.screen_id,
            assets,
            required_downloads,
            required_bundles,
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

    fn bundle_document(screen: ScreenId, schema: u32) -> Value {
        let widget = uuid::Uuid::from_u128(10);
        let bundle = Sha256Digest::of(b"widget code");
        let package = Sha256Digest::of(b"package");
        json!({
            "schemaVersion":schema, "manifestVersion":3, "screenId":screen, "mode":"presentation",
            "assets":[],
            "playlist":{"id":uuid::Uuid::from_u128(5),"items":[{"id":uuid::Uuid::from_u128(6),
                "assetId":widget,"assetType":"widget","deliveryPolicy":"download"}]},
            "playlists":[],"schedules":[],"dataSources":[],"plugins":[],
            "widgets":[{"assetId":widget,"name":"Scores","provider":"acme.athletics.scoreboard",
                "presentation":{"schemaVersion":3,"kind":"component",
                    "requiredCapabilities":{"widget.external-runtime":1},
                    "component":{"type":"acme.athletics.scoreboard","version":2,
                        "config":{},"dataSources":[],"media":[],"empty":"render",
                        "package":{"packageId":"acme.athletics",
                            "digest":format!("sha256:{}", package.to_hex()),
                            "sha256":bundle.to_hex(),"fileSize":11,
                            "downloadPath":"/api/v1/player/packages/acme.athletics/widgets/scoreboard"}}}}],
        })
    }

    #[test]
    fn external_bundle_claims_are_extracted_while_presentations_stay_opaque() {
        let screen = ScreenId::from_uuid(uuid::Uuid::from_u128(1));
        let bundle = Sha256Digest::of(b"widget code");
        let package = Sha256Digest::of(b"package");
        let document = bundle_document(screen, 18);
        let identity = crate::manifest_digest(&document);
        let prepared = NativeManifest::parse(document.clone(), screen, identity).unwrap();
        assert_eq!(prepared.document, document);
        assert_eq!(prepared.required_bundles.len(), 1);
        let claim = &prepared.required_bundles[0];
        assert_eq!(claim.package_id, "acme.athletics");
        assert_eq!(claim.package_digest, package);
        assert_eq!(claim.digest, bundle);
        assert_eq!(claim.size_bytes, 11);
        assert_eq!(claim.download_path, "/api/v1/player/packages/acme.athletics/widgets/scoreboard");
        // One object per bundle digest no matter how many Widgets share it.
        let mut shared = document.clone();
        shared["widgets"] = json!([shared["widgets"][0].clone(), shared["widgets"][0].clone()]);
        let identity = crate::manifest_digest(&shared);
        let prepared = NativeManifest::parse(shared, screen, identity).unwrap();
        assert_eq!(prepared.required_bundles.len(), 1);
    }

    #[test]
    fn malformed_bundle_claims_fail_the_manifest() {
        let screen = ScreenId::from_uuid(uuid::Uuid::from_u128(1));
        let mutate = |key: &str, value: Value| {
            let mut document = bundle_document(screen, 18);
            document["widgets"][0]["presentation"]["component"]["package"][key] = value;
            let identity = crate::manifest_digest(&document);
            NativeManifest::parse(document, screen, identity)
        };
        for (key, value) in [
            ("packageId", json!("not a package")),
            ("packageId", json!("tilecast")),
            ("digest", json!("deadbeef")),
            ("digest", json!("sha256:xyz")),
            ("sha256", json!("xyz")),
            ("sha256", json!("00")),
            ("fileSize", json!(0)),
            ("fileSize", json!(2 * 1024 * 1024)),
            ("downloadPath", json!("/api/v1/system/identity")),
            ("downloadPath", json!("/api/v1/player/../escape")),
        ] {
            assert!(matches!(mutate(key, value), Err(NativeManifestError::Bundle)), "claim with bad {key} parsed");
        }
        let mut missing = bundle_document(screen, 18);
        missing["widgets"][0]["presentation"]["component"]["package"].as_object_mut().unwrap().remove("sha256");
        let identity = crate::manifest_digest(&missing);
        assert!(matches!(NativeManifest::parse(missing, screen, identity), Err(NativeManifestError::Bundle)));
        // A package block below v18 is corrupt: no server emits it there.
        let older = bundle_document(screen, 17);
        let identity = crate::manifest_digest(&older);
        assert!(matches!(NativeManifest::parse(older, screen, identity), Err(NativeManifestError::Schema)));
    }
}
