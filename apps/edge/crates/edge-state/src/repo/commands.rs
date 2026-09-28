//! Durable player command records (`migrations/0003_commands_and_config.sql`).
//!
//! A record is keyed by the server's `idempotencyKey`, the semantic
//! non-replay key. The delivery `id` that acknowledgement and result reports
//! address is stored beside it and follows the latest delivery.
//!
//! The guarantee is at-most-once local execution with durable non-replay:
//! [`begin_executing`] commits `executing` before the caller enters a
//! handler, and a record found `executing` at start is completed by
//! [`recover_interrupted`] instead of running again. Keys imported from the
//! legacy player's `executed-commands.json` are completed records, so they
//! suppress exactly the commands it had already run.

use edge_protocol::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, ms};
use crate::{Result, StateError};

pub const REPLAY_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
pub const MAX_ROWS: i64 = 5_000;
/// The server's own limits for a result report.
pub const MAX_RESULT_CODE_BYTES: usize = 80;
pub const MAX_RESULT_MESSAGE_BYTES: usize = 240;
pub const INTERRUPTED_CODE: &str = "command_interrupted";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandState {
    Received,
    Acknowledged,
    Executing,
    Completed,
}

impl CommandState {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "received" => Ok(Self::Received),
            "acknowledged" => Ok(Self::Acknowledged),
            "executing" => Ok(Self::Executing),
            "completed" => Ok(Self::Completed),
            other => Err(StateError::InvalidValue(format!("command state {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportState {
    None,
    Pending,
    Reported,
    Abandoned,
    NotRequired,
}

impl ReportState {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "none" => Ok(Self::None),
            "pending" => Ok(Self::Pending),
            "reported" => Ok(Self::Reported),
            "abandoned" => Ok(Self::Abandoned),
            "not_required" => Ok(Self::NotRequired),
            other => Err(StateError::InvalidValue(format!("command report state {other}"))),
        }
    }
}

/// A terminal command result, bounded to what the server accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub success: bool,
    pub code: String,
    pub message: String,
}

impl CommandResult {
    /// Builds a result, truncating code and message on character boundaries
    /// to the server's byte limits. An empty code becomes `command_failed`.
    pub fn new(success: bool, code: &str, message: &str) -> Self {
        let code = truncate_bytes(code, MAX_RESULT_CODE_BYTES);
        Self {
            success,
            code: if code.is_empty() { "command_failed".to_owned() } else { code },
            message: truncate_bytes(message, MAX_RESULT_MESSAGE_BYTES),
        }
    }

    pub fn ok(code: &str, message: &str) -> Self {
        Self::new(true, code, message)
    }

    pub fn failed(code: &str, message: &str) -> Self {
        Self::new(false, code, message)
    }
}

pub fn truncate_bytes(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRecord {
    pub idempotency_key: String,
    pub command_id: Option<String>,
    pub command_type: String,
    pub state: CommandState,
    pub result: Option<CommandResult>,
    pub report_state: ReportState,
    pub received_at: Timestamp,
    pub completed_at: Option<Timestamp>,
}

const COLUMNS: &str = "idempotency_key, command_id, command_type, state, success, result_code, result_message,
                       report_state, received_at_ms, completed_at_ms";

type Row =
    (String, Option<String>, String, String, Option<i64>, Option<String>, Option<String>, String, i64, Option<i64>);

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

fn record(row: Row) -> Result<CommandRecord> {
    let (key, command_id, command_type, state, success, code, message, report_state, received, completed) = row;
    let result = match (success, code) {
        (Some(success), Some(code)) => {
            Some(CommandResult { success: success == 1, code, message: message.unwrap_or_default() })
        }
        _ => None,
    };
    Ok(CommandRecord {
        idempotency_key: key,
        command_id,
        command_type,
        state: CommandState::parse(&state)?,
        result,
        report_state: ReportState::parse(&report_state)?,
        received_at: from_ms(received)?,
        completed_at: completed.map(from_ms).transpose()?,
    })
}

pub fn get(connection: &Connection, idempotency_key: &str) -> Result<Option<CommandRecord>> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM player_commands WHERE idempotency_key = ?1"),
            params![idempotency_key],
            read_row,
        )
        .optional()?
        .map(record)
        .transpose()
}

