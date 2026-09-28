//! The production [`UpdateHost`]: systemd over D-Bus, two fixed programs,
//! the kernel boot ID and `CLOCK_BOOTTIME`, and the daemon's status socket.
//!
//! Boundaries (docs/tilecast-edge-update-threat-review.md):
//!
//! * Unit names are the constants of `host.rs`.
//! * `systemd-sysusers` and `systemd-tmpfiles --create` run with their fixed
//!   configuration paths, a cleared environment and a timeout. No shell.
//! * The guard units are written from `guard_units.rs`; the only variable
//!   is a validated version name.

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use edge_ipc::client::{ClientOptions, IpcClient};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::method::{Empty, Method};
use edge_protocol::ipc::status::DaemonStatus;
use zbus::zvariant::OwnedObjectPath;

use crate::host::{GUARD_SERVICE, GUARD_TIMER, HostError, UnitActivity, UpdateHost};

const EDGE_SOCKET: &str = "/run/tilecast-edge/edge.sock";
const JOB_TIMEOUT: Duration = Duration::from_secs(90);

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
    fn reload(&self) -> zbus::Result<()>;
}

#[derive(Debug)]
pub struct LinuxHost {
    system: zbus::Connection,
    unit_dir: PathBuf,
    install_root: PathBuf,
}

fn failed(context: &str, error: impl std::fmt::Display) -> HostError {
    HostError::failed(format!("{context}: {error}"))
}

impl LinuxHost {
    pub async fn connect(unit_dir: &Path, install_root: &Path) -> Result<Self, HostError> {
        let system = zbus::Connection::system().await.map_err(|e| failed("system bus", e))?;
        Ok(Self { system, unit_dir: unit_dir.to_path_buf(), install_root: install_root.to_path_buf() })
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
}

/// Runs a fixed program with fixed arguments, a cleared environment and a
/// timeout.
async fn run_fixed(program: &str, args: &[&str]) -> Result<(), HostError> {
    let mut command = tokio::process::Command::new(program);
    command
        .env_clear()
        .env("LANG", "C")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| HostError::Timeout("system configuration"))?
        .map_err(|e| failed(program, e))?;
    if !output.status.success() {
        let error: String = String::from_utf8_lossy(&output.stderr).chars().take(200).collect();
        return Err(HostError::failed(format!("{program}: {}", error.trim())));
    }
    Ok(())
}

#[async_trait]
impl UpdateHost for LinuxHost {
    async fn stop(&self, unit: &str) -> Result<(), HostError> {
        let job = self.manager().await?.stop_unit(unit, "replace").await.map_err(|e| failed(unit, e))?;
        self.wait_job(&job, JOB_TIMEOUT).await
    }

    async fn start(&self, unit: &str) -> Result<(), HostError> {
        let manager = self.manager().await?;
        let _ = manager.reset_failed_unit(unit).await;
        manager.start_unit(unit, "replace").await.map_err(|e| failed(unit, e))?;
        Ok(())
    }

    async fn activity(&self, unit: &str) -> Result<UnitActivity, HostError> {
        let path = self.manager().await?.load_unit(unit).await.map_err(|e| failed(unit, e))?;
        let state: String = self.property(&path, "org.freedesktop.systemd1.Unit", "ActiveState").await?;
        Ok(match state.as_str() {
            "inactive" => UnitActivity::Inactive,
            "failed" => UnitActivity::Failed,
            _ => UnitActivity::Running,
        })
    }

    async fn reload(&self) -> Result<(), HostError> {
        self.manager().await?.reload().await.map_err(|e| failed("daemon-reload", e))
    }

    async fn apply_system_configuration(&self) -> Result<(), HostError> {
        run_fixed("/usr/bin/systemd-sysusers", &["/usr/lib/sysusers.d/tilecast-edge.conf"]).await?;
        run_fixed("/usr/bin/systemd-tmpfiles", &["--create", "/usr/lib/tmpfiles.d/tilecast-edge.conf"]).await
    }

