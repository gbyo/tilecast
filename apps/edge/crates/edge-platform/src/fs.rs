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

/// Opens the absolute `path` read-only if it is a regular file of at most
/// `max_bytes`, without following a symbolic link in any component.
///
/// Every component is opened with `openat(O_NOFOLLOW)` from the directory
/// before it. This is what `openat2(RESOLVE_NO_SYMLINKS)` does, but it also
/// works where that call is unavailable: systemd's `RestrictSUIDSGID=` makes
/// `openat2` fail with `ENOSYS`, because a seccomp filter cannot read the
/// mode inside its argument structure.
///
/// Returns `Ok(None)` when a component is missing, is a symbolic link or is
/// not a directory, or when the file is not a regular file or is larger than
/// `max_bytes`. A relative path or a `.`/`..` component is an error.
pub fn open_regular_no_links(path: &Path, max_bytes: u64) -> std::io::Result<Option<(File, u64)>> {
    use rustix::fs::{Mode, openat};
    use rustix::io::Errno;
    use std::path::Component;

    let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a plain absolute path");
    let mut components = path.components();
    if components.next() != Some(Component::RootDir) {
        return Err(invalid());
    }
    let names: Vec<_> = components
        .map(|component| match component {
            Component::Normal(name) => Ok(name),
            _ => Err(invalid()),
        })
        .collect::<Result<_, _>>()?;
    let Some((last, parents)) = names.split_last() else { return Err(invalid()) };
    let missing = |error: Errno| matches!(error, Errno::NOENT | Errno::LOOP | Errno::NOTDIR);
    let directory = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut dir = rustix::fs::open("/", OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?;
    for name in parents {
        dir = match openat(&dir, *name, directory, Mode::empty()) {
            Ok(fd) => fd,
            Err(error) if missing(error) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
    }
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC;
    let file = match openat(&dir, *last, flags, Mode::empty()) {
        Ok(fd) => File::from(fd),
        Err(error) if missing(error) => return Ok(None),
        Err(error) => return Err(error.into()),
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
    fn no_component_may_be_a_link() {
        let dir = tempfile::tempdir().expect("tempdir");
        // The temporary directory itself may sit behind a link (/tmp on macOS).
        let root = dir.path().canonicalize().expect("canonical");
        std::fs::create_dir_all(root.join("real/sub")).expect("dirs");
        std::fs::write(root.join("real/sub/object"), b"bytes").expect("write");
        let (_, len) = open_regular_no_links(&root.join("real/sub/object"), 16).expect("open").expect("opened");
        assert_eq!(len, 5);
        assert!(open_regular_no_links(&root.join("real/sub/object"), 4).expect("open").is_none(), "over the bound");
        assert!(open_regular_no_links(&root.join("real/sub/missing"), 16).expect("open").is_none());
        assert!(open_regular_no_links(&root.join("real/sub"), 16).expect("open").is_none(), "a directory");

        std::os::unix::fs::symlink(root.join("real"), root.join("linked")).expect("symlink");
        assert!(open_regular_no_links(&root.join("linked/sub/object"), 16).expect("open").is_none(), "a link parent");
        std::os::unix::fs::symlink(root.join("real/sub/object"), root.join("real/final")).expect("symlink");
        assert!(open_regular_no_links(&root.join("real/final"), 16).expect("open").is_none(), "a link file");
        assert!(open_regular_no_links(&root.join("real/sub/object/x"), 16).expect("open").is_none(), "a file parent");

        assert!(open_regular_no_links(Path::new("relative/object"), 16).is_err());
        assert!(open_regular_no_links(&root.join("real/../real/sub/object"), 16).is_err());
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
