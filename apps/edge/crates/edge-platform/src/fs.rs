//! Opening files that another account may control.
//!
//! The legacy importer and the migrator read files in a directory that the
//! legacy kiosk account owns. A path check followed by an ordinary open is a
//! race: the file can become a symbolic link, a FIFO or a device between the
//! two calls. [`open_regular`] opens first, without following a final
//! symbolic link and without blocking on a FIFO, and then checks the open
//! file itself.

use std::fs::File;
use std::io::Read as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;

use rustix::fs::OFlags;

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

/// Reads a regular file of at most `max_bytes` completely. The read stops at
/// the bound even if the file grows after it was opened.
pub fn read_regular(path: &Path, max_bytes: u64) -> std::io::Result<Option<Vec<u8>>> {
    let Some((file, len)) = open_regular(path, max_bytes)? else { return Ok(None) };
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Ok(None);
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bounded_regular_files_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("state.json");
        std::fs::write(&file, b"{}").expect("write");
        assert_eq!(read_regular(&file, 16).expect("read").as_deref(), Some(&b"{}"[..]));
        assert!(read_regular(&file, 1).expect("read").is_none(), "over the bound");
        assert!(read_regular(&dir.path().join("missing"), 16).expect("read").is_none());
        assert!(read_regular(dir.path(), 16).expect("read").is_none(), "a directory");
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(&file, &link).expect("symlink");
        assert!(read_regular(&link, 16).expect("read").is_none(), "a symbolic link is never followed");
    }

    #[test]
    fn a_fifo_is_refused_without_blocking() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fifo = dir.path().join("fifo");
        let made = std::process::Command::new("mkfifo").arg(&fifo).status().expect("mkfifo");
        assert!(made.success());
        assert!(read_regular(&fifo, 16).expect("read").is_none());
    }
}
