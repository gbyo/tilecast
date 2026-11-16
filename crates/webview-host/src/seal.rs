//! At-rest protection for the private stores. The platform seals with its
//! user-scoped facility (DPAPI, the Keychain); the seal is injected so the
//! store logic stays testable where that facility does not exist.

/// Encrypts small secrets for storage and decrypts them back.
pub trait Sealer: Send + Sync + std::fmt::Debug {
    fn seal(&self, plaintext: &[u8]) -> std::io::Result<Vec<u8>>;
    fn open(&self, sealed: &[u8]) -> std::io::Result<Vec<u8>>;
}

/// A reversible transform for tests. It is not encryption and never leaves
/// test builds: production always wires the platform sealer.
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
