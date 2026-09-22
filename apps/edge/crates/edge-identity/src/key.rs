//! Node private keys.
//!
//! Keys live in the identity directory as `node-key-<fingerprint>.pk8`
//! (PKCS#8 DER, mode 0600), where the fingerprint is the first 16 hex
//! characters of SHA-256 over the raw public key. Naming by fingerprint makes
//! rotation crash-safe without renames: a new key is written and fsynced
//! before the certificate that references it is stored, and a key file no
//! stored certificate references is an orphan that
//! [`remove_orphans`] deletes.

use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use edge_protocol::Sha256Digest;
use edge_protocol::signed::{PublicKey, SigningKey};
use ring::signature::KeyPair as _;

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("key file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("key file is not an Ed25519 PKCS#8 key")]
    Invalid,
    #[error("key file must be a regular file readable only by its owner")]
    Permissions,
    #[error("random number generation failed")]
    Random,
}

/// A node's Ed25519 key.
pub struct NodeKey {
    pkcs8: Vec<u8>,
    public: PublicKey,
}

impl std::fmt::Debug for NodeKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print key material.
        write!(f, "NodeKey({})", self.fingerprint())
    }
}

impl NodeKey {
    pub fn generate() -> Result<Self, KeyError> {
        let rng = ring::rand::SystemRandom::new();
        let document = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).map_err(|_| KeyError::Random)?;
        Self::from_pkcs8(document.as_ref().to_vec())
    }

    pub fn from_pkcs8(pkcs8: Vec<u8>) -> Result<Self, KeyError> {
        let pair =
            ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&pkcs8).map_err(|_| KeyError::Invalid)?;
        let public = PublicKey::from_slice(pair.public_key().as_ref()).ok_or(KeyError::Invalid)?;
        Ok(Self { pkcs8, public })
    }

    pub fn public_key(&self) -> &PublicKey {
        &self.public
    }

    /// Key file identity: 16 hex characters of SHA-256(raw public key).
    pub fn fingerprint(&self) -> String {
        Sha256Digest::of(self.public.raw()).to_hex()[..16].to_owned()
    }

    pub fn file_name(&self) -> String {
        file_name(&self.fingerprint())
    }

    /// PKCS#8 DER, for building TLS configurations and CSRs in this process
    /// only. Callers must not log, send or persist it elsewhere.
    pub fn pkcs8_der(&self) -> &[u8] {
        &self.pkcs8
    }

    pub fn signing_key(&self) -> Result<SigningKey, KeyError> {
        SigningKey::from_pkcs8(&self.pkcs8).map_err(|_| KeyError::Invalid)
    }

    /// Writes the key into `dir` (temp file, fsync, rename, fsync dir).
    pub fn save(&self, dir: &Path) -> Result<PathBuf, KeyError> {
        let path = dir.join(self.file_name());
        let temp = dir.join(format!(".{}.tmp", self.file_name()));
        let _ = std::fs::remove_file(&temp);
        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temp)?;
        file.write_all(&self.pkcs8)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, &path)?;
        if let Ok(directory) = std::fs::File::open(dir) {
            let _ = directory.sync_all();
        }
        Ok(path)
    }

    /// Loads `node-key-<fingerprint>.pk8` from `dir`, refusing files that are
    /// not owner-only.
    pub fn load(dir: &Path, fingerprint: &str) -> Result<Self, KeyError> {
        let path = dir.join(file_name(fingerprint));
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(KeyError::Permissions);
        }
        let key = Self::from_pkcs8(std::fs::read(&path)?)?;
        if key.fingerprint() != fingerprint {
            return Err(KeyError::Invalid);
        }
        Ok(key)
    }
}

fn file_name(fingerprint: &str) -> String {
    format!("node-key-{fingerprint}.pk8")
}

/// Deletes key files whose fingerprints are not in `referenced`.
pub fn remove_orphans(dir: &Path, referenced: &[String]) -> std::io::Result<usize> {
    let mut removed = 0;
    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(fingerprint) = name.strip_prefix("node-key-").and_then(|n| n.strip_suffix(".pk8")) else {
            if name.starts_with(".node-key-") && name.ends_with(".tmp") {
                std::fs::remove_file(entry.path())?;
                removed += 1;
            }
            continue;
        };
        if !referenced.iter().any(|r| r == fingerprint) {
            std::fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_with_owner_only_permissions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key = NodeKey::generate().expect("generate");
        let path = key.save(dir.path()).expect("save");
        assert_eq!(std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777, 0o600);
        let loaded = NodeKey::load(dir.path(), &key.fingerprint()).expect("load");
        assert_eq!(loaded.public_key(), key.public_key());
        assert!(!format!("{key:?}").contains(&format!("{:?}", key.pkcs8_der())));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        assert!(matches!(NodeKey::load(dir.path(), &key.fingerprint()), Err(KeyError::Permissions)));
    }

    #[test]
    fn orphans_are_removed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let kept = NodeKey::generate().expect("generate");
        let orphan = NodeKey::generate().expect("generate");
        kept.save(dir.path()).expect("save");
        orphan.save(dir.path()).expect("save");
        std::fs::write(dir.path().join("device-credential"), b"secret").expect("write");
        assert_eq!(remove_orphans(dir.path(), &[kept.fingerprint()]).expect("clean"), 1);
        assert!(dir.path().join(kept.file_name()).exists());
        assert!(!dir.path().join(orphan.file_name()).exists());
        assert!(dir.path().join("device-credential").exists(), "non-key files are untouched");
    }
}
