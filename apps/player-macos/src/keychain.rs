//! At-rest sealing for the private credential and pairing stores, keyed by a
//! random 256-bit key held in the user's login Keychain.
//!
//! The key is created once, add-only: an existing item is never overwritten,
//! because replacing it would make every sealed store unreadable. When two
//! processes race to create it, the loser reads the winner's key. Any other
//! Keychain failure (locked, access denied) is an error, never a reason to
//! create a new key.
//!
//! The item lives in the file-based login Keychain, which does not sync and
//! unlocks at login. The data protection Keychain (and its
//! `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` class) needs a signed
//! application with a Keychain access group entitlement, so it is not used.
//!
//! Sealed format: `version || nonce (12) || AES-256-GCM ciphertext and tag`,
//! with the version byte as associated data.

use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use std::io;
use std::sync::{Arc, Mutex, PoisonError};

/// The Keychain service that names every Tilecast Player item.
pub const KEYCHAIN_SERVICE: &str = "org.tilecast.player";
/// The account of the production sealing key.
pub const SEALING_KEY_ACCOUNT: &str = "state-sealing-key";

const SEAL_VERSION: u8 = 1;
const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;

/// Seals with AES-256-GCM under the Keychain key, loaded on first use and
/// then cached for the life of the process.
pub struct KeychainSealer {
    account: String,
    rng: SystemRandom,
    key: Mutex<Option<Arc<LessSafeKey>>>,
}

impl std::fmt::Debug for KeychainSealer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("KeychainSealer").field("account", &self.account).finish_non_exhaustive()
    }
}

impl KeychainSealer {
    /// A sealer whose key is the item `account` under [`KEYCHAIN_SERVICE`].
    pub fn new(account: impl Into<String>) -> Self {
        Self { account: account.into(), rng: SystemRandom::new(), key: Mutex::new(None) }
    }

    /// The sealer the Player uses for its private stores.
    pub fn production() -> Self {
        Self::new(SEALING_KEY_ACCOUNT)
    }

    pub fn seal(&self, plaintext: &[u8]) -> io::Result<Vec<u8>> {
        seal_with(self.key()?.as_ref(), &self.rng, plaintext)
    }

    pub fn open(&self, sealed: &[u8]) -> io::Result<Vec<u8>> {
        open_with(self.key()?.as_ref(), sealed)
    }

    fn key(&self) -> io::Result<Arc<LessSafeKey>> {
        let mut cached = self.key.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(key) = cached.as_ref() {
            return Ok(Arc::clone(key));
        }
        let bytes = item::load_or_create(KEYCHAIN_SERVICE, &self.account, &self.rng)?;
        let key = Arc::new(aead_key(&bytes)?);
        *cached = Some(Arc::clone(&key));
        Ok(key)
    }
}

fn aead_key(bytes: &[u8]) -> io::Result<LessSafeKey> {
    if bytes.len() != KEY_LEN {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "the Keychain sealing key has the wrong length"));
    }
    let key = UnboundKey::new(&AES_256_GCM, bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "the Keychain sealing key is unusable"))?;
    Ok(LessSafeKey::new(key))
}

fn seal_with(key: &LessSafeKey, rng: &dyn SecureRandom, plaintext: &[u8]) -> io::Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce).map_err(|_| io::Error::other("the system random source failed"))?;
    let mut sealed = Vec::with_capacity(1 + NONCE_LEN + plaintext.len() + TAG_LEN);
    sealed.push(SEAL_VERSION);
    sealed.extend_from_slice(&nonce);
    let mut body = plaintext.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from([SEAL_VERSION]), &mut body)
        .map_err(|_| io::Error::other("sealing failed"))?;
    sealed.extend_from_slice(&body);
    Ok(sealed)
}

fn open_with(key: &LessSafeKey, sealed: &[u8]) -> io::Result<Vec<u8>> {
    let invalid = |message: &'static str| io::Error::new(io::ErrorKind::InvalidData, message);
    let (&version, rest) = sealed.split_first().ok_or_else(|| invalid("sealed data is empty"))?;
    if version != SEAL_VERSION {
        return Err(invalid("sealed data has an unknown version"));
    }
    if rest.len() < NONCE_LEN + TAG_LEN {
        return Err(invalid("sealed data is truncated"));
    }
    let (nonce, body) = rest.split_at(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| invalid("sealed data is truncated"))?;
    let mut body = body.to_vec();
    let plaintext = key
        .open_in_place(nonce, Aad::from([SEAL_VERSION]), &mut body)
        .map_err(|_| invalid("sealed data failed authentication"))?;
    Ok(plaintext.to_vec())
}

impl webview_host::seal::Sealer for KeychainSealer {
    fn seal(&self, plaintext: &[u8]) -> io::Result<Vec<u8>> {
        KeychainSealer::seal(self, plaintext)
    }

    fn open(&self, sealed: &[u8]) -> io::Result<Vec<u8>> {
        KeychainSealer::open(self, sealed)
    }
}

/// The production sealer: the login Keychain's state-sealing key.
pub fn production_sealer() -> Arc<dyn webview_host::seal::Sealer> {
    Arc::new(KeychainSealer::production())
}

