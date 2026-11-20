//! Windows roots for the shared host layout ([`webview_host::paths`]).
//!
//! ```text
//! %LOCALAPPDATA%\Tilecast\Tilecast Player\   per-user state, outside the MSIX package
//! %TEMP%\Tilecast\Tilecast Player\          scratch files (recreated every start)
//! ```
//!
//! The MSIX package directory is read-only and is replaced on every update,
//! so all state lives under LocalAppData, which survives updates. The state
//! subdirectories inherit the user profile's user-only ACLs.

use std::path::{Path, PathBuf};

pub use webview_host::paths::HostPaths as WindowsPaths;

/// `%LOCALAPPDATA%\Tilecast\Tilecast Player`, or the `TILECAST_WINDOWS_STATE_DIR`
/// override. Tests pass an explicit directory instead.
pub fn default_state_dir() -> Option<PathBuf> {
    if std::env::var_os("TILECAST_WINDOWS_STATE_DIR").is_some() {
        return webview_host::paths::absolute_env("TILECAST_WINDOWS_STATE_DIR");
    }
    crate::win32::local_app_data().map(|base| base.join("Tilecast").join("Tilecast Player"))
}

/// `%TEMP%\Tilecast\Tilecast Player`, or the `TILECAST_WINDOWS_RUNTIME_DIR`
/// override. Tests pass an explicit directory instead.
pub fn default_runtime_dir() -> Option<PathBuf> {
    if std::env::var_os("TILECAST_WINDOWS_RUNTIME_DIR").is_some() {
        return webview_host::paths::absolute_env("TILECAST_WINDOWS_RUNTIME_DIR");
    }
    std::env::temp_dir().is_absolute().then(|| std::env::temp_dir().join("Tilecast").join("Tilecast Player"))
}

/// Resolves roots from explicit overrides, then the per-user defaults.
/// Returns `None` outside Windows without overrides, where there is no user
/// profile to derive.
pub fn from_environment(state_override: Option<&Path>, runtime_override: Option<&Path>) -> Option<WindowsPaths> {
    WindowsPaths::resolve(
        state_override.map(Path::to_path_buf).or_else(default_state_dir),
        runtime_override.map(Path::to_path_buf).or_else(default_runtime_dir),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_win_and_relative_paths_are_refused() {
        let state = std::env::temp_dir().join("tilecast-windows-paths-test");
        let runtime = std::env::temp_dir().join("tilecast-windows-paths-run");
        let paths = from_environment(Some(&state), Some(&runtime)).expect("absolute");
        assert_eq!(paths.state_dir, state);
        assert!(from_environment(Some(Path::new("relative")), Some(&runtime)).is_none());
        assert!(from_environment(Some(&state), Some(Path::new("relative"))).is_none());
    }
}
