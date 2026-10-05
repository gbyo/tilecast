//! Core private stores backed by the Android security boundary.
//!
//! The device credential lives in Android Keystore/AES-GCM behind
//! `KeystoreCredentialStore`. The short-lived pairing session lives in an
//! app-private file the handler owns. Neither ever enters Player State,
//! Room, logs, or the bridge status payload. [`StoreCalls`] is the seam:
//! production calls Kotlin, host tests use [`MemStoreCalls`].

use std::sync::{Arc, Mutex};

use player_client::pairing::{PairingFileError, PairingSession};
use player_client::{CredentialError, CredentialStore, DeviceCredential, PairingStore};

use crate::jvm::{Jvm, JvmError, method};

/// The six private-store operations, in one trait so hosts and tests share
/// the JSON/error mapping in [`JvmCredentialStore`] and [`JvmPairingStore`].
pub trait StoreCalls: Send + Sync + std::fmt::Debug {
    fn credential_load(&self) -> Result<Option<String>, StoreError>;
    fn credential_save(&self, value: &str) -> Result<(), StoreError>;
    fn credential_remove(&self) -> Result<(), StoreError>;
    fn pairing_load(&self) -> Result<Option<String>, StoreError>;
    fn pairing_save(&self, json: &str) -> Result<(), StoreError>;
    fn pairing_remove(&self) -> Result<(), StoreError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    #[error("the Android store is unavailable")]
    Unavailable,
}

impl From<JvmError> for StoreError {
    fn from(_: JvmError) -> Self {
        Self::Unavailable
    }
}

/// Production calls into the Kotlin handler. Kotlin integer codes: `0` is
/// success; anything else is a storage failure without further detail.
#[derive(Debug)]
pub struct JvmStoreCalls {
    jvm: Arc<Jvm>,
}

impl JvmStoreCalls {
    pub fn new(jvm: Arc<Jvm>) -> Self {
        Self { jvm }
    }

    fn check(code: i32) -> Result<(), StoreError> {
        if code == 0 { Ok(()) } else { Err(StoreError::Unavailable) }
    }
}

impl StoreCalls for JvmStoreCalls {
    fn credential_load(&self) -> Result<Option<String>, StoreError> {
        Ok(self.jvm.call_string(method::credential_load(), None)?)
    }

    fn credential_save(&self, value: &str) -> Result<(), StoreError> {
        let code = self.jvm.call_int(method::credential_save(), Some(value))?;
        Self::check(code)
    }

    fn credential_remove(&self) -> Result<(), StoreError> {
        let code = self.jvm.call_int(method::credential_remove(), None)?;
        Self::check(code)
    }

    fn pairing_load(&self) -> Result<Option<String>, StoreError> {
        Ok(self.jvm.call_string(method::pairing_session_load(), None)?)
    }

    fn pairing_save(&self, json: &str) -> Result<(), StoreError> {
        let code = self.jvm.call_int(method::pairing_session_save(), Some(json))?;
        Self::check(code)
    }

    fn pairing_remove(&self) -> Result<(), StoreError> {
        let code = self.jvm.call_int(method::pairing_session_remove(), None)?;
        Self::check(code)
    }
}

/// In-memory calls for host tests. No JNI, no Keystore, no files.
#[derive(Debug, Default)]
pub struct MemStoreCalls {
    credential: Mutex<Option<String>>,
    pairing: Mutex<Option<String>>,
    fail: Mutex<bool>,
}

impl MemStoreCalls {
    pub fn fail_next(&self, fail: bool) {
        *self.fail.lock().unwrap_or_else(|error| error.into_inner()) = fail;
    }

