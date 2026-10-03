//! The device bearer credential (`tc_device_<public-id>.<secret>`).
//!
//! It authenticates this player to the Tilecast Server and nothing else. It is
//! persisted by a host-owned CredentialStore, never in SQLite,
//! never over IPC, never in logs: `Debug` and `Display` print
//! a redaction. The server client reads the value through
//! [`DeviceCredential::authorization_header`], used by the server client
//! after installation identity is verified. Hosts also have explicit storage access.

/// A credential is deliberately not a serializable renderer or IPC value.
///
/// ```compile_fail
/// fn put_in_payload(credential: player_client::DeviceCredential) {
///     let _ = serde_json::to_string(&credential);
/// }
/// ```
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

    /// Explicit secret access for a host-owned credential store. Never log or serialize this value.
    pub fn secret_for_storage(&self) -> &str {
        &self.0
    }
}

/// A host-owned credential backend; the HTTP client never accesses it.
pub trait CredentialStore: Send + Sync + std::fmt::Debug {
    fn load(&self) -> Result<Option<DeviceCredential>, CredentialError>;
    fn save(&self, credential: &DeviceCredential) -> Result<(), CredentialError>;
    fn remove(&self) -> Result<(), CredentialError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_and_debug_never_expose_the_secret() {
        let value = format!("tc_device_{}.{}", "0".repeat(26), "s".repeat(43));
        let credential = DeviceCredential::parse(&value).expect("valid");
        assert_eq!(format!("{credential:?}"), "DeviceCredential([redacted])");
        assert_eq!(credential.authorization_header(), format!("Bearer {value}"));
        assert!(DeviceCredential::parse("tc_device_short.secret").is_err());
        assert!(DeviceCredential::parse("Bearer x").is_err());
    }
}
