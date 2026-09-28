//! The signed update envelope (M10).
//!
//! The M7 release manifest signs every file of a release tree, but not the
//! archive that carries the tree to a screen. The envelope binds the
//! downloadable archive: its name, size and SHA-256, together with the
//! digest of the release manifest inside it and of its SBOM. It is signed
//! with the same Tilecast Ed25519 update key and in the same way (a base64
//! signature over the exact JSON bytes). There is no second key, no second
//! algorithm and no OpenPGP.
//!
//! Three parties verify it:
//!
//! 1. the Tilecast Server, before it accepts or caches the release
//!    (`apps/server/internal/updates`);
//! 2. `tilecastd`, before it downloads the archive, against the server's
//!    metadata and the `install_player_update` command;
//! 3. `tilecast-edge-update`, before it stages the archive: the envelope
//!    again, then the archive digest, then the release manifest inside it.
//!
//! The envelope is also a Tilecast Player update manifest: the server reads
//! it with the same fields as the Linux Player's (`artifactAssetName`,
//! `artifactSizeBytes`, `artifactSha256`) and uses `playerFamily` to keep
//! Edge and Electron releases apart.

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::manifest::{ReleaseError, hex, is_version_name, verify_signature, version_code};

pub const ENVELOPE_SCHEMA_VERSION: u32 = 1;
/// The Player release family of Tilecast Edge. The server also knows
/// `android` and `electron-linux`.
pub const PLAYER_FAMILY: &str = "edge";
pub const PLATFORM: &str = "linux";
pub const MAX_ENVELOPE_BYTES: usize = 16 * 1024;
pub const MAX_RELEASE_NOTES: usize = 4_000;
pub const MAX_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Architectures a release can be built for, in `std::env::consts::ARCH`
/// spelling (what `uname -m` prints).
pub const ARCHITECTURES: &[&str] = &["x86_64", "aarch64"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateEnvelope {
    pub schema_version: u32,
    pub product: String,
    pub player_family: String,
    pub platform: String,
    pub arch: String,
    pub version_name: String,
    pub version_code: u64,
    pub channel: String,
    #[serde(default)]
    pub release_notes: String,
    pub artifact_asset_name: String,
    pub artifact_size_bytes: u64,
    pub artifact_sha256: String,
    pub release_manifest_sha256: String,
    pub sbom_sha256: String,
    /// The highest `tilecastd` state database schema this release migrates to
    /// (`edge_state::supported_schema_version`). A screen whose database is
    /// newer refuses the release before activation.
    pub state_schema_version: u32,
}

impl UpdateEnvelope {
    /// The archive name the release build writes.
    pub fn expected_artifact_name(version_name: &str, arch: &str) -> String {
        format!("tilecast-edge-{version_name}-{arch}.tar.zst")
    }
}

/// An envelope whose signature verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedEnvelope {
    pub envelope: UpdateEnvelope,
    pub artifact: edge_protocol::Sha256Digest,
    pub envelope_sha256: String,
    pub envelope_bytes: Vec<u8>,
    pub signature_bytes: Vec<u8>,
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Verifies the signature over the exact envelope bytes, then parses and
/// validates them. The architecture is not compared with this machine's;
/// see [`VerifiedEnvelope::check_host`].
pub fn verify_envelope(bytes: &[u8], signature: &[u8], key: &[u8; 32]) -> Result<VerifiedEnvelope, ReleaseError> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(ReleaseError::Invalid("update envelope too large"));
    }
    if signature.len() > 1024 {
        return Err(ReleaseError::MissingSignature);
    }
    verify_signature(bytes, signature, key)?;
    let envelope: UpdateEnvelope =
        serde_json::from_slice(bytes).map_err(|_| ReleaseError::Invalid("not an update envelope"))?;
    validate(&envelope)?;
    let artifact = edge_protocol::Sha256Digest::parse(&envelope.artifact_sha256)
        .map_err(|_| ReleaseError::Invalid("invalid digest"))?;
    Ok(VerifiedEnvelope {
        envelope,
        artifact,
        envelope_sha256: hex(&Sha256::digest(bytes)),
        envelope_bytes: bytes.to_vec(),
        signature_bytes: signature.to_vec(),
    })
}

fn validate(envelope: &UpdateEnvelope) -> Result<(), ReleaseError> {
    if envelope.schema_version != ENVELOPE_SCHEMA_VERSION {
        return Err(ReleaseError::Invalid("unsupported update envelope schema"));
    }
    if envelope.product != crate::manifest::PRODUCT
        || envelope.player_family != PLAYER_FAMILY
        || envelope.platform != PLATFORM
    {
        return Err(ReleaseError::Invalid("not a Tilecast Edge update"));
    }
    if !ARCHITECTURES.contains(&envelope.arch.as_str()) {
        return Err(ReleaseError::Invalid("unknown architecture"));
    }
    if !is_version_name(&envelope.version_name) || version_code(&envelope.version_name) != Some(envelope.version_code) {
        return Err(ReleaseError::Invalid("invalid version"));
    }
    if !matches!(envelope.channel.as_str(), "stable" | "beta") {
        return Err(ReleaseError::Invalid("invalid channel"));
    }
    if envelope.release_notes.len() > MAX_RELEASE_NOTES {
        return Err(ReleaseError::Invalid("release notes too long"));
    }
    if envelope.artifact_asset_name != UpdateEnvelope::expected_artifact_name(&envelope.version_name, &envelope.arch) {
        return Err(ReleaseError::Invalid("unexpected artifact name"));
    }
    if envelope.artifact_size_bytes == 0 || envelope.artifact_size_bytes > MAX_ARTIFACT_BYTES {
        return Err(ReleaseError::Invalid("artifact size out of range"));
    }
    if !is_digest(&envelope.artifact_sha256)
        || !is_digest(&envelope.release_manifest_sha256)
        || !is_digest(&envelope.sbom_sha256)
    {
        return Err(ReleaseError::Invalid("invalid digest"));
    }
    if envelope.state_schema_version == 0 {
        return Err(ReleaseError::Invalid("invalid state schema version"));
    }
    Ok(())
}

