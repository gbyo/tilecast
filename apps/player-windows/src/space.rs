//! Free-space measurement for CAS reserve policy.

use std::path::Path;

/// Bytes available to the caller on the volume holding `path`.
#[derive(Debug, Default, Clone, Copy)]
pub struct DiskSpaceProbe;

impl player_cas::space::SpaceProbe for DiskSpaceProbe {
    fn available_bytes(&self, path: &Path) -> std::io::Result<u64> {
        crate::win32::available_bytes(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::space::SpaceProbe as _;

    #[test]
    fn reports_space_on_windows_and_errors_elsewhere() {
        let dir = tempfile::tempdir().expect("tempdir");
        let probe = DiskSpaceProbe;
        #[cfg(windows)]
        assert!(probe.available_bytes(dir.path()).expect("space") > 0);
        #[cfg(not(windows))]
        assert!(probe.available_bytes(dir.path()).is_err());
    }
}
