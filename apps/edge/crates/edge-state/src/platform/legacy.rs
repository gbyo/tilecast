//! Bookkeeping for the one-time legacy Linux Player import.

use edge_protocol::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, from_ms_opt, ms};
use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportState {
    Started,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRecord {
    pub importer_version: u32,
    pub state: ImportState,
    pub source_dir: String,
    pub started_at: Timestamp,
    pub completed_at: Option<Timestamp>,
    pub failure_code: Option<String>,
    pub summary: serde_json::Value,
}

pub fn get(connection: &Connection) -> Result<Option<ImportRecord>> {
    type Row = (u32, String, String, i64, Option<i64>, Option<String>, String);
    let row: Option<Row> = connection
        .query_row(
            "SELECT importer_version, state, source_dir, started_at_ms, completed_at_ms, failure_code, summary
             FROM legacy_import WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()?;
    row.map(|(version, state, source, started, completed, failure, summary)| {
        Ok(ImportRecord {
            importer_version: version,
            state: match state.as_str() {
                "completed" => ImportState::Completed,
                "failed" => ImportState::Failed,
                _ => ImportState::Started,
            },
            source_dir: source,
            started_at: from_ms(started)?,
            completed_at: from_ms_opt(completed)?,
            failure_code: failure,
            summary: serde_json::from_str(&summary).unwrap_or(serde_json::Value::Null),
        })
    })
    .transpose()
}

pub fn begin(connection: &Connection, version: u32, source_dir: &str, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT INTO legacy_import (id, importer_version, state, source_dir, started_at_ms)
         VALUES (1, ?1, 'started', ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET importer_version = excluded.importer_version, state = 'started',
             source_dir = excluded.source_dir, started_at_ms = excluded.started_at_ms,
             completed_at_ms = NULL, failure_code = NULL",
        params![version, source_dir, ms(now)],
    )?;
    Ok(())
}

pub fn complete(connection: &Connection, summary: &serde_json::Value, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE legacy_import SET state = 'completed', completed_at_ms = ?1, summary = ?2 WHERE id = 1",
        params![ms(now), summary.to_string()],
    )?;
    Ok(())
}

pub fn fail(connection: &Connection, code: &str, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE legacy_import SET state = 'failed', completed_at_ms = ?1, failure_code = ?2 WHERE id = 1",
        params![ms(now), code],
    )?;
    Ok(())
}
