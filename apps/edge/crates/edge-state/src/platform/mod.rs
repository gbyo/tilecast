//! Edge-only repositories in the historical shared physical database.
//! Shared schema compatibility does not give Player Core behavioral ownership.

pub mod legacy;
pub mod presentation_network;
pub mod updates;

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
