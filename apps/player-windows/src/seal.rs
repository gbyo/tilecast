//! User-scoped DPAPI sealing for the private stores
//! ([`webview_host::seal::Sealer`]).

use std::sync::Arc;

pub use webview_host::seal::Sealer;
#[cfg(any(test, feature = "test-util"))]
pub use webview_host::seal::TestSealer;

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
