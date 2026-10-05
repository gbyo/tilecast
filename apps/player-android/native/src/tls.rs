//! Android platform TLS trust.
//!
//! On Android, Rust networking validates server certificates with Android's
//! platform TrustManager decisions through `rustls-platform-verifier`, the
//! same trust ordinary Android networking uses (including enterprise roots).
//! The verifier needs the process `JavaVM` and app `Context` handles once,
//! before the first handshake; Kotlin passes them to
//! [`init_with_context`] during host startup.
//!
//! Linux and macOS behavior is unchanged: `player-client` keeps its static
//! root configuration there.

use jni::Env;
use jni::objects::JObject;

/// Stores the Android runtime handles for the platform verifier. Idempotent:
/// a second call with the same process handles succeeds without replacing
/// them. Must run before any Core networking on Android.
pub fn init_with_context(env: &mut Env, context: JObject) -> Result<(), TlsInitError> {
    #[cfg(target_os = "android")]
    {
        rustls_platform_verifier::android::init_with_env(env, context).map_err(|_| TlsInitError::Init)?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (env, context);
        Err(TlsInitError::Unsupported)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TlsInitError {
    #[error("the platform verifier could not be initialized")]
    Init,
    #[error("platform verifier init is Android-only")]
    Unsupported,
}

impl TlsInitError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Init => "tls_init_failed",
            Self::Unsupported => "tls_init_unsupported",
        }
    }
}
