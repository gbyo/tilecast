//! Installing signed releases: the one installer that `tilecast-edge-migrate`
//! (M7) and `tilecast-edge-update` (M10) share.
//!
//! The operations are separate so that an update can prepare a release long
//! before it runs it:
//!
//! * **stage**: verify and install a complete, immutable release under
//!   `/opt/tilecast-edge/<version>/`, built in `<version>.staging` and
//!   renamed into place. Nothing that runs changes.
//! * **activate**: verify the staged tree again, install its system files
//!   (units, sysusers, tmpfiles, udev, modules-load, user units) and point
//!   `current` at it with one `rename(2)`.
//!
//! Files come from an unpacked directory (the operator's first installation)
//! or from a signed archive ([`crate::archive`]). Either way, only the files
//! that the signed manifest names are installed; each one is hashed while it
//! is written and must match its signed size, digest and mode. Paths come
//! only from the signed manifest and are checked before use. An installed
//! version directory is never overwritten and never changed.

use std::collections::BTreeSet;
use std::io::{Read, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::manifest::{
    KEY_OVERRIDE_FILE, MANIFEST_NAME, MAX_FILES, ReleaseError, ReleaseFile, SIGNATURE_NAME, UNITS, USER_UNIT_ENABLED,
    USER_UNITS, VerifiedRelease, hex, is_version_name, trusted_key, verify_manifest,
};

/// Space kept free on the install filesystem after a release is staged.
pub const INSTALL_RESERVE_BYTES: u64 = 64 * 1024 * 1024;

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

    /// The directory of a version. `version` must be a valid version name;
    /// callers check it with [`is_version_name`] first.
    pub fn version_dir(&self, version: &str) -> PathBuf {
        self.install_root.join(version)
    }

    pub fn key(&self) -> Result<[u8; 32], ReleaseError> {
        trusted_key(&self.key_override)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageOutcome {
    Staged { version: String },
    AlreadyStaged { version: String },
}

impl StageOutcome {
    pub fn version(&self) -> &str {
        match self {
            Self::Staged { version } | Self::AlreadyStaged { version } => version,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed { version: String, previous: Option<String> },
    AlreadyInstalled { version: String },
}

/// M7's operator installation: stage from an unpacked directory, then
/// activate. Units stay disabled; the migrator enables them.
pub fn install(source: &Path, layout: &Layout) -> Result<(InstallOutcome, VerifiedRelease), ReleaseError> {
    install_with_key(source, layout, &layout.key()?)
}

pub fn install_with_key(
    source: &Path,
    layout: &Layout,
    key: &[u8; 32],
) -> Result<(InstallOutcome, VerifiedRelease), ReleaseError> {
    let previous = current_version(layout);
    let (staged, release) = stage_from_dir(source, layout, key)?;
    activate(layout, staged.version(), key)?;
    let outcome = match staged {
        StageOutcome::Staged { version } => InstallOutcome::Installed { version, previous },
        StageOutcome::AlreadyStaged { version } => InstallOutcome::AlreadyInstalled { version },
    };
    Ok((outcome, release))
}

/// Stages the verified release in `source` (an unpacked release tree).
pub fn stage_from_dir(
    source: &Path,
    layout: &Layout,
    key: &[u8; 32],
) -> Result<(StageOutcome, VerifiedRelease), ReleaseError> {
    let release = verify_manifest(source, key)?;
    let outcome = stage_with(&release, layout, key, |staging| {
        for file in &release.manifest.files {
            let Some((input, size)) = edge_platform::fs::open_regular(&source.join(&file.path), file.size)? else {
                return Err(ReleaseError::FileUnavailable(file.path.clone()));
            };
            if size != file.size {
                return Err(ReleaseError::FileUnavailable(file.path.clone()));
            }
            write_verified(input, staging, file)?;
        }
        Ok(())
    })?;
    Ok((outcome, release))
}

/// The shared staging step: an installed version is verified and left
/// alone; otherwise `fill` writes the files into a fresh staging directory,
/// which is completed, synced and renamed into place.
pub(crate) fn stage_with(
    release: &VerifiedRelease,
    layout: &Layout,
    key: &[u8; 32],
    fill: impl FnOnce(&Path) -> Result<(), ReleaseError>,
) -> Result<StageOutcome, ReleaseError> {
    let version = release.manifest.version_name.clone();
    std::fs::DirBuilder::new().recursive(true).mode(0o755).create(&layout.install_root)?;
    std::fs::set_permissions(&layout.install_root, std::fs::Permissions::from_mode(0o755))?;
    let target = layout.version_dir(&version);
    if std::fs::symlink_metadata(&target).is_ok() {
        // Never overwrite an installed version; an identical one is a no-op.
        let installed = verify_installed(&target, key).map_err(|_| ReleaseError::InstalledCorrupt(version.clone()))?;
        if installed.manifest_sha256 != release.manifest_sha256 {
            return Err(ReleaseError::InstalledCorrupt(version));
        }
        return Ok(StageOutcome::AlreadyStaged { version });
    }
    if free_bytes(&layout.install_root)? < release.manifest.total_bytes().saturating_add(INSTALL_RESERVE_BYTES) {
        return Err(ReleaseError::InsufficientSpace("install root"));
    }
    let staging = layout.install_root.join(format!("{version}.staging"));
    if std::fs::symlink_metadata(&staging).is_ok() {
        std::fs::remove_dir_all(&staging)?;
    }
    std::fs::DirBuilder::new().mode(0o755).create(&staging)?;
    let filled = fill(&staging).and_then(|()| {
        write_file(&staging, MANIFEST_NAME, &release.manifest_bytes, 0o644)?;
        write_file(&staging, SIGNATURE_NAME, &release.signature_bytes, 0o644)?;
        // Directories are 0755 whatever the installer's umask was: the
        // tilecast account runs these binaries and reads the runtime.
        open_tree(&staging)?;
        sync_tree(&staging)?;
        Ok(())
    });
    if let Err(error) = filled {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    std::fs::rename(&staging, &target)?;
    sync_dir(&layout.install_root)?;
    Ok(StageOutcome::Staged { version })
}

/// Makes an installed, verified release current: its system files, then the
/// `current` link. Idempotent. Does not start, stop or reload anything.
pub fn activate(layout: &Layout, version: &str, key: &[u8; 32]) -> Result<VerifiedRelease, ReleaseError> {
    if !is_version_name(version) {
        return Err(ReleaseError::Invalid("invalid version"));
    }
    let dir = layout.version_dir(version);
    if std::fs::symlink_metadata(&dir).is_err() {
        return Err(ReleaseError::NotInstalled(version.to_owned()));
    }
    let release = verify_installed(&dir, key)?;
    install_system_files(&dir, layout)?;
    switch_current(layout, version)?;
    Ok(release)
}

/// Copies one signed file into `root`, hashing the bytes as they are written.
fn write_verified(mut input: impl Read, root: &Path, file: &ReleaseFile) -> Result<(), ReleaseError> {
    let destination = root.join(&file.path);
    if let Some(parent) = destination.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o755).create(parent)?;
    }
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(file.mode_bits())
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(&destination)?;
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

pub(crate) fn write_archive_file(input: impl Read, root: &Path, file: &ReleaseFile) -> Result<(), ReleaseError> {
    write_verified(input, root, file)
}

fn write_file(dir: &Path, name: &str, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    write_atomic(dir, name, bytes, mode)
}

/// Writes `name` in `dir` with `mode`: temporary file, sync, rename,
/// directory sync.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let temporary = dir.join(format!(".{name}.tmp"));
    let _ = std::fs::remove_file(&temporary);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, dir.join(name))?;
    sync_dir(dir)
}

pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
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
        sync_dir(&dir)?;
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
    sync_dir(&layout.install_root)
}

/// The version `current` names, if it names a valid version name.
pub fn current_version(layout: &Layout) -> Option<String> {
    let target = std::fs::read_link(layout.current()).ok()?;
    let name = target.to_str()?;
    is_version_name(name).then(|| name.to_owned())
}

/// Copies the release's units and system configuration into place.
pub fn install_system_files(release_dir: &Path, layout: &Layout) -> Result<(), ReleaseError> {
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
        write_atomic(&dir, &name, &bytes, 0o644)?;
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
    sync_dir(&wants)
}

/// Verifies an installed release tree: the signature, every file's size,
/// digest and mode, and that nothing else is in the tree.
pub fn verify_installed(dir: &Path, key: &[u8; 32]) -> Result<VerifiedRelease, ReleaseError> {
    let release = verify_manifest(dir, key)?;
    let corrupt = || ReleaseError::InstalledCorrupt(release.manifest.version_name.clone());
    if dir.file_name().and_then(|n| n.to_str()) != Some(release.manifest.version_name.as_str()) {
        return Err(corrupt());
    }
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

/// Installed version directories, by name. Staging and removal leftovers,
/// `current` and anything that is not a version name are not versions.
pub fn installed_versions(layout: &Layout) -> std::io::Result<Vec<String>> {
    let mut versions = Vec::new();
    let entries = match std::fs::read_dir(&layout.install_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(versions),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str()
            && is_version_name(name)
        {
            versions.push(name.to_owned());
        }
    }
    versions.sort_by_key(|name| std::cmp::Reverse(crate::manifest::version_code(name).unwrap_or(0)));
    Ok(versions)
}

/// Removes an installed version. It is renamed out of the version namespace
/// first, so a crash never leaves a partial tree under a version name.
pub fn remove_version(layout: &Layout, version: &str) -> std::io::Result<()> {
    if !is_version_name(version) || current_version(layout).as_deref() == Some(version) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a removable version"));
    }
    let dir = layout.version_dir(version);
    let doomed = layout.install_root.join(format!(".{version}.removing"));
    match std::fs::rename(&dir, &doomed) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    sync_dir(&layout.install_root)?;
    std::fs::remove_dir_all(&doomed)?;
    sync_dir(&layout.install_root)
}

/// Removes interrupted staging and removal directories.
pub fn remove_leftovers(layout: &Layout) -> std::io::Result<usize> {
    let mut removed = 0;
    let entries = match std::fs::read_dir(&layout.install_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        let leftover = name
            .strip_suffix(".staging")
            .or_else(|| name.strip_prefix('.').and_then(|n| n.strip_suffix(".removing")))
            .is_some_and(is_version_name);
        if leftover && entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
            removed += 1;
        }
    }
    if removed > 0 {
        sync_dir(&layout.install_root)?;
    }
    Ok(removed)
}

