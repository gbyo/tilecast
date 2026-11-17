//! The WebView host filesystem layout below two platform-chosen roots.
//!
//! ```text
//! <state>/                      per-user state that survives updates
//!     state.db                  SQLite metadata
//!     identity/                 sealed device credential and pairing session
//!     cas/sha256/<ab>/<hash>    verified immutable objects
//!     partial/<hash>.part       resumable downloads
//!     updates/                  staged release artifacts
//!     diagnostics/              bounded local diagnostics
//!     <engine>/                 renderer profile data the embedder never reads
//! <runtime>/                    scratch files (recreated every start)
//! ```
//!
//! The platform resolves the two roots (`%LOCALAPPDATA%`, `~/Library/...`).
//! `cas/` and `partial/` share one volume so promotion is an atomic rename.
//! Every path below is derived from the roots and fixed names; no path is
//! ever built from a filename, URL or server input.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPaths {
    pub state_dir: PathBuf,
    pub runtime_dir: PathBuf,
}

impl HostPaths {
    pub fn new(state_dir: impl Into<PathBuf>, runtime_dir: impl Into<PathBuf>) -> Self {
        Self { state_dir: state_dir.into(), runtime_dir: runtime_dir.into() }
    }

    /// Both roots, or `None` when either is missing or relative.
    pub fn resolve(state_dir: Option<PathBuf>, runtime_dir: Option<PathBuf>) -> Option<Self> {
        let state_dir = state_dir.filter(|path| path.is_absolute())?;
        let runtime_dir = runtime_dir.filter(|path| path.is_absolute())?;
        Some(Self { state_dir, runtime_dir })
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

    /// The renderer profile directory, named after the engine (`webview2`):
    /// cookies, caches, and GPU state the embedder never reads. Wiping it is
    /// a clean renderer slate.
    pub fn renderer_data_dir(&self, engine: &str) -> PathBuf {
        self.state_dir.join(engine)
    }

    pub fn diagnostics_dir(&self) -> PathBuf {
        self.state_dir.join("diagnostics")
    }

    /// Creates the state subdirectories. The sealed files inside carry their
    /// own protection; on Unix the identity directory is also owner-only.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for dir in [
            self.state_dir.clone(),
            self.identity_dir(),
            self.cas_root(),
            self.cas_root().join("sha256"),
            self.partial_dir(),
            self.updates_dir(),
            self.diagnostics_dir(),
            self.runtime_dir.clone(),
        ] {
            std::fs::create_dir_all(&dir)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(self.identity_dir(), std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// The operator configuration file beside the state it configures.
    pub fn config_file(&self, name: &str) -> PathBuf {
        self.state_dir.join(name)
    }
}

/// Options for a new private file: created exclusively, write-only, and
/// owner-only on Unix.
pub fn private_file_options() -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options
}

/// An absolute override from the environment, if set.
pub fn absolute_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|dir| Path::new(dir).is_absolute())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_names_derive_from_the_roots() {
        let state = std::env::temp_dir().join("tilecast-host-state");
        let run = std::env::temp_dir().join("tilecast-host-run");
        let paths = HostPaths::new(&state, &run);
        assert_eq!(paths.state_db(), state.join("state.db"));
        assert_eq!(paths.identity_dir(), state.join("identity"));
        assert_eq!(paths.cas_root(), state.join("cas"));
        assert_eq!(paths.partial_dir(), state.join("partial"));
        assert_eq!(paths.updates_dir(), state.join("updates"));
        assert_eq!(paths.diagnostics_dir(), state.join("diagnostics"));
        assert_eq!(paths.renderer_data_dir("webview2"), state.join("webview2"));
    }

    #[test]
    fn relative_roots_are_refused() {
        let state = std::env::temp_dir().join("tilecast-host-paths-test");
        let runtime = std::env::temp_dir().join("tilecast-host-paths-run");
        let paths = HostPaths::resolve(Some(state.clone()), Some(runtime.clone())).expect("absolute");
        assert_eq!(paths.state_dir, state);
        assert!(HostPaths::resolve(Some(PathBuf::from("relative")), Some(runtime.clone())).is_none());
        assert!(HostPaths::resolve(Some(state.clone()), Some(PathBuf::from("relative"))).is_none());
        assert!(HostPaths::resolve(None, Some(runtime)).is_none());
    }

    #[test]
    fn ensure_dirs_creates_the_layout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = HostPaths::new(dir.path().join("state"), dir.path().join("run"));
        paths.ensure_dirs().expect("ensure");
        for sub in ["identity", "cas", "partial", "updates", "diagnostics"] {
            assert!(dir.path().join("state").join(sub).is_dir(), "{sub}");
        }
        assert!(dir.path().join("run").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(paths.identity_dir()).expect("identity").permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }
}
