//! Free-space measurement for CAS reserve policy.

use std::path::Path;

/// Bytes available to the caller on the volume holding `path`.
#[derive(Debug, Default, Clone, Copy)]
pub struct DiskSpaceProbe;

impl player_cas::space::SpaceProbe for DiskSpaceProbe {
    fn available_bytes(&self, path: &Path) -> std::io::Result<u64> {
        available_bytes(path)
    }
}

/// `statfs` rather than `statvfs`: Darwin's `statvfs` block counts are
/// 32-bit and saturate on large volumes. `f_bavail` excludes blocks reserved
/// for the superuser, and `f_bsize` is the block size it counts in.
#[cfg(target_os = "macos")]
pub fn available_bytes(path: &Path) -> std::io::Result<u64> {
    let stat = rustix::fs::statfs(path)?;
    Ok(stat.f_bavail.saturating_mul(u64::from(stat.f_bsize)))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn available_bytes(path: &Path) -> std::io::Result<u64> {
    let stat = rustix::fs::statvfs(path)?;
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
}

#[cfg(not(unix))]
pub fn available_bytes(_path: &Path) -> std::io::Result<u64> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "disk free space is only measured on Unix"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::space::SpaceProbe as _;

    #[cfg(unix)]
    #[test]
    fn reports_space_for_a_real_volume_and_errors_for_a_missing_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let probe = DiskSpaceProbe;
        assert!(probe.available_bytes(dir.path()).expect("space") > 0);
        assert!(probe.available_bytes(&dir.path().join("missing")).is_err());
    }
}
