//! Presentation Network restart state (migration 0005): which Tilecast
//! connection is up, and whether the Wi-Fi radio was on before Tilecast
//! activated it. There is no credential here, by construction.

use edge_protocol::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};

use super::ms;
use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkState {
    /// A lowercase canonical UUID (the server's `presentationNetworkId`).
    pub active_network_id: Option<String>,
    /// The conservative default is "already on": Tilecast then never turns an
    /// operator's radio off.
    pub radio_was_enabled: bool,
}

impl Default for NetworkState {
    fn default() -> Self {
        Self { active_network_id: None, radio_was_enabled: true }
    }
}

pub fn get(connection: &Connection) -> Result<NetworkState> {
    let row: Option<(Option<String>, i64)> = connection
        .query_row(
            "SELECT active_network_id, radio_was_enabled FROM presentation_network_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        None => NetworkState::default(),
        Some((id, radio)) => NetworkState {
            // An unreadable identifier is discarded, not guessed at.
            active_network_id: id.filter(|id| is_network_id(id)),
            radio_was_enabled: radio != 0,
        },
    })
}

pub fn put(connection: &Connection, state: &NetworkState, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT INTO presentation_network_state (singleton, active_network_id, radio_was_enabled, updated_at_ms)
         VALUES (1, ?1, ?2, ?3)
         ON CONFLICT (singleton) DO UPDATE SET
             active_network_id = excluded.active_network_id,
             radio_was_enabled = excluded.radio_was_enabled,
             updated_at_ms = excluded.updated_at_ms",
        params![
            state.active_network_id.as_deref().filter(|id| is_network_id(id)),
            i64::from(state.radio_was_enabled),
            ms(now)
        ],
    )?;
    Ok(())
}

/// A lowercase canonical UUID.
pub fn is_network_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}
