//! Owner-only Linux persistence of private pairing state.
pub use player_client::pairing::*;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
pub const FILE_NAME: &str = "pairing-session";
const MAX_FILE_BYTES: u64 = 16 * 1024;
#[derive(Debug, Clone)]
pub struct FilePairingStore {
    identity_dir: PathBuf,
}
impl FilePairingStore {
    pub fn new(identity_dir: impl Into<PathBuf>) -> Self {
        Self { identity_dir: identity_dir.into() }
    }
    /// Writes the session atomically with mode 0600.
    pub fn write_at(session: &PairingSession, identity_dir: &Path) -> Result<(), PairingFileError> {
        let io = |e: std::io::Error| PairingFileError::Io(e.kind().to_string());
        let encoded = serde_json::to_vec(session).map_err(|_| PairingFileError::Format)?;
        let path = identity_dir.join(FILE_NAME);
        let temp = identity_dir.join(format!(".{FILE_NAME}.tmp"));
        let _ = std::fs::remove_file(&temp);
        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temp).map_err(io)?;
        file.write_all(&encoded).map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        std::fs::rename(&temp, &path).map_err(io)?;
        if let Ok(dir) = std::fs::File::open(identity_dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    pub fn read_at(identity_dir: &Path) -> Result<Option<PairingSession>, PairingFileError> {
        let path = identity_dir.join(FILE_NAME);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(PairingFileError::Io(error.kind().to_string())),
        };
        if !metadata.file_type().is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(PairingFileError::Permissions);
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(PairingFileError::Format);
        }
        let bytes = std::fs::read(&path).map_err(|e| PairingFileError::Io(e.kind().to_string()))?;
        serde_json::from_slice(&bytes).map(Some).map_err(|_| PairingFileError::Format)
    }

    /// Removes the session and every secret in it.
    pub fn remove_at(identity_dir: &Path) -> Result<(), PairingFileError> {
        match std::fs::remove_file(identity_dir.join(FILE_NAME)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(PairingFileError::Io(error.kind().to_string())),
        }
    }
}

impl PairingStore for FilePairingStore {
    fn load(&self) -> Result<Option<PairingSession>, PairingFileError> {
        Self::read_at(&self.identity_dir)
    }
    fn save(&self, session: &PairingSession) -> Result<(), PairingFileError> {
        Self::write_at(session, &self.identity_dir)
    }
    fn remove(&self) -> Result<(), PairingFileError> {
        Self::remove_at(&self.identity_dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_client::pairing::PollStatus;
    fn session() -> PairingSession {
        serde_json::from_value(serde_json::json!({
            "serverUrl":"https://signs.example.org", "installationId":"1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a",
            "sessionId":"1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a", "pollSecret":"p".repeat(43),
            "code":"ABC123", "approvalUrl":"https://signs.example.org/screens/pair",
            "expiresAt":"2033-05-18T03:33:20Z", "pollingIntervalSeconds":3
        }))
        .expect("session")
    }
    #[test]
    fn secrets_are_redacted_and_the_file_is_private() {
        let with_token = session().with_enrollment_token("t".repeat(43));
        let debug = format!("{with_token:?} {:?}", PollStatus::Claimed("t".repeat(43)));
        assert!(!debug.contains("ppp") && !debug.contains("ttt"), "{debug}");
        let dir = tempfile::tempdir().unwrap();
        let store = FilePairingStore::new(dir.path());
        let backend: &dyn PairingStore = &store;
        backend.save(&with_token).unwrap();
        let mode = std::fs::metadata(dir.path().join(FILE_NAME)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(backend.load().unwrap(), Some(with_token));
        std::fs::set_permissions(dir.path().join(FILE_NAME), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(backend.load(), Err(PairingFileError::Permissions));
        backend.remove().unwrap();
        assert_eq!(backend.load(), Ok(None));
    }
}
