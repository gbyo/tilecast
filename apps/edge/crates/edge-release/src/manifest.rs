//! The signed release manifest (M7).
//!
//! A release is a directory tree plus `tilecast-edge-release.json`, which
//! lists every file with its size, SHA-256 and mode, and
//! `tilecast-edge-release.json.sig`, a detached Ed25519 signature over the
//! exact bytes of the JSON. This is the signing model of the Linux Player
//! update manifest (`scripts/build-linux-player-release.sh`): the same key,
//! the same `openssl pkeyutl -sign -rawin` step and base64 signature. The
//! `product` field is `tilecast-edge`, so a Linux Player manifest can never
//! be accepted as an Edge release.

use std::collections::BTreeSet;
use std::io::Read as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;

use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

/// Tilecast's public Ed25519 release-signing key: the key the server trusts
/// for Player update manifests (`apps/server/internal/config/trusted_update_key.go`).
pub const DEFAULT_PUBLIC_KEY: &str = "pqsc4g9DNHwgHYeiqhbmjV9IFzkNPBy/WUbBRij4zdk=";
/// A root-owned override for custom builds, like the server's
/// `TILECAST_UPDATE_MANIFEST_PUBLIC_KEY`.
pub const KEY_OVERRIDE_FILE: &str = "/etc/tilecast-edge/release-signing-key";
pub const MANIFEST_NAME: &str = "tilecast-edge-release.json";
pub const SIGNATURE_NAME: &str = "tilecast-edge-release.json.sig";
pub const PRODUCT: &str = "tilecast-edge";
pub const SBOM_PATH: &str = "share/doc/tilecast-edge/sbom.cdx.json";

pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const MAX_SIGNATURE_BYTES: u64 = 1024;
pub const MAX_FILES: usize = 8192;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Files every release must carry, because the installers start or install
/// them by these fixed names.
pub const REQUIRED_FILES: &[&str] = &[
    "bin/tilecastd",
    "bin/tilecastctl",
    "bin/tilecast-renderer-wpe",
    "bin/tilecast-edge-migrate",
    "bin/tilecast-edge-update",
    "bin/tilecast-session-bridge",
    "lib/gstreamer-1.0/libgsttcmedia.so",
    "share/tilecast/renderer-web/index.html",
    "share/tilecast/selftest/fixture.json",
    SBOM_PATH,
    "packaging/sysusers.d/tilecast-edge.conf",
    "packaging/tmpfiles.d/tilecast-edge.conf",
    "packaging/udev/70-tilecast-display.rules",
    "packaging/modules-load.d/tilecast-edge.conf",
];

/// The user units a release installs for the tilecast account's session
/// (`packaging/systemd-user`). Only the path unit is enabled; it starts the
/// bridge while `tilecastd`'s socket exists.
pub const USER_UNITS: &[&str] = &["tilecast-session-bridge.service", "tilecast-session-bridge.path"];
pub const USER_UNIT_ENABLED: &str = "tilecast-session-bridge.path";

/// The systemd units a release installs. The installers only ever install,
/// enable, start or stop units from this list, plus the update guard units
/// that `tilecast-edge-update` writes itself.
pub const UNITS: &[&str] = &[
    "tilecast-edge.service",
    "tilecast-renderer.service",
    "tilecast-edge-migrate.service",
    "tilecast-edge-migrate-recover.service",
    "tilecast-edge-selftest.service",
    "tilecast-renderer-selftest.service",
    "tilecast-renderer-probe.service",
    "tilecast-edge-compat.service",
    "tilecast-edge-import.service",
    "tilecast-edge-update.service",
    "tilecast-edge-update.socket",
];

