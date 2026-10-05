//! Windows secure file opening. The interface is owned by player-cas.
//!
//! Windows has no `O_NOFOLLOW`, but `FILE_FLAG_OPEN_REPARSE_POINT` makes the
//! open return the link itself instead of following it. The adapter opens
//! with that flag, then requires the opened handle to be a regular file
//! (not a reparse point: symlink, junction, mount point) within the bound.
//! The check runs on the handle that is read, so swapping the path after the
//! open cannot change what is read. A pre-open attribute check still refuses
//! an existing link early. As defense in depth, every object the store
//! serves was hashed against its digest, and the state directory inherits
//! the user profile's user-only ACLs.
//!
//! Directory junctions deserve a note: only the final component is checked,
//! as on Unix. Parent directories of the store are created by the player and
//! never follow server input.

use player_cas::open::{RegularOpen, SecureOpener};
use std::fs::File;
use std::path::Path;

/// Opens `path` read-only. On Windows a reparse point is opened as itself
/// rather than followed, so the caller can refuse it from the handle.
fn open_without_following(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

/// Whether an opened handle's attributes mark a reparse point.
#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsSecureOpener;

impl SecureOpener for WindowsSecureOpener {
    fn open_regular(&self, path: &Path, max_bytes: u64) -> std::io::Result<RegularOpen> {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RegularOpen::Missing);
            }
            Err(error) => return Err(error),
        };
        // On Windows `is_symlink` reports reparse points: symlinks and
        // junctions alike.
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            return Ok(RegularOpen::Refused);
        }
        let file = open_without_following(path)?;
        let metadata = file.metadata()?;
        if is_reparse_point(&metadata) || !metadata.is_file() || metadata.len() > max_bytes {
            return Ok(RegularOpen::Refused);
        }
        Ok(RegularOpen::Opened(file, metadata.len()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_regular_open_rejects_links_directories_and_oversize() {
        let opener = WindowsSecureOpener;
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("object");
        std::fs::write(&path, b"content").expect("write");
        let opened = opener.open_regular(&path, 7).expect("open");
        assert!(matches!(opened, RegularOpen::Opened(_, 7)), "{opened:?}");
        assert!(matches!(opener.open_regular(&path, 6).expect("over limit"), RegularOpen::Refused));
        assert!(matches!(opener.open_regular(dir.path(), 7).expect("directory"), RegularOpen::Refused));
        assert!(matches!(opener.open_regular(&dir.path().join("missing"), 7).expect("missing"), RegularOpen::Missing));
        #[cfg(windows)]
        {
            // Creating a symlink needs Developer Mode or the symlink
            // privilege; without it there is nothing to refuse.
            let link = dir.path().join("link");
            if std::os::windows::fs::symlink_file(&path, &link).is_err() {
                return;
            }
            assert!(matches!(opener.open_regular(&link, 7).expect("link"), RegularOpen::Refused));
        }
        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&path, &link).expect("symlink");
            assert!(matches!(opener.open_regular(&link, 7).expect("link"), RegularOpen::Refused));
        }
    }
}
