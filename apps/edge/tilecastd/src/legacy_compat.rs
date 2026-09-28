//! `tilecastd check-legacy-compat`: M7 migration step 4.
//!
//! Before the migrator stops the legacy player, it checks the presentation
//! that the legacy player shows now against the capability profile of the
//! *installed* `tilecastd` binary. A presentation that Edge would refuse
//! must not be cut over: the screen would go from working content to the
//! "Presentation unavailable" surface.
//!
//! The check is offline and read-only. It reads one file,
//! `manifest-active.json`, from a copy of the legacy data directory. It
//! opens no database, sends nothing and needs no credential. The migrator
//! runs it as the `tilecast` account in `tilecast-edge-compat.service`,
//! which has no network.

use std::collections::BTreeMap;
use std::path::Path;

use edge_protocol::{ScreenId, Sha256Digest};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::manifest::{Candidate, incompatibilities};

const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompatReport {
    /// `compatible`, `incompatible`, `no_cached_presentation` or `invalid`.
    pub outcome: &'static str,
    pub manifest_version: Option<i64>,
    pub reasons: Vec<CompatReason>,
    /// Total size of the distinct media that the presentation lists. The
    /// migrator uses it to decide whether it can copy the cached media.
    pub media_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompatReason {
    pub code: &'static str,
    pub detail: String,
}

impl CompatReport {
    /// Cutover may continue: the presentation is compatible, or there is no
    /// cached presentation to lose.
    pub fn allows_cutover(&self) -> bool {
        matches!(self.outcome, "compatible" | "no_cached_presentation")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredManifest {
    manifest: Value,
    #[serde(default)]
    screen_id: Option<String>,
}

pub fn check(legacy_dir: &Path) -> std::io::Result<CompatReport> {
    let report = |outcome, reasons, manifest_version, media_bytes| CompatReport {
        outcome,
        manifest_version,
        reasons,
        media_bytes,
    };
    let invalid = |code: &'static str, detail: &str| {
        report("invalid", vec![CompatReason { code, detail: detail.into() }], None, 0)
    };
    let Some(bytes) = edge_platform::fs::read_regular(&legacy_dir.join("manifest-active.json"), MAX_MANIFEST_BYTES)?
    else {
        return Ok(report("no_cached_presentation", vec![], None, 0));
    };
    let Ok(stored) = serde_json::from_slice::<StoredManifest>(&bytes) else {
        return Ok(invalid("legacy_state_invalid", "manifest-active.json is not a stored manifest"));
    };
    let Some(screen) = stored.screen_id.as_deref().and_then(|id| id.parse::<ScreenId>().ok()) else {
        return Ok(invalid("legacy_state_invalid", "manifest-active.json has no screen identity"));
    };
    let digest = Sha256Digest::of(&bytes);
    let candidate = match Candidate::parse(stored.manifest, screen, digest) {
        Ok(candidate) => candidate,
        Err(error) => return Ok(invalid(error.reason_code(), &error.to_string())),
    };
    let media: BTreeMap<Sha256Digest, u64> =
        candidate.required_downloads.iter().map(|asset| (asset.digest, asset.size_bytes)).collect();
    let media_bytes = media.values().fold(0u64, |sum, size| sum.saturating_add(*size));
    let reasons: Vec<CompatReason> = incompatibilities(&candidate.document, &candidate.assets)
        .into_iter()
        .map(|reason| CompatReason { code: reason.code(), detail: reason.to_string() })
        .collect();
    let outcome = if reasons.is_empty() { "compatible" } else { "incompatible" };
    Ok(report(outcome, reasons, Some(candidate.version), media_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: &str = "c791e841-b6ab-4e3f-a9f5-3b763cb47bd9";
    const ASSET: &str = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
    const VARIANT: &str = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";

    fn manifest() -> Value {
        serde_json::json!({
            "schemaVersion": 11, "manifestVersion": 8, "screenId": SCREEN, "mode": "presentation",
            "assets": [{"assetId": ASSET, "variantId": VARIANT,
                "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "fileSize": 100, "mimeType": "image/png",
                "downloadPath": format!("/api/v1/player/assets/{ASSET}/variants/{VARIANT}")}],
            "playlist": {"id": "e719e602-3b8f-4a2f-bec5-24b16e14725f", "items": [{
                "id": "ca48c671-8e48-4bad-ab75-6125064d0f5c", "assetId": ASSET, "variantId": VARIANT,
                "assetType": "image", "deliveryPolicy": "automatic", "durationMs": 10000,
                "fitMode": "cover", "transition": "fade", "audioEnabled": true, "volume": 0.8
            }]},
            "playlists": [], "schedules": [], "websites": [], "widgets": [], "dataSources": [],
            "plugins": [], "layouts": []
        })
    }

    fn write(dir: &Path, manifest: Value, screen: &str) {
        let stored = serde_json::json!({"manifest": manifest, "etag": null, "storedAt": "2026-01-01T00:00:00Z",
            "installationId": "d5b3b6f5-5b0c-4a36-9f27-9d8a4a3c2e11", "screenId": screen,
            "normalizedServerUrl": "https://signs.example.org"});
        std::fs::write(dir.join("manifest-active.json"), serde_json::to_vec(&stored).unwrap()).unwrap();
    }

    #[test]
    fn a_compatible_presentation_allows_cutover_and_reports_its_media() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(check(dir.path()).unwrap().outcome, "no_cached_presentation");
        assert!(check(dir.path()).unwrap().allows_cutover());
        write(dir.path(), manifest(), SCREEN);
        let report = check(dir.path()).unwrap();
        assert_eq!((report.outcome, report.manifest_version, report.media_bytes), ("compatible", Some(8), 100));
        assert!(report.allows_cutover());
    }

    #[test]
    fn an_incompatible_or_invalid_presentation_stops_the_cutover() {
        let dir = tempfile::tempdir().unwrap();
        let mut value = manifest();
        value["plugins"] = serde_json::json!([{"id": "ca48c671-8e48-4bad-ab75-6125064d0f5c",
            "type": "air_quality", "version": 1, "config": {}}]);
        write(dir.path(), value, SCREEN);
        let report = check(dir.path()).unwrap();
        assert_eq!(report.outcome, "incompatible");
        assert_eq!(report.reasons[0].code, "presentation_incompatible_plugin");
        assert!(!report.allows_cutover());

        write(dir.path(), manifest(), "00000000-0000-4000-8000-000000000000");
        let report = check(dir.path()).unwrap();
        assert_eq!((report.outcome, report.reasons[0].code), ("invalid", "manifest_wrong_screen"));
        std::fs::write(dir.path().join("manifest-active.json"), b"not json").unwrap();
        assert_eq!(check(dir.path()).unwrap().outcome, "invalid");
    }

    #[test]
    fn a_linked_manifest_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        write(elsewhere.path(), manifest(), SCREEN);
        std::os::unix::fs::symlink(
            elsewhere.path().join("manifest-active.json"),
            dir.path().join("manifest-active.json"),
        )
        .unwrap();
        assert_eq!(check(dir.path()).unwrap().outcome, "no_cached_presentation");
    }
}
