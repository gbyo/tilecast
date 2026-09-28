//! Daemon lifecycle bookkeeping and the player identity.

use edge_protocol::{PlayerId, Timestamp};
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, ms, parse};
use crate::{Result, StateError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRecord {
    pub boot_count: u64,
    /// The previous run did not reach a clean shutdown (crash, power cut,
    /// watchdog kill). Callers schedule integrity checks when this is set.
    pub previous_run_unclean: bool,
    pub first_start: bool,
}

/// Records a daemon start. Must be the first write of every run.
pub fn record_start(connection: &Connection, now: Timestamp, version: &str) -> Result<StartRecord> {
    let existing: Option<(i64, i64)> = connection
        .query_row("SELECT boot_count, running FROM daemon_state WHERE id = 1", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    match existing {
        None => {
            connection.execute(
                "INSERT INTO daemon_state (id, created_at_ms, boot_count, running, last_started_at_ms, daemon_version)
                 VALUES (1, ?1, 1, 1, ?1, ?2)",
                params![ms(now), version],
            )?;
            Ok(StartRecord { boot_count: 1, previous_run_unclean: false, first_start: true })
        }
        Some((boot_count, running)) => {
            let unclean = running == 1;
            connection.execute(
                "UPDATE daemon_state SET boot_count = boot_count + 1, running = 1,
                     unclean_shutdown_count = unclean_shutdown_count + ?1,
                     last_started_at_ms = ?2, daemon_version = ?3
                 WHERE id = 1",
                params![i64::from(unclean), ms(now), version],
            )?;
            Ok(StartRecord { boot_count: boot_count as u64 + 1, previous_run_unclean: unclean, first_start: false })
        }
    }
}

/// Records a clean shutdown. The last write of a clean run.
pub fn record_clean_shutdown(connection: &Connection, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE daemon_state SET running = 0, last_clean_shutdown_at_ms = ?1 WHERE id = 1",
        params![ms(now)],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerIdentitySource {
    Generated,
    LegacyImport,
}

impl PlayerIdentitySource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Generated => "generated",
            Self::LegacyImport => "legacy_import",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerIdentity {
    pub player_id: PlayerId,
    pub source: PlayerIdentitySource,
    pub created_at: Timestamp,
}

pub fn player_identity(connection: &Connection) -> Result<Option<PlayerIdentity>> {
    let row: Option<(String, String, i64)> = connection
        .query_row("SELECT player_id, source, created_at_ms FROM player_identity WHERE id = 1", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    row.map(|(player_id, source, created)| {
        Ok(PlayerIdentity {
            player_id: parse(&player_id, "player_id")?,
            source: match source.as_str() {
                "legacy_import" => PlayerIdentitySource::LegacyImport,
                _ => PlayerIdentitySource::Generated,
            },
            created_at: from_ms(created)?,
        })
    })
    .transpose()
}

/// Stores the player ID once. It never changes afterwards: setting a
/// different value is an error, because the server's pairing metadata and
/// screen history already know this device by it.
pub fn set_player_identity(
    connection: &Connection,
    player_id: PlayerId,
    source: PlayerIdentitySource,
    now: Timestamp,
) -> Result<PlayerIdentity> {
    if let Some(existing) = player_identity(connection)? {
        if existing.player_id != player_id {
            return Err(StateError::InvalidValue("player identity is already set to a different value".into()));
        }
        return Ok(existing);
    }
    connection.execute(
        "INSERT INTO player_identity (id, player_id, source, created_at_ms) VALUES (1, ?1, ?2, ?3)",
        params![player_id.to_string(), source.as_str(), ms(now)],
    )?;
    Ok(PlayerIdentity { player_id, source, created_at: now })
}
