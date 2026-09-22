//! Structured logging to stderr (journald captures it under systemd).
//!
//! Conventions, enforced in review: every event has `component` and `event`
//! fields; identifiers are logged in full only when they are not secrets;
//! digests are logged as `Sha256Digest::short()`; never log credentials,
//! private keys, Presentation Network secrets, website URLs with query
//! strings, raw sensor samples or signed-document bodies.

use tracing_subscriber::EnvFilter;

use crate::config::{LogConfig, LogFormat};

pub fn init(config: &LogConfig) {
    let filter = EnvFilter::try_from_env("TILECAST_LOG").unwrap_or_else(|_| EnvFilter::new(&config.level));
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).with_target(false);
    let result = match config.format {
        LogFormat::Json => builder.json().flatten_event(true).with_current_span(false).try_init(),
        LogFormat::Text => builder.try_init(),
    };
    // A second init (tests) is harmless.
    let _ = result;
}
