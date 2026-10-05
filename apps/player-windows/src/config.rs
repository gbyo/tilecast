//! Operator configuration (`tilecast-windows.toml`). The player runs with
//! defaults; the file only overrides them. Unknown fields are rejected so a
//! typo can never silently mean something else.

use std::path::{Path, PathBuf};

/// `%LOCALAPPDATA%\Tilecast\Tilecast Player\tilecast-windows.toml`, beside
/// the state it configures.
pub const CONFIG_FILE_NAME: &str = "tilecast-windows.toml";

pub fn default_config_file() -> Option<PathBuf> {
    crate::paths::default_state_dir().map(|dir| dir.join(CONFIG_FILE_NAME))
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read {path}: {source}")]
    Read { path: PathBuf, source: std::io::Error },
    #[error("invalid {path}: {message}")]
    Invalid { path: PathBuf, message: String },
}

#[derive(Debug, Clone, Default, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct PathsConfig {
    /// Overrides the LocalAppData state directory.
    pub state_dir: Option<PathBuf>,
    /// Overrides the TEMP runtime directory.
    pub runtime_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct CasConfig {
    /// Content-store byte limit (default 8 GiB).
    pub limit_bytes: u64,
    /// Free-space floor the store never eats into (default 1 GiB).
    pub reserved_free_bytes: u64,
}

impl Default for CasConfig {
    fn default() -> Self {
        Self { limit_bytes: 8 << 30, reserved_free_bytes: 1 << 30 }
    }
}

#[derive(Debug, Clone, Default, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct LogConfig {
    /// `error`, `warn`, `info`, `debug` or `trace` (default `info`).
    pub level: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WindowsConfig {
    #[serde(default)]
    pub paths: PathsConfig,
    #[serde(default)]
    pub cas: CasConfig,
    #[serde(default)]
    pub log: LogConfig,
}

impl WindowsConfig {
    /// Loads `path`, or defaults when it is absent and not explicit.
    pub fn load(path: &Path, explicit: bool) -> Result<Self, ConfigError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !explicit => {
                return Ok(Self::default());
            }
            Err(source) => return Err(ConfigError::Read { path: path.to_path_buf(), source }),
        };
        let config: Self = toml::from_str(&text)
            .map_err(|error| ConfigError::Invalid { path: path.to_path_buf(), message: error.to_string() })?;
        config.validate().map_err(|message| ConfigError::Invalid { path: path.to_path_buf(), message })?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), String> {
        for (name, path) in
            [("paths.state_dir", self.paths.state_dir.as_ref()), ("paths.runtime_dir", self.paths.runtime_dir.as_ref())]
        {
            if let Some(path) = path.filter(|path| !path.is_absolute()) {
                return Err(format!("{name} must be absolute, got {}", path.display()));
            }
        }
        if self.cas.reserved_free_bytes >= self.cas.limit_bytes {
            return Err("cas.reserved_free_bytes must be below cas.limit_bytes".to_owned());
        }
        if let Some(level) = self.log.level.as_deref()
            && !["error", "warn", "info", "debug", "trace"].contains(&level)
        {
            return Err(format!("log.level must be error, warn, info, debug or trace, got {level}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_validate_and_unknown_fields_are_rejected() {
        WindowsConfig::default().validate().expect("defaults");
        let parsed =
            toml::from_str::<WindowsConfig>("nope = 1\n[cas]\nlimit_bytes = 1024\nreserved_free_bytes = 2048\n")
                .expect_err("unknown field");
        assert!(parsed.to_string().contains("nope"), "{parsed}");
        let parsed: WindowsConfig =
            toml::from_str("[cas]\nlimit_bytes = 1024\nreserved_free_bytes = 2048\n").expect("parses");
        assert!(parsed.validate().is_err());
    }

    #[test]
    fn missing_implicit_config_means_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = WindowsConfig::load(&dir.path().join("absent.toml"), false).expect("defaults");
        assert_eq!(config, WindowsConfig::default());
        assert!(WindowsConfig::load(&dir.path().join("absent.toml"), true).is_err());
    }
}
