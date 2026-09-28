//! The production [`Host`]: systemd, the kiosk account and the filesystem.
//!
//! Boundaries (see the threat-boundary review):
//!
//! * The system manager is reached over D-Bus. Unit names are constants of
//!   this crate or unit IDs that systemd itself reported for a constant
//!   (`display-manager.service` resolves to the real display manager).
//! * The kiosk account's user manager is reached with
//!   `/usr/bin/systemctl --user --machine=<user>@.host <verb> tilecast-player.service`:
//!   a fixed program, a fixed unit, a verb from a fixed set, a user name that
//!   matched `/etc/passwd` and a strict pattern, a cleared environment, a
//!   timeout and bounded output. No shell is involved.
//! * Everything under the kiosk account's home is untrusted. The legacy
//!   data directory is opened with `RESOLVE_NO_SYMLINKS`, every file in it
//!   with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, and each must be a regular
//!   file owned by the kiosk account, of bounded size. Root only reads these
//!   files and copies their bytes; it never parses the credential file.
//! * Files root creates for the `tilecast` account are created in a
//!   directory root just made (mode 0700), with `O_EXCL | O_NOFOLLOW`, and
//!   handed over with `fchown` on the open descriptor.

use std::io::{Read as _, Write as _};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use edge_ipc::client::{ClientOptions, IpcClient};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::method::{Empty, Method};
use edge_protocol::ipc::status::DaemonStatus;
use rustix::fs::{Mode, OFlags, ResolveFlags};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use zbus::zvariant::OwnedObjectPath;

use crate::host::*;
use crate::release::{Layout, verify_installed};
use crate::state::{FileDigest, KioskRecord, RUN_DIR, ReleaseRef};

const SYSTEMCTL: &str = "/usr/bin/systemctl";
const EDGE_STATE_DIR: &str = "/var/lib/tilecast-edge";
const EDGE_SOCKET: &str = "/run/tilecast-edge/edge.sock";
const LEGACY_COPY: &str = "legacy-copy";
const MAX_STATE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MEDIA_FILES: usize = 10_000;
const MAX_TASK_OUTPUT_BYTES: u64 = 256 * 1024;
const MAX_COMMAND_OUTPUT: usize = 64 * 1024;
const JOB_TIMEOUT: Duration = Duration::from_secs(90);

/// The legacy state files, by the legacy player's fixed names
/// (`apps/player-linux/src/core/storage.ts`).
pub const LEGACY_STATE_FILES: &[&str] =
    &["installation.json", "credential.json", "executed-commands.json", "playback-flags.json", "manifest-active.json"];

#[zbus::proxy(
    interface = "org.freedesktop.systemd1.Manager",
    default_service = "org.freedesktop.systemd1",
    default_path = "/org/freedesktop/systemd1"
)]
trait Manager {
    fn start_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn stop_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn reset_failed_unit(&self, name: &str) -> zbus::Result<()>;
    fn load_unit(&self, name: &str) -> zbus::Result<OwnedObjectPath>;
    fn enable_unit_files(
        &self,
        files: &[&str],
        runtime: bool,
        force: bool,
    ) -> zbus::Result<(bool, Vec<(String, String, String)>)>;
    fn disable_unit_files(&self, files: &[&str], runtime: bool) -> zbus::Result<Vec<(String, String, String)>>;
    fn add_dependency_unit_files(
        &self,
        files: &[&str],
        target: &str,
        kind: &str,
        runtime: bool,
        force: bool,
    ) -> zbus::Result<Vec<(String, String, String)>>;
    fn reload(&self) -> zbus::Result<()>;
    fn restart_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
}

#[zbus::proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Login {
    fn set_user_linger(&self, uid: u32, enable: bool, interactive: bool) -> zbus::Result<()>;
}

/// The tilecast account's user unit that the migrator may start
/// (`packaging/systemd-user`).
const BRIDGE_PATH_UNIT: &str = "tilecast-session-bridge.path";

#[derive(Debug)]
pub struct LinuxHost {
    system: zbus::Connection,
    layout: Layout,
    run_dir: PathBuf,
    edge_state_dir: PathBuf,
    tilecast: (u32, u32),
}

fn failed(context: &str, error: impl std::fmt::Display) -> HostError {
    HostError::failed(format!("{context}: {error}"))
}

