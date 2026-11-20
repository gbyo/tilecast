//! Sealed device credential persistence ([`crate::seal::Sealer`]: DPAPI on
//! Windows, a Keychain-held key on macOS). The portable client holds only
//! values. On Unix the file is also owner-only.

use player_client::credential::CredentialError;
pub use player_client::credential::{CredentialStore, DeviceCredential};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::seal::Sealer;

pub const FILE_NAME: &str = "device-credential";
/// A sealed credential is small; anything larger is not ours.
const MAX_FILE_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone)]
pub struct SealedCredentialStore {
    identity_dir: PathBuf,
    sealer: Arc<dyn Sealer>,
}

impl SealedCredentialStore {
    pub fn new(identity_dir: impl Into<PathBuf>, sealer: Arc<dyn Sealer>) -> Self {
        Self { identity_dir: identity_dir.into(), sealer }
    }

    /// Writes the credential sealed and atomically.
    pub fn write_at(
        credential: &DeviceCredential,
        identity_dir: &Path,
        sealer: &dyn Sealer,
    ) -> Result<(), CredentialError> {
        let io = |e: std::io::Error| CredentialError::Io(e.kind().to_string());
        let sealed = sealer.seal(credential.secret_for_storage().as_bytes()).map_err(io)?;
        let path = identity_dir.join(FILE_NAME);
        let temp = identity_dir.join(format!(".{FILE_NAME}.tmp"));
        let _ = std::fs::remove_file(&temp);
        let mut file = crate::paths::private_file_options().open(&temp).map_err(io)?;
        file.write_all(&sealed).map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        std::fs::rename(&temp, &path).map_err(io)?;
        if let Ok(dir) = std::fs::File::open(identity_dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    pub fn read_at(identity_dir: &Path, sealer: &dyn Sealer) -> Result<Option<DeviceCredential>, CredentialError> {
        let io = |e: std::io::Error| CredentialError::Io(e.kind().to_string());
        let path = identity_dir.join(FILE_NAME);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io(error)),
        };
        // A link or a directory where the sealed credential belongs is never
        // followed. The seal is what keeps another user from reading the
        // secret; owner-only modes on Unix are defense in depth.
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            return Err(CredentialError::Permissions);
        }
        let sealed = std::fs::read(&path).map_err(io)?;
        let plaintext = sealer.open(&sealed).map_err(io)?;
        let value = String::from_utf8(plaintext).map_err(|_| CredentialError::Format)?;
        DeviceCredential::parse(value.trim()).map(Some)
    }

    /// Deletes the credential after the server confirmed it invalid/revoked.
    pub fn remove_at(identity_dir: &Path) -> Result<(), CredentialError> {
        match std::fs::remove_file(identity_dir.join(FILE_NAME)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(CredentialError::Io(error.kind().to_string())),
        }
    }
}

impl CredentialStore for SealedCredentialStore {
    fn load(&self) -> Result<Option<DeviceCredential>, CredentialError> {
        Self::read_at(&self.identity_dir, self.sealer.as_ref())
    }

    fn save(&self, credential: &DeviceCredential) -> Result<(), CredentialError> {
        Self::write_at(credential, &self.identity_dir, self.sealer.as_ref())
    }

    fn remove(&self) -> Result<(), CredentialError> {
        Self::remove_at(&self.identity_dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::TestSealer;

    pub(crate) const TEST_CREDENTIAL: &str =
        "tc_device_01j8xk2m4n6p8q0r2s4t6v8w0y.ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ";

    fn store(dir: &Path) -> SealedCredentialStore {
        SealedCredentialStore::new(dir, Arc::new(TestSealer))
    }

    #[test]
    fn sealed_round_trip_never_writes_plaintext() {
        let credential = DeviceCredential::parse(TEST_CREDENTIAL).expect("valid");
        assert_eq!(format!("{credential:?}"), "DeviceCredential([redacted])");
        let dir = tempfile::tempdir().expect("tempdir");
        let backend: &dyn CredentialStore = &store(dir.path());
        backend.save(&credential).expect("save");
        let raw = std::fs::read(dir.path().join(FILE_NAME)).expect("read");
        assert!(!raw.windows(TEST_CREDENTIAL.len()).any(|w| w == TEST_CREDENTIAL.as_bytes()));
        assert_eq!(backend.load().expect("load"), Some(credential));
        backend.remove().expect("remove");
        assert_eq!(backend.load().expect("missing"), None);
    }

    #[test]
    fn links_and_oversize_files_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend: &dyn CredentialStore = &store(dir.path());
        std::fs::write(dir.path().join(FILE_NAME), vec![0u8; MAX_FILE_BYTES as usize + 1]).expect("write");
        assert_eq!(backend.load(), Err(CredentialError::Permissions));
        #[cfg(unix)]
        {
            let target = dir.path().join("target");
            std::fs::write(&target, b"secret").expect("write");
            let _ = std::fs::remove_file(dir.path().join(FILE_NAME));
            std::os::unix::fs::symlink(&target, dir.path().join(FILE_NAME)).expect("symlink");
            assert_eq!(backend.load(), Err(CredentialError::Permissions));
        }
    }

    #[cfg(unix)]
    #[test]
    fn sealed_files_are_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let credential = DeviceCredential::parse(TEST_CREDENTIAL).expect("credential");
        SealedCredentialStore::write_at(&credential, dir.path(), &crate::seal::TestSealer).expect("write");
        let mode = std::fs::metadata(dir.path().join(FILE_NAME)).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn corrupted_seals_do_not_parse() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend: &dyn CredentialStore = &store(dir.path());
        std::fs::write(dir.path().join(FILE_NAME), b"not a sealed credential").expect("write");
        assert_eq!(backend.load(), Err(CredentialError::Format));
    }
}
