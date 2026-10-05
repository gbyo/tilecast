//! Windows secure file opening. The interface is owned by player-cas.
//!
//! Windows has no `O_NOFOLLOW`: a link can only be refused by inspecting it
//! before opening. This adapter refuses reparse points (symlinks, junctions,
//! mount points) via a pre-open attribute check, then requires the opened
//! handle to be a regular file within the bound. A same-user attacker racing
//! the check could still swap the path between the check and the open —
//! unlike on Unix, that race cannot be closed from user space. Two facts
//! bound it: the state directory inherits the user profile's user-only ACLs,
//! and every object the store serves was hashed against its digest, so
//! swapped bytes fail verification rather than playing.
//!
//! Directory junctions deserve a note: only the final component is checked,
//! as on Unix. Parent directories of the store are created by the player and
//! never follow server input.

use player_cas::open::{RegularOpen, SecureOpener};
use std::fs::File;
use std::path::Path;

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
        if metadata.file_type().is_symlink() {
            return Ok(RegularOpen::Refused);
        }
        let file: File = std::fs::OpenOptions::new().read(true).open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > max_bytes {
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
