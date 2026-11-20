//! macOS secure file opening. The interface is owned by player-cas, which
//! has no Unix opener of its own; this matches the Edge and Android openers.
//!
//! `O_NOFOLLOW` refuses a symbolic link in the final component however it is
//! swapped in, `O_NONBLOCK` keeps a FIFO from blocking the open, and the type
//! and size checks run on the opened descriptor. `O_NOFOLLOW_ANY` is not
//! used: the state directory may sit below a system symlink such as
//! `/var -> /private/var`, and its parents are created by the Player, never
//! named by Server input.

pub use player_cas::open::{RegularOpen, SecureOpener};
use std::path::Path;

#[derive(Debug, Default, Clone, Copy)]
pub struct MacosSecureOpener;

#[cfg(unix)]
impl SecureOpener for MacosSecureOpener {
    fn open_regular(&self, path: &Path, max_bytes: u64) -> std::io::Result<RegularOpen> {
        use rustix::fs::OFlags;
        use std::os::unix::fs::OpenOptionsExt as _;
        let flags = OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY;
        let file = match std::fs::OpenOptions::new().read(true).custom_flags(flags.bits() as i32).open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(RegularOpen::Missing),
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

#[cfg(not(unix))]
impl SecureOpener for MacosSecureOpener {
    fn open_regular(&self, _path: &Path, _max_bytes: u64) -> std::io::Result<RegularOpen> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no-follow opening is only implemented on Unix"))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn bounded_regular_open_rejects_links_directories_and_oversize() {
        let opener = MacosSecureOpener;
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
        let dangling = dir.path().join("dangling");
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &dangling).expect("symlink");
        assert!(matches!(opener.open_regular(&dangling, 7).expect("dangling link"), RegularOpen::Refused));
    }

    #[test]
    fn fifo_is_refused_without_blocking() {
        let opener = MacosSecureOpener;
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("fifo");
        assert!(std::process::Command::new("mkfifo").arg(&path).status().expect("mkfifo").success());
        assert!(matches!(opener.open_regular(&path, 7).expect("fifo"), RegularOpen::Refused));
    }
}
