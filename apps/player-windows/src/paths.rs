//! Canonical Windows Player filesystem layout.
//!
//! ```text
//! %LOCALAPPDATA%\Tilecast\Tilecast Player\   per-user state, outside the MSIX package
//!     state.db                              SQLite metadata
//!     identity\                             DPAPI-sealed device credential and pairing session
//!     cas\sha256\<ab>\<hash>                verified immutable objects
//!     partial\<hash>.part                   resumable downloads
//!     updates\                              staged release artifacts
//!     diagnostics\                          bounded local diagnostics
//! %TEMP%\Tilecast\Tilecast Player\          scratch files (recreated every start)
//! ```
//!
//! The MSIX package directory is read-only and is replaced on every update,
//! so all state lives under LocalAppData, which survives updates. `cas/` and
//! `partial/` share one volume so promotion is an atomic rename. Every path
//! below is derived from these roots and fixed names; no path is ever built
//! from a filename, URL or server input.

use std::path::{Path, PathBuf};

/// `%LOCALAPPDATA%\Tilecast\Tilecast Player`, or the `TILECAST_WINDOWS_STATE_DIR`
/// override. Tests pass an explicit directory instead.
pub fn default_state_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("TILECAST_WINDOWS_STATE_DIR").map(PathBuf::from) {
        return dir.is_absolute().then_some(dir);
    }
    crate::win32::local_app_data().map(|base| base.join("Tilecast").join("Tilecast Player"))
}

/// `%TEMP%\Tilecast\Tilecast Player`, or the `TILECAST_WINDOWS_RUNTIME_DIR`
/// override. Tests pass an explicit directory instead.
pub fn default_runtime_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("TILECAST_WINDOWS_RUNTIME_DIR").map(PathBuf::from) {
        return dir.is_absolute().then_some(dir);
    }
    std::env::temp_dir().is_absolute().then(|| std::env::temp_dir().join("Tilecast").join("Tilecast Player"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsPaths {
    pub state_dir: PathBuf,
    pub runtime_dir: PathBuf,
}

impl WindowsPaths {
    pub fn new(state_dir: impl Into<PathBuf>, runtime_dir: impl Into<PathBuf>) -> Self {
        Self { state_dir: state_dir.into(), runtime_dir: runtime_dir.into() }
    }

    /// Resolves roots from explicit overrides, then the per-user defaults.
    /// Returns `None` outside Windows without overrides, where there is no
    /// user profile to derive.
    pub fn from_environment(state_override: Option<&Path>, runtime_override: Option<&Path>) -> Option<Self> {
        let state_dir =
            state_override.map(Path::to_path_buf).or_else(default_state_dir).filter(|path| path.is_absolute())?;
        let runtime_dir =
            runtime_override.map(Path::to_path_buf).or_else(default_runtime_dir).filter(|path| path.is_absolute())?;
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

    /// The WebView2 profile directory: cookies, caches, and GPU state the
    /// embedder never reads. Wiping it is a clean renderer slate.
    pub fn webview_data_dir(&self) -> PathBuf {
        self.state_dir.join("webview2")
    }

    pub fn diagnostics_dir(&self) -> PathBuf {
        self.state_dir.join("diagnostics")
    }

    /// Creates the state subdirectories. They inherit the user profile's
    /// user-only ACLs; the sealed files inside carry their own DPAPI
    /// protection, so the layout does not depend on tightening them.
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_names_derive_from_the_roots() {
        // Windows-style roots only join with backslashes on Windows; this
        // test asserts the fixed names whatever the separator is.
        let state = std::env::temp_dir().join("tilecast-windows-state");
        let run = std::env::temp_dir().join("tilecast-windows-run");
        let paths = WindowsPaths::new(&state, &run);
        assert_eq!(paths.state_db(), state.join("state.db"));
        assert_eq!(paths.identity_dir(), state.join("identity"));
        assert_eq!(paths.cas_root(), state.join("cas"));
        assert_eq!(paths.partial_dir(), state.join("partial"));
        assert_eq!(paths.updates_dir(), state.join("updates"));
        assert_eq!(paths.diagnostics_dir(), state.join("diagnostics"));
    }

    #[test]
    fn overrides_win_and_relative_paths_are_refused() {
        let state = std::env::temp_dir().join("tilecast-windows-paths-test");
        let runtime = std::env::temp_dir().join("tilecast-windows-paths-run");
        let paths = WindowsPaths::from_environment(Some(&state), Some(&runtime)).expect("absolute");
        assert_eq!(paths.state_dir, state);
        assert!(WindowsPaths::from_environment(Some(Path::new("relative")), Some(&runtime)).is_none());
        assert!(WindowsPaths::from_environment(Some(&state), Some(Path::new("relative"))).is_none());
    }

    #[test]
    fn ensure_dirs_creates_the_layout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = WindowsPaths::new(dir.path().join("state"), dir.path().join("run"));
        paths.ensure_dirs().expect("ensure");
        for sub in ["identity", "cas", "partial", "updates", "diagnostics"] {
            assert!(dir.path().join("state").join(sub).is_dir(), "{sub}");
        }
        assert!(dir.path().join("run").exists());
    }
}