#[derive(Debug, thiserror::Error)]
pub enum ReleaseError {
    #[error("release I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("the release manifest is missing or too large")]
    MissingManifest,
    #[error("the release signature is missing or malformed")]
    MissingSignature,
    #[error("the release signature does not verify with the trusted key")]
    BadSignature,
    #[error("the trusted key override is not a root-owned, private Ed25519 key")]
    BadKey,
    #[error("the release manifest is invalid: {0}")]
    Invalid(&'static str),
    #[error("this release is for {0}, not this machine")]
    WrongArchitecture(String),
    #[error("release file {0} is missing, linked or the wrong size")]
    FileUnavailable(String),
    #[error("release file {0} does not match its signed digest")]
    DigestMismatch(String),
    #[error("the installed release {0} does not match its signed manifest")]
    InstalledCorrupt(String),
    #[error("the release archive does not match its update envelope: {0}")]
    ArchiveMismatch(&'static str),
    #[error("the release archive is malformed: {0}")]
    ArchiveInvalid(&'static str),
    #[error("not enough free space: {0}")]
    InsufficientSpace(&'static str),
    #[error("release {0} is not installed")]
    NotInstalled(String),
}

impl ReleaseError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Io(_) => "release_io_error",
            Self::MissingManifest => "release_manifest_missing",
            Self::MissingSignature => "release_signature_missing",
            Self::BadSignature => "release_signature_invalid",
            Self::BadKey => "release_key_invalid",
            Self::Invalid(_) => "release_manifest_invalid",
            Self::WrongArchitecture(_) => "release_wrong_architecture",
            Self::FileUnavailable(_) => "release_file_unavailable",
            Self::DigestMismatch(_) => "release_digest_mismatch",
            Self::InstalledCorrupt(_) => "installed_release_corrupt",
            Self::ArchiveMismatch(_) => "release_archive_mismatch",
            Self::ArchiveInvalid(_) => "release_archive_invalid",
            Self::InsufficientSpace(_) => "insufficient_disk",
            Self::NotInstalled(_) => "release_not_installed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub product: String,
    pub platform: String,
    pub arch: String,
    pub version_name: String,
    pub version_code: u64,
    /// The WPE WebKit build that the release carries and was qualified with.
    pub wpe_webkit_version: String,
    /// The distribution whose system libraries the release was built against.
    pub base_distribution: String,
    pub files: Vec<ReleaseFile>,
}

impl ReleaseManifest {
    pub fn file(&self, path: &str) -> Option<&ReleaseFile> {
        self.files.iter().find(|file| file.path == path)
    }

    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).fold(0u64, u64::saturating_add)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    /// `0644` or `0755`.
    pub mode: String,
}

impl ReleaseFile {
    pub fn mode_bits(&self) -> u32 {
        if self.mode == "0755" { 0o755 } else { 0o644 }
    }
}

/// A manifest whose signature verified, with the digest of its bytes.
#[derive(Debug, Clone)]
pub struct VerifiedRelease {
    pub manifest: ReleaseManifest,
    pub manifest_sha256: String,
    pub manifest_bytes: Vec<u8>,
    pub signature_bytes: Vec<u8>,
}

/// Loads the trusted key: the root-owned override if it exists, otherwise
/// the compiled-in key.
pub fn trusted_key(override_file: &Path) -> Result<[u8; 32], ReleaseError> {
    let text = match edge_platform::fs::open_regular(override_file, 1024)? {
        None if !override_file.exists() => DEFAULT_PUBLIC_KEY.to_owned(),
        None => return Err(ReleaseError::BadKey),
        Some((mut file, _)) => {
            let metadata = file.metadata()?;
            if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
                return Err(ReleaseError::BadKey);
            }
            let mut text = String::new();
            file.read_to_string(&mut text).map_err(|_| ReleaseError::BadKey)?;
            text
        }
    };
    decode_key(text.trim())
}

pub fn decode_key(text: &str) -> Result<[u8; 32], ReleaseError> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok())
        .ok_or(ReleaseError::BadKey)
}

/// Verifies a base64 detached Ed25519 signature over `bytes`.
pub fn verify_signature(bytes: &[u8], signature_text: &[u8], key: &[u8; 32]) -> Result<(), ReleaseError> {
    let signature = base64::engine::general_purpose::STANDARD
        .decode(String::from_utf8_lossy(signature_text).trim())
        .map_err(|_| ReleaseError::MissingSignature)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(bytes, &signature)
        .map_err(|_| ReleaseError::BadSignature)
}

/// Reads and verifies the manifest in `dir` with `key`.
pub fn verify_manifest(dir: &Path, key: &[u8; 32]) -> Result<VerifiedRelease, ReleaseError> {
    let manifest_bytes = edge_platform::fs::read_regular(&dir.join(MANIFEST_NAME), MAX_MANIFEST_BYTES)?
        .ok_or(ReleaseError::MissingManifest)?;
    let signature_bytes = edge_platform::fs::read_regular(&dir.join(SIGNATURE_NAME), MAX_SIGNATURE_BYTES)?
        .ok_or(ReleaseError::MissingSignature)?;
    verify_manifest_bytes(manifest_bytes, signature_bytes, key)
}

