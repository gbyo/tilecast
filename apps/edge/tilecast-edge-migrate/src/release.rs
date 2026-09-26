//! Signed Tilecast Edge releases: verification and installation.
//!
//! A release is a directory tree plus `tilecast-edge-release.json`, which
//! lists every file with its size, SHA-256 and mode, and
//! `tilecast-edge-release.json.sig`, a detached Ed25519 signature over the
//! exact bytes of the JSON. This is the signing model of the Linux Player
//! update manifest (`scripts/build-linux-player-release.sh`): the same key,
//! the same `openssl pkeyutl -sign -rawin` step and base64 signature. The
//! `product` field is `tilecast-edge`, so a Linux Player manifest can never
//! be accepted as an Edge release.
//!
//! The migrator never unpacks an archive. The operator unpacks the release
//! anywhere, and `install` copies exactly the files that the signed manifest
//! names: each source is opened without following links, must be a regular
//! file of the signed size, and is hashed while it is copied. A file whose
//! bytes differ is never installed. Paths come only from the signed
//! manifest and are checked before use.
//!
//! The installed tree is `/opt/tilecast-edge/<version>/`, built in
//! `<version>.staging` and renamed into place, and `current` is a symbolic
//! link switched atomically. An installed version directory is never
//! overwritten.

use std::collections::BTreeSet;
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Component, Path, PathBuf};

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

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 1024;
const MAX_FILES: usize = 8192;
const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Files every release must carry, because the migrator starts or installs
/// them by these fixed names.
pub const REQUIRED_FILES: &[&str] = &[
    "bin/tilecastd",
    "bin/tilecastctl",
    "bin/tilecast-renderer-wpe",
    "bin/tilecast-edge-migrate",
    "bin/tilecast-session-bridge",
    "lib/gstreamer-1.0/libgsttcmedia.so",
    "share/tilecast/renderer-web/index.html",
    "share/tilecast/selftest/fixture.json",
    "share/doc/tilecast-edge/sbom.cdx.json",
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

/// The systemd units a release installs. The migrator only ever installs,
/// enables, starts or stops units from this list.
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

/// Reads and verifies the manifest in `dir` with `key`.
pub fn verify_manifest(dir: &Path, key: &[u8; 32]) -> Result<VerifiedRelease, ReleaseError> {
    let manifest_bytes = edge_platform::fs::read_regular(&dir.join(MANIFEST_NAME), MAX_MANIFEST_BYTES)?
        .ok_or(ReleaseError::MissingManifest)?;
    let signature_text = edge_platform::fs::read_regular(&dir.join(SIGNATURE_NAME), MAX_SIGNATURE_BYTES)?
        .ok_or(ReleaseError::MissingSignature)?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(String::from_utf8_lossy(&signature_text).trim())
        .map_err(|_| ReleaseError::MissingSignature)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(&manifest_bytes, &signature)
        .map_err(|_| ReleaseError::BadSignature)?;
    // Only signed bytes are parsed.
    let manifest: ReleaseManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| ReleaseError::Invalid("not a release manifest"))?;
    validate(&manifest)?;
    let manifest_sha256 = hex(&Sha256::digest(&manifest_bytes));
    Ok(VerifiedRelease { manifest, manifest_sha256, manifest_bytes, signature_bytes: signature_text })
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
        if !is_release_path(&file.path) || !paths.insert(file.path.as_str()) {
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Where a release installs. Production uses [`Layout::system`]; tests use
/// temporary directories.
#[derive(Debug, Clone)]
pub struct Layout {
    pub install_root: PathBuf,
    pub unit_dir: PathBuf,
    pub sysusers_dir: PathBuf,
    pub tmpfiles_dir: PathBuf,
    pub udev_rules_dir: PathBuf,
    pub modules_load_dir: PathBuf,
    /// Units for every user manager (`systemctl --global` scope).
    pub user_unit_dir: PathBuf,
    pub key_override: PathBuf,
}

impl Layout {
    pub fn system() -> Self {
        Self {
            install_root: PathBuf::from("/opt/tilecast-edge"),
            unit_dir: PathBuf::from("/etc/systemd/system"),
            sysusers_dir: PathBuf::from("/usr/lib/sysusers.d"),
            tmpfiles_dir: PathBuf::from("/usr/lib/tmpfiles.d"),
            udev_rules_dir: PathBuf::from("/usr/lib/udev/rules.d"),
            modules_load_dir: PathBuf::from("/usr/lib/modules-load.d"),
            user_unit_dir: PathBuf::from("/etc/systemd/user"),
            key_override: PathBuf::from(KEY_OVERRIDE_FILE),
        }
    }

    pub fn current(&self) -> PathBuf {
        self.install_root.join("current")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed { version: String, previous: Option<String> },
    AlreadyInstalled { version: String },
}

/// Copies one signed file, hashing the bytes as they are written.
fn copy_verified(source: &Path, target: &Path, file: &ReleaseFile) -> Result<(), ReleaseError> {
    let Some((mut input, size)) = edge_platform::fs::open_regular(source, file.size)? else {
        return Err(ReleaseError::FileUnavailable(file.path.clone()));
    };
    if size != file.size {
        return Err(ReleaseError::FileUnavailable(file.path.clone()));
    }
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(file.mode_bits())
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(target)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut written = 0u64;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        written += read as u64;
        if written > file.size {
            return Err(ReleaseError::FileUnavailable(file.path.clone()));
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    if written != file.size || hex(&hasher.finalize()) != file.sha256 {
        return Err(ReleaseError::DigestMismatch(file.path.clone()));
    }
    // The umask never loosens or tightens the signed mode.
    output.set_permissions(std::fs::Permissions::from_mode(file.mode_bits()))?;
    output.sync_all()?;
    Ok(())
}

fn hash_file(path: &Path, expected_size: u64) -> Result<Option<String>, ReleaseError> {
    let Some((mut input, size)) = edge_platform::fs::open_regular(path, expected_size)? else { return Ok(None) };
    if size != expected_size {
        return Ok(None);
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(Some(hex(&hasher.finalize())))
}

/// Installs the verified release from `source` (the unpacked release).
pub fn install(source: &Path, layout: &Layout) -> Result<(InstallOutcome, VerifiedRelease), ReleaseError> {
    install_inner(source, layout, &trusted_key(&layout.key_override)?)
}

fn install_inner(
    source: &Path,
    layout: &Layout,
    key: &[u8; 32],
) -> Result<(InstallOutcome, VerifiedRelease), ReleaseError> {
    let release = verify_manifest(source, key)?;
    let version = release.manifest.version_name.clone();
    std::fs::DirBuilder::new().recursive(true).mode(0o755).create(&layout.install_root)?;
    std::fs::set_permissions(&layout.install_root, std::fs::Permissions::from_mode(0o755))?;
    let target = layout.install_root.join(&version);
    let outcome = if std::fs::symlink_metadata(&target).is_ok() {
        // Never overwrite an installed version; an identical one is a no-op.
        verify_installed(&target, key).map_err(|_| ReleaseError::InstalledCorrupt(version.clone()))?;
        InstallOutcome::AlreadyInstalled { version: version.clone() }
    } else {
        let staging = layout.install_root.join(format!("{version}.staging"));
        if std::fs::symlink_metadata(&staging).is_ok() {
            std::fs::remove_dir_all(&staging)?;
        }
        std::fs::DirBuilder::new().mode(0o755).create(&staging)?;
        for file in &release.manifest.files {
            let destination = staging.join(&file.path);
            if let Some(parent) = destination.parent() {
                std::fs::DirBuilder::new().recursive(true).mode(0o755).create(parent)?;
            }
            copy_verified(&source.join(&file.path), &destination, file)?;
        }
        state_write(&staging, MANIFEST_NAME, &release.manifest_bytes)?;
        state_write(&staging, SIGNATURE_NAME, &release.signature_bytes)?;
        // Directories are 0755 whatever the installer's umask was: the
        // tilecast account runs these binaries and reads the runtime.
        open_tree(&staging)?;
        sync_tree(&staging)?;
        std::fs::rename(&staging, &target)?;
        crate::state::sync_dir(&layout.install_root)?;
        let previous = std::fs::read_link(layout.current()).ok().and_then(|p| p.to_str().map(str::to_owned));
        InstallOutcome::Installed { version: version.clone(), previous }
    };
    switch_current(layout, &version)?;
    install_system_files(&target, layout)?;
    Ok((outcome, release))
}

fn state_write(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    crate::state::write_atomic(dir, name, bytes)?;
    std::fs::set_permissions(dir.join(name), std::fs::Permissions::from_mode(0o644))
}

fn open_tree(root: &Path) -> std::io::Result<()> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))?;
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    Ok(())
}

fn sync_tree(root: &Path) -> std::io::Result<()> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                stack.push(entry.path());
            }
        }
        crate::state::sync_dir(&dir)?;
    }
    Ok(())
}

