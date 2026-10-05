//! Linux secure file opening. The interface is owned by player-cas.

pub use player_cas::open::{RegularOpen, SecureOpener};
use rustix::fs::OFlags;
use std::fs::File;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;

/// Opens files with `O_NOFOLLOW`, so a symbolic link can never be followed,
/// however it is swapped in. Linux and macOS share these open-file metadata
/// semantics.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnixSecureOpener;

impl SecureOpener for UnixSecureOpener {
    fn open_regular(&self, path: &Path, max_bytes: u64) -> std::io::Result<RegularOpen> {
        let flags = OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY;
        let file: File = match std::fs::OpenOptions::new().read(true).custom_flags(flags.bits() as i32).open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RegularOpen::Missing);
            }
            // ELOOP: the final component is a symbolic link.
            Err(error) if error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error()) => {
                return Ok(RegularOpen::Refused);
            }
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file() || metadata.len() > max_bytes {
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
        let opener = UnixSecureOpener;
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("object");
        std::fs::write(&path, b"content").expect("write");
        let opened = opener.open_regular(&path, 7).expect("open");
        assert!(matches!(opened, RegularOpen::Opened(_, 7)), "{opened:?}");
        assert!(matches!(opener.open_regular(&path, 6).expect("over limit"), RegularOpen::Refused));
        assert!(matches!(opener.open_regular(dir.path(), 7).expect("directory"), RegularOpen::Refused));
        assert!(matches!(opener.open_regular(&dir.path().join("missing"), 7).expect("missing"), RegularOpen::Missing));
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).expect("symlink");
        assert!(matches!(opener.open_regular(&link, 7).expect("link"), RegularOpen::Refused));
    }

    #[test]
    fn fifo_is_refused_without_blocking() {
        let opener = UnixSecureOpener;
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("fifo");
        assert!(std::process::Command::new("mkfifo").arg(&path).status().expect("mkfifo").success());
        assert!(matches!(opener.open_regular(&path, 7).expect("fifo"), RegularOpen::Refused));
    }
}