/// Records a delivery. A new key is inserted as `received`. An existing
/// record keeps its state; its delivery ID moves to this delivery so the
/// next acknowledgement or result report addresses what the server is
/// currently offering. A completed record whose result has not reached this
/// delivery becomes `pending` again, so the stored result is resent to it.
pub fn observe(
    connection: &Connection,
    idempotency_key: &str,
    command_id: &str,
    command_type: &str,
    now: Timestamp,
) -> Result<CommandRecord> {
    connection.execute(
        "INSERT OR IGNORE INTO player_commands (idempotency_key, command_id, command_type, state, report_state,
                                                received_at_ms)
         VALUES (?1, ?2, ?3, 'received', 'none', ?4)",
        params![idempotency_key, command_id, command_type, ms(now)],
    )?;
    connection.execute(
        "UPDATE player_commands SET
             report_state = CASE WHEN state = 'completed' THEN 'pending' ELSE report_state END,
             command_id = ?2
         WHERE idempotency_key = ?1",
        params![idempotency_key, command_id],
    )?;
    get(connection, idempotency_key)?.ok_or_else(|| StateError::InvalidValue("command record vanished".into()))
}

pub fn mark_acknowledged(connection: &Connection, idempotency_key: &str, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE player_commands SET state = 'acknowledged', acknowledged_at_ms = ?2
         WHERE idempotency_key = ?1 AND state = 'received'",
        params![idempotency_key, ms(now)],
    )?;
    Ok(())
}

/// Moves a record that has not started into `executing`. Returns whether it
/// moved; only then may the caller enter the handler. The statement commits
/// before it returns (autocommit with `synchronous = FULL`).
pub fn begin_executing(connection: &Connection, idempotency_key: &str, now: Timestamp) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE player_commands SET state = 'executing', executing_at_ms = ?2
         WHERE idempotency_key = ?1 AND state IN ('received', 'acknowledged')",
        params![idempotency_key, ms(now)],
    )?;
    Ok(changed == 1)
}

/// Stores a terminal result. Allowed from any unfinished state: from
/// `executing` after a handler, or from `received`/`acknowledged` for a
/// command that is settled without running (invalid, not actionable). The
/// result becomes `pending` for the server unless `report` says otherwise.
/// A completed record is never overwritten.
pub fn complete(
    connection: &Connection,
    idempotency_key: &str,
    result: &CommandResult,
    report: ReportState,
    now: Timestamp,
) -> Result<bool> {
    let report = match report {
        ReportState::NotRequired => "not_required",
        ReportState::Reported => "reported",
        ReportState::Abandoned => "abandoned",
        ReportState::None | ReportState::Pending => "pending",
    };
    let result = CommandResult::new(result.success, &result.code, &result.message);
    let changed = connection.execute(
        "UPDATE player_commands SET state = 'completed', success = ?2, result_code = ?3, result_message = ?4,
             report_state = ?5, completed_at_ms = ?6
         WHERE idempotency_key = ?1 AND state <> 'completed'",
        params![idempotency_key, i64::from(result.success), result.code, result.message, report, ms(now)],
    )?;
    Ok(changed == 1)
}

/// The server took the result for `command_id`. A later delivery under a
/// different ID has moved the record on and keeps it pending.
pub fn mark_reported(connection: &Connection, idempotency_key: &str, command_id: &str, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE player_commands SET report_state = 'reported', reported_at_ms = ?3
         WHERE idempotency_key = ?1 AND command_id = ?2 AND report_state = 'pending'",
        params![idempotency_key, command_id, ms(now)],
    )?;
    Ok(())
}

