//! Removal of the Tilecast Edge 0.2.0 field workaround, once it cannot be
//! needed again.
//!
//! Release 0.2.0 failed on Debian 13 screens, and the first migrations there
//! worked only with hand-written systemd drop-ins that disabled WebKit's
//! sandbox (`edge-0.2.0-field-fix.conf`, and one obsolete configuration file).
//! A normal update does not replace those files, so a 0.2.1 screen would keep
//! them. This module removes exactly the files that were deployed, and
//! nothing else.
//!
//! # Rules
//!
//! * **Exact bytes.** [`KNOWN`] lists five paths with the SHA-256 of the one
//!   content that was deployed at each. A file is removed only when its path
//!   is on the list and its digest equals the listed digest. A file at a
//!   listed path with any other content is an unknown administrator override:
//!   it is left untouched and reported. No other path is ever read or removed.
//! * **After confirmation, never during the window.** The 0.2.0 helper on the
//!   screen runs the update to 0.2.1 and any rollback from it, and it does not
//!   know these files. So nothing is removed before the 0.2.1 release is the
//!   confirmed, current release: the helper does this only when it is the
//!   current release's own helper, no update transaction is open, and no
//!   migration is settling. A rollback to 0.2.0 therefore leaves the machine
//!   exactly as it was, with the workaround that 0.2.0 needs.
//!   The 0.2.1 renderers refuse `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS`
//!   themselves, so the candidate runs with WebKit's real sandbox even while
//!   these files still exist.
//! * **Move, reload, then discard.** The files are copied to a backup in the
//!   helper's private state directory (the manifest is written last),
//!   removed, `daemon-reload` runs, and only then is the backup deleted. A
//!   failed reload restores the files from the backup. A crash at any point
//!   is finished or undone by the next run.

use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::host::{HostError, UpdateHost};

/// Larger files are never read: the deployed files are a few hundred bytes.
const MAX_FILE_BYTES: u64 = 16 * 1024;
const BACKUP_DIR: &str = "field-workaround-backup";
const MANIFEST: &str = "manifest.json";
pub const REPORT: &str = "field-workaround.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    /// `/etc/systemd/system`.
    UnitDir,
    /// `/etc/tilecast-edge`.
    ConfigDir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Known {
    pub area: Area,
    /// Relative to the area, never absolute and never containing `..`.
    pub path: &'static str,
    pub sha256: &'static str,
}

/// Every file of the 0.2.0 field workaround, at the one content deployed.
/// The school migration script wrote the four drop-ins; the configuration
/// file exists only on the first canary.
pub const KNOWN: &[Known] = &[
    Known {
        area: Area::UnitDir,
        path: "tilecast-renderer-selftest.service.d/edge-0.2.0-field-fix.conf",
        sha256: "16b3c5ee08191aa111ab72949a17fce5b334776cfa7d7f218fac3be416f1ddbc",
    },
    Known {
        area: Area::UnitDir,
        path: "tilecast-renderer.service.d/edge-0.2.0-field-fix.conf",
        sha256: "c1f0cd083640731cc682bd16ba6ddfd875c7c00692261447e67f8666258490e6",
    },
    Known {
        area: Area::UnitDir,
        path: "tilecast-web-renderer.service.d/edge-0.2.0-field-fix.conf",
        sha256: "9cb35e76c1ec8ef982fb46ef6ecf57a9a0c14474b04f7e2c497e16e86b8cb9d0",
    },
    Known {
        area: Area::UnitDir,
        path: "tilecast-edge-selftest.service.d/edge-0.2.0-field-fix.conf",
        sha256: "ce3d1dea27aba5d24346bdb4ba4870a80264df026b27b1ccd5168cc9db00545c",
    },
    Known {
        area: Area::ConfigDir,
        path: "selftest-0.2.0-field.toml",
        sha256: "50b452f6af225015935c34a17490d6dbbec24c495a525d6aa255a03395e0515d",
    },
];

/// Where the files are, where the backup goes, and when to leave them alone.
#[derive(Debug, Clone)]
pub struct Roots {
    pub unit_dir: PathBuf,
    pub config_dir: PathBuf,
    /// The helper's state directory; the backup and the report live here.
    pub state_dir: PathBuf,
    /// Present while the migrator settles a cutover.
    pub probation_file: PathBuf,
}

