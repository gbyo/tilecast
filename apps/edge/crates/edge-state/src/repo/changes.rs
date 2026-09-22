//! Signed change feed position and retained envelopes.
//!
//! The position is advanced only through [`record_applied`], in the same
//! transaction that stores the envelope, so a restart never re-applies or
//! skips a change. See `edge_protocol::signed::change` for chain semantics.

use edge_protocol::signed::change::{ChainPosition, VerifiedChange};
use edge_protocol::{Sha256Digest, Timestamp};
use rusqlite::{Connection, OptionalExtension, params};

use super::{ms, parse};
use crate::Result;

/// Retention bounds for stored envelopes.
pub const MAX_RETAINED_CHANGES: i64 = 5_000;
pub const RETENTION_MS: i64 = 14 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeedState {
    pub position: ChainPosition,
    pub highest_seen_sequence: u64,
}

pub fn feed_state(connection: &Connection) -> Result<Option<FeedState>> {
    let row: Option<(i64, i64)> = connection
        .query_row("SELECT last_sequence, highest_seen_sequence FROM change_feed_state WHERE id = 1", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    Ok(row.map(|(last, highest)| FeedState {
        position: ChainPosition { last_sequence: last as u64 },
        highest_seen_sequence: highest as u64,
    }))
}

/// Establishes the feed baseline from an authoritative server read. Never
/// call with a sequence learned from a peer. Does nothing if a baseline at or
/// beyond `sequence` already exists.
pub fn set_baseline(connection: &Connection, sequence: u64, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT INTO change_feed_state (id, last_sequence, highest_seen_sequence, updated_at_ms)
         VALUES (1, ?1, ?1, ?2)
         ON CONFLICT (id) DO UPDATE SET
             last_sequence = MAX(last_sequence, excluded.last_sequence),
             highest_seen_sequence = MAX(highest_seen_sequence, excluded.highest_seen_sequence),
             updated_at_ms = excluded.updated_at_ms",
        params![sequence as i64, ms(now)],
    )?;
    Ok(())
}

pub fn note_seen(connection: &Connection, sequence: u64, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE change_feed_state SET highest_seen_sequence = MAX(highest_seen_sequence, ?1), updated_at_ms = ?2
         WHERE id = 1",
        params![sequence as i64, ms(now)],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied,
    Expired,
    UnknownType,
    NotApplicable,
}

impl ApplyOutcome {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Expired => "expired",
            Self::UnknownType => "unknown_type",
            Self::NotApplicable => "not_applicable",
        }
    }
}

/// Stores `change` and advances the position to it, atomically. The caller
/// must have classified the change as `ChainDecision::Next` against the
/// stored position; this function re-checks and refuses otherwise.
pub fn record_applied(
    connection: &mut Connection,
    change: &VerifiedChange,
    received_from: &str,
    outcome: ApplyOutcome,
    now: Timestamp,
) -> Result<bool> {
    let tx = connection.transaction()?;
    let last: Option<i64> =
        tx.query_row("SELECT last_sequence FROM change_feed_state WHERE id = 1", [], |row| row.get(0)).optional()?;
    if last != Some(change.body.previous_sequence as i64) {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO server_changes (sequence, previous_sequence, change_type, body_digest, document,
                                     received_from, received_at_ms, applied_at_ms, outcome)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
        params![
            change.body.sequence as i64,
            change.body.previous_sequence as i64,
            change.body.change_type.as_str(),
            change.body_digest.to_hex(),
            change.document.to_json_bytes(),
            received_from,
            ms(now),
            outcome.as_str(),
        ],
    )?;
    tx.execute(
        "UPDATE change_feed_state SET last_sequence = ?1,
             highest_seen_sequence = MAX(highest_seen_sequence, ?1), updated_at_ms = ?2 WHERE id = 1",
        params![change.body.sequence as i64, ms(now)],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Digest stored for `sequence`, for duplicate/conflict detection.
pub fn stored_digest(connection: &Connection, sequence: u64) -> Result<Option<Sha256Digest>> {
    let value: Option<String> = connection
        .query_row("SELECT body_digest FROM server_changes WHERE sequence = ?1", params![sequence as i64], |row| {
            row.get(0)
        })
        .optional()?;
    value.map(|v| parse(&v, "body_digest")).transpose()
}

/// Stored envelopes after `after`, in order, for relaying to a peer.
pub fn documents_after(connection: &Connection, after: u64, limit: usize) -> Result<Vec<Vec<u8>>> {
    let mut statement =
        connection.prepare("SELECT document FROM server_changes WHERE sequence > ?1 ORDER BY sequence ASC LIMIT ?2")?;
    let rows = statement.query_map(params![after as i64, limit as i64], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<Vec<u8>>>>()?)
}

/// Enforces the retention bounds.
pub fn prune(connection: &Connection, now: Timestamp) -> Result<usize> {
    let by_age =
        connection.execute("DELETE FROM server_changes WHERE received_at_ms < ?1", params![ms(now) - RETENTION_MS])?;
    let by_count = connection.execute(
        "DELETE FROM server_changes WHERE sequence NOT IN (
             SELECT sequence FROM server_changes ORDER BY sequence DESC LIMIT ?1)",
        params![MAX_RETAINED_CHANGES],
    )?;
    Ok(by_age + by_count)
}
