//! The signed Windows update envelope: the schema-1 signed manifest,
//! binding the downloadable MSIX package by name, size, and SHA-256.
//!
//! The envelope is Tilecast's trust layer. Windows/MSIX signing is the
//! independent second layer: the envelope never replaces the package
//! signature, and the package signature never replaces the envelope.
//! Three parties verify the envelope: the Tilecast Server before it
//! accepts or caches the release, this player before it downloads the
//! package, and this player again after the download and before
//! deployment.

use base64::Engine as _;

pub const ENVELOPE_SCHEMA_VERSION: u32 = 1;
pub const PRODUCT: &str = "tilecast-windows";
pub const PLAYER_FAMILY: &str = "windows";
pub const PLATFORM: &str = "windows";
pub const MAX_ENVELOPE_BYTES: usize = 16 * 1024;
pub const MAX_RELEASE_NOTES: usize = 4_000;
pub const MAX_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Architectures a release can be built for, in
/// `std::env::consts::ARCH` spelling.
pub const ARCHITECTURES: &[&str] = &["x86_64", "aarch64"];

/// Tilecast's permanent public Ed25519 update-signing key: the key the
/// server trusts for Player update manifests
/// (`apps/server/internal/config/trusted_update_key.go`) and the key the
/// release build signs with. Custom builds replace this constant and
/// rebuild; there is no runtime override.
pub const TRUSTED_PUBLIC_KEY: &str = "pqsc4g9DNHwgHYeiqhbmjV9IFzkNPBy/WUbBRij4zdk=";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
}

/// An envelope whose signature verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedEnvelope {
    pub envelope: UpdateEnvelope,
    pub artifact: player_types::Sha256Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EnvelopeError {
    #[error("update envelope too large")]
    TooLarge,
    #[error("update envelope signature is missing")]
    MissingSignature,
    #[error("the update envelope signature does not verify with the trusted key")]
    BadSignature,
    #[error("the trusted update key is invalid")]
    BadKey,
    #[error("invalid update envelope: {0}")]
    Invalid(&'static str),
    #[error("update is for another architecture: {0}")]
    WrongArchitecture(String),
}

impl UpdateEnvelope {
    /// The MSIX name the release build writes.
    pub fn expected_artifact_name(version_name: &str, arch: &str) -> String {
        format!("tilecast-windows-{version_name}-{arch}.msix")
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn trusted_key() -> Result<[u8; 32], EnvelopeError> {
    base64::engine::general_purpose::STANDARD
        .decode(TRUSTED_PUBLIC_KEY)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok())
        .ok_or(EnvelopeError::BadKey)
}

/// Verifies the base64 detached Ed25519 signature over the exact envelope
/// bytes, then parses and validates them. Only signed bytes are parsed.
/// The architecture is not compared with this machine's; see
/// [`VerifiedEnvelope::check_host`].
pub fn verify_envelope(bytes: &[u8], signature: &[u8], key: &[u8; 32]) -> Result<VerifiedEnvelope, EnvelopeError> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(EnvelopeError::TooLarge);
    }
    if signature.len() > 1024 {
        return Err(EnvelopeError::MissingSignature);
    }
    let signature = base64::engine::general_purpose::STANDARD
        .decode(String::from_utf8_lossy(signature).trim())
        .map_err(|_| EnvelopeError::MissingSignature)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(bytes, &signature)
        .map_err(|_| EnvelopeError::BadSignature)?;
    let envelope: UpdateEnvelope =
        serde_json::from_slice(bytes).map_err(|_| EnvelopeError::Invalid("not an update envelope"))?;
    validate(&envelope)?;
    let artifact = player_types::Sha256Digest::parse(&envelope.artifact_sha256)
        .map_err(|_| EnvelopeError::Invalid("invalid digest"))?;
    Ok(VerifiedEnvelope { envelope, artifact })
}

fn validate(envelope: &UpdateEnvelope) -> Result<(), EnvelopeError> {
    if envelope.schema_version != ENVELOPE_SCHEMA_VERSION {
        return Err(EnvelopeError::Invalid("unsupported update envelope schema"));
    }
    if envelope.product != PRODUCT || envelope.player_family != PLAYER_FAMILY || envelope.platform != PLATFORM {
        return Err(EnvelopeError::Invalid("not a Windows Player update"));
    }
    if !ARCHITECTURES.contains(&envelope.arch.as_str()) {
        return Err(EnvelopeError::Invalid("unknown architecture"));
    }
    if crate::update::version_code(&envelope.version_name) != Some(envelope.version_code) {
        return Err(EnvelopeError::Invalid("invalid version"));
    }
    if !matches!(envelope.channel.as_str(), "stable" | "beta") {
        return Err(EnvelopeError::Invalid("invalid channel"));
    }
    if envelope.release_notes.len() > MAX_RELEASE_NOTES {
        return Err(EnvelopeError::Invalid("release notes too long"));
    }
    if envelope.artifact_asset_name != UpdateEnvelope::expected_artifact_name(&envelope.version_name, &envelope.arch) {
        return Err(EnvelopeError::Invalid("unexpected artifact name"));
    }
    if envelope.artifact_size_bytes == 0 || envelope.artifact_size_bytes > MAX_ARTIFACT_BYTES {
        return Err(EnvelopeError::Invalid("artifact size out of range"));
    }
    if !is_digest(&envelope.artifact_sha256) {
        return Err(EnvelopeError::Invalid("invalid digest"));
    }
    Ok(())
}

