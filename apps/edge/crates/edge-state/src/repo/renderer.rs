//! Renderer supervision state. Written on events that matter (ready,
//! restart, safe-mode transitions); progress time is flushed on a cadence by
//! the supervisor, never per progress event.

use edge_protocol::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms_opt, ms};
use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RendererRecord {
    pub last_ready_at: Option<Timestamp>,
    pub last_progress_at: Option<Timestamp>,
    pub restart_count: u64,
    pub last_error_code: Option<String>,
    pub safe_mode: bool,
    pub safe_mode_reason: Option<String>,
}

pub fn get(connection: &Connection) -> Result<RendererRecord> {
    type Row = (Option<i64>, Option<i64>, i64, Option<String>, i64, Option<String>);
    let row: Option<Row> = connection
        .query_row(
            "SELECT last_ready_at_ms, last_progress_at_ms, restart_count, last_error_code, safe_mode, safe_mode_reason
             FROM renderer_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()?;
    match row {
        None => Ok(RendererRecord::default()),
        Some((ready, progress, restarts, error, safe, reason)) => Ok(RendererRecord {
            last_ready_at: from_ms_opt(ready)?,
            last_progress_at: from_ms_opt(progress)?,
            restart_count: restarts as u64,
            last_error_code: error,
            safe_mode: safe == 1,
            safe_mode_reason: reason,
        }),
    }
}

pub fn put(connection: &Connection, record: &RendererRecord, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT INTO renderer_state (id, last_ready_at_ms, last_progress_at_ms, restart_count, last_error_code,
                                     safe_mode, safe_mode_reason, updated_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET
             last_ready_at_ms = excluded.last_ready_at_ms,
             last_progress_at_ms = excluded.last_progress_at_ms,
             restart_count = excluded.restart_count,
             last_error_code = excluded.last_error_code,
             safe_mode = excluded.safe_mode,
             safe_mode_reason = excluded.safe_mode_reason,
             updated_at_ms = excluded.updated_at_ms",
        params![
            record.last_ready_at.map(ms),
            record.last_progress_at.map(ms),
            record.restart_count as i64,
            record.last_error_code,
            i64::from(record.safe_mode),
            record.safe_mode_reason,
            ms(now),
        ],
    )?;
    Ok(())
}