/// Points `current` at `version` with one `rename(2)`.
pub fn switch_current(layout: &Layout, version: &str) -> std::io::Result<()> {
    let link = layout.current();
    if std::fs::read_link(&link).ok().as_deref() == Some(Path::new(version)) {
        return Ok(());
    }
    let temporary = layout.install_root.join(".current.tmp");
    let _ = std::fs::remove_file(&temporary);
    std::os::unix::fs::symlink(version, &temporary)?;
    std::fs::rename(&temporary, &link)?;
    crate::state::sync_dir(&layout.install_root)
}

/// Copies the release's units and system configuration into place.
fn install_system_files(release_dir: &Path, layout: &Layout) -> Result<(), ReleaseError> {
    let mut copies: Vec<(PathBuf, PathBuf, String)> = UNITS
        .iter()
        .map(|unit| (release_dir.join("packaging/systemd").join(unit), layout.unit_dir.clone(), (*unit).to_owned()))
        .collect();
    copies.push((
        release_dir.join("packaging/sysusers.d/tilecast-edge.conf"),
        layout.sysusers_dir.clone(),
        "tilecast-edge.conf".into(),
    ));
    copies.push((
        release_dir.join("packaging/tmpfiles.d/tilecast-edge.conf"),
        layout.tmpfiles_dir.clone(),
        "tilecast-edge.conf".into(),
    ));
    copies.push((
        release_dir.join("packaging/udev/70-tilecast-display.rules"),
        layout.udev_rules_dir.clone(),
        "70-tilecast-display.rules".into(),
    ));
    copies.push((
        release_dir.join("packaging/modules-load.d/tilecast-edge.conf"),
        layout.modules_load_dir.clone(),
        "tilecast-edge.conf".into(),
    ));
    copies.extend(USER_UNITS.iter().map(|unit| {
        (release_dir.join("packaging/systemd-user").join(unit), layout.user_unit_dir.clone(), (*unit).to_owned())
    }));
    for (source, dir, name) in copies {
        let bytes = edge_platform::fs::read_regular(&source, 256 * 1024)?
            .ok_or_else(|| ReleaseError::FileUnavailable(name.clone()))?;
        std::fs::DirBuilder::new().recursive(true).mode(0o755).create(&dir)?;
        crate::state::write_atomic(&dir, &name, &bytes)?;
        std::fs::set_permissions(dir.join(&name), std::fs::Permissions::from_mode(0o644))?;
    }
    enable_user_unit(layout)?;
    Ok(())
}

