//! Free-space measurement.

use std::path::Path;

/// Bytes available to an unprivileged writer on the filesystem holding
/// `path` (`f_bavail * f_frsize`).
pub fn available_bytes(path: &Path) -> std::io::Result<u64> {
    let stat = rustix::fs::statvfs(path).map_err(std::io::Error::from)?;
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
}

/// Measures free space. A trait so CAS reserve logic can be tested without
/// filling a disk.
pub trait SpaceProbe: Send + Sync + std::fmt::Debug {
    fn available_bytes(&self, path: &Path) -> std::io::Result<u64>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct StatvfsProbe;

impl SpaceProbe for StatvfsProbe {
    fn available_bytes(&self, path: &Path) -> std::io::Result<u64> {
        available_bytes(path)
    }
}

/// A fixed answer, for tests.
#[derive(Debug, Clone, Copy)]
pub struct FixedSpace(pub u64);

impl SpaceProbe for FixedSpace {
    fn available_bytes(&self, _path: &Path) -> std::io::Result<u64> {
        Ok(self.0)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_some_space_for_temp_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(super::available_bytes(dir.path()).expect("statvfs") > 0);
    }
}