    fn failed(&self) -> bool {
        *self.fail.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl StoreCalls for MemStoreCalls {
    fn credential_load(&self) -> Result<Option<String>, StoreError> {
        if self.failed() {
            return Err(StoreError::Unavailable);
        }
        Ok(self.credential.lock().unwrap_or_else(|error| error.into_inner()).clone())
    }

    fn credential_save(&self, value: &str) -> Result<(), StoreError> {
        if self.failed() {
            return Err(StoreError::Unavailable);
        }
        *self.credential.lock().unwrap_or_else(|error| error.into_inner()) = Some(value.to_owned());
        Ok(())
    }

    fn credential_remove(&self) -> Result<(), StoreError> {
        if self.failed() {
            return Err(StoreError::Unavailable);
        }
        *self.credential.lock().unwrap_or_else(|error| error.into_inner()) = None;
        Ok(())
    }

    fn pairing_load(&self) -> Result<Option<String>, StoreError> {
        if self.failed() {
            return Err(StoreError::Unavailable);
        }
        Ok(self.pairing.lock().unwrap_or_else(|error| error.into_inner()).clone())
    }

    fn pairing_save(&self, json: &str) -> Result<(), StoreError> {
        if self.failed() {
            return Err(StoreError::Unavailable);
        }
        *self.pairing.lock().unwrap_or_else(|error| error.into_inner()) = Some(json.to_owned());
        Ok(())
    }

    fn pairing_remove(&self) -> Result<(), StoreError> {
        if self.failed() {
            return Err(StoreError::Unavailable);
        }
        *self.pairing.lock().unwrap_or_else(|error| error.into_inner()) = None;
        Ok(())
    }
}

#[derive(Debug)]
pub struct JvmCredentialStore {
    calls: Arc<dyn StoreCalls>,
}

impl JvmCredentialStore {
    pub fn new(calls: Arc<dyn StoreCalls>) -> Self {
        Self { calls }
    }
}

impl CredentialStore for JvmCredentialStore {
    fn load(&self) -> Result<Option<DeviceCredential>, CredentialError> {
        match self.calls.credential_load() {
            Ok(None) => Ok(None),
            Ok(Some(value)) => DeviceCredential::parse(&value).map(Some),
            Err(_) => Err(CredentialError::Io("credential store unavailable".to_owned())),
        }
    }

    fn save(&self, credential: &DeviceCredential) -> Result<(), CredentialError> {
        self.calls
            .credential_save(credential.secret_for_storage())
            .map_err(|_| CredentialError::Io("credential store unavailable".to_owned()))
    }

    fn remove(&self) -> Result<(), CredentialError> {
        self.calls.credential_remove().map_err(|_| CredentialError::Io("credential store unavailable".to_owned()))
    }
}

#[derive(Debug)]
pub struct JvmPairingStore {
    calls: Arc<dyn StoreCalls>,
}

impl JvmPairingStore {
    pub fn new(calls: Arc<dyn StoreCalls>) -> Self {
        Self { calls }
    }
}

impl PairingStore for JvmPairingStore {
    fn load(&self) -> Result<Option<PairingSession>, PairingFileError> {
        match self.calls.pairing_load() {
            Ok(None) => Ok(None),
            Ok(Some(json)) => serde_json::from_str(&json).map(Some).map_err(|_| PairingFileError::Format),
            Err(_) => Err(PairingFileError::Io("pairing store unavailable".to_owned())),
        }
    }

    fn save(&self, session: &PairingSession) -> Result<(), PairingFileError> {
        let json = serde_json::to_string(session).map_err(|_| PairingFileError::Format)?;
        self.calls.pairing_save(&json).map_err(|_| PairingFileError::Io("pairing store unavailable".to_owned()))
    }

    fn remove(&self) -> Result<(), PairingFileError> {
        self.calls.pairing_remove().map_err(|_| PairingFileError::Io("pairing store unavailable".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential_value() -> String {
        format!("tc_device_{}.{}", "a".repeat(26), "b".repeat(43))
    }

    #[test]
    fn credential_round_trip_validates_format() {
        let calls = Arc::new(MemStoreCalls::default());
        let store = JvmCredentialStore::new(calls.clone());
        assert_eq!(store.load().expect("load"), None);
        let credential = DeviceCredential::parse(&credential_value()).expect("parse");
        store.save(&credential).expect("save");
        assert_eq!(store.load().expect("reload"), Some(credential));
        calls.credential_save("not-a-credential").expect("raw save");
        assert_eq!(store.load(), Err(CredentialError::Format));
        store.remove().expect("remove");
        assert_eq!(store.load().expect("empty"), None);
    }

    #[test]
    fn credential_failures_map_to_io() {
        let calls = Arc::new(MemStoreCalls::default());
        calls.fail_next(true);
        let store = JvmCredentialStore::new(calls);
        assert!(matches!(store.load(), Err(CredentialError::Io(_))));
    }

    #[test]
    fn pairing_round_trip_rejects_malformed_json() {
        let calls = Arc::new(MemStoreCalls::default());
        let store = JvmPairingStore::new(calls.clone());
        assert_eq!(store.load().expect("load"), None);
        calls.pairing_save("{nope").expect("raw save");
        assert_eq!(store.load(), Err(PairingFileError::Format));
        calls.fail_next(true);
        assert!(matches!(store.load(), Err(PairingFileError::Io(_))));
        store.remove().expect_err("remove fails");
    }
}
