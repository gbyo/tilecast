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
        let mut by_variant = BTreeSet::new();
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
                || !by_variant.insert((source.asset_id, source.variant_id))
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
                if !by_variant.contains(&(item.asset_id, variant)) {
                    return Err(ManifestError::Reference);
                }
            }
        }
        Ok(Self { document, version: wire.manifest_version, screen_id: wire.screen_id, assets })
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
            "playlist": {"items": [{"assetId": ASSET, "variantId": VARIANT, "assetType": "image"}]},
            "playlists": []
        })
    }

    #[test]
    fn accepts_exact_server_asset_identity() {
        let parsed = Candidate::parse(candidate(), SCREEN.parse().unwrap()).unwrap();
        assert_eq!(parsed.version, 8);
        assert_eq!(parsed.assets[0].digest.to_hex(), DIGEST);
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
}