impl Roots {
    fn resolve(&self, known: &Known) -> PathBuf {
        match known.area {
            Area::UnitDir => self.unit_dir.join(known.path),
            Area::ConfigDir => self.config_dir.join(known.path),
        }
    }

    fn backup(&self) -> PathBuf {
        self.state_dir.join(BACKUP_DIR)
    }
}

/// A file at a listed path whose content is not the deployed one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnknownOverride {
    pub path: String,
    /// `None` when the file is too large to hash or is not a regular file.
    pub sha256: Option<String>,
}

/// What a run found and did. Persisted as `field-workaround.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub removed: Vec<String>,
    pub unknown_overrides: Vec<UnknownOverride>,
    pub at_ms: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("field workaround I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("field workaround reload: {0}")]
    Host(#[from] HostError),
    #[error("the field workaround backup is invalid")]
    Backup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupEntry {
    /// Index into [`KNOWN`].
    known: usize,
    sha256: String,
    mode: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupManifest {
    entries: Vec<BackupEntry>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

enum Found {
    Absent,
    /// The deployed content, with the file's mode.
    Known {
        bytes: Vec<u8>,
        mode: u32,
    },
    Unknown(UnknownOverride),
}

fn inspect(roots: &Roots, known: &Known) -> Result<Found, Error> {
    let path = roots.resolve(known);
    // A listed path that is a link, a directory or a file of any other kind
    // is not the deployed file; it is reported, never removed.
    let shown = |sha256| Found::Unknown(UnknownOverride { path: path.display().to_string(), sha256 });
    let Some(metadata) = lstat(&path)? else { return Ok(Found::Absent) };
    if !metadata.file_type().is_file() {
        return Ok(shown(None));
    }
    let Some((mut file, _)) = edge_platform::fs::open_regular_no_links(&path, MAX_FILE_BYTES)? else {
        return Ok(shown(None));
    };
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes)?;
    let actual = digest(&bytes);
    let mode = file.metadata()?.permissions().mode() & 0o7777;
    if actual == known.sha256 { Ok(Found::Known { bytes, mode }) } else { Ok(shown(Some(actual))) }
}

fn lstat(path: &Path) -> Result<Option<std::fs::Metadata>, Error> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        // A missing file, or a path whose parent is missing or not a directory.
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

/// What the machine has now, without changing anything: the deployed files
/// that are present and the unknown overrides at listed paths.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scan {
    pub known_present: Vec<String>,
    pub unknown_overrides: Vec<UnknownOverride>,
}

pub fn scan(roots: &Roots, list: &[Known]) -> Result<Scan, Error> {
    let mut result = Scan::default();
    for known in list {
        match inspect(roots, known)? {
            Found::Absent => {}
            Found::Known { .. } => result.known_present.push(roots.resolve(known).display().to_string()),
            Found::Unknown(unknown) => result.unknown_overrides.push(unknown),
        }
    }
    Ok(result)
}

fn write_private(path: &Path, bytes: &[u8], mode: u32) -> Result<(), Error> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = edge_release::install::sync_dir(parent);
    }
}

fn read_manifest(backup: &Path) -> Result<Option<BackupManifest>, Error> {
    let Some(bytes) = edge_platform::fs::read_regular(&backup.join(MANIFEST), MAX_FILE_BYTES)? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|_| Error::Backup)
}

fn remove_backup(roots: &Roots) -> Result<(), Error> {
    match std::fs::remove_dir_all(roots.backup()) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => {
            let _ = edge_release::install::sync_dir(&roots.state_dir);
            Ok(())
        }
    }
}

/// Puts the backed-up files back, byte for byte, where they were.
fn restore(roots: &Roots, list: &[Known], manifest: &BackupManifest) -> Result<(), Error> {
    for (position, entry) in manifest.entries.iter().enumerate() {
        let known = list.get(entry.known).ok_or(Error::Backup)?;
        let bytes = edge_platform::fs::read_regular(&roots.backup().join(format!("{position}.bin")), MAX_FILE_BYTES)?
            .ok_or(Error::Backup)?;
        if digest(&bytes) != entry.sha256 || entry.sha256 != known.sha256 {
            return Err(Error::Backup);
        }
        let target = roots.resolve(known);
        if lstat(&target)?.is_some() {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::DirBuilder::new().recursive(true).mode(0o755).create(parent)?;
        }
        write_private(&target, &bytes, entry.mode)?;
        sync_parent(&target);
    }
    Ok(())
}

