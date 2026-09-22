//! Daemon configuration (`/etc/tilecast-edge/edge.toml`).
//!
//! The file is optional and root-owned; every field has a safe default. It is
//! operator configuration, never server- or peer-supplied: server policy
//! arrives through signed, typed Edge configuration instead. Unknown keys are
//! rejected so a typo fails loudly at startup (`tilecastd check-config`).

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
    pub mesh: MeshConfig,
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

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct MeshConfig {
    /// Mesh and peer delivery stay off until enabled by the operator or,
    /// later, by signed server policy (RFC §47.1).
    pub enabled: bool,
    pub zenoh_port: u16,
    pub blob_port: u16,
    /// `host:port` Zenoh TLS endpoints tried in addition to multicast. Hints
    /// only: certificate verification decides trust.
    pub static_seeds: Vec<String>,
    pub multicast_scouting: bool,
    /// Interface names the mesh may listen on. Empty means "the interface
    /// carrying the default route". Presentation Network interfaces are always
    /// excluded regardless of this list.
    pub interfaces: Vec<String>,
}

impl Default for MeshConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            zenoh_port: 7447,
            blob_port: 7448,
            static_seeds: Vec::new(),
            multicast_scouting: true,
            interfaces: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct LogConfig {
    /// `tracing` filter directive, e.g. `info` or `info,edge_mesh=debug`.
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
        if self.mesh.zenoh_port == 0 || self.mesh.blob_port == 0 || self.mesh.zenoh_port == self.mesh.blob_port {
            return Err("mesh ports must be distinct and non-zero".into());
        }
        if self.mesh.static_seeds.len() > 32 {
            return Err("mesh.static_seeds may list at most 32 endpoints".into());
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
        std::fs::write(&path, "[mesh]\nenabled = true\nzenoh_port = 7447\nblob_port = 7448\n").expect("write");
        assert!(EdgeConfig::load(&path, true).expect("valid").mesh.enabled);
        std::fs::write(&path, "[mesh]\nenabeld = true\n").expect("write");
        assert!(EdgeConfig::load(&path, true).is_err());
        std::fs::write(&path, "[paths]\nstate_dir = \"relative\"\n").expect("write");
        assert!(EdgeConfig::load(&path, true).is_err());
        std::fs::write(&path, "[mesh]\nzenoh_port = 7448\n").expect("write");
        assert!(EdgeConfig::load(&path, true).is_err());
    }
}