impl LinuxHost {
    pub async fn connect(layout: Layout) -> Result<Self, HostError> {
        let system = zbus::Connection::system().await.map_err(|e| failed("system bus", e))?;
        let tilecast = passwd_entry("tilecast")?.map(|entry| (entry.uid, entry.gid)).unwrap_or((u32::MAX, u32::MAX));
        std::fs::DirBuilder::new().recursive(true).mode(0o755).create(RUN_DIR).map_err(|e| failed(RUN_DIR, e))?;
        // Explicit modes throughout: the service's UMask=0077 would narrow
        // them, and the task units' account must reach its inputs.
        std::fs::set_permissions(RUN_DIR, std::fs::Permissions::from_mode(0o755)).map_err(|e| failed(RUN_DIR, e))?;
        Ok(Self {
            system,
            layout,
            run_dir: PathBuf::from(RUN_DIR),
            edge_state_dir: PathBuf::from(EDGE_STATE_DIR),
            tilecast,
        })
    }

    /// After `install`: creates the tilecast account, its display group and
    /// the state directory from the release's configuration, reloads
    /// systemd, and turns lingering on for the account so that its user
    /// manager (and with it the session bridge) runs at boot.
    ///
    /// Display device access is optional hardware (docs/tilecast-edge.md
    /// §19 rule 7): applying the udev rule and loading `i2c-dev` now is best
    /// effort, reported as a warning, and happens at the next boot anyway.
    pub async fn install_system_configuration(&self) -> Result<Vec<String>, HostError> {
        run_fixed("/usr/bin/systemd-sysusers", &["/usr/lib/sysusers.d/tilecast-edge.conf"]).await?;
        run_fixed("/usr/bin/systemd-tmpfiles", &["--create", "/usr/lib/tmpfiles.d/tilecast-edge.conf"]).await?;
        self.reload().await?;
        let uid = passwd_entry("tilecast")?.ok_or_else(|| HostError::failed("sysusers did not create tilecast"))?.uid;
        LoginProxy::new(&self.system)
            .await
            .map_err(|e| failed("logind", e))?
            .set_user_linger(uid, true, false)
            .await
            .map_err(|e| failed("enabling lingering for tilecast", e))?;

        let mut warnings = Vec::new();
        if Path::new("/run/udev/control").exists() {
            let reloaded = run_fixed("/usr/bin/udevadm", &["control", "--reload"]).await;
            let triggered = match reloaded {
                Ok(()) => {
                    run_fixed(
                        "/usr/bin/udevadm",
                        &["trigger", "--action=change", "--subsystem-match=cec", "--subsystem-match=i2c-dev"],
                    )
                    .await
                }
                Err(error) => Err(error),
            };
            if let Err(error) = triggered {
                warnings.push(format!("display device permissions apply after a reboot ({error})"));
            }
        } else {
            warnings.push("udev is not running; display device permissions apply after a reboot".into());
        }
        if let Err(error) = self.restart_and_wait("systemd-modules-load.service").await {
            warnings.push(format!("i2c-dev loads at the next boot ({error})"));
        }
        // A user manager that was already running needs to read the new user
        // units; one that lingering just started reads them itself.
        if self.unit(&format!("user@{uid}.service")).await.is_ok_and(|unit| unit.active) {
            let machine = "--machine=tilecast@.host";
            let started = match run_fixed(SYSTEMCTL, &["--user", machine, "daemon-reload"]).await {
                Ok(()) => run_fixed(SYSTEMCTL, &["--user", machine, "start", BRIDGE_PATH_UNIT]).await,
                Err(error) => Err(error),
            };
            if let Err(error) = started {
                warnings.push(format!("the session bridge starts at the next boot ({error})"));
            }
        }
        Ok(warnings)
    }

    async fn restart_and_wait(&self, unit: &str) -> Result<(), HostError> {
        let job = self.manager().await?.restart_unit(unit, "replace").await.map_err(|e| failed(unit, e))?;
        self.wait_job(&job, JOB_TIMEOUT).await
    }

