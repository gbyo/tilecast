//! The narrow Kotlin/Rust JNI boundary.
//!
//! Coarse operations, primitives and short strings only:
//!
//! | Kotlin (`PlayerCoreNative`) | Effect |
//! |---|---|
//! | `nativeVersion()` | Crate version string, never null in practice |
//! | `nativeOpen(filesDir, userAgent, handler)` | Opens the process host; handle or `0` |
//! | `nativeStatus(handle)` | Always a JSON envelope (errors inside) |
//! | `nativeStartCore(handle)` | `0` started, `1` bad handle, `2` not live |
//! | `nativeBeginPairing(handle, url)` | Always a JSON envelope (errors inside) |
//! | `nativeResetPairing(handle)` | `0` reset, `1` bad handle, `2` not live |
//! | `nativeResetServer(handle)` | `0` reset, `1` bad handle, `2` not live |
//! | `nativeClose(handle)` | `0` closed, `1` bad handle, `2` not live |
//! | `nativeInitTls(context)` | `0` ready, `1` failed, `2` non-Android |
//! | `nativeQualifyCas(filesDir)` | CAS checklist JSON (instrumented tests only) |
//! | `nativeSyncConfig(handle)` | One config reconcile as a JSON envelope |
//! | `nativeSyncManifest(handle)` | One manifest sync as a JSON envelope |
//! | `nativeFetchIdentity(handle, url)` | Public server identity as a JSON envelope |
//! | `nativeBackgroundLiveness(handle)` | One background liveness ping as a JSON envelope |
//! | `nativeActivatePresentation(handle, json)` | Activation outcome as a JSON envelope |
//! | `nativeRendererReport(handle, json)` | `0` applied, `1` ignored, `2` malformed, `3` bad handle |
//! | `nativeRendererRecovery(handle, json)` | Recovery outcome as a JSON envelope |
//!
//! `nativeStatus` and `nativeBeginPairing` always return a JSON object so
//! Kotlin parses one shape: `{"ok":true,...}` or `{"ok":false,"code":"..."}`.
//! Codes are stable machine strings from [`crate::host::HostError::code`];
//! human messages and paths stay out of the bridge.
//!
//! Panic discipline: the workspace builds with `panic = "abort"`, so every
//! closure below maps errors to values instead of unwrapping. `with_env`
//! adds `catch_unwind` for unwind builds, but this crate treats a panic as
//! a bug, not a control-flow path.

use std::path::Path;
use std::sync::Arc;

use jni::objects::{JObject, JString};
use jni::{Env, EnvUnowned, errors};

use crate::host::{close_host, open_host, with_host};
use crate::jvm::Jvm;

/// Rejects absurd inputs before they reach the host. The app-private files
/// dir and the server URL are short strings; anything longer is a caller bug.
const MAX_FILES_DIR_CHARS: usize = 4096;
const MAX_URL_CHARS: usize = 2048;

fn open_handle(env: &mut Env, files_dir: &str, user_agent: &str, handler: &JObject) -> i64 {
    if files_dir.is_empty() || files_dir.len() > MAX_FILES_DIR_CHARS {
        return 0;
    }
    let jvm = match Jvm::bind(env, handler) {
        Ok(jvm) => Arc::new(jvm),
        Err(_) => return 0,
    };
    open_host(Path::new(files_dir), jvm, user_agent).unwrap_or(0)
}

fn status_json(handle: i64) -> String {
    match with_host(handle, |host| host.status()) {
        Ok(status) => status.to_string(),
        Err(error) => serde_json::json!({"bridge": 3, "ok": false, "code": error.code()}).to_string(),
    }
}

