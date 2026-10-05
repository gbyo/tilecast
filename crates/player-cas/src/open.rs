//! Host-supplied secure file opening.
//!
//! Verified storage opens two kinds of files it did not just create: stored
//! objects ([`crate::ContentStore::open_verified`]) and import sources
//! ([`crate::ContentStore::import_file`]). Both opens must refuse symbolic
//! links and non-regular files without blocking on FIFOs, and both are
//! bounded in size. The race-free primitive for that differs per operating
//! system (`O_NOFOLLOW` on Unix has no Windows equivalent), so each native
//! host supplies its own adapter and the store holds only this port — the
//! same split as [`crate::space::SpaceProbe`].
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