    async fn manager(&self) -> Result<ManagerProxy<'_>, HostError> {
        ManagerProxy::new(&self.system).await.map_err(|e| failed("systemd manager", e))
    }

    async fn property<T>(&self, path: &OwnedObjectPath, interface: &str, name: &str) -> Result<T, HostError>
    where
        T: TryFrom<zbus::zvariant::OwnedValue>,
        T::Error: Into<zbus::Error>,
    {
        let proxy: zbus::Proxy<'_> = zbus::proxy::Builder::new(&self.system)
            .destination("org.freedesktop.systemd1")
            .and_then(|b| b.path(path.clone()))
            .and_then(|b| b.interface(interface.to_owned()))
            .map_err(|e| failed("unit proxy", e))?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .map_err(|e| failed("unit proxy", e))?;
        proxy.get_property(name).await.map_err(|e| failed(name, e))
    }

    /// Waits until a job object disappears, which is when systemd finished it.
    async fn wait_job(&self, job: &OwnedObjectPath, timeout: Duration) -> Result<(), HostError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let alive = self.property::<String>(job, "org.freedesktop.systemd1.Job", "State").await.is_ok();
            if !alive {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(HostError::Timeout("systemd job"));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn unit_path(&self, name: &str) -> Result<OwnedObjectPath, HostError> {
        self.manager().await?.load_unit(name).await.map_err(|e| failed(name, e))
    }

    async fn reload(&self) -> Result<(), HostError> {
        self.manager().await?.reload().await.map_err(|e| failed("daemon-reload", e))
    }

    /// `systemctl --user --machine=<user>@.host <verb> tilecast-player.service`.
    async fn user_systemctl(&self, kiosk: &KioskRecord, verb: &[&str]) -> Result<String, HostError> {
        if !is_account_name(&kiosk.user) {
            return Err(HostError::failed("invalid kiosk account name"));
        }
        let machine = format!("--machine={}@.host", kiosk.user);
        let mut command = tokio::process::Command::new(SYSTEMCTL);
        command
            .env_clear()
            .env("LANG", "C")
            .arg("--user")
            .arg(machine)
            .arg("--no-pager")
            .args(verb)
            .arg(LEGACY_UNIT)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(60), command.output())
            .await
            .map_err(|_| HostError::Timeout("systemctl --user"))?
            .map_err(|e| failed("systemctl --user", e))?;
        let text = String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(MAX_COMMAND_OUTPUT)]).into_owned();
        if !output.status.success() {
            let error: String = String::from_utf8_lossy(&output.stderr).chars().take(200).collect();
            return Err(HostError::failed(format!("systemctl --user {}: {}", verb.join(" "), error.trim())));
        }
        Ok(text)
    }

    fn open_legacy_dir(&self, kiosk: &KioskRecord) -> Result<OwnedFd, HostError> {
        let fd = rustix::fs::openat2(
            rustix::fs::CWD,
            &kiosk.data_dir,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )
        .map_err(|e| failed("legacy data directory", e))?;
        let stat = rustix::fs::fstat(&fd).map_err(|e| failed("legacy data directory", e))?;
        if stat.st_uid != kiosk.uid {
            return Err(HostError::failed("the legacy data directory is not owned by the kiosk account"));
        }
        Ok(fd)
    }

    /// Opens a regular file beneath `dir`, owned by `uid`, at most `max` bytes.
    fn open_beneath(dir: &OwnedFd, name: &str, uid: u32, max: u64) -> Result<Option<(std::fs::File, u64)>, HostError> {
        let fd = match rustix::fs::openat2(
            dir,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            // A link, or a path that leaves the directory: not a legacy file.
            Err(rustix::io::Errno::LOOP | rustix::io::Errno::XDEV) => return Ok(None),
            Err(error) => return Err(failed(name, error)),
        };
        let stat = rustix::fs::fstat(&fd).map_err(|e| failed(name, e))?;
        let regular = rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::RegularFile;
        if !regular || stat.st_uid != uid || stat.st_size < 0 || stat.st_size as u64 > max {
            return Ok(None);
        }
        Ok(Some((std::fs::File::from(fd), stat.st_size as u64)))
    }

    fn open_edge_state_dir(&self) -> Result<OwnedFd, HostError> {
        let fd = rustix::fs::openat2(
            rustix::fs::CWD,
            &self.edge_state_dir,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )
        .map_err(|e| failed(EDGE_STATE_DIR, e))?;
        let stat = rustix::fs::fstat(&fd).map_err(|e| failed(EDGE_STATE_DIR, e))?;
        if stat.st_uid != self.tilecast.0 {
            return Err(HostError::failed("the Edge state directory is not owned by the tilecast account"));
        }
        Ok(fd)
    }

    /// Creates a file for the tilecast account inside a root-made directory.
    fn create_for_tilecast(&self, dir: &OwnedFd, name: &str, mode: u32) -> Result<std::fs::File, HostError> {
        let fd = rustix::fs::openat(
            dir,
            name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(mode),
        )
        .map_err(|e| failed(name, e))?;
        self.give_to_tilecast(&fd)?;
        Ok(std::fs::File::from(fd))
    }

    fn give_to_tilecast(&self, fd: impl AsFd) -> Result<(), HostError> {
        let (uid, gid) = self.tilecast;
        if uid == u32::MAX {
            return Err(HostError::failed("the tilecast account does not exist"));
        }
        rustix::fs::fchown(fd, Some(rustix::fs::Uid::from_raw(uid)), Some(rustix::fs::Gid::from_raw(gid)))
            .map_err(|e| failed("fchown", e))
    }

    fn mkdir_private(&self, parent: &OwnedFd, name: &str) -> Result<OwnedFd, HostError> {
        rustix::fs::mkdirat(parent, name, Mode::from_raw_mode(0o700)).map_err(|e| failed(name, e))?;
        rustix::fs::openat(
            parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| failed(name, e))
    }
}

