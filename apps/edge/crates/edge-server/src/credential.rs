//! The device bearer credential (`tc_device_<public-id>.<secret>`).
//!
//! It authenticates this player to the Tilecast Server and nothing else. It is
//! stored only in `identity/device-credential` (mode 0600), never in SQLite,
//! never over IPC, never in logs: `Debug` and `Display` print
//! a redaction, and the only way to read the value is
//! [`DeviceCredential::authorization_header`], used by the server client
//! after installation identity is verified.

use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub const FILE_NAME: &str = "device-credential";

#[derive(Clone, PartialEq, Eq)]
pub struct DeviceCredential(String);

impl std::fmt::Debug for DeviceCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DeviceCredential([redacted])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    #[error("the device credential has an invalid format")]
    Format,
    #[error("the credential file must be a regular file readable only by its owner")]
    Permissions,
    #[error("credential file error: {0}")]
    Io(String),
}

impl DeviceCredential {
    /// Validates the shape the server issues (`devices.ParseDeviceCredential`).
    pub fn parse(value: &str) -> Result<Self, CredentialError> {
        let rest = value.strip_prefix("tc_device_").ok_or(CredentialError::Format)?;
        let (public_id, secret) = rest.split_once('.').ok_or(CredentialError::Format)?;
        let public_ok =
            public_id.len() == 26 && public_id.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase());
        let secret_ok = secret.len() >= 40
            && secret.len() <= 256
            && secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !public_ok || !secret_ok {
            return Err(CredentialError::Format);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn authorization_header(&self) -> String {
        format!("Bearer {}", self.0)
    }

    /// Writes the credential atomically with mode 0600.
    pub fn save(&self, identity_dir: &Path) -> Result<(), CredentialError> {
        let io = |e: std::io::Error| CredentialError::Io(e.kind().to_string());
        let path = identity_dir.join(FILE_NAME);
        let temp = identity_dir.join(format!(".{FILE_NAME}.tmp"));
        let _ = std::fs::remove_file(&temp);
        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temp).map_err(io)?;
        file.write_all(self.0.as_bytes()).map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        std::fs::rename(&temp, &path).map_err(io)?;
        if let Ok(dir) = std::fs::File::open(identity_dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    pub fn load(identity_dir: &Path) -> Result<Option<Self>, CredentialError> {
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
        Self::parse(value.trim()).map(Some)
    }

    /// Deletes the credential after the server confirmed it invalid/revoked.
    pub fn remove(identity_dir: &Path) -> Result<(), CredentialError> {
        match std::fs::remove_file(identity_dir.join(FILE_NAME)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(CredentialError::Io(error.kind().to_string())),
        }
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
        credential.save(dir.path()).expect("save");
        let mode = std::fs::metadata(dir.path().join(FILE_NAME)).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(DeviceCredential::load(dir.path()).expect("load"), Some(credential));
        std::fs::set_permissions(dir.path().join(FILE_NAME), std::fs::Permissions::from_mode(0o640)).expect("chmod");
        assert_eq!(DeviceCredential::load(dir.path()), Err(CredentialError::Permissions));
    }
}
