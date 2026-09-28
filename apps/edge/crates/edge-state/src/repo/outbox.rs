//! The bounded durable outbox for Activity events and telemetry samples
//! (migration 0004).

use edge_protocol::Timestamp;
use rusqlite::{Connection, OptionalExtension as _, params};

use super::ms;
use crate::Result;

/// The binding bound (docs/tilecast-edge.md §16).
pub const MAX_ROWS: i64 = 500;
/// The share of the bound telemetry may hold: two hours of samples.
pub const MAX_TELEMETRY_ROWS: i64 = 120;
pub const MAX_BODY_BYTES: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxKind {
    ActivityEvent,
    TelemetrySample,
}

impl OutboxKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ActivityEvent => "activity_event",
            Self::TelemetrySample => "telemetry_sample",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRow {
    pub id: i64,
    pub event_id: String,
    pub body: String,
    pub created_at: i64,
    pub attempts: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OutboxStats {
    pub queued_activity: u64,
    pub queued_telemetry: u64,
    pub dropped_activity: u64,
    pub dropped_telemetry: u64,
    pub rejected: u64,
    pub expired: u64,
}

fn bound(connection: &Connection) -> Result<()> {
    let telemetry = connection.execute(
        "DELETE FROM outbox WHERE kind = 'telemetry_sample' AND id NOT IN
             (SELECT id FROM outbox WHERE kind = 'telemetry_sample' ORDER BY id DESC LIMIT ?1)",
        params![MAX_TELEMETRY_ROWS],
    )?;
    let over: Vec<(i64, String)> = {
        let mut statement = connection
            .prepare("SELECT id, kind FROM outbox WHERE id NOT IN (SELECT id FROM outbox ORDER BY id DESC LIMIT ?1)")?;
        let rows = statement.query_map(params![MAX_ROWS], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let activity = over.iter().filter(|(_, kind)| kind == "activity_event").count() as i64;
    let telemetry = telemetry as i64 + (over.len() as i64 - activity);
    for (id, _) in &over {
        connection.execute("DELETE FROM outbox WHERE id = ?1", params![id])?;
    }
    if activity > 0 || telemetry > 0 {
        connection.execute(
            "UPDATE outbox_state SET dropped_activity = dropped_activity + ?1,
                 dropped_telemetry = dropped_telemetry + ?2 WHERE singleton = 1",
            params![activity, telemetry],
        )?;
    }
    Ok(())
}

/// Enqueues one Activity event. `build` receives the event's sequence,
/// allocated in the same transaction, and returns its JSON body.
pub fn enqueue_activity(
    connection: &mut Connection,
    event_id: &str,
    now: Timestamp,
    build: impl FnOnce(i64) -> String,
) -> Result<i64> {
    let tx = connection.transaction()?;
    let sequence: i64 = tx.query_row("SELECT next_sequence FROM outbox_state WHERE singleton = 1", [], |r| r.get(0))?;
    let body = build(sequence);
    if body.len() > MAX_BODY_BYTES {
        return Err(crate::StateError::InvalidValue("activity event too large".into()));
    }
    tx.execute(
        "UPDATE outbox_state SET next_sequence = next_sequence + 1, updated_at_ms = ?1 WHERE singleton = 1",
        params![ms(now)],
    )?;
    tx.execute(
        "INSERT INTO outbox (kind, event_id, body, created_at_ms) VALUES ('activity_event', ?1, ?2, ?3)",
        params![event_id, body, ms(now)],
    )?;
    bound(&tx)?;
    tx.commit()?;
    Ok(sequence)
}

pub fn enqueue_telemetry(connection: &mut Connection, sample_id: &str, body: &str, now: Timestamp) -> Result<()> {
    if body.len() > MAX_BODY_BYTES {
        return Err(crate::StateError::InvalidValue("telemetry sample too large".into()));
    }
    let tx = connection.transaction()?;
    tx.execute(
        "INSERT INTO outbox (kind, event_id, body, created_at_ms) VALUES ('telemetry_sample', ?1, ?2, ?3)",
        params![sample_id, body, ms(now)],
    )?;
    bound(&tx)?;
    tx.commit()?;
    Ok(())
}

/// The oldest queued reports of one kind.
pub fn pending(connection: &Connection, kind: OutboxKind, limit: usize) -> Result<Vec<OutboxRow>> {
    let mut statement = connection.prepare(
        "SELECT id, event_id, body, created_at_ms, attempts FROM outbox WHERE kind = ?1 ORDER BY id ASC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![kind.as_str(), limit as i64], |row| {
        Ok(OutboxRow {
            id: row.get(0)?,
            event_id: row.get(1)?,
            body: row.get(2)?,
            created_at: row.get(3)?,
            attempts: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The server took these reports (accepted or duplicate).
pub fn delivered(connection: &mut Connection, ids: &[i64]) -> Result<()> {
    let tx = connection.transaction()?;
    for id in ids {
        tx.execute("DELETE FROM outbox WHERE id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(())
}

/// The server refused this report as invalid: it is never sent again.
pub fn rejected(connection: &mut Connection, id: i64) -> Result<()> {
    let tx = connection.transaction()?;
    if tx.execute("DELETE FROM outbox WHERE id = ?1", params![id])? > 0 {
        tx.execute("UPDATE outbox_state SET rejected = rejected + 1 WHERE singleton = 1", [])?;
    }
    tx.commit()?;
    Ok(())
}

/// Removes telemetry samples created before `cutoff` (outside the server's
/// reporting window) and counts them.
pub fn expire_telemetry(connection: &mut Connection, cutoff: Timestamp) -> Result<usize> {
    let tx = connection.transaction()?;
    let removed =
        tx.execute("DELETE FROM outbox WHERE kind = 'telemetry_sample' AND created_at_ms < ?1", params![ms(cutoff)])?;
    if removed > 0 {
        tx.execute("UPDATE outbox_state SET expired = expired + ?1 WHERE singleton = 1", params![removed as i64])?;
    }
    tx.commit()?;
    Ok(removed)
}

pub fn attempted(connection: &Connection, id: i64) -> Result<()> {
    connection.execute("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn stats(connection: &Connection) -> Result<OutboxStats> {
    let count = |kind: &str| -> Result<u64> {
        Ok(connection.query_row("SELECT COUNT(*) FROM outbox WHERE kind = ?1", params![kind], |r| r.get::<_, i64>(0))?
            as u64)
    };
    let (dropped_activity, dropped_telemetry, rejected, expired): (i64, i64, i64, i64) = connection.query_row(
        "SELECT dropped_activity, dropped_telemetry, rejected, expired FROM outbox_state WHERE singleton = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok(OutboxStats {
        queued_activity: count("activity_event")?,
        queued_telemetry: count("telemetry_sample")?,
        dropped_activity: dropped_activity as u64,
        dropped_telemetry: dropped_telemetry as u64,
        rejected: rejected as u64,
        expired: expired as u64,
    })
}

/// Dropped activity events the server has not been told about, marked as
/// told. The caller reports the count in an `outbox.overflow` event.
pub fn take_unreported_drops(connection: &mut Connection) -> Result<u64> {
    let tx = connection.transaction()?;
    let (dropped, reported): (i64, i64) = tx.query_row(
        "SELECT dropped_activity, reported_dropped_activity FROM outbox_state WHERE singleton = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if dropped > reported {
        tx.execute("UPDATE outbox_state SET reported_dropped_activity = dropped_activity WHERE singleton = 1", [])?;
    }
    tx.commit()?;
    Ok(dropped.saturating_sub(reported) as u64)
}

pub fn open_sessions(connection: &Connection) -> Result<Option<String>> {
    Ok(connection
        .query_row("SELECT open_sessions FROM outbox_state WHERE singleton = 1", [], |r| r.get(0))
        .optional()?
        .flatten())
}

pub fn set_open_sessions(connection: &Connection, value: Option<&str>) -> Result<()> {
    if value.is_some_and(|v| v.len() > 16_384) {
        return Err(crate::StateError::InvalidValue("open sessions too large".into()));
    }
    connection.execute("UPDATE outbox_state SET open_sessions = ?1 WHERE singleton = 1", params![value])?;
    Ok(())
}
