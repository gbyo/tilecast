//! Host-supplied secure file opening.
//!
//! Verified storage opens two kinds of files it did not just create: stored
//! objects ([`crate::ContentStore::open_verified`]) and import sources
//! ([`crate::ContentStore::import_file`]). Both opens must refuse symbolic
//! links and non-regular files without blocking on FIFOs, and both are
//! bounded in size. The race-free primitive for that differs per operating
//! system (`O_NOFOLLOW` on Unix has no Windows equivalent), so the store
//! holds only this port — the same split as [`crate::space::SpaceProbe`].
//! Every Unix host (Linux Edge, Android, macOS) passes the one
//! `UnixSecureOpener` defined here; Windows supplies its own adapter.
//!
//! An adapter refuses what it cannot open safely; it never follows a link to
//! find out. Content verification stays in the store either way: every byte
//! served was hashed against its digest.

use std::fs::File;
use std::path::Path;

/// The outcome of a bounded regular-file open.
#[derive(Debug)]
pub enum RegularOpen {
    /// A regular file of at most the bound, with its length from the open
    /// file rather than from an earlier `stat`.
    Opened(File, u64),
    /// The path does not exist.
    Missing,
    /// The path exists but is not safe to open: a symbolic link (or, on
    /// Windows, a reparse point), a non-regular file, or a file over the
    /// bound.
    Refused,
}

/// Opens `path` read-only if it is a regular file of at most `max_bytes`.
pub trait SecureOpener: Send + Sync + std::fmt::Debug {
    fn open_regular(&self, path: &Path, max_bytes: u64) -> std::io::Result<RegularOpen>;
}

/// Opens files with `O_NOFOLLOW`, so a symbolic link in the final component
/// is refused however it is swapped in. `O_NONBLOCK` keeps a FIFO from
/// blocking the open, and the type and size checks run on the opened
/// descriptor, never on an earlier `stat`. Linux, Android and macOS share
/// these semantics.
///
/// Parent components may be links: a state directory can sit below a system
/// link such as macOS `/var -> /private/var`. Parents are chosen by the host
/// or derived from validated digests, never named by Server input, so
/// `O_NOFOLLOW_ANY` and `RESOLVE_NO_SYMLINKS` are not used.
#[cfg(unix)]
#[derive(Debug, Default, Clone, Copy)]
pub struct UnixSecureOpener;

#[cfg(unix)]
impl SecureOpener for UnixSecureOpener {
    fn open_regular(&self, path: &Path, max_bytes: u64) -> std::io::Result<RegularOpen> {
        use rustix::fs::OFlags;
        use std::os::unix::fs::OpenOptionsExt as _;
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

/// A portable opener for tests in this crate and in player-core, which run on
/// every host OS. It checks for a link and then opens, so it is not race-free,
/// and a FIFO blocks it. A Player host never passes it: Unix hosts pass
/// [`UnixSecureOpener`] and Windows passes its own adapter.
#[cfg(any(test, feature = "test-util"))]
#[derive(Debug, Default, Clone, Copy)]
pub struct TestOpener;

#[cfg(any(test, feature = "test-util"))]
impl SecureOpener for TestOpener {
    fn open_regular(&self, path: &Path, max_bytes: u64) -> std::io::Result<RegularOpen> {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RegularOpen::Missing);
            }
            Err(error) => return Err(error),
        };
        if metadata.file_type().is_symlink() {
            return Ok(RegularOpen::Refused);
        }
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > max_bytes {
            return Ok(RegularOpen::Refused);
        }
        Ok(RegularOpen::Opened(file, metadata.len()))
    }
}

#[cfg(all(test, unix))]
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
        let dangling = dir.path().join("dangling");
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &dangling).expect("symlink");
        assert!(matches!(opener.open_regular(&dangling, 7).expect("dangling link"), RegularOpen::Refused));
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
