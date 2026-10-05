//! At-rest protection for the private stores. Production seals with
//! user-scoped DPAPI; the seal is injected so the store logic stays
//! testable where DPAPI does not exist.

use std::sync::Arc;

/// Encrypts small secrets for storage and decrypts them back.
pub trait Sealer: Send + Sync + std::fmt::Debug {
    fn seal(&self, plaintext: &[u8]) -> std::io::Result<Vec<u8>>;
    fn open(&self, sealed: &[u8]) -> std::io::Result<Vec<u8>>;
}

/// User-scoped DPAPI: only this Windows user on this machine can unseal.
/// Machine-scoped protection is never used: any local user could unseal it.
#[derive(Debug, Default, Clone, Copy)]
pub struct DpapiSealer;

impl Sealer for DpapiSealer {
    fn seal(&self, plaintext: &[u8]) -> std::io::Result<Vec<u8>> {
        crate::win32::protect_user_data(plaintext)
    }

    fn open(&self, sealed: &[u8]) -> std::io::Result<Vec<u8>> {
        crate::win32::unprotect_user_data(sealed)
    }
}

pub fn production_sealer() -> Arc<dyn Sealer> {
    Arc::new(DpapiSealer)
}

/// A reversible transform for tests. It is not encryption and never leaves
/// test builds: production always wires [`DpapiSealer`].
#[cfg(any(test, feature = "test-util"))]
#[derive(Debug, Default, Clone, Copy)]
pub struct TestSealer;

#[cfg(any(test, feature = "test-util"))]
impl Sealer for TestSealer {
    fn seal(&self, plaintext: &[u8]) -> std::io::Result<Vec<u8>> {
        Ok(plaintext.iter().map(|byte| byte ^ 0x5a).collect())
    }

    fn open(&self, sealed: &[u8]) -> std::io::Result<Vec<u8>> {
        self.seal(sealed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trips_on_windows_and_fails_elsewhere() {
        let sealer = DpapiSealer;
        #[cfg(windows)]
        {
            let sealed = sealer.seal(b"secret").expect("seal");
            assert_ne!(sealed, b"secret");
            assert_eq!(sealer.open(&sealed).expect("open"), b"secret");
        }
        #[cfg(not(windows))]
        {
            assert!(sealer.seal(b"secret").is_err());
            assert!(sealer.open(b"secret").is_err());
        }
    }
}
