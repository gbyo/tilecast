//! Rust-to-Kotlin upcalls for the Core host.
//!
//! Core drivers run on Tokio worker threads and call into Kotlin for
//! Android-owned facts: the Keystore credential, the private pairing file,
//! device metadata, and status surfaces. Every call uses a scoped thread
//! attachment, so a worker is detached before the call returns and no
//! attachment outlives its thread. Calls are synchronous and must stay
//! millisecond-scale; Kotlin does no network or disk I/O beyond its private
//! stores on this path.
//!
//! Method names and signatures below form the Rust side of the bridge
//! contract. The Kotlin handler (`CoreBridgeHandler`) must keep them exact,
//! and the ProGuard rules keep them through minification.

use jni::objects::{Global, JObject, JValue};
use jni::strings::JNIStr;
use jni::{Env, JavaVM, jni_sig};

/// Opaque handle to the Kotlin bridge object. Secrets cross this boundary
/// as Java strings inside the process; they are never logged, and every
/// payload is length-bounded before crossing.
#[derive(Debug)]
pub struct Jvm {
    vm: JavaVM,
    handler: Global<JObject<'static>>,
}

#[derive(Debug, thiserror::Error)]
pub enum JvmError {
    #[error("the Kotlin bridge call failed")]
    Call,
    #[error("the Kotlin bridge is missing")]
    MissingHandler,
}

impl From<jni::errors::Error> for JvmError {
    fn from(_: jni::errors::Error) -> Self {
        Self::Call
    }
}

impl Jvm {
    /// Binds the Kotlin handler for later upcalls. Call once from the
    /// opening native method, which already runs attached.
    pub fn bind(env: &mut Env, handler: &JObject) -> Result<Self, JvmError> {
        if handler.is_null() {
            return Err(JvmError::MissingHandler);
        }
        Ok(Self { vm: env.get_java_vm()?, handler: env.new_global_ref(handler)? })
    }

    fn with_env<T>(&self, run: impl FnOnce(&mut Env, &JObject) -> Result<T, JvmError>) -> Result<T, JvmError> {
        self.vm
            .attach_current_thread_for_scope(|env| {
                let handler = self.handler.as_obj();
                run(env, handler)
            })
            .map_err(|_: JvmError| JvmError::Call)
    }

    fn text(env: &Env, object: JObject) -> Result<Option<String>, JvmError> {
        if object.is_null() {
            return Ok(None);
        }
        let string = env.cast_local::<jni::objects::JString>(object).map_err(|_| JvmError::Call)?;
        string.try_to_string(env).map(Some).map_err(|_| JvmError::Call)
    }

    /// Calls `String method()` or `String method(String)`. A Java null or a
    /// thrown exception becomes `Ok(None)` for loads; saves use [`Self::call_int`].
    pub fn call_string(&self, method: &JNIStr, arg: Option<&str>) -> Result<Option<String>, JvmError> {
        self.with_env(|env, handler| {
            let value = match arg {
                Some(text) => {
                    let input = env.new_string(text)?;
                    let input = JValue::from(&input);
                    env.call_method(handler, method, jni_sig!((input: JString) -> JString), &[input])?
                }
                None => env.call_method(handler, method, jni_sig!(() -> JString), &[])?,
            }
            .l()?;
            Self::text(env, value)
        })
    }

    /// Calls `int method()` or `int method(String)`. Kotlin returns `0` for
    /// success and a small positive code otherwise.
    pub fn call_int(&self, method: &JNIStr, arg: Option<&str>) -> Result<i32, JvmError> {
        self.with_env(|env, handler| {
            match arg {
                Some(text) => {
                    let input = env.new_string(text)?;
                    let input = JValue::from(&input);
                    env.call_method(handler, method, jni_sig!((input: JString) -> jint), &[input])?
                }
                None => env.call_method(handler, method, jni_sig!(() -> jint), &[])?,
            }
            .i()
            .map_err(|_| JvmError::Call)
        })
    }

    /// Calls `long method()`. A thrown exception becomes an error; the
    /// caller falls back to its own measurement.
    pub fn call_long(&self, method: &JNIStr) -> Result<i64, JvmError> {
        self.with_env(|env, handler| {
            env.call_method(handler, method, jni_sig!(() -> jlong), &[])?.j().map_err(|_| JvmError::Call)
        })
    }

    /// Calls `void method(String)`. Best effort: the caller already holds
    /// the durable state, so a failed surface update never fails the pass.
    pub fn call_void(&self, method: &JNIStr, arg: &str) -> Result<(), JvmError> {
        self.with_env(|env, handler| {
            let input = env.new_string(arg)?;
            let input = JValue::from(&input);
            env.call_method(handler, method, jni_sig!((input: JString) -> void), &[input])?.v()?;
            Ok(())
        })
    }
}

/// Handler entry points. Each constant names a `CoreBridgeHandler` method.
/// Keep the spelling in sync with the Kotlin source and the ProGuard rules.
pub mod method {
    use jni::jni_str;
    use jni::strings::JNIStr;

    pub fn credential_load() -> &'static JNIStr {
        jni_str!("credentialLoad")
    }
    pub fn credential_save() -> &'static JNIStr {
        jni_str!("credentialSave")
    }
    pub fn credential_remove() -> &'static JNIStr {
        jni_str!("credentialRemove")
    }
    pub fn pairing_session_load() -> &'static JNIStr {
        jni_str!("pairingSessionLoad")
    }
    pub fn pairing_session_save() -> &'static JNIStr {
        jni_str!("pairingSessionSave")
    }
    pub fn pairing_session_remove() -> &'static JNIStr {
        jni_str!("pairingSessionRemove")
    }
    pub fn device_metadata() -> &'static JNIStr {
        jni_str!("deviceMetadata")
    }
    pub fn pairing_status() -> &'static JNIStr {
        jni_str!("onPairingStatus")
    }
    pub fn execute_platform_command() -> &'static JNIStr {
        jni_str!("executePlatformCommand")
    }
    pub fn device_uptime_seconds() -> &'static JNIStr {
        jni_str!("deviceUptimeSeconds")
    }
    pub fn renderer_request() -> &'static JNIStr {
        jni_str!("rendererRequest")
    }
}
