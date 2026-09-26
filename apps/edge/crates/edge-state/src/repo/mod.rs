//! Typed repositories. Every SQL statement in Tilecast Edge lives under this
//! module. Functions take a `&Connection` (or `&mut Connection` when they
//! need a transaction) and return typed values; callers never see rows.

pub mod binding;
pub mod capabilities;
pub mod cas;
pub mod commands;
pub mod config;
pub mod daemon;
pub mod legacy;
pub mod manifests;
pub mod noise_history;
pub mod outbox;
pub mod playback;
pub mod presentation_network;
pub mod renderer;

use edge_protocol::Timestamp;

use crate::{Result, StateError};

pub(crate) fn ms(value: Timestamp) -> i64 {
    value.unix_millis()
}

pub(crate) fn from_ms(value: i64) -> Result<Timestamp> {
    Timestamp::from_unix_millis(value).ok_or_else(|| StateError::InvalidValue(format!("timestamp {value}")))
}

pub(crate) fn from_ms_opt(value: Option<i64>) -> Result<Option<Timestamp>> {
    value.map(from_ms).transpose()
}

pub(crate) fn parse<T: std::str::FromStr>(value: &str, what: &str) -> Result<T> {
    value
        .parse()
        .map_err(|_| StateError::InvalidValue(format!("{what}: {}", value.chars().take(64).collect::<String>())))
}
