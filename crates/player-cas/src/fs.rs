//! Security-preserving bounded file opening on supported Unix hosts.
//! Linux and macOS share these O_NOFOLLOW/O_NONBLOCK and open-file metadata
//! semantics. This code is not an adapter for platforms without those guarantees.

use rustix::fs::OFlags;
use std::fs::File;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;

/// Opens `path` read-only if it is a regular file of at most `max_bytes`.
///
/// Returns `Ok(None)` when the path does not exist, is a symbolic link, is
/// not a regular file, or is larger than `max_bytes`. The returned length is
/// from the open file, not from an earlier `stat`.
pub fn open_regular(path: &Path, max_bytes: u64) -> std::io::Result<Option<(File, u64)>> {
    let flags = OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY;
    let file = match std::fs::OpenOptions::new().read(true).custom_flags(flags.bits() as i32).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        // ELOOP: the final component is a symbolic link.
        Err(error) if error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error()) => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return Ok(None);
    }
    Ok(Some((file, metadata.len())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_regular_open_rejects_links_directories_and_oversize() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("object");
        std::fs::write(&path, b"content").expect("write");
        assert_eq!(open_regular(&path, 7).expect("open").expect("regular").1, 7);
        assert!(open_regular(&path, 6).expect("over limit").is_none());
        assert!(open_regular(dir.path(), 7).expect("directory").is_none());
        assert!(open_regular(&dir.path().join("missing"), 7).expect("missing").is_none());
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).expect("symlink");
        assert!(open_regular(&link, 7).expect("link").is_none());
    }

    #[test]
    fn fifo_is_refused_without_blocking() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("fifo");
        assert!(std::process::Command::new("mkfifo").arg(&path).status().expect("mkfifo").success());
        assert!(open_regular(&path, 7).expect("fifo").is_none());
    }
}
