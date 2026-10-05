//! Android storage locations for Player Core state.
//!
//! Core state lives in its own directory below the app-private files dir. It
//! never reuses the legacy Room SQLite file or the legacy media cache: those
//! keep different schema histories and stay readable for the documented
//! rollback window. The PR2 legacy importer copies verified data across.

use std::path::PathBuf;

/// Core-owned files below this directory: `state.db`, `cas/`, `partial/`.
pub const CORE_DIR_NAME: &str = "player-core";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorePaths {
    /// `<filesDir>/player-core`.
    pub root: PathBuf,
    /// `<filesDir>/player-core/state.db` (Player State, Core authority).
    pub state_db: PathBuf,
    /// `<filesDir>/player-core/cas` (verified content objects).
    pub cas_dir: PathBuf,
    /// `<filesDir>/player-core/partial` (resumable partial downloads).
    pub partial_dir: PathBuf,
    /// `<filesDir>/player-core/installed-config.json` (installed projection).
    pub installed_config: PathBuf,
}

/// Derives Core locations from the app-private files directory. Pure and
/// total: every caller, test, and host agrees on the same layout.
pub fn core_paths(files_dir: &std::path::Path) -> CorePaths {
    let root = files_dir.join(CORE_DIR_NAME);
    CorePaths {
        state_db: root.join("state.db"),
        cas_dir: root.join("cas"),
        partial_dir: root.join("partial"),
        installed_config: root.join(crate::config_host::INSTALLED_CONFIG_NAME),
        root,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_stable() {
        let paths = core_paths(std::path::Path::new("/data/user/0/org.tilecast.player/files"));
        assert_eq!(paths.root, PathBuf::from("/data/user/0/org.tilecast.player/files/player-core"));
        assert_eq!(paths.state_db, paths.root.join("state.db"));
        assert_eq!(paths.cas_dir, paths.root.join("cas"));
        assert_eq!(paths.partial_dir, paths.root.join("partial"));
        assert_eq!(paths.installed_config, paths.root.join("installed-config.json"));
    }

    #[test]
    fn layout_never_points_at_room_files() {
        let paths = core_paths(std::path::Path::new("/files"));
        for path in [&paths.state_db, &paths.cas_dir, &paths.partial_dir] {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            assert!(!name.ends_with(".db-shm") && !name.ends_with(".db-wal"));
            assert!(path.starts_with(&paths.root));
        }
        assert_ne!(paths.state_db.extension().and_then(|e| e.to_str()), Some("room"));
    }
}