/// Verifies manifest bytes and their signature, then parses them. Only
/// signed bytes are parsed.
pub fn verify_manifest_bytes(
    manifest_bytes: Vec<u8>,
    signature_bytes: Vec<u8>,
    key: &[u8; 32],
) -> Result<VerifiedRelease, ReleaseError> {
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(ReleaseError::MissingManifest);
    }
    if signature_bytes.len() as u64 > MAX_SIGNATURE_BYTES {
        return Err(ReleaseError::MissingSignature);
    }
    verify_signature(&manifest_bytes, &signature_bytes, key)?;
    let manifest: ReleaseManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| ReleaseError::Invalid("not a release manifest"))?;
    validate(&manifest)?;
    let manifest_sha256 = hex(&Sha256::digest(&manifest_bytes));
    Ok(VerifiedRelease { manifest, manifest_sha256, manifest_bytes, signature_bytes })
}

fn validate(manifest: &ReleaseManifest) -> Result<(), ReleaseError> {
    if manifest.schema_version != 1 {
        return Err(ReleaseError::Invalid("unsupported schema version"));
    }
    if manifest.product != PRODUCT || manifest.platform != "linux" {
        return Err(ReleaseError::Invalid("not a Tilecast Edge release"));
    }
    if manifest.arch != std::env::consts::ARCH {
        return Err(ReleaseError::WrongArchitecture(manifest.arch.chars().take(32).collect()));
    }
    if !is_version_name(&manifest.version_name) || manifest.version_code == 0 {
        return Err(ReleaseError::Invalid("invalid version"));
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_FILES {
        return Err(ReleaseError::Invalid("file count out of range"));
    }
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    for file in &manifest.files {
        if !is_release_path(&file.path)
            || matches!(file.path.as_str(), MANIFEST_NAME | SIGNATURE_NAME)
            || !paths.insert(file.path.as_str())
        {
            return Err(ReleaseError::Invalid("invalid or duplicate path"));
        }
        if edge_protocol::Sha256Digest::parse(&file.sha256).is_err()
            || file.size > MAX_FILE_BYTES
            || !matches!(file.mode.as_str(), "0644" | "0755")
        {
            return Err(ReleaseError::Invalid("invalid file entry"));
        }
        total = total.saturating_add(file.size);
    }
    if total > MAX_TOTAL_BYTES {
        return Err(ReleaseError::Invalid("release too large"));
    }
    // No file may also be a directory of another file.
    for path in &paths {
        let prefix = format!("{path}/");
        if paths.range(prefix.as_str()..).next().is_some_and(|next| next.starts_with(&prefix)) {
            return Err(ReleaseError::Invalid("a file is also a directory"));
        }
    }
    for required in REQUIRED_FILES {
        if !paths.contains(required) {
            return Err(ReleaseError::Invalid("a required file is missing"));
        }
    }
    for unit in UNITS {
        if !paths.contains(format!("packaging/systemd/{unit}").as_str()) {
            return Err(ReleaseError::Invalid("a required unit is missing"));
        }
    }
    for unit in USER_UNITS {
        if !paths.contains(format!("packaging/systemd-user/{unit}").as_str()) {
            return Err(ReleaseError::Invalid("a required unit is missing"));
        }
    }
    Ok(())
}

/// `MAJOR.MINOR.PATCH` with an optional `-prerelease` of plain characters.
pub fn is_version_name(value: &str) -> bool {
    let (core, pre) = value.split_once('-').unwrap_or((value, ""));
    let numbers: Vec<&str> = core.split('.').collect();
    value.len() <= 64
        && numbers.len() == 3
        && numbers.iter().all(|n| !n.is_empty() && n.len() <= 9 && n.bytes().all(|b| b.is_ascii_digit()))
        && pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        && (value.contains('-') == !pre.is_empty())
}

/// The monotonic version code of a version name, as the release build writes
/// it (`apps/edge/release/stage-release.py`, and the Linux Player's
/// `parseVersionCode`): `MAJOR * 1_000_000 + MINOR * 1_000 + PATCH`. The
/// prerelease part does not count. `None` for an invalid name or a part of
/// 1000 or more, which would collide.
pub fn version_code(version_name: &str) -> Option<u64> {
    if !is_version_name(version_name) {
        return None;
    }
    let core = version_name.split_once('-').map_or(version_name, |(core, _)| core);
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let (major, minor, patch) = (parts.next()??, parts.next()??, parts.next()??);
    if minor >= 1_000 || patch >= 1_000 || major >= 1_000_000 {
        return None;
    }
    Some(major * 1_000_000 + minor * 1_000 + patch)
}

/// A relative path of plain components.
pub fn is_release_path(value: &str) -> bool {
    let components: Vec<&str> = value.split('/').collect();
    value.len() <= 512
        && components.len() <= 12
        && components.iter().all(|c| {
            !c.is_empty()
                && c.len() <= 128
                && *c != "."
                && *c != ".."
                && c.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
        })
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Signer;

    #[test]
    fn the_published_pem_is_the_compiled_in_key() {
        let pem = include_str!("../../../release/tilecast-update-key.pem");
        let body: String = pem.lines().filter(|line| !line.starts_with("-----")).collect();
        let der = base64::engine::general_purpose::STANDARD.decode(body).unwrap();
        assert_eq!(&der[..12], &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
        assert_eq!(der[12..], decode_key(DEFAULT_PUBLIC_KEY).unwrap());
    }

    #[test]
    fn names_codes_and_keys_are_checked() {
        for good in ["0.1.0", "10.20.30", "1.2.3-rc.1"] {
            assert!(is_version_name(good), "{good}");
        }
        for bad in ["1.2", "1.2.3-", "1.2.3/..", "v1.2.3", "1.2.3-rc_1"] {
            assert!(!is_version_name(bad), "{bad}");
        }
        assert_eq!(version_code("0.1.0"), Some(1_000));
        assert_eq!(version_code("1.2.3-rc.1"), Some(1_002_003));
        assert_eq!(version_code("1.2000.0"), None, "a part of 1000 or more would collide");
        assert!(is_release_path("share/tilecast/renderer-web/index.html"));
        for bad in ["/etc/passwd", "a/../b", "a//b", "./a", "a/b c"] {
            assert!(!is_release_path(bad), "{bad}");
        }
        assert!(decode_key(DEFAULT_PUBLIC_KEY).is_ok());
        assert!(decode_key("c2hvcnQ=").is_err());
        assert_eq!(trusted_key(Path::new("/nonexistent/key")).unwrap(), decode_key(DEFAULT_PUBLIC_KEY).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("key");
        std::fs::write(&key, DEFAULT_PUBLIC_KEY).unwrap();
        if rustix_is_root() {
            assert!(trusted_key(&key).is_ok());
        } else {
            assert!(matches!(trusted_key(&key), Err(ReleaseError::BadKey)));
        }
    }

    fn rustix_is_root() -> bool {
        std::fs::metadata("/proc/self").map(|m| m.uid() == 0).unwrap_or(false)
    }

    #[test]
    fn tampered_and_foreign_manifests_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let signer = Signer::new();

        let foreign = root.path().join("foreign");
        Signer::new().write_release(&foreign, "0.2.2");
        assert!(matches!(verify_manifest(&foreign, &signer.public()), Err(ReleaseError::BadSignature)));

        let player = root.path().join("player");
        let mut manifest = signer.write_release(&player, "0.2.3");
        manifest["product"] = serde_json::json!("tilecast-player");
        signer.sign(&player, &serde_json::to_vec(&manifest).unwrap());
        assert!(matches!(verify_manifest(&player, &signer.public()), Err(ReleaseError::Invalid(_))));

        let escape = root.path().join("escape");
        let mut manifest = signer.write_release(&escape, "0.2.4");
        manifest["files"][0]["path"] = serde_json::json!("../../etc/passwd");
        signer.sign(&escape, &serde_json::to_vec(&manifest).unwrap());
        assert!(matches!(verify_manifest(&escape, &signer.public()), Err(ReleaseError::Invalid(_))));

        let shadow = root.path().join("shadow");
        let mut manifest = signer.write_release(&shadow, "0.2.5");
        manifest["files"][0]["path"] = serde_json::json!(MANIFEST_NAME);
        signer.sign(&shadow, &serde_json::to_vec(&manifest).unwrap());
        assert!(
            matches!(verify_manifest(&shadow, &signer.public()), Err(ReleaseError::Invalid(_))),
            "a listed file may not replace the manifest itself"
        );
    }
}