fn copy_all(mut from: std::fs::File, to: &mut std::fs::File, expected: u64) -> Result<(), HostError> {
    let copied = std::io::copy(&mut (&mut from).take(expected), to).map_err(|e| failed("copy", e))?;
    if copied != expected {
        return Err(HostError::failed("a legacy file changed size while it was copied"));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PasswdEntry {
    uid: u32,
    gid: u32,
    home: PathBuf,
}

/// `name` in `/etc/passwd` (local accounts: kiosks do not use a directory
/// service for their login).
fn passwd_entry(name: &str) -> Result<Option<PasswdEntry>, HostError> {
    let bytes = edge_platform::fs::read_regular(Path::new("/etc/passwd"), 4 * 1024 * 1024)
        .map_err(|e| failed("/etc/passwd", e))?
        .unwrap_or_default();
    Ok(parse_passwd(&String::from_utf8_lossy(&bytes), name))
}

fn parse_passwd(text: &str, name: &str) -> Option<PasswdEntry> {
    text.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        (fields.len() == 7 && fields[0] == name).then_some(())?;
        Some(PasswdEntry { uid: fields[2].parse().ok()?, gid: fields[3].parse().ok()?, home: PathBuf::from(fields[5]) })
    })
}

/// A POSIX-style login name.
/// Runs a fixed root-owned program with fixed arguments: no shell, a
/// cleared environment, no input and a timeout.
async fn run_fixed(program: &str, args: &[&str]) -> Result<(), HostError> {
    let mut command = tokio::process::Command::new(program);
    command
        .env_clear()
        .env("LANG", "C")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(60), command.status())
        .await
        .map_err(|_| HostError::Timeout("system configuration"))?
        .map_err(|e| failed(program, e))?;
    if !status.success() {
        return Err(HostError::failed(format!("{program} {} failed", args.first().unwrap_or(&""))));
    }
    Ok(())
}

