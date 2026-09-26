//! Canonical Tilecast Edge filesystem layout (docs/tilecast-edge.md §5).
//!
//! ```text
//! /etc/tilecast-edge/edge.toml          root-owned optional operator config
//! /var/lib/tilecast-edge/               StateDirectory=tilecast-edge (0700 tilecast)
//!     state.db                          SQLite metadata
//!     identity/                         0700: device-credential
//!     cas/sha256/<ab>/<hash>            verified immutable objects
//!     partial/<hash>.part               resumable downloads
//!     updates/                          staged release artifacts
//!     diagnostics/                      bounded local diagnostics
//! /run/tilecast-edge/                   RuntimeDirectory=tilecast-edge (0750)
//!     edge.sock                         IPC socket, 0660 tilecast:tilecast
//! ```
//!
//! `cas/` and `partial/` share the state directory's filesystem so promotion
//! is an atomic `rename(2)`. Every path below is derived from these roots and
//! fixed names; no path is ever built from a filename, URL or server input.

use std::path::{Path, PathBuf};

pub const DEFAULT_STATE_DIR: &str = "/var/lib/tilecast-edge";
pub const DEFAULT_RUNTIME_DIR: &str = "/run/tilecast-edge";
pub const DEFAULT_CONFIG_FILE: &str = "/etc/tilecast-edge/edge.toml";
pub const SOCKET_NAME: &str = "edge.sock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgePaths {
    pub state_dir: PathBuf,
    pub runtime_dir: PathBuf,
}

impl EdgePaths {
    pub fn new(state_dir: impl Into<PathBuf>, runtime_dir: impl Into<PathBuf>) -> Self {
        Self { state_dir: state_dir.into(), runtime_dir: runtime_dir.into() }
    }

    /// Resolves roots from systemd's `STATE_DIRECTORY`/`RUNTIME_DIRECTORY`
    /// (set by `StateDirectory=`/`RuntimeDirectory=`), falling back to the
    /// canonical defaults. Only the first entry of each colon-separated list
    /// is used.
    pub fn from_environment(state_override: Option<&Path>, runtime_override: Option<&Path>) -> Self {
        let first = |name: &str| {
            std::env::var_os(name)
                .and_then(|value| value.to_str().and_then(|v| v.split(':').next()).map(PathBuf::from))
                .filter(|path| path.is_absolute())
        };
        Self {
            state_dir: state_override
                .map(Path::to_path_buf)
                .or_else(|| first("STATE_DIRECTORY"))
                .unwrap_or_else(|| PathBuf::from(DEFAULT_STATE_DIR)),
            runtime_dir: runtime_override
                .map(Path::to_path_buf)
                .or_else(|| first("RUNTIME_DIRECTORY"))
                .unwrap_or_else(|| PathBuf::from(DEFAULT_RUNTIME_DIR)),
        }
    }

    pub fn state_db(&self) -> PathBuf {
        self.state_dir.join("state.db")
    }

    pub fn identity_dir(&self) -> PathBuf {
        self.state_dir.join("identity")
    }

    pub fn cas_root(&self) -> PathBuf {
        self.state_dir.join("cas")
    }

    pub fn partial_dir(&self) -> PathBuf {
        self.state_dir.join("partial")
    }

    pub fn updates_dir(&self) -> PathBuf {
        self.state_dir.join("updates")
    }

    pub fn diagnostics_dir(&self) -> PathBuf {
        self.state_dir.join("diagnostics")
    }

    pub fn socket(&self) -> PathBuf {
        self.runtime_dir.join(SOCKET_NAME)
    }

    /// Creates the private subdirectories with owner-only permissions. The
    /// roots themselves are created by systemd (or by the caller in tests).
    pub fn ensure_private_dirs(&self) -> std::io::Result<()> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        for dir in [
            self.state_dir.clone(),
            self.identity_dir(),
            self.cas_root(),
            self.cas_root().join("sha256"),
            self.partial_dir(),
            self.updates_dir(),
            self.diagnostics_dir(),
        ] {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
        }
        // The identity directory must never be readable by anyone else, even
        // if an operator created it by hand with a looser mode.
        std::fs::set_permissions(self.identity_dir(), std::fs::Permissions::from_mode(0o700))?;
        std::fs::DirBuilder::new().recursive(true).mode(0o750).create(&self.runtime_dir)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_paths_are_fixed_names_under_roots() {
        let paths = EdgePaths::new("/var/lib/tilecast-edge", "/run/tilecast-edge");
        assert_eq!(paths.state_db(), PathBuf::from("/var/lib/tilecast-edge/state.db"));
        assert_eq!(paths.cas_root(), PathBuf::from("/var/lib/tilecast-edge/cas"));
        assert_eq!(paths.socket(), PathBuf::from("/run/tilecast-edge/edge.sock"));
    }

    #[test]
    fn private_dirs_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = EdgePaths::new(dir.path().join("state"), dir.path().join("run"));
        paths.ensure_private_dirs().expect("create");
        let mode = std::fs::metadata(paths.identity_dir()).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
