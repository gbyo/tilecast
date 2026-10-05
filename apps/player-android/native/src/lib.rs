//! Android platform host for shared Player Core.
//!
//! This crate is Android platform code, not a sixth shared Player crate. It
//! owns the narrow Kotlin/Rust bridge: one process-level [`host::AndroidHost`]
//! (Tokio runtime, Player State, CAS, and a [`player_core::PlayerCore`]
//! instance), the Android storage locations ([`paths`]), and Android platform
//! TLS trust ([`tls`]).
//!
//! Kotlin owns the Android lifecycle, UI, WebView runtime hosting, Keystore,
//! scheduling, and every other OS behavior. Shared native Player behavior
//! stays in Player Core. See `docs/player-core.md` and
//! `docs/android-development.md`.
//!
//! # Safety rules
//!
//! * The workspace builds with `panic = "abort"`, so a Rust panic inside a
//!   JNI call aborts the player process. Code reachable from [`ffi`] must
//!   never panic: validate every input, map every error to a return code,
//!   and keep `unwrap`/`expect`/indexing out of that path.
//! * Raw JNI pointers are confined to [`ffi`], the one module allowed an
//!   explicitly audited `unsafe` scope. Everything else stays safe Rust.

// Audited FFI scope: raw JNI entry points only. Each function converts its
// raw arguments to safe `jni` wrappers on entry, validates every input,
// maps errors to return codes (never panics: `panic = "abort"` would kill
// the process), and holds no lock across a Kotlin upcall.
pub mod cas_qualify;
pub mod commands;
pub mod config_host;
pub mod drivers;
#[allow(unsafe_code)]
pub mod ffi;
pub mod host;
pub mod jvm;
pub mod legacy_import;
pub mod live_stream;
pub mod manifest_host;
pub mod pairing_host;
pub mod paths;
pub mod presentation_capabilities;
pub mod renderer;
pub mod selection;
pub mod server_link;
pub mod stores;
pub mod telemetry;
pub mod tls;
pub mod widget_capabilities;