/// Removes the deployed files that are present, and reports the rest.
///
/// Idempotent. A run that was interrupted is finished: a backup without a
/// manifest is discarded (nothing had been removed), and a backup with one
/// means the files are already gone, so it only reloads and discards.
pub async fn clean<H: UpdateHost>(host: &H, roots: &Roots, list: &[Known], now_ms: i64) -> Result<Report, Error> {
    let backup = roots.backup();
    let mut interrupted = false;
    if lstat(&backup)?.is_some() {
        match read_manifest(&backup) {
            Ok(Some(_)) => interrupted = true,
            // Copying was unfinished: no original has been touched.
            _ => remove_backup(roots)?,
        }
    }

    let mut report = Report { at_ms: now_ms, ..Report::default() };
    let mut present = Vec::new();
    for (index, known) in list.iter().enumerate() {
        match inspect(roots, known)? {
            Found::Absent => {}
            Found::Known { bytes, mode } => present.push((index, known, bytes, mode)),
            Found::Unknown(unknown) => {
                tracing::warn!(
                    component = "update",
                    event = "unknown_administrator_override",
                    path = unknown.path,
                    sha256 = unknown.sha256.as_deref().unwrap_or("unreadable"),
                    "a file at a Tilecast field-workaround path is not the deployed content; leaving it untouched"
                );
                report.unknown_overrides.push(unknown);
            }
        }
    }

    if !present.is_empty() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&roots.state_dir)?;
        let _ = remove_backup(roots);
        std::fs::DirBuilder::new().mode(0o700).create(&backup)?;
        let mut entries = Vec::new();
        for (position, (index, known, bytes, mode)) in present.iter().enumerate() {
            write_private(&backup.join(format!("{position}.bin")), bytes, 0o600)?;
            entries.push(BackupEntry { known: *index, sha256: known.sha256.to_owned(), mode: *mode });
        }
        let manifest = BackupManifest { entries };
        // The manifest is the commit point: with it, the backup is whole.
        edge_release::install::write_atomic(&backup, MANIFEST, &serde_json::to_vec_pretty(&manifest)?, 0o600)?;
        edge_release::install::sync_dir(&backup)?;
        for (_, known, _, _) in &present {
            let target = roots.resolve(known);
            // The content is checked again immediately before it is removed.
            if !matches!(inspect(roots, known)?, Found::Known { .. }) {
                continue;
            }
            std::fs::remove_file(&target)?;
            sync_parent(&target);
            if let Some(parent) = target.parent()
                && known.area == Area::UnitDir
            {
                // Only the now-empty drop-in directory; an administrator's
                // other drop-ins keep it alive.
                let _ = std::fs::remove_dir(parent);
            }
            report.removed.push(target.display().to_string());
        }
        interrupted = true;
    }

    if interrupted {
        match host.reload().await {
            Ok(()) => {}
            Err(error) => {
                // Leave the machine as it was, with the backup kept for the
                // next run to try again.
                // A restore that fails must not hide the reload error.
                if let Ok(Some(manifest)) = read_manifest(&backup)
                    && let Err(restore_error) = restore(roots, list, &manifest)
                {
                    tracing::error!(component = "update", event = "field_workaround_restore_failed", error = %restore_error);
                }
                return Err(error.into());
            }
        }
        remove_backup(roots)?;
    }

    persist(roots, &report)?;
    if !report.removed.is_empty() {
        tracing::info!(component = "update", event = "field_workaround_removed", files = report.removed.len());
    }
    Ok(report)
}

fn persist(roots: &Roots, report: &Report) -> Result<(), Error> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&roots.state_dir)?;
    let bytes = serde_json::to_vec_pretty(report).map_err(|_| Error::Backup)?;
    edge_release::install::write_atomic(&roots.state_dir, REPORT, &bytes, 0o600)?;
    Ok(())
}

impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::Backup
    }
}