pub fn is_account_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'_'))
        && value.len() <= 32
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// An absolute path with only normal components.
/// Checked on the text: `Path::components` silently drops `.` and `//`.
fn is_clean_absolute(path: &Path) -> bool {
    let Some(text) = path.to_str() else { return false };
    text.len() <= 1024
        && text.len() > 1
        && text.starts_with('/')
        && text[1..].split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Splits `systemctl show -p Environment` output: space-separated
/// assignments, double-quoted when they contain spaces.
fn parse_environment(value: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut current = String::new();
    let (mut quoted, mut escaped) = (false, false);
    for ch in value.chars().chain(std::iter::once(' ')) {
        match (escaped, quoted, ch) {
            (true, _, _) => {
                current.push(ch);
                escaped = false;
            }
            (false, true, '\\') => escaped = true,
            (false, _, '"') => quoted = !quoted,
            (false, false, ' ') => {
                if let Some((key, value)) = current.split_once('=') {
                    out.push((key.to_owned(), value.to_owned()));
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    out
}

fn show_properties(text: &str) -> std::collections::HashMap<String, String> {
    text.lines().filter_map(|line| line.split_once('=')).map(|(k, v)| (k.to_owned(), v.to_owned())).collect()
}

fn is_enabled(state: &str) -> bool {
    matches!(state, "enabled" | "enabled-runtime" | "alias" | "linked")
}

fn is_active(state: &str) -> bool {
    matches!(state, "active" | "activating" | "reloading" | "refreshing")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAssets {
    manifest: AssetList,
}

#[derive(serde::Deserialize)]
struct AssetList {
    #[serde(default)]
    assets: Vec<StoredAsset>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAsset {
    asset_id: String,
    variant_id: String,
    file_size: u64,
}

fn is_plain_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

#[async_trait]
impl Host for LinuxHost {
    async fn unit(&self, name: &str) -> Result<UnitState, HostError> {
        let path = self.unit_path(name).await?;
        let unit = "org.freedesktop.systemd1.Unit";
        let load: String = self.property(&path, unit, "LoadState").await?;
        if load != "loaded" {
            return Ok(UnitState { loaded: false, id: name.to_owned(), enabled: false, active: false });
        }
        let id: String = self.property(&path, unit, "Id").await?;
        let file_state: String = self.property(&path, unit, "UnitFileState").await?;
        let active: String = self.property(&path, unit, "ActiveState").await?;
        Ok(UnitState { loaded: true, id, enabled: is_enabled(&file_state), active: is_active(&active) })
    }

    async fn enable(&self, units: &[&str]) -> Result<(), HostError> {
        self.manager().await?.enable_unit_files(units, false, false).await.map_err(|e| failed("enable", e))?;
        self.reload().await
    }

    async fn disable(&self, units: &[&str]) -> Result<(), HostError> {
        self.manager().await?.disable_unit_files(units, false).await.map_err(|e| failed("disable", e))?;
        self.reload().await
    }

    async fn start(&self, unit: &str) -> Result<(), HostError> {
        let manager = self.manager().await?;
        let _ = manager.reset_failed_unit(unit).await;
        let job = manager.start_unit(unit, "replace").await.map_err(|e| failed(unit, e))?;
        self.wait_job(&job, JOB_TIMEOUT).await?;
        if !self.unit(unit).await?.active {
            return Err(HostError::failed(format!("{unit} did not start")));
        }
        Ok(())
    }

    async fn arm_recovery(&self) -> Result<(), HostError> {
        let manager = self.manager().await?;
        manager.enable_unit_files(&[RECOVER_UNIT], false, false).await.map_err(|e| failed("enable recovery", e))?;
        for unit in EDGE_UNITS {
            manager
                .add_dependency_unit_files(&[RECOVER_UNIT], unit, "Requires", false, false)
                .await
                .map_err(|e| failed("recovery dependency", e))?;
        }
        self.reload().await
    }

    async fn disarm_recovery(&self) -> Result<(), HostError> {
        // Disabling removes every link to the unit, including the Edge
        // units' Requires= links.
        self.disable(&[RECOVER_UNIT]).await
    }

    async fn start_detached(&self, unit: &str) -> Result<(), HostError> {
        let manager = self.manager().await?;
        let _ = manager.reset_failed_unit(unit).await;
        manager.start_unit(unit, "replace").await.map_err(|e| failed(unit, e))?;
        Ok(())
    }

    async fn stop(&self, unit: &str) -> Result<(), HostError> {
        let job = self.manager().await?.stop_unit(unit, "replace").await.map_err(|e| failed(unit, e))?;
        self.wait_job(&job, JOB_TIMEOUT).await
    }

    async fn run_task(&self, unit: &str, output: &str, timeout: Duration) -> Result<TaskResult, HostError> {
        let output_path = self.run_dir.join(output);
        let _ = std::fs::remove_file(&output_path);
        let manager = self.manager().await?;
        let _ = manager.reset_failed_unit(unit).await;
        let job = manager.start_unit(unit, "replace").await.map_err(|e| failed(unit, e))?;
        if let Err(error) = self.wait_job(&job, timeout).await {
            let _ = self.stop(unit).await;
            return Err(error);
        }
        let path = self.unit_path(unit).await?;
        let exit_status: i32 = self.property(&path, "org.freedesktop.systemd1.Service", "ExecMainStatus").await?;
        let text = edge_platform::fs::read_regular(&output_path, MAX_TASK_OUTPUT_BYTES)
            .map_err(|e| failed(output, e))?
            .unwrap_or_default();
        let output = String::from_utf8_lossy(&text)
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .and_then(|line| serde_json::from_str::<Value>(line).ok());
        Ok(TaskResult { exit_status, output })
    }

    async fn resolve_kiosk(&self, user: &str) -> Result<KioskRecord, HostError> {
        if !is_account_name(user) {
            return Err(HostError::failed("not a valid account name"));
        }
        let entry = passwd_entry(user)?.ok_or_else(|| HostError::failed("no such local account"))?;
        if entry.uid < 1000 || entry.uid == 65534 || !is_clean_absolute(&entry.home) {
            return Err(HostError::failed("not a kiosk login account"));
        }
        if !self.unit(&format!("user@{}.service", entry.uid)).await?.active {
            return Err(HostError::failed(
                "the account's user manager is not running; enable lingering with `loginctl enable-linger`",
            ));
        }
        let kiosk =
            KioskRecord { user: user.to_owned(), uid: entry.uid, home: entry.home.clone(), data_dir: PathBuf::new() };
        // The legacy unit may pin the data directory; otherwise the player's
        // own default applies (`apps/player-linux/src/core/storage.ts`).
        let shown = self.user_systemctl(&kiosk, &["show", "--property=Environment"]).await?;
        let environment = parse_environment(show_properties(&shown).get("Environment").map_or("", String::as_str));
        let lookup = |key: &str| environment.iter().find(|(k, _)| k == key).map(|(_, v)| PathBuf::from(v));
        let data_dir = lookup("TILECAST_DATA_DIR")
            .or_else(|| lookup("XDG_DATA_HOME").map(|dir| dir.join("tilecast-player")))
            .unwrap_or_else(|| entry.home.join(".local/share/tilecast-player"));
        if !is_clean_absolute(&data_dir) {
            return Err(HostError::failed("the legacy data directory is not a clean absolute path"));
        }
        let kiosk = KioskRecord { data_dir, ..kiosk };
        self.open_legacy_dir(&kiosk)?;
        Ok(kiosk)
    }

    async fn legacy_unit(&self, kiosk: &KioskRecord) -> Result<UnitState, HostError> {
        let shown = self.user_systemctl(kiosk, &["show", "--property=LoadState,ActiveState,UnitFileState,Id"]).await?;
        let properties = show_properties(&shown);
        let get = |key: &str| properties.get(key).map_or("", String::as_str);
        Ok(UnitState {
            loaded: get("LoadState") == "loaded",
            id: LEGACY_UNIT.to_owned(),
            enabled: is_enabled(get("UnitFileState")),
            active: is_active(get("ActiveState")),
        })
    }

    async fn legacy_enable(&self, kiosk: &KioskRecord) -> Result<(), HostError> {
        self.user_systemctl(kiosk, &["enable"]).await.map(|_| ())
    }

    async fn legacy_disable(&self, kiosk: &KioskRecord) -> Result<(), HostError> {
        self.user_systemctl(kiosk, &["disable"]).await.map(|_| ())
    }

    async fn legacy_start(&self, kiosk: &KioskRecord) -> Result<(), HostError> {
        self.user_systemctl(kiosk, &["start", "--no-block"]).await.map(|_| ())
    }

    async fn legacy_stop(&self, kiosk: &KioskRecord) -> Result<(), HostError> {
        self.user_systemctl(kiosk, &["stop"]).await.map(|_| ())
    }

    fn legacy_processes(&self, kiosk: Option<&KioskRecord>) -> Result<usize, HostError> {
        let mut count = 0;
        let entries = std::fs::read_dir("/proc").map_err(|e| failed("/proc", e))?;
        for entry in entries.flatten().take(1 << 16) {
            let name = entry.file_name();
            let Some(pid) = name.to_str().filter(|n| n.bytes().all(|b| b.is_ascii_digit())) else { continue };
            let Ok(metadata) = std::fs::metadata(entry.path()) else { continue };
            if kiosk.is_some_and(|k| metadata.uid() != k.uid) {
                continue;
            }
            let Ok(Some(cmdline)) =
                edge_platform::fs::read_regular(&Path::new("/proc").join(pid).join("cmdline"), 4096)
            else {
                continue;
            };
            let program = cmdline.split(|b| *b == 0).next().unwrap_or_default();
            let base = program.rsplit(|b| *b == b'/').next().unwrap_or_default();
            if base.starts_with(b"tilecast-player") {
                count += 1;
            }
        }
        Ok(count)
    }

    fn snapshot_legacy(&self, kiosk: &KioskRecord) -> Result<Vec<FileDigest>, HostError> {
        let dir = self.open_legacy_dir(kiosk)?;
        let mut out = vec![];
        for name in LEGACY_STATE_FILES {
            let Some((mut file, size)) = Self::open_beneath(&dir, name, kiosk.uid, MAX_STATE_FILE_BYTES)? else {
                continue;
            };
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(|e| failed(name, e))?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            out.push(FileDigest { path: (*name).to_owned(), sha256: hex(&hasher.finalize()), size });
        }
        Ok(out)
    }

    fn stage_compat(&self, kiosk: &KioskRecord) -> Result<(), HostError> {
        let compat = self.run_dir.join("compat");
        if std::fs::symlink_metadata(&compat).is_ok() {
            std::fs::remove_dir_all(&compat).map_err(|e| failed("compat stage", e))?;
        }
        std::fs::DirBuilder::new().mode(0o750).create(&compat).map_err(|e| failed("compat stage", e))?;
        let (_, gid) = self.tilecast;
        rustix::fs::chown(&compat, None, Some(rustix::fs::Gid::from_raw(gid))).map_err(|e| failed("chown", e))?;
        std::fs::set_permissions(&compat, std::fs::Permissions::from_mode(0o750)).map_err(|e| failed("chmod", e))?;
        let dir = self.open_legacy_dir(kiosk)?;
        if let Some((source, size)) = Self::open_beneath(&dir, "manifest-active.json", kiosk.uid, MAX_STATE_FILE_BYTES)?
        {
            let mut target = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o640)
                .custom_flags(OFlags::NOFOLLOW.bits() as i32)
                .open(compat.join("manifest-active.json"))
                .map_err(|e| failed("compat stage", e))?;
            copy_all(source, &mut target, size)?;
            rustix::fs::fchown(&target, None, Some(rustix::fs::Gid::from_raw(gid))).map_err(|e| failed("chown", e))?;
            rustix::fs::fchmod(&target, Mode::from_raw_mode(0o640)).map_err(|e| failed("chmod", e))?;
        }
        Ok(())
    }

    fn stage_import(&self, kiosk: &KioskRecord, media_budget_bytes: u64) -> Result<StageSummary, HostError> {
        self.clear_import_stage()?;
        let state = self.open_edge_state_dir()?;
        let copy = self.mkdir_private(&state, LEGACY_COPY)?;
        let legacy = self.open_legacy_dir(kiosk)?;
        let mut summary = StageSummary { state_files: 0, media_files: 0, media_bytes: 0, media_copied: false };
        for name in LEGACY_STATE_FILES {
            let Some((source, size)) = Self::open_beneath(&legacy, name, kiosk.uid, MAX_STATE_FILE_BYTES)? else {
                continue;
            };
            let mut target = self.create_for_tilecast(&copy, name, 0o600)?;
            copy_all(source, &mut target, size)?;
            summary.state_files += 1;
        }
        // Which media to copy: the assets the copied manifest lists, by the
        // legacy player's `<assetId>-<variantId>` names.
        let manifest = Self::open_beneath(&copy, "manifest-active.json", self.tilecast.0, MAX_STATE_FILE_BYTES)?;
        let mut wanted: Vec<(String, u64)> = vec![];
        if let Some((mut file, _)) = manifest {
            let mut bytes = vec![];
            file.read_to_end(&mut bytes).map_err(|e| failed("manifest copy", e))?;
            if let Ok(stored) = serde_json::from_slice::<StoredAssets>(&bytes) {
                for asset in stored.manifest.assets.into_iter().take(MAX_MEDIA_FILES) {
                    if is_plain_id(&asset.asset_id) && is_plain_id(&asset.variant_id) {
                        let name = format!("{}-{}", asset.asset_id, asset.variant_id);
                        if !wanted.iter().any(|(n, _)| *n == name) {
                            wanted.push((name, asset.file_size));
                        }
                    }
                }
            }
        }
        let total = wanted.iter().fold(0u64, |sum, (_, size)| sum.saturating_add(*size));
        if !wanted.is_empty() && total <= media_budget_bytes {
            let legacy_media = rustix::fs::openat2(
                &legacy,
                "cache/media",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
                ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
            );
            if let Ok(legacy_media) = legacy_media {
                let cache = self.mkdir_private(&copy, "cache")?;
                let media = self.mkdir_private(&cache, "media")?;
                for (name, size) in &wanted {
                    let Some((source, actual)) = Self::open_beneath(&legacy_media, name, kiosk.uid, *size)? else {
                        continue;
                    };
                    if actual != *size {
                        continue;
                    }
                    let mut target = self.create_for_tilecast(&media, name, 0o600)?;
                    copy_all(source, &mut target, actual)?;
                    summary.media_files += 1;
                    summary.media_bytes += actual;
                }
                self.give_to_tilecast(&media)?;
                self.give_to_tilecast(&cache)?;
                summary.media_copied = true;
            }
        }
        // Handed over last, so the tilecast account could not add anything
        // while root filled it.
        self.give_to_tilecast(&copy)?;
        Ok(summary)
    }

    fn clear_import_stage(&self) -> Result<(), HostError> {
        let path = self.edge_state_dir.join(LEGACY_COPY);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => {
                std::fs::remove_dir_all(&path).map_err(|e| failed("legacy copy", e))
            }
            Ok(_) => std::fs::remove_file(&path).map_err(|e| failed("legacy copy", e)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failed("legacy copy", error)),
        }
    }

    fn free_state_bytes(&self) -> Result<u64, HostError> {
        let stat = rustix::fs::statvfs(&self.edge_state_dir).map_err(|e| failed(EDGE_STATE_DIR, e))?;
        Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
    }

    fn set_probation(&self, on: bool) -> Result<(), HostError> {
        let path = Path::new(edge_platform::paths::MIGRATION_PROBATION_FILE);
        if on {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o644)
                .custom_flags(OFlags::NOFOLLOW.bits() as i32)
                .open(path)
                .map_err(|e| failed("probation marker", e))?;
            file.write_all(b"migration settling\n").map_err(|e| failed("probation marker", e))?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644))
                .map_err(|e| failed("probation marker", e))
        } else {
            match std::fs::remove_file(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(failed("probation marker", error)),
                _ => Ok(()),
            }
        }
    }

    fn verify_release(&self) -> Result<ReleaseRef, HostError> {
        let key = crate::release::trusted_key(&self.layout.key_override).map_err(|e| failed("release key", e))?;
        let current = std::fs::canonicalize(self.layout.current()).map_err(|e| failed("current release", e))?;
        if current.parent() != Some(self.layout.install_root.as_path()) {
            return Err(HostError::failed("current does not point into the install root"));
        }
        let release = verify_installed(&current, &key).map_err(|e| failed("installed release", e))?;
        Ok(ReleaseRef {
            version_name: release.manifest.version_name,
            version_code: release.manifest.version_code,
            manifest_sha256: release.manifest_sha256,
        })
    }

    async fn edge_status(&self) -> Option<DaemonStatus> {
        let options = ClientOptions::new(Role::Tilecastctl, "tilecast-edge-migrate", env!("CARGO_PKG_VERSION"));
        let request = async {
            let client = IpcClient::connect(Path::new(EDGE_SOCKET), options).await.ok()?;
            let value = client.request(Method::StatusGet(Empty {})).await.ok()?.ok()?;
            serde_json::from_value::<DaemonStatus>(value).ok()
        };
        tokio::time::timeout(Duration::from_secs(5), request).await.ok().flatten()
    }

    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default()
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemctl_environment_is_split_like_systemd_prints_it() {
        let parsed = parse_environment(r#"PATH=/usr/bin TILECAST_LOG_LEVEL=info "TILECAST_DATA_DIR=/srv/tile cast""#);
        assert_eq!(
            parsed,
            vec![
                ("PATH".into(), "/usr/bin".into()),
                ("TILECAST_LOG_LEVEL".into(), "info".into()),
                ("TILECAST_DATA_DIR".into(), "/srv/tile cast".into()),
            ]
        );
        assert!(parse_environment("").is_empty());
    }

    #[test]
    fn account_names_and_paths_are_strict() {
        for good in ["kiosk", "tilecast", "_signage", "user-1"] {
            assert!(is_account_name(good), "{good}");
        }
        for bad in ["", "Kiosk", "1user", "a b", "kiosk@.host", "x;rm", &"a".repeat(33)] {
            assert!(!is_account_name(bad), "{bad}");
        }
        assert!(is_clean_absolute(Path::new("/home/kiosk/.local/share/tilecast-player")));
        for bad in ["relative", "/home/../etc", "/home/./kiosk", "/home//kiosk"] {
            assert!(!is_clean_absolute(Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn passwd_lines_are_parsed_exactly() {
        let text = "root:x:0:0:root:/root:/bin/bash\nkiosk:x:1000:1000:Kiosk,,,:/home/kiosk:/bin/bash\nbad:line\n";
        assert_eq!(
            parse_passwd(text, "kiosk"),
            Some(PasswdEntry { uid: 1000, gid: 1000, home: PathBuf::from("/home/kiosk") })
        );
        assert_eq!(parse_passwd(text, "kios"), None);
        assert_eq!(parse_passwd(text, "bad"), None);
    }
}
