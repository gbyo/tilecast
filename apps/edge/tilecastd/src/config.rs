//! Daemon configuration (`/etc/tilecast-edge/edge.toml`).
//!
//! The file is optional and root-owned; every field has a safe default. It is
//! operator configuration, never server-supplied: server policy arrives as
//! typed player configuration over the normal player API instead. Unknown
//! keys are rejected so a typo, or a section this build no longer has, fails
//! loudly at startup (`tilecastd check-config`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct EdgeConfig {
    pub paths: PathsConfig,
    pub ipc: IpcConfig,
    pub cas: CasConfig,
    pub renderer: RendererConfig,
    pub display: DisplayConfig,
    pub log: LogConfig,
    pub legacy: LegacyConfig,
    pub dev: DevConfig,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct PathsConfig {
    /// Overrides `STATE_DIRECTORY` / `/var/lib/tilecast-edge`.
    pub state_dir: Option<PathBuf>,
    /// Overrides `RUNTIME_DIRECTORY` / `/run/tilecast-edge`.
    pub runtime_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct IpcConfig {
    /// Extra UIDs allowed to connect as a renderer. Normally empty: the
    /// renderer runs as the daemon's own `tilecast` account.
    pub renderer_uids: BTreeSet<u32>,
    /// Extra UIDs allowed read-only `tilecastctl` access.
    pub observer_uids: BTreeSet<u32>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct CasConfig {
    /// Upper bound on verified CAS bytes (the legacy player default: 8 GiB).
    pub limit_bytes: u64,
    /// Free space that downloads never consume (legacy default: 1 GiB).
    pub reserved_free_bytes: u64,
    /// Concurrent inbound downloads (legacy default: 2).
    pub max_concurrent_downloads: usize,
}

impl Default for CasConfig {
    fn default() -> Self {
        Self {
            limit_bytes: 8 * 1024 * 1024 * 1024,
            reserved_free_bytes: 1024 * 1024 * 1024,
            max_concurrent_downloads: 2,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct RendererConfig {
    /// Installed renderer binary, probed for capability reporting only.
    /// tilecastd never launches it: `tilecast-renderer.service` does.
    pub binary: PathBuf,
    pub dri_dir: PathBuf,
    pub wayland_runtime_dir: Option<PathBuf>,
    pub wayland_display: Option<String>,
    /// No meaningful progress for this long while playing marks a stall.
    pub stall_threshold_seconds: u64,
    pub prevent_display_sleep: bool,
}

impl Default for RendererConfig {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("/opt/tilecast-edge/current/bin/tilecast-renderer-wpe"),
            dri_dir: PathBuf::from("/dev/dri"),
            wayland_runtime_dir: None,
            wayland_display: None,
            stall_threshold_seconds: 180,
            prevent_display_sleep: true,
        }
    }
}

/// Display control (HDMI-CEC and DDC/CI). Both are on by default and are
/// used only when the hardware and the udev grant exist; a display that
/// misbehaves under DDC/CI polling can be excluded here.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct DisplayConfig {
    pub cec_enabled: bool,
    pub ddc_enabled: bool,
    /// Use only this CEC adapter (`cec0` … `cec31`) instead of the first one
    /// with a connected display.
    pub cec_adapter: Option<String>,
}

impl Default for DisplayConfig {
    fn default() -> Self {
        Self { cec_enabled: true, ddc_enabled: true, cec_adapter: None }
    }
}

impl DisplayConfig {
    /// The adapter number of `cec_adapter`, when it is set and valid.
    pub fn cec_adapter_number(&self) -> Option<u8> {
        let digits = self.cec_adapter.as_deref()?.strip_prefix("cec")?;
        if digits.is_empty() || digits.len() > 2 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        digits.parse::<u8>().ok().filter(|n| *n < 32)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct LogConfig {
    /// `tracing` filter directive, e.g. `info` or `info,edge_cas=debug`.
    pub level: String,
    /// `json` (journald/production) or `text` (development).
    pub format: LogFormat,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self { level: "info".into(), format: LogFormat::Json }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogFormat {
    Json,
    Text,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct LegacyConfig {
    /// The legacy Linux Player data directory to import once. Defaults to
    /// `$HOME/.local/share/tilecast-player` of the daemon account.
    pub data_dir: Option<PathBuf>,
}

/// Development and CI settings. Rejected in production builds' packaged
/// configuration by review, and inert unless set explicitly.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct DevConfig {
    /// A local presentation fixture (JSON) to activate instead of the status
    /// surface. Its media files are imported into the CAS and verified before
    /// activation. Operator-configured only; never reachable through IPC.
    pub fixture: Option<PathBuf>,
    /// Device and sysfs roots for display control, so tests can use a
    /// temporary tree. Default `/dev` and `/sys`.
    pub hardware_dev_dir: Option<PathBuf>,
    pub hardware_sys_dir: Option<PathBuf>,
    /// The Presentation Network helper's socket. Default
    /// `/run/tilecast/networkd.sock`.
    pub networkd_socket: Option<PathBuf>,
    /// The update helper's socket. Default
    /// `/run/tilecast-edge-update/update.sock`.
    pub update_helper_socket: Option<PathBuf>,
    /// `false` keeps the daemon from taking a systemd-logind idle inhibitor
    /// lock, so a test never changes the host it runs on.
    pub idle_inhibit: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid configuration in {path}: {message}")]
    Invalid { path: PathBuf, message: String },
}

impl EdgeConfig {
    /// Loads `path`. A missing file at the default location means defaults;
    /// a missing explicitly requested file is an error.
    pub fn load(path: &Path, explicit: bool) -> Result<Self, ConfigError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !explicit => return Ok(Self::default()),
            Err(source) => return Err(ConfigError::Read { path: path.to_path_buf(), source }),
        };
        let config: Self = toml::from_str(&text)
            .map_err(|error| ConfigError::Invalid { path: path.to_path_buf(), message: error.message().to_owned() })?;
        config.validate().map_err(|message| ConfigError::Invalid { path: path.to_path_buf(), message })?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), String> {
        for (name, path) in [
            ("paths.state_dir", self.paths.state_dir.as_ref()),
            ("paths.runtime_dir", self.paths.runtime_dir.as_ref()),
            ("legacy.data_dir", self.legacy.data_dir.as_ref()),
            ("dev.fixture", self.dev.fixture.as_ref()),
            ("dev.hardware_dev_dir", self.dev.hardware_dev_dir.as_ref()),
            ("dev.hardware_sys_dir", self.dev.hardware_sys_dir.as_ref()),
            ("dev.networkd_socket", self.dev.networkd_socket.as_ref()),
            ("dev.update_helper_socket", self.dev.update_helper_socket.as_ref()),
        ] {
            if let Some(path) = path
                && !path.is_absolute()
            {
                return Err(format!("{name} must be an absolute path"));
            }
        }
        if self.cas.limit_bytes == 0 {
            return Err("cas.limit_bytes must be greater than zero".into());
        }
        if !(1..=16).contains(&self.cas.max_concurrent_downloads) {
            return Err("cas.max_concurrent_downloads must be between 1 and 16".into());
        }
        if self.display.cec_adapter.is_some() && self.display.cec_adapter_number().is_none() {
            return Err("display.cec_adapter must name an adapter such as cec0".into());
        }
        if !(30..=3_600).contains(&self.renderer.stall_threshold_seconds) {
            return Err("renderer.stall_threshold_seconds must be between 30 and 3600".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_default_file_means_defaults() {
        let config = EdgeConfig::load(Path::new("/nonexistent/tilecast/edge.toml"), false).expect("defaults");
        assert_eq!(config, EdgeConfig::default());
        assert!(EdgeConfig::load(Path::new("/nonexistent/tilecast/edge.toml"), true).is_err());
    }

    #[test]
    fn rejects_unknown_keys_and_invalid_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("edge.toml");
        std::fs::write(&path, "[cas]\nmax_concurrent_downloads = 4\n").expect("write");
        assert_eq!(EdgeConfig::load(&path, true).expect("valid").cas.max_concurrent_downloads, 4);
        std::fs::write(&path, "[cas]\nmax_concurent_downloads = 4\n").expect("write");
        assert!(EdgeConfig::load(&path, true).is_err());
        std::fs::write(&path, "[paths]\nstate_dir = \"relative\"\n").expect("write");
        assert!(EdgeConfig::load(&path, true).is_err());
        std::fs::write(&path, "[cas]\nmax_concurrent_downloads = 0\n").expect("write");
        assert!(EdgeConfig::load(&path, true).is_err());
        std::fs::write(&path, "[display]\ncec_adapter = \"cec1\"\nddc_enabled = false\n").expect("write");
        let display = EdgeConfig::load(&path, true).expect("valid").display;
        assert_eq!((display.cec_adapter_number(), display.ddc_enabled), (Some(1), false));
        for bad in ["/dev/cec1", "cec", "cec99", "i2c-1"] {
            std::fs::write(&path, format!("[display]\ncec_adapter = \"{bad}\"\n")).expect("write");
            assert!(EdgeConfig::load(&path, true).is_err(), "{bad}");
        }
        // Peer delivery is not part of Edge 1; a leftover section is an error.
        std::fs::write(&path, "[mesh]\nenabled = true\n").expect("write");
        assert!(EdgeConfig::load(&path, true).is_err());
    }
}
