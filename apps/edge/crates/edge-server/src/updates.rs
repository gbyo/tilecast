//! The ordinary Player update contracts (`apps/server/internal/httpapi/updates.go`):
//! release metadata for a targeted screen, and deployment status reports.
//!
//! Metadata is validated here and nothing more: the caller verifies the
//! signed envelope with the Tilecast key before it trusts any field.

use base64::Engine as _;
use serde_json::Value;

/// Far above a real envelope (about 1 KiB); the same bound the helper and the
/// server apply.
pub const MAX_SIGNED_MANIFEST_BYTES: usize = 16 * 1024;
const MAX_SIGNATURE_BYTES: usize = 1024;

/// `GET /player/updates/{releaseId}` for an Edge release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateMetadata {
    pub release_id: uuid::Uuid,
    pub player_family: String,
    pub architecture: String,
    pub version_code: u64,
    pub version_name: String,
    pub artifact_size_bytes: u64,
    pub artifact_sha256: String,
    pub artifact_path: String,
    /// The exact signed envelope bytes.
    pub signed_manifest: Vec<u8>,
    /// Its base64 signature text.
    pub manifest_signature: Vec<u8>,
}

fn text<'a>(data: &'a Value, key: &str, max: usize) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= max)
}

/// Parses the `data` of a metadata answer. `None` for anything that is not a
/// well-formed Edge release answer.
pub fn update_metadata(data: &Value) -> Option<UpdateMetadata> {
    let signed_manifest = base64::engine::general_purpose::STANDARD
        .decode(text(data, "signedManifest", MAX_SIGNED_MANIFEST_BYTES.div_ceil(3) * 4)?)
        .ok()
        .filter(|bytes| bytes.len() <= MAX_SIGNED_MANIFEST_BYTES)?;
    Some(UpdateMetadata {
        release_id: uuid::Uuid::parse_str(text(data, "releaseId", 64)?).ok()?,
        player_family: text(data, "playerFamily", 32)?.to_owned(),
        architecture: text(data, "architecture", 32)?.to_owned(),
        version_code: data.get("versionCode").and_then(Value::as_u64)?,
        version_name: text(data, "versionName", 64)?.to_owned(),
        artifact_size_bytes: data.get("artifactSizeBytes").and_then(Value::as_u64)?,
        artifact_sha256: text(data, "artifactSha256", 64)?.to_owned(),
        artifact_path: text(data, "artifactPath", 512)?.to_owned(),
        signed_manifest,
        manifest_signature: text(data, "manifestSignature", MAX_SIGNATURE_BYTES)?.as_bytes().to_vec(),
    })
}

/// A status report (`POST /player/update-deployments/{id}/status`). The
/// server accepts `downloading`, `downloaded`, `verifying`, `ready`,
/// `installing`, `reconnecting`, `failed`, and for Tilecast Edge the
/// explicit confirmation `succeeded`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateReport {
    pub state: &'static str,
    pub downloaded_bytes: u64,
    pub installer_status: Option<String>,
    pub error: Option<String>,
}

impl UpdateReport {
    pub fn body(&self) -> Value {
        let mut body = serde_json::json!({ "state": self.state, "downloadedBytes": self.downloaded_bytes });
        if let Some(status) = &self.installer_status {
            body["installerStatus"] = Value::String(status.chars().take(64).collect());
        }
        if let Some(error) = &self.error {
            body["error"] = Value::String(error.chars().take(240).collect());
        }
        body
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateReportOutcome {
    Accepted,
    /// `409`: the deployment is cancelled or complete for this screen.
    Closed,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer() -> Value {
        serde_json::json!({
            "releaseId": "0f6b2f0e-0001-4c55-9a53-27f2f0b2f0aa", "artifactId": "tilecast-edge-0.2.0-x86_64.tar.zst",
            "platform": "linux", "playerFamily": "edge", "architecture": "x86_64", "versionCode": 2000,
            "versionName": "0.2.0", "artifactSizeBytes": 4096, "artifactSha256": "a".repeat(64),
            "artifactPath": "/api/v1/player/updates/0f6b2f0e-0001-4c55-9a53-27f2f0b2f0aa/artifact",
            "signedManifest": "eyJhIjoxfQ==", "manifestSignature": "c2ln", "stateSchemaVersion": 6,
        })
    }

    #[test]
    fn an_edge_answer_parses_and_keeps_the_exact_envelope() {
        let metadata = update_metadata(&answer()).unwrap();
        assert_eq!(metadata.signed_manifest, br#"{"a":1}"#);
        assert_eq!(metadata.version_code, 2000);
    }

    #[test]
    fn a_non_edge_or_oversized_answer_is_refused() {
        let mut appimage = answer();
        appimage.as_object_mut().unwrap().remove("signedManifest");
        assert!(update_metadata(&appimage).is_none(), "an Electron answer has no envelope");
        let mut huge = answer();
        huge["signedManifest"] = Value::String("A".repeat(40_000));
        assert!(update_metadata(&huge).is_none());
        let mut bad = answer();
        bad["releaseId"] = Value::String("../x".into());
        assert!(update_metadata(&bad).is_none());
    }

    #[test]
    fn reports_are_bounded() {
        let report = UpdateReport {
            state: "failed",
            downloaded_bytes: 1,
            installer_status: Some("rolled_back".into()),
            error: Some("x".repeat(500)),
        };
        assert_eq!(report.body()["error"].as_str().unwrap().len(), 240);
    }
}