/// The report of the last run, if there was one.
pub fn last_report(state_dir: &Path) -> Option<Report> {
    let bytes = edge_platform::fs::read_regular(&state_dir.join(REPORT), MAX_FILE_BYTES).ok()??;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fake::FakeHost;

    /// The five files as deployed, byte for byte (`tests/field-workaround/`),
    /// in the order of [`KNOWN`].
    pub const FIXTURES: [&[u8]; 5] = [
        include_bytes!("../tests/field-workaround/tilecast-renderer-selftest.service.d/edge-0.2.0-field-fix.conf"),
        include_bytes!("../tests/field-workaround/tilecast-renderer.service.d/edge-0.2.0-field-fix.conf"),
        include_bytes!("../tests/field-workaround/tilecast-web-renderer.service.d/edge-0.2.0-field-fix.conf"),
        include_bytes!("../tests/field-workaround/tilecast-edge-selftest.service.d/edge-0.2.0-field-fix.conf"),
        include_bytes!("../tests/field-workaround/selftest-0.2.0-field.toml"),
    ];

    pub struct Machine {
        pub dir: tempfile::TempDir,
        pub roots: Roots,
    }

    pub fn machine() -> Machine {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots {
            unit_dir: dir.path().join("etc/systemd/system"),
            config_dir: dir.path().join("etc/tilecast-edge"),
            state_dir: dir.path().join("var/lib/tilecast-edge-update"),
            probation_file: dir.path().join("run/probation"),
        };
        Machine { dir, roots }
    }

    impl Machine {
        pub fn path(&self, index: usize) -> PathBuf {
            self.roots.resolve(&KNOWN[index])
        }

        pub fn install(&self, index: usize, bytes: &[u8]) {
            let path = self.path(index);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        pub fn install_all(&self) {
            for (index, bytes) in FIXTURES.iter().enumerate() {
                self.install(index, bytes);
            }
        }
    }

    #[test]
    fn the_listed_digests_are_the_deployed_bytes_and_every_path_is_plain() {
        assert_eq!(FIXTURES.len(), KNOWN.len());
        for (known, bytes) in KNOWN.iter().zip(FIXTURES) {
            assert_eq!(digest(bytes), known.sha256, "{}", known.path);
            let path = Path::new(known.path);
            assert!(path.is_relative() && path.components().all(|c| matches!(c, std::path::Component::Normal(_))));
        }
        // The one the user pasted first, to guard against a transposition.
        assert!(KNOWN.iter().any(|k| k.sha256.starts_with("16b3c5ee")));
        assert!(String::from_utf8_lossy(FIXTURES[1]).contains("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1"));
    }

    #[tokio::test]
    async fn the_deployed_files_are_removed_after_a_reload_and_the_backup_is_discarded() {
        let machine = machine();
        machine.install_all();
        let host = FakeHost::new(machine.dir.path().join("opt"));
        let report = clean(&host, &machine.roots, KNOWN, 7).await.unwrap();
        assert_eq!(report.removed.len(), 5);
        assert!(report.unknown_overrides.is_empty());
        for index in 0..5 {
            assert!(!machine.path(index).exists());
        }
        for dir in ["tilecast-renderer.service.d", "tilecast-web-renderer.service.d"] {
            assert!(!machine.roots.unit_dir.join(dir).exists(), "an emptied drop-in directory goes with its file");
        }
        assert!(!machine.roots.backup().exists(), "the backup is discarded after the reload");
        assert_eq!(host.with(|s| s.reloads), 1);
        assert_eq!(last_report(&machine.roots.state_dir), Some(report));
        // A second run finds nothing and reloads nothing.
        let again = clean(&host, &machine.roots, KNOWN, 8).await.unwrap();
        assert!(again.removed.is_empty());
        assert_eq!(host.with(|s| s.reloads), 1);
    }

    #[tokio::test]
    async fn an_administrator_override_is_never_removed_even_at_a_listed_path() {
        let machine = machine();
        machine.install_all();
        let edited = b"[Service]\nEnvironment=WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1\nEnvironment=MINE=1\n";
        machine.install(1, edited);
        // A different file in a listed directory, and a link at a listed path.
        let sibling = machine.roots.unit_dir.join("tilecast-web-renderer.service.d/10-mine.conf");
        std::fs::write(&sibling, "[Service]\nNice=5\n").unwrap();
        let host = FakeHost::new(machine.dir.path().join("opt"));
        let report = clean(&host, &machine.roots, KNOWN, 7).await.unwrap();
        assert_eq!(report.removed.len(), 4);
        assert_eq!(std::fs::read(machine.path(1)).unwrap(), edited, "left exactly as the administrator wrote it");
        assert_eq!(
            report.unknown_overrides,
            vec![UnknownOverride { path: machine.path(1).display().to_string(), sha256: Some(digest(edited)) }]
        );
        assert!(sibling.exists(), "other drop-ins are never touched, and keep their directory");
        assert!(machine.roots.unit_dir.join("tilecast-web-renderer.service.d").exists());
    }

    #[tokio::test]
    async fn a_link_or_a_directory_at_a_listed_path_is_not_followed_or_removed() {
        let machine = machine();
        let target = machine.dir.path().join("elsewhere.conf");
        std::fs::write(&target, FIXTURES[2]).unwrap();
        let link = machine.path(2);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        std::fs::create_dir_all(machine.path(0)).unwrap();
        let host = FakeHost::new(machine.dir.path().join("opt"));
        let report = clean(&host, &machine.roots, KNOWN, 7).await.unwrap();
        assert!(report.removed.is_empty());
        assert_eq!(report.unknown_overrides.len(), 2);
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(machine.path(0).is_dir());
        assert!(target.exists());
        assert_eq!(host.with(|s| s.reloads), 0, "nothing changed, nothing reloaded");
    }

    #[tokio::test]
    async fn a_failed_reload_puts_the_files_back_byte_for_byte() {
        let machine = machine();
        machine.install_all();
        let host = FakeHost::new(machine.dir.path().join("opt"));
        host.with(|s| s.fail_reload = true);
        assert!(clean(&host, &machine.roots, KNOWN, 7).await.is_err());
        for (index, bytes) in FIXTURES.iter().enumerate() {
            assert_eq!(std::fs::read(machine.path(index)).unwrap(), *bytes, "file {index} restored exactly");
            assert_eq!(std::fs::metadata(machine.path(index)).unwrap().permissions().mode() & 0o777, 0o644);
        }
        // The next run, with a working reload, removes them.
        host.with(|s| s.fail_reload = false);
        let report = clean(&host, &machine.roots, KNOWN, 8).await.unwrap();
        assert_eq!(report.removed.len(), 5);
        assert!(!machine.roots.backup().exists());
    }

    #[tokio::test]
    async fn a_crash_before_the_manifest_leaves_the_files_and_the_next_run_removes_them() {
        let machine = machine();
        machine.install_all();
        // Copying began and stopped: partial backup, no manifest, all originals.
        std::fs::create_dir_all(machine.roots.backup()).unwrap();
        std::fs::write(machine.roots.backup().join("0.bin"), b"partial").unwrap();
        let host = FakeHost::new(machine.dir.path().join("opt"));
        let report = clean(&host, &machine.roots, KNOWN, 7).await.unwrap();
        assert_eq!(report.removed.len(), 5);
        assert!(!machine.roots.backup().exists());
    }

    #[tokio::test]
    async fn a_crash_after_the_files_were_removed_finishes_with_the_reload() {
        let machine = machine();
        machine.install_all();
        let host = FakeHost::new(machine.dir.path().join("opt"));
        // Everything up to the reload happened, then the helper died.
        host.with(|s| s.fail_reload = true);
        let _ = clean(&host, &machine.roots, KNOWN, 7).await;
        host.with(|s| s.fail_reload = false);
        // Model the death after removal: files gone, backup whole.
        for index in 0..5 {
            let _ = std::fs::remove_file(machine.path(index));
        }
        let manifest = BackupManifest {
            entries: (0..5)
                .map(|i| BackupEntry { known: i, sha256: KNOWN[i].sha256.to_owned(), mode: 0o644 })
                .collect(),
        };
        std::fs::create_dir_all(machine.roots.backup()).unwrap();
        std::fs::write(machine.roots.backup().join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();
        let before = host.with(|s| s.reloads);
        clean(&host, &machine.roots, KNOWN, 8).await.unwrap();
        assert_eq!(host.with(|s| s.reloads), before + 1, "the interrupted run reloads");
        assert!(!machine.roots.backup().exists());
    }

    #[test]
    fn a_scan_changes_nothing() {
        let machine = machine();
        machine.install_all();
        machine.install(3, b"[Service]\nNice=1\n");
        let result = scan(&machine.roots, KNOWN).unwrap();
        assert_eq!(result.known_present.len(), 4);
        assert_eq!(result.unknown_overrides.len(), 1);
        for index in 0..5 {
            assert!(machine.path(index).exists());
        }
    }
}