    async fn arm_guard(&self, previous_version: &str) -> Result<(), HostError> {
        if !edge_release::manifest::is_version_name(previous_version) {
            return Err(HostError::failed("invalid previous version"));
        }
        let service = crate::guard_units::service(&self.install_root, previous_version);
        edge_release::install::write_atomic(&self.unit_dir, GUARD_SERVICE, service.as_bytes(), 0o644)
            .map_err(|e| failed(GUARD_SERVICE, e))?;
        edge_release::install::write_atomic(&self.unit_dir, GUARD_TIMER, crate::guard_units::timer().as_bytes(), 0o644)
            .map_err(|e| failed(GUARD_TIMER, e))?;
        let manager = self.manager().await?;
        manager.reload().await.map_err(|e| failed("daemon-reload", e))?;
        manager
            .enable_unit_files(&[GUARD_SERVICE, GUARD_TIMER], false, true)
            .await
            .map_err(|e| failed("enable guard", e))?;
        manager.reload().await.map_err(|e| failed("daemon-reload", e))?;
        manager.start_unit(GUARD_TIMER, "replace").await.map_err(|e| failed(GUARD_TIMER, e))?;
        Ok(())
    }

    async fn disarm_guard(&self) -> Result<(), HostError> {
        let manager = self.manager().await?;
        let present = self.unit_dir.join(GUARD_SERVICE).exists() || self.unit_dir.join(GUARD_TIMER).exists();
        if !present {
            return Ok(());
        }
        let _ = manager.stop_unit(GUARD_TIMER, "replace").await;
        let _ = manager.disable_unit_files(&[GUARD_SERVICE, GUARD_TIMER], false).await;
        for name in [GUARD_SERVICE, GUARD_TIMER] {
            match std::fs::remove_file(self.unit_dir.join(name)) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(failed(name, error)),
                _ => {}
            }
        }
        edge_release::install::sync_dir(&self.unit_dir).map_err(|e| failed("unit directory", e))?;
        manager.reload().await.map_err(|e| failed("daemon-reload", e))
    }

    async fn restarts(&self, unit: &str) -> Result<u64, HostError> {
        let path = self.manager().await?.load_unit(unit).await.map_err(|e| failed(unit, e))?;
        let restarts: u32 = self.property(&path, "org.freedesktop.systemd1.Service", "NRestarts").await?;
        Ok(u64::from(restarts))
    }

    async fn daemon_status(&self) -> Option<DaemonStatus> {
        let options = ClientOptions::new(Role::Tilecastctl, "tilecast-edge-update", env!("CARGO_PKG_VERSION"));
        let request = async {
            let client = IpcClient::connect(Path::new(EDGE_SOCKET), options).await.ok()?;
            let value = client.request(Method::StatusGet(Empty {})).await.ok()?.ok()?;
            serde_json::from_value::<DaemonStatus>(value).ok()
        };
        tokio::time::timeout(Duration::from_secs(5), request).await.ok().flatten()
    }

    /// The kernel's boot ID and the start time of PID 1. On a machine both
    /// change only at boot; in a container the boot ID survives a restart of
    /// the container, and PID 1's start time does not.
    fn boot_id(&self) -> String {
        let boot: String = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map(|text| text.trim().chars().take(64).collect())
            .unwrap_or_default();
        let init = std::fs::read_to_string("/proc/1/stat")
            .ok()
            .and_then(|stat| {
                stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(19).map(str::to_owned))
            })
            .unwrap_or_default();
        format!("{boot}:{init}")
    }

    fn boottime_ms(&self) -> i64 {
        let time = rustix::time::clock_gettime(rustix::time::ClockId::Boottime);
        time.tv_sec.saturating_mul(1_000).saturating_add(time.tv_nsec / 1_000_000)
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