/// The server can no longer take a result for `command_id` (expired or
/// cancelled). The result is kept; only its delivery stops.
pub fn mark_abandoned(connection: &Connection, idempotency_key: &str, command_id: &str, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE player_commands SET report_state = 'abandoned', reported_at_ms = ?3
         WHERE idempotency_key = ?1 AND command_id = ?2 AND report_state = 'pending'",
        params![idempotency_key, command_id, ms(now)],
    )?;
    Ok(())
}

/// Completed results that still wait for the server, oldest first.
pub fn pending_reports(connection: &Connection, limit: usize) -> Result<Vec<CommandRecord>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM player_commands
         WHERE state = 'completed' AND report_state = 'pending' AND command_id IS NOT NULL
         ORDER BY completed_at_ms ASC LIMIT ?1"
    ))?;
    let rows = statement.query_map(params![limit as i64], read_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(record).collect()
}

/// Settles every record a previous run left `executing`. Its handler may or
/// may not have had an effect, so it is never run again; the server receives
/// `command_interrupted`. Returns the number of records settled.
pub fn recover_interrupted(connection: &Connection, now: Timestamp) -> Result<usize> {
    Ok(connection.execute(
        "UPDATE player_commands SET state = 'completed', success = 0, result_code = ?1,
             result_message = 'The player stopped while this command was running. It was not run again.',
             report_state = 'pending', completed_at_ms = ?2
         WHERE state = 'executing'",
        params![INTERRUPTED_CODE, ms(now)],
    )?)
}

/// Imports a key the legacy player had already executed. It can never run
/// under Edge; nothing is reported for it unless the server delivers it
/// again.
pub fn import_completed(connection: &Connection, idempotency_key: &str, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT INTO player_commands (idempotency_key, command_id, command_type, state, success,
                                      result_code, result_message, report_state, received_at_ms,
                                      completed_at_ms)
         VALUES (?1, NULL, 'legacy_import', 'completed', 1, 'already_executed',
                 'The command was already executed by this player.', 'not_required', ?2, ?2)
         ON CONFLICT (idempotency_key) DO UPDATE SET
             state = 'completed', success = 1, result_code = 'already_executed',
             result_message = 'The command was already executed by this player.',
             report_state = 'not_required', completed_at_ms = ?2
         WHERE state <> 'completed'",
        params![idempotency_key, ms(now)],
    )?;
    Ok(())
}

/// Removes records that can no longer matter: settled results the server
/// has taken (or never needed) and commands that never started, after the
/// replay window; then the oldest of those beyond [`MAX_ROWS`]. An
/// `executing` record and a result still waiting for the server are never
/// removed.
pub fn prune(connection: &Connection, now: Timestamp) -> Result<usize> {
    const PRUNABLE: &str = "(state IN ('received', 'acknowledged')
                             OR (state = 'completed' AND report_state IN ('reported', 'abandoned', 'not_required')))";
    let mut removed = connection.execute(
        &format!("DELETE FROM player_commands WHERE {PRUNABLE} AND received_at_ms < ?1"),
        params![ms(now) - REPLAY_WINDOW_MS],
    )?;
    removed += connection.execute(
        &format!(
            "DELETE FROM player_commands WHERE idempotency_key IN (
                 SELECT idempotency_key FROM player_commands WHERE {PRUNABLE}
                 ORDER BY received_at_ms ASC
                 LIMIT max(0, (SELECT count(*) FROM player_commands) - ?1))"
        ),
        params![MAX_ROWS],
    )?;
    Ok(removed)
}

pub fn count(connection: &Connection) -> Result<i64> {
    Ok(connection.query_row("SELECT count(*) FROM player_commands", [], |row| row.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn results_are_truncated_on_character_boundaries() {
        let result = CommandResult::failed(&"é".repeat(60), &"ü".repeat(200));
        assert!(result.code.len() <= MAX_RESULT_CODE_BYTES);
        assert!(result.message.len() <= MAX_RESULT_MESSAGE_BYTES);
        assert!(result.code.chars().all(|c| c == 'é'));
        assert_eq!(CommandResult::failed("", "x").code, "command_failed");
    }
}