fn begin_json(handle: i64, url: &str) -> String {
    if url.is_empty() || url.len() > MAX_URL_CHARS {
        return serde_json::json!({"ok": false, "code": "server_url_rejected"}).to_string();
    }
    match with_host(handle, |host| host.begin_pairing(url)) {
        Ok(Ok(())) => serde_json::json!({"ok": true}).to_string(),
        Ok(Err(error)) | Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

fn lifecycle_code(handle: i64, run: impl FnOnce(&crate::host::AndroidHost)) -> i32 {
    match with_host(handle, run) {
        Ok(()) => 0,
        Err(crate::host::HostError::BadHandle) => 1,
        Err(_) => 2,
    }
}

fn close_code(handle: i64) -> i32 {
    match close_host(handle) {
        Ok(()) => 0,
        Err(crate::host::HostError::BadHandle) => 1,
        Err(_) => 2,
    }
}

fn tls_code(result: Result<(), crate::tls::TlsInitError>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(crate::tls::TlsInitError::Unsupported) => 2,
        Err(crate::tls::TlsInitError::Init) => 1,
    }
}

fn qualify_json(files_dir: &str) -> String {
    if files_dir.is_empty() || files_dir.len() > MAX_FILES_DIR_CHARS {
        return serde_json::json!({"ok": false, "code": "files_dir_unusable"}).to_string();
    }
    let dir = Path::new(files_dir);
    if !dir.is_absolute() {
        return serde_json::json!({"ok": false, "code": "files_dir_unusable"}).to_string();
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(_) => return serde_json::json!({"ok": false, "code": "runtime_start_failed"}).to_string(),
    };
    let checks = runtime.block_on(crate::cas_qualify::qualify(&dir.join("cas-qualify")));
    crate::cas_qualify::report_json(&checks).to_string()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeVersion<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            Ok(JObject::from(env.new_string(env!("CARGO_PKG_VERSION"))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeOpen<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    files_dir: JString<'local>,
    user_agent: JString<'local>,
    handler: JObject<'local>,
) -> i64 {
    unowned
        .with_env(|env| -> errors::Result<i64> {
            let dir = files_dir.try_to_string(env).unwrap_or_default();
            let agent = user_agent.try_to_string(env).unwrap_or_default();
            Ok(open_handle(env, &dir, &agent, &handler))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeStartCore<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> i32 {
    unowned
        .with_env(|_env| -> errors::Result<i32> { Ok(lifecycle_code(handle, |host| host.start_drivers())) })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeBeginPairing<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
    url: JString<'local>,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            let url = url.try_to_string(env).unwrap_or_default();
            Ok(JObject::from(env.new_string(begin_json(handle, &url))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeResetPairing<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> i32 {
    unowned
        .with_env(|_env| -> errors::Result<i32> { Ok(lifecycle_code(handle, |host| host.reset_pairing())) })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeResetServer<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> i32 {
    unowned
        .with_env(|_env| -> errors::Result<i32> { Ok(lifecycle_code(handle, |host| host.reset_server())) })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeStatus<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> { Ok(JObject::from(env.new_string(status_json(handle))?)) })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeClose<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> i32 {
    unowned
        .with_env(|_env| -> errors::Result<i32> { Ok(close_code(handle)) })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeInitTls<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    context: JObject<'local>,
) -> i32 {
    unowned
        .with_env(|env| -> errors::Result<i32> { Ok(tls_code(crate::tls::init_with_context(env, context))) })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

fn sync_json(handle: i64) -> String {
    match with_host(handle, |host| host.sync_config()) {
        Ok(Ok(report)) => report.to_string(),
        Ok(Err(error)) | Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeSyncConfig<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> { Ok(JObject::from(env.new_string(sync_json(handle))?)) })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

fn sync_manifest_json(handle: i64) -> String {
    match with_host(handle, |host| host.sync_manifest()) {
        Ok(Ok(report)) => report.to_string(),
        Ok(Err(error)) | Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

fn identity_json(handle: i64, url: &str) -> String {
    if url.is_empty() || url.len() > MAX_URL_CHARS {
        return serde_json::json!({"ok": false, "code": "server_url_rejected"}).to_string();
    }
    match with_host(handle, |host| host.fetch_identity(url)) {
        Ok(report) => report.to_string(),
        Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

fn liveness_json(handle: i64) -> String {
    match with_host(handle, |host| host.background_liveness()) {
        Ok(Ok(report)) => report.to_string(),
        Ok(Err(error)) | Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

fn import_legacy_json(handle: i64) -> String {
    match with_host(handle, |host| host.import_legacy()) {
        Ok(outcome) => outcome.to_string(),
        Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeImportLegacy<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            Ok(JObject::from(env.new_string(import_legacy_json(handle))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeSyncManifest<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            Ok(JObject::from(env.new_string(sync_manifest_json(handle))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeFetchIdentity<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
    url: JString<'local>,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            let url = url.try_to_string(env).unwrap_or_default();
            Ok(JObject::from(env.new_string(identity_json(handle, &url))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeBackgroundLiveness<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            Ok(JObject::from(env.new_string(liveness_json(handle))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

/// Bounds a projected activation or report before it reaches the
/// engine. Presentations carry media manifests; anything larger is a
/// caller bug.
const MAX_RENDERER_JSON_CHARS: usize = 8 * 1024 * 1024;

fn activate_json(handle: i64, json: &str) -> String {
    if json.is_empty() || json.len() > MAX_RENDERER_JSON_CHARS {
        return serde_json::json!({"ok": true, "outcome": "refused", "reason": "malformed_activation"}).to_string();
    }
    match with_host(handle, |host| host.activate_presentation(json)) {
        Ok(outcome) => outcome.to_string(),
        Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

fn report_code(handle: i64, json: &str) -> i32 {
    if json.is_empty() || json.len() > MAX_RENDERER_JSON_CHARS {
        return crate::host::renderer_report::MALFORMED;
    }
    match with_host(handle, |host| host.renderer_report(json)) {
        Ok(code) => code,
        Err(crate::host::HostError::BadHandle) => 3,
        Err(_) => crate::host::renderer_report::MALFORMED,
    }
}

fn recovery_json(handle: i64, json: &str) -> String {
    if json.is_empty() || json.len() > MAX_RENDERER_JSON_CHARS {
        return serde_json::json!({"ok": true, "outcome": "refused", "reason": "unknown_action"}).to_string();
    }
    match with_host(handle, |host| host.renderer_recovery(json)) {
        Ok(outcome) => outcome.to_string(),
        Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

fn observations_stored(handle: i64, json: &str) -> i32 {
    if json.is_empty() || json.len() > crate::observations::MAX_OBSERVATIONS_BYTES {
        return -1;
    }
    with_host(handle, |host| host.report_observations(json)).unwrap_or(-1)
}

fn effective_config_json(handle: i64) -> String {
    match with_host(handle, |host| host.effective_config()) {
        Ok(value) => value.to_string(),
        Err(error) => serde_json::json!({"ok": false, "code": error.code()}).to_string(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeActivatePresentation<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
    json: JString<'local>,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            let json = json.try_to_string(env).unwrap_or_default();
            Ok(JObject::from(env.new_string(activate_json(handle, &json))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeRendererReport<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
    json: JString<'local>,
) -> i32 {
    unowned
        .with_env(|env| -> errors::Result<i32> {
            let json = json.try_to_string(env).unwrap_or_default();
            Ok(report_code(handle, &json))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeRendererRecovery<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
    json: JString<'local>,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            let json = json.try_to_string(env).unwrap_or_default();
            Ok(JObject::from(env.new_string(recovery_json(handle, &json))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeReportObservations<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
    json: JString<'local>,
) -> i32 {
    unowned
        .with_env(|env| -> errors::Result<i32> {
            let json = json.try_to_string(env).unwrap_or_default();
            Ok(observations_stored(handle, &json))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeConfigJson<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    handle: i64,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            Ok(JObject::from(env.new_string(effective_config_json(handle))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tilecast_player_core_PlayerCoreNative_nativeQualifyCas<'local>(
    mut unowned: EnvUnowned<'local>,
    _this: JObject<'local>,
    files_dir: JString<'local>,
) -> JObject<'local> {
    unowned
        .with_env(|env| -> errors::Result<JObject<'local>> {
            let dir = files_dir.try_to_string(env).unwrap_or_default();
            Ok(JObject::from(env.new_string(qualify_json(&dir))?))
        })
        .resolve::<errors::ThrowRuntimeExAndDefault>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_rejects_unusable_urls_without_touching_global_state() {
        let value: serde_json::Value = serde_json::from_str(&begin_json(7, "")).expect("parses");
        assert_eq!(value["ok"], false);
        assert_eq!(value["code"], "server_url_rejected");
        let long = "x".repeat(MAX_URL_CHARS + 1);
        let value: serde_json::Value = serde_json::from_str(&begin_json(7, &long)).expect("parses");
        assert_eq!(value["code"], "server_url_rejected");
    }

    #[test]
    fn status_reports_machine_code_for_bad_handle() {
        let value: serde_json::Value = serde_json::from_str(&status_json(7)).expect("status parses");
        assert_eq!(value["bridge"], 3);
        assert_eq!(value["ok"], false);
        assert_eq!(value["code"], "bad_handle");
    }

    #[test]
    fn renderer_entries_reject_absurd_input_without_touching_global_state() {
        let value: serde_json::Value = serde_json::from_str(&activate_json(7, "")).expect("parses");
        assert_eq!(value["reason"], "malformed_activation");
        let value: serde_json::Value = serde_json::from_str(&recovery_json(7, "")).expect("parses");
        assert_eq!(value["reason"], "unknown_action");
        assert_eq!(report_code(7, ""), crate::host::renderer_report::MALFORMED);
        assert_eq!(report_code(7, r#"{"type":"connected","generation":1}"#), 3);
    }

    #[test]
    fn close_maps_unknown_handles() {
        assert_eq!(close_code(0), 1);
        assert_eq!(close_code(-1), 1);
    }

    #[test]
    fn sync_reports_machine_code_for_bad_handle() {
        let value: serde_json::Value = serde_json::from_str(&sync_json(7)).expect("parses");
        assert_eq!(value["ok"], false);
        assert_eq!(value["code"], "bad_handle");
    }

    #[test]
    fn qualify_rejects_unusable_dirs_without_running() {
        let value: serde_json::Value = serde_json::from_str(&qualify_json("")).expect("parses");
        assert_eq!(value["ok"], false);
        assert_eq!(value["code"], "files_dir_unusable");
        let value: serde_json::Value = serde_json::from_str(&qualify_json("relative")).expect("parses");
        assert_eq!(value["code"], "files_dir_unusable");
    }

    #[test]
    fn tls_codes_are_stable() {
        assert_eq!(tls_code(Ok(())), 0);
        assert_eq!(tls_code(Err(crate::tls::TlsInitError::Init)), 1);
        assert_eq!(tls_code(Err(crate::tls::TlsInitError::Unsupported)), 2);
    }
}
