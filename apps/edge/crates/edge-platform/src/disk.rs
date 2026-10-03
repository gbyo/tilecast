//! Free-space measurement.

use std::path::Path;

/// Bytes available to an unprivileged writer on the filesystem holding
/// `path` (`f_bavail * f_frsize`).
pub fn available_bytes(path: &Path) -> std::io::Result<u64> {
    let stat = rustix::fs::statvfs(path).map_err(std::io::Error::from)?;
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_some_space_for_temp_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(super::available_bytes(dir.path()).expect("statvfs") > 0);
    }
}