/// What `systemctl --global enable` does for the bridge's path unit: a
/// relative link in `default.target.wants`. The unit's `ConditionUser=`
/// keeps it out of every session but the tilecast account's.
fn enable_user_unit(layout: &Layout) -> std::io::Result<()> {
    let wants = layout.user_unit_dir.join("default.target.wants");
    std::fs::DirBuilder::new().recursive(true).mode(0o755).create(&wants)?;
    let link = wants.join(USER_UNIT_ENABLED);
    let target = Path::new("..").join(USER_UNIT_ENABLED);
    if std::fs::read_link(&link).ok().as_deref() == Some(target.as_path()) {
        return Ok(());
    }
    let temporary = wants.join(format!(".{USER_UNIT_ENABLED}.tmp"));
    let _ = std::fs::remove_file(&temporary);
    std::os::unix::fs::symlink(&target, &temporary)?;
    std::fs::rename(&temporary, &link)?;
    crate::state::sync_dir(&wants)
}

/// Verifies an installed release tree: the signature, every file's size,
/// digest and mode, and that nothing else is in the tree.
pub fn verify_installed(dir: &Path, key: &[u8; 32]) -> Result<VerifiedRelease, ReleaseError> {
    let release = verify_manifest(dir, key)?;
    let corrupt = || ReleaseError::InstalledCorrupt(release.manifest.version_name.clone());
    let mut expected: BTreeSet<PathBuf> = [MANIFEST_NAME, SIGNATURE_NAME].iter().map(PathBuf::from).collect();
    for file in &release.manifest.files {
        let path = dir.join(&file.path);
        if hash_file(&path, file.size)?.as_deref() != Some(file.sha256.as_str()) {
            return Err(corrupt());
        }
        let mode = std::fs::symlink_metadata(&path)?.permissions().mode() & 0o7777;
        if mode != file.mode_bits() {
            return Err(corrupt());
        }
        expected.insert(PathBuf::from(&file.path));
    }
    // Anything extra, including a link, means the tree was changed.
    let mut stack = vec![dir.to_path_buf()];
    let mut entries = 0usize;
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current)? {
            let entry = entry?;
            entries += 1;
            if entries > MAX_FILES * 4 {
                return Err(corrupt());
            }
            let kind = entry.file_type()?;
            let relative = entry.path().strip_prefix(dir).map(Path::to_path_buf).map_err(|_| corrupt())?;
            if kind.is_dir() {
                stack.push(entry.path());
            } else if !kind.is_file()
                || !expected.contains(&relative)
                || relative.components().any(|c| !matches!(c, Component::Normal(_)))
            {
                return Err(corrupt());
            }
        }
    }
    Ok(release)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ring::signature::KeyPair as _;

    pub(crate) struct Signer {
        pair: ring::signature::Ed25519KeyPair,
    }

    impl Signer {
        pub(crate) fn new() -> Self {
            let rng = ring::rand::SystemRandom::new();
            let document = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
            Self { pair: ring::signature::Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap() }
        }

        pub(crate) fn public(&self) -> [u8; 32] {
            self.pair.public_key().as_ref().try_into().unwrap()
        }

        pub(crate) fn public_base64(&self) -> String {
            base64::engine::general_purpose::STANDARD.encode(self.public())
        }

        /// Writes a complete release into `dir`, returning the manifest.
        pub(crate) fn write_release(&self, dir: &Path, version: &str) -> serde_json::Value {
            let mut files = vec![];
            let mut add = |path: &str, bytes: &[u8], mode: &str| {
                let target = dir.join(path);
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(&target, bytes).unwrap();
                files.push(serde_json::json!({"path": path, "sha256": hex(&Sha256::digest(bytes)),
                    "size": bytes.len(), "mode": mode}));
            };
            for path in REQUIRED_FILES {
                let mode = if path.starts_with("bin/") { "0755" } else { "0644" };
                add(path, format!("{path} {version}").as_bytes(), mode);
            }
            for unit in UNITS {
                add(&format!("packaging/systemd/{unit}"), format!("[Unit]\n# {unit}\n").as_bytes(), "0644");
            }
            for unit in USER_UNITS {
                add(&format!("packaging/systemd-user/{unit}"), format!("[Unit]\n# {unit}\n").as_bytes(), "0644");
            }
            let manifest = serde_json::json!({
                "schemaVersion": 1, "product": "tilecast-edge", "platform": "linux",
                "arch": std::env::consts::ARCH, "versionName": version, "versionCode": 1000,
                "wpeWebkitVersion": "2.54.0", "baseDistribution": "debian-13", "files": files,
            });
            self.sign(dir, &serde_json::to_vec_pretty(&manifest).unwrap());
            manifest
        }

        pub(crate) fn sign(&self, dir: &Path, bytes: &[u8]) {
            std::fs::write(dir.join(MANIFEST_NAME), bytes).unwrap();
            let signature = base64::engine::general_purpose::STANDARD.encode(self.pair.sign(bytes).as_ref());
            std::fs::write(dir.join(SIGNATURE_NAME), signature).unwrap();
        }
    }

    pub(crate) fn layout(root: &Path, signer: &Signer) -> Layout {
        let key = root.join("release-signing-key");
        std::fs::write(&key, signer.public_base64()).unwrap();
        Layout {
            install_root: root.join("opt"),
            unit_dir: root.join("etc-systemd"),
            sysusers_dir: root.join("sysusers"),
            tmpfiles_dir: root.join("tmpfiles"),
            udev_rules_dir: root.join("udev"),
            modules_load_dir: root.join("modules-load"),
            user_unit_dir: root.join("etc-systemd-user"),
            key_override: key,
        }
    }

    /// Tests run unprivileged, so the override file is not root-owned; they
    /// pass the key directly where ownership matters.
    fn install_with(source: &Path, layout: &Layout, signer: &Signer) -> Result<InstallOutcome, ReleaseError> {
        let _ = verify_manifest(source, &signer.public())?;
        let mut layout = layout.clone();
        layout.key_override = PathBuf::from("/nonexistent/key");
        // The default key cannot verify a test signature, so install through
        // the verified path with the test key.
        install_inner(source, &layout, &signer.public()).map(|(outcome, _)| outcome)
    }

    #[test]
    fn a_signed_release_installs_once_and_switches_current() {
        let root = tempfile::tempdir().unwrap();
        let signer = Signer::new();
        let source = root.path().join("unpacked");
        signer.write_release(&source, "0.2.0");
        let layout = layout(root.path(), &signer);

        let outcome = install_with(&source, &layout, &signer).unwrap();
        assert_eq!(outcome, InstallOutcome::Installed { version: "0.2.0".into(), previous: None });
        assert_eq!(std::fs::read_link(layout.current()).unwrap(), PathBuf::from("0.2.0"));
        let installed = layout.install_root.join("0.2.0");
        verify_installed(&installed, &signer.public()).unwrap();
        let mode = std::fs::metadata(installed.join("bin/tilecastd")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        assert!(layout.unit_dir.join("tilecast-edge.service").exists());
        assert!(layout.sysusers_dir.join("tilecast-edge.conf").exists());
        assert!(layout.udev_rules_dir.join("70-tilecast-display.rules").exists());
        assert!(layout.modules_load_dir.join("tilecast-edge.conf").exists());
        assert!(layout.user_unit_dir.join("tilecast-session-bridge.service").exists());
        assert_eq!(
            std::fs::read_link(layout.user_unit_dir.join("default.target.wants/tilecast-session-bridge.path")).unwrap(),
            PathBuf::from("../tilecast-session-bridge.path"),
            "only the path unit is enabled, as systemctl --global enable would"
        );
        assert!(!layout.user_unit_dir.join("default.target.wants/tilecast-session-bridge.service").exists());
        assert!(!layout.install_root.join("0.2.0.staging").exists());

        // Installing the same release again changes nothing.
        let again = install_with(&source, &layout, &signer).unwrap();
        assert_eq!(again, InstallOutcome::AlreadyInstalled { version: "0.2.0".into() });

        // A changed file in the installed tree, or an extra one, is detected.
        std::fs::write(installed.join("share/extra"), b"x").unwrap();
        assert!(matches!(verify_installed(&installed, &signer.public()), Err(ReleaseError::InstalledCorrupt(_))));
        assert!(matches!(install_with(&source, &layout, &signer), Err(ReleaseError::InstalledCorrupt(_))));
    }

    #[test]
    fn tampered_or_foreign_releases_are_refused_before_anything_is_written() {
        let root = tempfile::tempdir().unwrap();
        let signer = Signer::new();
        let layout = layout(root.path(), &signer);

        // A file changed after signing.
        let source = root.path().join("tampered");
        signer.write_release(&source, "0.2.0");
        std::fs::write(source.join("bin/tilecastd"), b"bin/tilecastd 0.2.X").unwrap();
        assert!(matches!(install_with(&source, &layout, &signer), Err(ReleaseError::DigestMismatch(_))));
        assert!(std::fs::read_link(layout.current()).is_err(), "current never points at a partial release");
        assert!(!layout.install_root.join("0.2.0").exists());

        // A file replaced by a link to the right bytes.
        let source = root.path().join("linked");
        signer.write_release(&source, "0.2.1");
        let elsewhere = root.path().join("elsewhere");
        std::fs::rename(source.join("bin/tilecastctl"), &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, source.join("bin/tilecastctl")).unwrap();
        assert!(matches!(install_with(&source, &layout, &signer), Err(ReleaseError::FileUnavailable(_))));

        // A manifest signed by another key.
        let source = root.path().join("foreign");
        Signer::new().write_release(&source, "0.2.2");
        assert!(matches!(verify_manifest(&source, &signer.public()), Err(ReleaseError::BadSignature)));

        // A signed Linux Player manifest is not an Edge release.
        let source = root.path().join("player");
        let mut manifest = signer.write_release(&source, "0.2.3");
        manifest["product"] = serde_json::json!("tilecast-player");
        signer.sign(&source, &serde_json::to_vec(&manifest).unwrap());
        assert!(matches!(verify_manifest(&source, &signer.public()), Err(ReleaseError::Invalid(_))));

        // A path that escapes the tree, even when signed.
        let source = root.path().join("escape");
        let mut manifest = signer.write_release(&source, "0.2.4");
        manifest["files"][0]["path"] = serde_json::json!("../../etc/passwd");
        signer.sign(&source, &serde_json::to_vec(&manifest).unwrap());
        assert!(matches!(verify_manifest(&source, &signer.public()), Err(ReleaseError::Invalid(_))));
    }

    #[test]
    fn the_published_pem_is_the_compiled_in_key() {
        let pem = include_str!("../../release/tilecast-update-key.pem");
        let body: String = pem.lines().filter(|line| !line.starts_with("-----")).collect();
        let der = base64::engine::general_purpose::STANDARD.decode(body).unwrap();
        assert_eq!(&der[..12], &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
        assert_eq!(der[12..], decode_key(DEFAULT_PUBLIC_KEY).unwrap());
    }

    #[test]
    fn names_and_keys_are_checked() {
        for good in ["0.1.0", "10.20.30", "1.2.3-rc.1"] {
            assert!(is_version_name(good), "{good}");
        }
        for bad in ["1.2", "1.2.3-", "1.2.3/..", "v1.2.3", "1.2.3-rc_1"] {
            assert!(!is_version_name(bad), "{bad}");
        }
        assert!(is_release_path("share/tilecast/renderer-web/index.html"));
        for bad in ["/etc/passwd", "a/../b", "a//b", "./a", "a/b c"] {
            assert!(!is_release_path(bad), "{bad}");
        }
        assert!(decode_key(DEFAULT_PUBLIC_KEY).is_ok());
        assert!(decode_key("c2hvcnQ=").is_err());
        // Without an override the compiled-in key is trusted; an unowned
        // override is refused.
        assert_eq!(trusted_key(Path::new("/nonexistent/key")).unwrap(), decode_key(DEFAULT_PUBLIC_KEY).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("key");
        std::fs::write(&key, DEFAULT_PUBLIC_KEY).unwrap();
        if rustix::process::geteuid().is_root() {
            assert!(trusted_key(&key).is_ok());
        } else {
            assert!(matches!(trusted_key(&key), Err(ReleaseError::BadKey)));
        }
    }
}