/// Free bytes for an unprivileged writer on the filesystem of `path`.
pub fn free_bytes(path: &Path) -> std::io::Result<u64> {
    let stat = rustix::fs::statvfs(path).map_err(std::io::Error::from)?;
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Signer, layout};

    #[test]
    fn a_signed_release_installs_once_and_switches_current() {
        let root = tempfile::tempdir().unwrap();
        let signer = Signer::new();
        let source = root.path().join("unpacked");
        signer.write_release(&source, "0.2.0");
        let layout = layout(root.path());

        let (outcome, _) = install_with_key(&source, &layout, &signer.public()).unwrap();
        assert_eq!(outcome, InstallOutcome::Installed { version: "0.2.0".into(), previous: None });
        assert_eq!(std::fs::read_link(layout.current()).unwrap(), PathBuf::from("0.2.0"));
        let installed = layout.install_root.join("0.2.0");
        verify_installed(&installed, &signer.public()).unwrap();
        let mode = std::fs::metadata(installed.join("bin/tilecastd")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        assert!(layout.unit_dir.join("tilecast-edge.service").exists());
        assert!(layout.unit_dir.join("tilecast-edge-update.socket").exists());
        assert!(layout.sysusers_dir.join("tilecast-edge.conf").exists());
        assert!(layout.udev_rules_dir.join("70-tilecast-display.rules").exists());
        assert!(layout.modules_load_dir.join("tilecast-edge.conf").exists());
        assert!(layout.user_unit_dir.join("tilecast-session-bridge.service").exists());
        assert_eq!(
            std::fs::read_link(layout.user_unit_dir.join("default.target.wants/tilecast-session-bridge.path")).unwrap(),
            PathBuf::from("../tilecast-session-bridge.path"),
        );
        assert!(!layout.install_root.join("0.2.0.staging").exists());

        let (again, _) = install_with_key(&source, &layout, &signer.public()).unwrap();
        assert_eq!(again, InstallOutcome::AlreadyInstalled { version: "0.2.0".into() });

        std::fs::write(installed.join("share/extra"), b"x").unwrap();
        assert!(matches!(verify_installed(&installed, &signer.public()), Err(ReleaseError::InstalledCorrupt(_))));
        assert!(matches!(install_with_key(&source, &layout, &signer.public()), Err(ReleaseError::InstalledCorrupt(_))));
    }

    #[test]
    fn staging_never_touches_what_runs() {
        let root = tempfile::tempdir().unwrap();
        let signer = Signer::new();
        let layout = layout(root.path());
        let first = root.path().join("first");
        signer.write_release(&first, "0.1.0");
        install_with_key(&first, &layout, &signer.public()).unwrap();
        let units_before = std::fs::read(layout.unit_dir.join("tilecast-edge.service")).unwrap();

        let second = root.path().join("second");
        signer.write_release(&second, "0.2.0");
        std::fs::write(second.join("packaging/systemd/tilecast-edge.service"), b"[Unit]\n# 0.2.0\n").unwrap();
        let manifest = crate::testing::rehash(&second);
        signer.sign(&second, &serde_json::to_vec_pretty(&manifest).unwrap());
        let (outcome, _) = stage_from_dir(&second, &layout, &signer.public()).unwrap();
        assert_eq!(outcome, StageOutcome::Staged { version: "0.2.0".into() });
        assert_eq!(current_version(&layout).as_deref(), Some("0.1.0"), "staging does not activate");
        assert_eq!(std::fs::read(layout.unit_dir.join("tilecast-edge.service")).unwrap(), units_before);

        activate(&layout, "0.2.0", &signer.public()).unwrap();
        assert_eq!(current_version(&layout).as_deref(), Some("0.2.0"));
        assert_eq!(std::fs::read(layout.unit_dir.join("tilecast-edge.service")).unwrap(), b"[Unit]\n# 0.2.0\n");
        // Back again: activation is how a rollback restores the previous system files.
        activate(&layout, "0.1.0", &signer.public()).unwrap();
        assert_eq!(std::fs::read(layout.unit_dir.join("tilecast-edge.service")).unwrap(), units_before);
        assert_eq!(installed_versions(&layout).unwrap(), vec!["0.2.0".to_owned(), "0.1.0".to_owned()]);

        assert!(remove_version(&layout, "0.1.0").is_err(), "current is never removed");
        remove_version(&layout, "0.2.0").unwrap();
        assert_eq!(installed_versions(&layout).unwrap(), vec!["0.1.0".to_owned()]);
        assert!(matches!(activate(&layout, "0.2.0", &signer.public()), Err(ReleaseError::NotInstalled(_))));
    }

    #[test]
    fn tampered_releases_are_refused_before_anything_is_written() {
        let root = tempfile::tempdir().unwrap();
        let signer = Signer::new();
        let layout = layout(root.path());

        let source = root.path().join("tampered");
        signer.write_release(&source, "0.2.0");
        std::fs::write(source.join("bin/tilecastd"), b"bin/tilecastd 0.2.X").unwrap();
        assert!(matches!(install_with_key(&source, &layout, &signer.public()), Err(ReleaseError::DigestMismatch(_))));
        assert!(std::fs::read_link(layout.current()).is_err(), "current never points at a partial release");
        assert!(!layout.install_root.join("0.2.0").exists());
        assert!(!layout.install_root.join("0.2.0.staging").exists(), "a failed stage leaves nothing");

        let source = root.path().join("linked");
        signer.write_release(&source, "0.2.1");
        let elsewhere = root.path().join("elsewhere");
        std::fs::rename(source.join("bin/tilecastctl"), &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, source.join("bin/tilecastctl")).unwrap();
        assert!(matches!(install_with_key(&source, &layout, &signer.public()), Err(ReleaseError::FileUnavailable(_))));
    }

    #[test]
    fn leftovers_of_interrupted_staging_and_removal_are_cleared() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        std::fs::create_dir_all(layout.install_root.join("0.3.0.staging/bin")).unwrap();
        std::fs::create_dir_all(layout.install_root.join(".0.1.0.removing")).unwrap();
        std::fs::create_dir_all(layout.install_root.join("keep.staging")).unwrap();
        assert_eq!(remove_leftovers(&layout).unwrap(), 2);
        assert!(layout.install_root.join("keep.staging").exists(), "only version-named leftovers");
        assert!(installed_versions(&layout).unwrap().is_empty());
    }
}
