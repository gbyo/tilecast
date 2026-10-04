//! Owner-only Linux credential persistence. The portable client holds only values.
pub use player_client::credential::*;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
pub const FILE_NAME: &str = "device-credential";
#[derive(Debug, Clone)]
pub struct FileCredentialStore {
    identity_dir: PathBuf,
}
impl FileCredentialStore {
    pub fn new(identity_dir: impl Into<PathBuf>) -> Self {
        Self { identity_dir: identity_dir.into() }
    }
    /// Writes the credential atomically with mode 0600.
    pub fn write_at(credential: &DeviceCredential, identity_dir: &Path) -> Result<(), CredentialError> {
        let io = |e: std::io::Error| CredentialError::Io(e.kind().to_string());
        let path = identity_dir.join(FILE_NAME);
        let temp = identity_dir.join(format!(".{FILE_NAME}.tmp"));
        let _ = std::fs::remove_file(&temp);
        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temp).map_err(io)?;
        file.write_all(credential.secret_for_storage().as_bytes()).map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        std::fs::rename(&temp, &path).map_err(io)?;
        if let Ok(dir) = std::fs::File::open(identity_dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    pub fn read_at(identity_dir: &Path) -> Result<Option<DeviceCredential>, CredentialError> {
        let path = identity_dir.join(FILE_NAME);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(CredentialError::Io(error.kind().to_string())),
        };
        if !metadata.file_type().is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(CredentialError::Permissions);
        }
        let value = std::fs::read_to_string(&path).map_err(|e| CredentialError::Io(e.kind().to_string()))?;
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

impl CredentialStore for FileCredentialStore {
    fn load(&self) -> Result<Option<DeviceCredential>, CredentialError> {
        Self::read_at(&self.identity_dir)
    }
    fn save(&self, credential: &DeviceCredential) -> Result<(), CredentialError> {
        Self::write_at(credential, &self.identity_dir)
    }
    fn remove(&self) -> Result<(), CredentialError> {
        Self::remove_at(&self.identity_dir)
    }
}

#[cfg(test)]
pub(crate) const TEST_CREDENTIAL: &str =
    "tc_device_01j8xk2m4n6p8q0r2s4t6v8w0y.ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQ";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_save_load_and_redaction() {
        let credential = DeviceCredential::parse(TEST_CREDENTIAL).expect("valid");
        assert_eq!(format!("{credential:?}"), "DeviceCredential([redacted])");
        assert!(DeviceCredential::parse("tc_device_short.secret").is_err());
        assert!(DeviceCredential::parse("Bearer x").is_err());
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FileCredentialStore::new(dir.path());
        let backend: &dyn CredentialStore = &store;
        backend.save(&credential).expect("save");
        let mode = std::fs::metadata(dir.path().join(FILE_NAME)).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(backend.load().expect("load"), Some(credential));
        std::fs::set_permissions(dir.path().join(FILE_NAME), std::fs::Permissions::from_mode(0o640)).expect("chmod");
        assert_eq!(backend.load(), Err(CredentialError::Permissions));
        backend.remove().expect("remove");
        assert_eq!(backend.load().expect("missing"), None);
    }
}