impl VerifiedEnvelope {
    /// Refuses a release for another architecture than this build's.
    pub fn check_host(&self) -> Result<(), ReleaseError> {
        if self.envelope.arch == std::env::consts::ARCH {
            Ok(())
        } else {
            Err(ReleaseError::WrongArchitecture(self.envelope.arch.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Signer;

    fn envelope() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1, "product": "tilecast-edge", "playerFamily": "edge", "platform": "linux",
            "arch": "x86_64", "versionName": "0.2.0", "versionCode": 2000, "channel": "stable",
            "releaseNotes": "Notes.", "artifactAssetName": "tilecast-edge-0.2.0-x86_64.tar.zst",
            "artifactSizeBytes": 1234, "artifactSha256": "a".repeat(64),
            "releaseManifestSha256": "b".repeat(64), "sbomSha256": "c".repeat(64), "stateSchemaVersion": 6,
        })
    }

    #[test]
    fn a_signed_envelope_verifies_and_every_field_is_bound() {
        let signer = Signer::new();
        let bytes = serde_json::to_vec(&envelope()).unwrap();
        let verified = verify_envelope(&bytes, &signer.signature(&bytes), &signer.public()).unwrap();
        assert_eq!(verified.envelope.version_code, 2000);
        assert_eq!(verified.envelope_sha256, hex(&Sha256::digest(&bytes)));

        // One changed byte after signing.
        let mut tampered = bytes.clone();
        let at = tampered.iter().position(|b| *b == b'2').unwrap();
        tampered[at] = b'3';
        assert!(matches!(
            verify_envelope(&tampered, &signer.signature(&bytes), &signer.public()),
            Err(ReleaseError::BadSignature)
        ));
        // Another key.
        assert!(matches!(
            verify_envelope(&bytes, &Signer::new().signature(&bytes), &signer.public()),
            Err(ReleaseError::BadSignature)
        ));
    }

    /// The contract with the release build and the server: an envelope that
    /// `apps/edge/release/envelope.py` wrote and OpenSSL signed verifies here,
    /// and in the server's `TestEdgeEnvelopeFromTheReleaseBuild`.
    #[test]
    fn the_release_build_envelope_verifies() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/edge-protocol/fixtures/update-envelope");
        let bytes = std::fs::read(format!("{dir}/envelope.json")).unwrap();
        let signature = std::fs::read(format!("{dir}/envelope.json.sig")).unwrap();
        let key =
            crate::manifest::decode_key(std::fs::read_to_string(format!("{dir}/public-key")).unwrap().trim()).unwrap();
        let verified = verify_envelope(&bytes, &signature, &key).unwrap();
        assert_eq!(verified.envelope.artifact_asset_name, "tilecast-edge-0.2.0-x86_64.tar.zst");
        assert_eq!(verified.envelope.state_schema_version, 6);
    }

    #[test]
    fn signed_but_wrong_envelopes_are_refused() {
        let signer = Signer::new();
        let cases: Vec<(&str, serde_json::Value)> = vec![
            ("playerFamily", serde_json::json!("electron-linux")),
            ("product", serde_json::json!("tilecast-player")),
            ("platform", serde_json::json!("android")),
            ("arch", serde_json::json!("riscv64")),
            ("versionCode", serde_json::json!(2001)),
            ("channel", serde_json::json!("nightly")),
            ("artifactAssetName", serde_json::json!("tilecast-player.AppImage")),
            ("artifactSizeBytes", serde_json::json!(0)),
            ("artifactSha256", serde_json::json!("A".repeat(64))),
            ("stateSchemaVersion", serde_json::json!(0)),
        ];
        for (field, value) in cases {
            let mut document = envelope();
            document[field] = value;
            let bytes = serde_json::to_vec(&document).unwrap();
            assert!(
                matches!(
                    verify_envelope(&bytes, &signer.signature(&bytes), &signer.public()),
                    Err(ReleaseError::Invalid(_))
                ),
                "{field}"
            );
        }
        let mut unknown = envelope();
        unknown["downloadUrl"] = serde_json::json!("https://example.org/x");
        let bytes = serde_json::to_vec(&unknown).unwrap();
        assert!(verify_envelope(&bytes, &signer.signature(&bytes), &signer.public()).is_err(), "unknown field");
    }
}
