//! Command idempotency (ported semantics of the Linux player's
//! `core/commands.ts`). A disruptive command is recorded as `executing`
//! *before* it runs; a restart that finds such a row reports its result
//! instead of running it again.
//!
//! `command_id` holds the server-issued `idempotencyKey` of the command, the
//! same key the legacy player persisted in `executed-commands.json`, so keys
//! imported from a legacy installation suppress exactly the commands it had
//! already run.

use edge_protocol::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};

use super::ms;
use crate::Result;

pub const REPLAY_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandState {
    Received,
    Acknowledged,
    Executing,
    Completed,
}

impl CommandState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Acknowledged => "acknowledged",
            Self::Executing => "executing",
            Self::Completed => "completed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "acknowledged" => Self::Acknowledged,
            "executing" => Self::Executing,
            "completed" => Self::Completed,
            _ => Self::Received,
        }
    }
}

/// Records a command the first time it is seen. Returns the stored state:
/// `Received` for a new command, or whatever state a previous run reached.
pub fn observe(connection: &Connection, command_id: &str, command_type: &str, now: Timestamp) -> Result<CommandState> {
    connection.execute(
        "INSERT OR IGNORE INTO command_idempotency (command_id, command_type, state, received_at_ms)
         VALUES (?1, ?2, 'received', ?3)",
        params![command_id, command_type, ms(now)],
    )?;
    let state: String = connection.query_row(
        "SELECT state FROM command_idempotency WHERE command_id = ?1",
        params![command_id],
        |row| row.get(0),
    )?;
    Ok(CommandState::parse(&state))
}

pub fn advance(
    connection: &Connection,
    command_id: &str,
    state: CommandState,
    result_code: Option<&str>,
    now: Timestamp,
) -> Result<()> {
    let completed = (state == CommandState::Completed).then(|| ms(now));
    connection.execute(
        "UPDATE command_idempotency SET state = ?2, result_code = COALESCE(?3, result_code),
             completed_at_ms = COALESCE(?4, completed_at_ms)
         WHERE command_id = ?1",
        params![command_id, state.as_str(), result_code, completed],
    )?;
    Ok(())
}

pub fn state(connection: &Connection, command_id: &str) -> Result<Option<CommandState>> {
    let value: Option<String> = connection
        .query_row("SELECT state FROM command_idempotency WHERE command_id = ?1", params![command_id], |row| row.get(0))
        .optional()?;
    Ok(value.map(|v| CommandState::parse(&v)))
}

/// Imports a command the legacy player had already settled. Imported keys
/// are `completed` so they can never run again under Edge.
pub fn import_completed(connection: &Connection, command_id: &str, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO command_idempotency (command_id, command_type, state, result_code,
                                                    received_at_ms, completed_at_ms)
         VALUES (?1, 'legacy_import', 'completed', 'imported', ?2, ?2)",
        params![command_id, ms(now)],
    )?;
    Ok(())
}

pub fn prune(connection: &Connection, now: Timestamp) -> Result<usize> {
    Ok(connection.execute(
        "DELETE FROM command_idempotency WHERE state = 'completed' AND received_at_ms < ?1",
        params![ms(now) - REPLAY_WINDOW_MS],
    )?)
}
