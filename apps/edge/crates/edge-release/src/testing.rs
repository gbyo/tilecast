//! Test releases: a throwaway signing key, complete release trees, archives
//! and envelopes. Never part of a release build (feature `test-util`).

#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};

use base64::Engine as _;
use ring::signature::KeyPair as _;
use sha2::{Digest as _, Sha256};

use crate::envelope::{UpdateEnvelope, VerifiedEnvelope, verify_envelope};
use crate::manifest::{MANIFEST_NAME, REQUIRED_FILES, SBOM_PATH, SIGNATURE_NAME, UNITS, USER_UNITS, hex, version_code};

#[derive(Debug)]
pub struct Signer {
    pair: ring::signature::Ed25519KeyPair,
}

impl Default for Signer {
    fn default() -> Self {
        Self::new()
    }
}

impl Signer {
    pub fn new() -> Self {
        let rng = ring::rand::SystemRandom::new();
        let document = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        Self { pair: ring::signature::Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap() }
    }

    pub fn public(&self) -> [u8; 32] {
        self.pair.public_key().as_ref().try_into().unwrap()
    }

    pub fn public_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.public())
    }

    /// The base64 signature text, as `openssl pkeyutl -sign | base64` writes it.
    pub fn signature(&self, bytes: &[u8]) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.encode(self.pair.sign(bytes).as_ref()).into_bytes()
    }

    /// Writes a complete release into `dir`, returning the manifest.
    pub fn write_release(&self, dir: &Path, version: &str) -> serde_json::Value {
        for path in REQUIRED_FILES {
            let bytes = if *path == SBOM_PATH {
                format!("{{\"bomFormat\":\"CycloneDX\",\"version\":\"{version}\"}}")
            } else {
                format!("{path} {version}")
            };
            write(dir, path, bytes.as_bytes(), path.starts_with("bin/"));
        }
        for unit in UNITS {
            write(dir, &format!("packaging/systemd/{unit}"), format!("[Unit]\n# {unit} {version}\n").as_bytes(), false);
        }
        for unit in USER_UNITS {
            write(dir, &format!("packaging/systemd-user/{unit}"), format!("[Unit]\n# {unit}\n").as_bytes(), false);
        }
        let manifest = manifest_for(dir, version);
        self.sign(dir, &serde_json::to_vec_pretty(&manifest).unwrap());
        manifest
    }

    /// Writes `bytes` as the manifest of `dir` and signs them.
    pub fn sign(&self, dir: &Path, bytes: &[u8]) {
        std::fs::write(dir.join(MANIFEST_NAME), bytes).unwrap();
        std::fs::write(dir.join(SIGNATURE_NAME), self.signature(bytes)).unwrap();
    }

    /// A signed envelope for the archive of the release in `tree`.
    pub fn envelope(&self, tree: &Path, archive: &Path, state_schema_version: u32) -> VerifiedEnvelope {
        let bytes = self.envelope_bytes(tree, archive, state_schema_version);
        verify_envelope(&bytes, &self.signature(&bytes), &self.public()).unwrap()
    }

    pub fn envelope_bytes(&self, tree: &Path, archive: &Path, state_schema_version: u32) -> Vec<u8> {
        let manifest_bytes = std::fs::read(tree.join(MANIFEST_NAME)).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
        let version = manifest["versionName"].as_str().unwrap().to_owned();
        let arch = manifest["arch"].as_str().unwrap().to_owned();
        let archive_bytes = std::fs::read(archive).unwrap();
        let sbom = std::fs::read(tree.join(SBOM_PATH)).unwrap();
        let envelope = UpdateEnvelope {
            schema_version: 1,
            product: "tilecast-edge".into(),
            player_family: "edge".into(),
            platform: "linux".into(),
            artifact_asset_name: UpdateEnvelope::expected_artifact_name(&version, &arch),
            arch,
            version_code: version_code(&version).unwrap(),
            version_name: version,
            channel: "stable".into(),
            release_notes: String::new(),
            artifact_size_bytes: archive_bytes.len() as u64,
            artifact_sha256: hex(&Sha256::digest(&archive_bytes)),
            release_manifest_sha256: hex(&Sha256::digest(&manifest_bytes)),
            sbom_sha256: hex(&Sha256::digest(&sbom)),
            state_schema_version,
        };
        serde_json::to_vec(&envelope).unwrap()
    }
}

fn write(dir: &Path, path: &str, bytes: &[u8], executable: bool) {
    use std::os::unix::fs::PermissionsExt as _;
    let target = dir.join(path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, bytes).unwrap();
    let mode = if executable { 0o755 } else { 0o644 };
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A manifest listing every regular file in `dir` except the manifest and
/// its signature, as `stage-release.py` writes it.
pub fn manifest_for(dir: &Path, version: &str) -> serde_json::Value {
    use std::os::unix::fs::PermissionsExt as _;
    let mut files = vec![];
    let mut stack = vec![dir.to_path_buf()];
    let mut paths: Vec<PathBuf> = vec![];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                paths.push(entry.path());
            }
        }
    }
    paths.sort();
    for path in paths {
        let relative = path.strip_prefix(dir).unwrap().to_str().unwrap().to_owned();
        if relative == MANIFEST_NAME || relative == SIGNATURE_NAME {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        let executable = std::fs::metadata(&path).unwrap().permissions().mode() & 0o111 != 0;
        files.push(serde_json::json!({
            "path": relative, "sha256": hex(&Sha256::digest(&bytes)), "size": bytes.len(),
            "mode": if executable { "0755" } else { "0644" },
        }));
    }
    serde_json::json!({
        "schemaVersion": 1, "product": "tilecast-edge", "platform": "linux",
        "arch": std::env::consts::ARCH, "versionName": version,
        "versionCode": version_code(version).unwrap(),
        "wpeWebkitVersion": "2.54.0", "baseDistribution": "debian-13", "files": files,
    })
}

/// Recomputes the manifest of a release tree after a test changed a file.
pub fn rehash(dir: &Path) -> serde_json::Value {
    let current: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(MANIFEST_NAME)).unwrap()).unwrap();
    manifest_for(dir, current["versionName"].as_str().unwrap())
}

/// Packs `tree` as the release build does: `tar --sort=name -C tree .`
/// compressed with zstd. Symbolic links are stored as links.
pub fn write_archive(tree: &Path, out: &Path) {
    let mut builder = tar::Builder::new(Vec::new());
    builder.follow_symlinks(false);
    builder.mode(tar::HeaderMode::Deterministic);
    builder.append_dir_all(".", tree).unwrap();
    let tarball = builder.into_inner().unwrap();
    let compressed = ruzstd::encoding::compress_to_vec(&tarball[..], ruzstd::encoding::CompressionLevel::Fastest);
    std::fs::write(out, compressed).unwrap();
}

/// A layout under `root`, for tests.
pub fn layout(root: &Path) -> crate::install::Layout {
    crate::install::Layout {
        install_root: root.join("opt"),
        unit_dir: root.join("etc-systemd"),
        sysusers_dir: root.join("sysusers"),
        tmpfiles_dir: root.join("tmpfiles"),
        udev_rules_dir: root.join("udev"),
        modules_load_dir: root.join("modules-load"),
        user_unit_dir: root.join("etc-systemd-user"),
        key_override: root.join("no-key-override"),
    }
}
