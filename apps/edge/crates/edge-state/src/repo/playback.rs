//! Playback facts that survive restarts.

use edge_protocol::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms_opt, ms};
use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PlaybackState {
    pub playback_disabled: bool,
    pub server_clock_offset_ms: Option<i64>,
    pub server_clock_synchronized_at: Option<Timestamp>,
}

pub fn get(connection: &Connection) -> Result<PlaybackState> {
    let row: Option<(i64, Option<i64>, Option<i64>)> = connection
        .query_row(
            "SELECT playback_disabled, server_clock_offset_ms, server_clock_synchronized_at_ms
             FROM playback_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match row {
        None => Ok(PlaybackState::default()),
        Some((disabled, offset, synced)) => Ok(PlaybackState {
            playback_disabled: disabled == 1,
            server_clock_offset_ms: offset,
            server_clock_synchronized_at: from_ms_opt(synced)?,
        }),
    }
}

pub fn put(connection: &Connection, state: &PlaybackState, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT INTO playback_state (id, playback_disabled, server_clock_offset_ms,
                                     server_clock_synchronized_at_ms, updated_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO UPDATE SET
             playback_disabled = excluded.playback_disabled,
             server_clock_offset_ms = excluded.server_clock_offset_ms,
             server_clock_synchronized_at_ms = excluded.server_clock_synchronized_at_ms,
             updated_at_ms = excluded.updated_at_ms",
        params![
            i64::from(state.playback_disabled),
            state.server_clock_offset_ms,
            state.server_clock_synchronized_at.map(ms),
            ms(now),
        ],
    )?;
    Ok(())
}