#[cfg(target_os = "macos")]
mod item {
    use super::KEY_LEN;
    use ring::rand::SecureRandom;
    use security_framework::base::Error;
    use security_framework::item::{ItemAddOptions, ItemAddValue, ItemClass, Location};
    use security_framework::passwords::{PasswordOptions, generic_password};
    use std::io;

    const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    pub fn load_or_create(service: &str, account: &str, rng: &dyn SecureRandom) -> io::Result<Vec<u8>> {
        match read(service, account) {
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {}
            result => return result.map_err(|error| keychain_error("read", error)),
        }
        let mut key = vec![0u8; KEY_LEN];
        rng.fill(&mut key).map_err(|_| io::Error::other("the system random source failed"))?;
        let mut options = ItemAddOptions::new(ItemAddValue::Data {
            class: ItemClass::generic_password(),
            data: core_foundation::data::CFData::from_buffer(&key),
        });
        options
            .set_service(service)
            .set_account_name(account)
            .set_label("Tilecast Player")
            .set_description("Tilecast Player state key")
            .set_location(Location::DefaultFileKeychain);
        match options.add() {
            Ok(()) => Ok(key),
            Err(error) if error.code() == ERR_SEC_DUPLICATE_ITEM => {
                read(service, account).map_err(|error| keychain_error("read", error))
            }
            Err(error) => Err(keychain_error("add", error)),
        }
    }

    fn read(service: &str, account: &str) -> Result<Vec<u8>, Error> {
        generic_password(PasswordOptions::new_generic_password(service, account))
    }

    fn keychain_error(operation: &str, error: Error) -> io::Error {
        let kind = match error.code() {
            // errSecAuthFailed, errSecInteractionNotAllowed, userCanceledErr.
            -25293 | -25308 | -128 => io::ErrorKind::PermissionDenied,
            _ => io::ErrorKind::Other,
        };
        io::Error::new(kind, format!("Keychain {operation} failed (OSStatus {})", error.code()))
    }

    #[cfg(test)]
    pub fn delete(service: &str, account: &str) {
        let _ = security_framework::passwords::delete_generic_password(service, account);
    }
}

#[cfg(not(target_os = "macos"))]
mod item {
    use ring::rand::SecureRandom;
    use std::io;

    pub fn load_or_create(_service: &str, _account: &str, _rng: &dyn SecureRandom) -> io::Result<Vec<u8>> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "the Keychain is only available on macOS"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> LessSafeKey {
        aead_key(&[7u8; KEY_LEN]).expect("key")
    }

    #[test]
    fn sealing_round_trips_and_uses_fresh_nonces() {
        let key = test_key();
        let rng = SystemRandom::new();
        let first = seal_with(&key, &rng, b"device credential").expect("seal");
        let second = seal_with(&key, &rng, b"device credential").expect("seal");
        assert_ne!(first, second);
        assert_eq!(first[0], SEAL_VERSION);
        assert_eq!(first.len(), 1 + NONCE_LEN + b"device credential".len() + TAG_LEN);
        assert!(!first.windows(6).any(|window| window == b"device"));
        assert_eq!(open_with(&key, &first).expect("open"), b"device credential");
        assert_eq!(open_with(&key, &seal_with(&key, &rng, b"").expect("seal")).expect("open"), b"");
    }

    #[test]
    fn tampered_truncated_and_foreign_data_is_refused() {
        let key = test_key();
        let sealed = seal_with(&key, &SystemRandom::new(), b"pairing session").expect("seal");
        for index in 0..sealed.len() {
            let mut tampered = sealed.clone();
            tampered[index] ^= 0x01;
            let error = open_with(&key, &tampered).expect_err("tampering is detected");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }
        assert!(open_with(&key, &[]).is_err());
        assert!(open_with(&key, &sealed[..NONCE_LEN + TAG_LEN]).is_err());
        let other = aead_key(&[8u8; KEY_LEN]).expect("key");
        assert!(open_with(&other, &sealed).is_err());
        assert!(aead_key(&[0u8; 16]).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_key_is_created_once_and_reloaded() {
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                item::delete(KEYCHAIN_SERVICE, &self.0);
            }
        }
        let mut suffix = [0u8; 8];
        SystemRandom::new().fill(&mut suffix).expect("random");
        let account = format!("test-{}", suffix.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
        let _cleanup = Cleanup(account.clone());

        let sealer = KeychainSealer::new(account.clone());
        let sealed = sealer.seal(b"secret").expect("seal with a new Keychain key");
        assert_eq!(sealer.open(&sealed).expect("open"), b"secret");
        // A second sealer reads the stored key instead of creating one.
        let reloaded = KeychainSealer::new(account.clone());
        assert_eq!(reloaded.open(&sealed).expect("open with the stored key"), b"secret");
        let mut tampered = sealed.clone();
        *tampered.last_mut().expect("tag") ^= 0x80;
        assert!(reloaded.open(&tampered).is_err());
        assert!(!format!("{sealer:?}").contains("key:"));
    }
}
