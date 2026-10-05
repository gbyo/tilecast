//! DPAPI-sealed persistence of private pairing state.

use player_client::pairing::PairingFileError;
pub use player_client::pairing::{PairingSession, PairingStore};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::seal::Sealer;

pub const FILE_NAME: &str = "pairing-session";
const MAX_FILE_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone)]
pub struct SealedPairingStore {
    identity_dir: PathBuf,
    sealer: Arc<dyn Sealer>,
}

impl SealedPairingStore {
    pub fn new(identity_dir: impl Into<PathBuf>, sealer: Arc<dyn Sealer>) -> Self {
        Self { identity_dir: identity_dir.into(), sealer }
    }

    /// Writes the session sealed and atomically.
    pub fn write_at(
        session: &PairingSession,
        identity_dir: &Path,
        sealer: &dyn Sealer,
    ) -> Result<(), PairingFileError> {
        let io = |e: std::io::Error| PairingFileError::Io(e.kind().to_string());
        let encoded = serde_json::to_vec(session).map_err(|_| PairingFileError::Format)?;
        let sealed = sealer.seal(&encoded).map_err(io)?;
        let path = identity_dir.join(FILE_NAME);
        let temp = identity_dir.join(format!(".{FILE_NAME}.tmp"));
        let _ = std::fs::remove_file(&temp);
        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(io)?;
        file.write_all(&sealed).map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        std::fs::rename(&temp, &path).map_err(io)?;
        if let Ok(dir) = std::fs::File::open(identity_dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    pub fn read_at(identity_dir: &Path, sealer: &dyn Sealer) -> Result<Option<PairingSession>, PairingFileError> {
        let io = |e: std::io::Error| PairingFileError::Io(e.kind().to_string());
        let path = identity_dir.join(FILE_NAME);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            return Err(PairingFileError::Permissions);
        }
        let sealed = std::fs::read(&path).map_err(io)?;
        let encoded = sealer.open(&sealed).map_err(io)?;
        serde_json::from_slice(&encoded).map(Some).map_err(|_| PairingFileError::Format)
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

impl PairingStore for SealedPairingStore {
    fn load(&self) -> Result<Option<PairingSession>, PairingFileError> {
        Self::read_at(&self.identity_dir, self.sealer.as_ref())
    }

    fn save(&self, session: &PairingSession) -> Result<(), PairingFileError> {
        Self::write_at(session, &self.identity_dir, self.sealer.as_ref())
    }

    fn remove(&self) -> Result<(), PairingFileError> {
        Self::remove_at(&self.identity_dir)
    }
}

#[cfg(test)]
pub(crate) fn test_session() -> PairingSession {
    serde_json::from_value(serde_json::json!({
        "serverUrl": "https://signs.example.org",
        "installationId": "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a",
        "sessionId": "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a",
        "pollSecret": "p".repeat(43),
        "code": "ABC123",
        "approvalUrl": "https://signs.example.org/screens/pair",
        "expiresAt": "2033-05-18T03:33:20Z",
        "pollingIntervalSeconds": 3,
    }))
    .expect("session")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::TestSealer;

    #[test]
    fn sealed_round_trip_never_writes_secrets() {
        let session = test_session().with_enrollment_token("t".repeat(43));
        let dir = tempfile::tempdir().expect("tempdir");
        let backend: &dyn PairingStore = &SealedPairingStore::new(dir.path(), Arc::new(TestSealer));
        backend.save(&session).expect("save");
        let raw = std::fs::read(dir.path().join(FILE_NAME)).expect("read");
        assert!(!raw.windows(43).any(|w| w == vec![b'p'; 43]));
        assert!(!raw.windows(43).any(|w| w == vec![b't'; 43]));
        assert_eq!(backend.load().expect("load"), Some(session));
        backend.remove().expect("remove");
        assert_eq!(backend.load().expect("missing"), None);
    }

    #[test]
    fn oversize_files_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend: &dyn PairingStore = &SealedPairingStore::new(dir.path(), Arc::new(TestSealer));
        std::fs::write(dir.path().join(FILE_NAME), vec![0u8; MAX_FILE_BYTES as usize + 1]).expect("write");
        assert_eq!(backend.load(), Err(PairingFileError::Permissions));
    }
}