impl VerifiedEnvelope {
    /// Refuses a release for another architecture than this build's.
    pub fn check_host(&self) -> Result<(), EnvelopeError> {
        if self.envelope.arch == std::env::consts::ARCH {
            Ok(())
        } else {
            Err(EnvelopeError::WrongArchitecture(self.envelope.arch.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1, "product": "tilecast-windows", "playerFamily": "windows", "platform": "windows",
            "arch": "x86_64", "versionName": "0.2.0", "versionCode": 2000, "channel": "stable",
            "releaseNotes": "Notes.", "artifactAssetName": "tilecast-windows-0.2.0-x86_64.msix",
            "artifactSizeBytes": 1234, "artifactSha256": "a".repeat(64),
        })
    }

    fn sign(bytes: &[u8]) -> (Vec<u8>, [u8; 32]) {
        use ring::signature::KeyPair as _;
        let rng = ring::rand::SystemRandom::new();
        let key = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).expect("key");
        let key = ring::signature::Ed25519KeyPair::from_pkcs8(key.as_ref()).expect("key");
        let signature = base64::engine::general_purpose::STANDARD.encode(key.sign(bytes));
        let public: [u8; 32] = key.public_key().as_ref().try_into().expect("32 bytes");
        (signature.into_bytes(), public)
    }

    #[test]
    fn a_signed_envelope_verifies_and_every_field_is_bound() {
        let bytes = serde_json::to_vec(&envelope()).expect("fixture");
        let (signature, key) = sign(&bytes);
        let verified = verify_envelope(&bytes, &signature, &key).expect("verifies");
        assert_eq!(verified.envelope.version_code, 2000);

        let mut tampered = bytes.clone();
        let at = tampered.iter().position(|b| *b == b'2').expect("version digit");
        tampered[at] = b'3';
        assert!(matches!(verify_envelope(&tampered, &signature, &key), Err(EnvelopeError::BadSignature)));
        let (_, other) = sign(&bytes);
        assert!(matches!(verify_envelope(&bytes, &signature, &other), Err(EnvelopeError::BadSignature)));
    }

    #[test]
    fn signed_but_wrong_envelopes_are_refused() {
        let cases: Vec<(&str, serde_json::Value)> = vec![
            ("playerFamily", serde_json::json!("edge")),
            ("product", serde_json::json!("tilecast-player")),
            ("platform", serde_json::json!("android")),
            ("arch", serde_json::json!("riscv64")),
            ("versionCode", serde_json::json!(2001)),
            ("versionName", serde_json::json!("0.2")),
            ("channel", serde_json::json!("nightly")),
            ("artifactAssetName", serde_json::json!("tilecast-player.AppImage")),
            ("artifactSizeBytes", serde_json::json!(0)),
            ("artifactSha256", serde_json::json!("A".repeat(64))),
        ];
        for (field, value) in cases {
            let mut document = envelope();
            document[field] = value;
            let bytes = serde_json::to_vec(&document).expect("fixture");
            let (signature, key) = sign(&bytes);
            assert!(matches!(verify_envelope(&bytes, &signature, &key), Err(EnvelopeError::Invalid(_))), "{field}");
        }
        let mut unknown = envelope();
        unknown["downloadUrl"] = serde_json::json!("https://example.org/x");
        let bytes = serde_json::to_vec(&unknown).expect("fixture");
        let (signature, key) = sign(&bytes);
        assert!(verify_envelope(&bytes, &signature, &key).is_err(), "unknown field");
        let mut edge_only = envelope();
        edge_only["stateSchemaVersion"] = serde_json::json!(6);
        let bytes = serde_json::to_vec(&edge_only).expect("fixture");
        let (signature, key) = sign(&bytes);
        assert!(verify_envelope(&bytes, &signature, &key).is_err(), "edge-only field");
    }

    #[test]
    fn the_compiled_in_key_decodes() {
        assert_eq!(trusted_key().expect("key").len(), 32);
    }

    #[test]
    fn another_architecture_is_refused_after_verification() {
        let mut document = envelope();
        document["arch"] = serde_json::json!("aarch64");
        document["artifactAssetName"] = serde_json::json!("tilecast-windows-0.2.0-aarch64.msix");
        let bytes = serde_json::to_vec(&document).expect("fixture");
        let (signature, key) = sign(&bytes);
        let verified = verify_envelope(&bytes, &signature, &key).expect("verifies");
        if std::env::consts::ARCH == "aarch64" {
            assert!(verified.check_host().is_ok());
        } else {
            assert!(matches!(verified.check_host(), Err(EnvelopeError::WrongArchitecture(_))));
        }
    }
}
