//! Bounded durable outbox for reports to the server.

use edge_protocol::Timestamp;
use rusqlite::{Connection, params};

use super::ms;
use crate::Result;

pub const MAX_ROWS: i64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxKind {
    ActivityEvent,
}

impl OutboxKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::ActivityEvent => "activity_event",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxItem {
    pub id: i64,
    pub dedupe_key: String,
    pub payload: String,
    pub attempts: u32,
}

/// Enqueues a report. A second report with the same `dedupe_key` replaces the
/// first (status documents coalesce). When the outbox is full the oldest
/// rows are dropped and counted.
pub fn enqueue(
    connection: &Connection,
    kind: OutboxKind,
    dedupe_key: &str,
    payload: &str,
    now: Timestamp,
) -> Result<()> {
    connection.execute(
        "INSERT INTO outbox (kind, dedupe_key, payload, created_at_ms, next_attempt_at_ms) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (dedupe_key) DO UPDATE SET payload = excluded.payload, attempts = 0,
             next_attempt_at_ms = excluded.next_attempt_at_ms",
        params![kind.as_str(), dedupe_key, payload, ms(now)],
    )?;
    let dropped = connection.execute(
        "DELETE FROM outbox WHERE id NOT IN (SELECT id FROM outbox ORDER BY id DESC LIMIT ?1)",
        params![MAX_ROWS],
    )?;
    if dropped > 0 {
        connection.execute(
            "INSERT INTO outbox_meta (id, dropped_count) VALUES (1, ?1)
             ON CONFLICT (id) DO UPDATE SET dropped_count = dropped_count + excluded.dropped_count",
            params![dropped as i64],
        )?;
    }
    Ok(())
}

pub fn due(connection: &Connection, kind: OutboxKind, now: Timestamp, limit: usize) -> Result<Vec<OutboxItem>> {
    let mut statement = connection.prepare(
        "SELECT id, dedupe_key, payload, attempts FROM outbox
         WHERE kind = ?1 AND next_attempt_at_ms <= ?2 ORDER BY id ASC LIMIT ?3",
    )?;
    let rows = statement.query_map(params![kind.as_str(), ms(now), limit as i64], |row| {
        Ok(OutboxItem { id: row.get(0)?, dedupe_key: row.get(1)?, payload: row.get(2)?, attempts: row.get(3)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn delivered(connection: &Connection, id: i64) -> Result<()> {
    connection.execute("DELETE FROM outbox WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn retry_later(connection: &Connection, id: i64, next_attempt_at: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE outbox SET attempts = attempts + 1, next_attempt_at_ms = ?2 WHERE id = ?1",
        params![id, ms(next_attempt_at)],
    )?;
    Ok(())
}
