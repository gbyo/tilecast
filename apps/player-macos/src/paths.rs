//! macOS roots for the shared host layout.
//!
//! ```text
//! ~/Library/Application Support/Tilecast/Tilecast Player/   per-user state
//! ~/Library/Caches/Tilecast/Tilecast Player/                scratch files (recreated every start)
//! ```
//!
//! The home directory comes from `NSHomeDirectory`, not `$HOME`: a launch
//! agent can start with a different or missing `$HOME`, and inside an App
//! Sandbox Foundation returns the container, the only place the app may
//! write.

use std::path::{Path, PathBuf};

pub use webview_host::paths::HostPaths as MacosPaths;

pub const STATE_DIR_ENV: &str = "TILECAST_MACOS_STATE_DIR";
pub const RUNTIME_DIR_ENV: &str = "TILECAST_MACOS_RUNTIME_DIR";

/// Resolves roots from explicit overrides, then the per-user defaults.
/// Returns `None` when a root cannot be derived or is relative.
pub fn from_environment(state_override: Option<&Path>, runtime_override: Option<&Path>) -> Option<MacosPaths> {
    MacosPaths::resolve(
        state_override.map(Path::to_path_buf).or_else(default_state_dir),
        runtime_override.map(Path::to_path_buf).or_else(default_runtime_dir),
    )
}

/// `~/Library/Application Support/Tilecast/Tilecast Player`, or the
/// `TILECAST_MACOS_STATE_DIR` override. A relative override is refused, not
/// ignored. Tests pass an explicit directory instead.
pub fn default_state_dir() -> Option<PathBuf> {
    resolve(STATE_DIR_ENV, &["Library", "Application Support"])
}

/// `~/Library/Caches/Tilecast/Tilecast Player`, or the
/// `TILECAST_MACOS_RUNTIME_DIR` override. A relative override is refused,
/// not ignored. Tests pass an explicit directory instead.
pub fn default_runtime_dir() -> Option<PathBuf> {
    resolve(RUNTIME_DIR_ENV, &["Library", "Caches"])
}

fn resolve(override_env: &str, library: &[&str]) -> Option<PathBuf> {
    match std::env::var_os(override_env) {
        Some(dir) => absolute(PathBuf::from(dir)),
        None => home_dir().map(|home| player_dir(&home, library)),
    }
}

fn player_dir(home: &Path, library: &[&str]) -> PathBuf {
    library.iter().fold(home.to_path_buf(), |dir, part| dir.join(part)).join("Tilecast").join("Tilecast Player")
}

fn absolute(dir: PathBuf) -> Option<PathBuf> {
    dir.is_absolute().then_some(dir)
}

/// The user's home directory as Foundation reports it.
#[cfg(target_os = "macos")]
pub fn home_dir() -> Option<PathBuf> {
    absolute(PathBuf::from(objc2_foundation::NSHomeDirectory().to_string()))
}

#[cfg(not(target_os = "macos"))]
pub fn home_dir() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_lives_under_the_user_library() {
        let home = Path::new("/Users/signage");
        assert_eq!(
            player_dir(home, &["Library", "Application Support"]),
            Path::new("/Users/signage/Library/Application Support/Tilecast/Tilecast Player")
        );
        assert_eq!(
            player_dir(home, &["Library", "Caches"]),
            Path::new("/Users/signage/Library/Caches/Tilecast/Tilecast Player")
        );
        assert!(absolute(PathBuf::from("relative")).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn defaults_derive_from_the_platform_home() {
        let home = home_dir().expect("home directory");
        assert!(home.is_absolute());
        // The environment is process-wide, so this test reads it rather than
        // setting it: overrides are covered by `absolute` above.
        if std::env::var_os(STATE_DIR_ENV).is_none() {
            assert_eq!(default_state_dir(), Some(player_dir(&home, &["Library", "Application Support"])));
        }
        if std::env::var_os(RUNTIME_DIR_ENV).is_none() {
            assert_eq!(default_runtime_dir(), Some(player_dir(&home, &["Library", "Caches"])));
        }
    }
}
