//! Daemon lifecycle bookkeeping and the node identity.

use edge_protocol::{NodeId, Timestamp};
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
pub enum NodeIdentitySource {
    Generated,
    LegacyImport,
}

impl NodeIdentitySource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Generated => "generated",
            Self::LegacyImport => "legacy_import",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeIdentity {
    pub node_id: NodeId,
    pub source: NodeIdentitySource,
    pub created_at: Timestamp,
}

pub fn node_identity(connection: &Connection) -> Result<Option<NodeIdentity>> {
    let row: Option<(String, String, i64)> = connection
        .query_row("SELECT node_id, source, created_at_ms FROM node_identity WHERE id = 1", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    row.map(|(node_id, source, created)| {
        Ok(NodeIdentity {
            node_id: parse(&node_id, "node_id")?,
            source: match source.as_str() {
                "legacy_import" => NodeIdentitySource::LegacyImport,
                _ => NodeIdentitySource::Generated,
            },
            created_at: from_ms(created)?,
        })
    })
    .transpose()
}

/// Stores the node ID once. The node ID never changes afterwards: setting a
/// different value is an error, because every Edge certificate, peer record
/// and server screen history is keyed by it.
pub fn set_node_identity(
    connection: &Connection,
    node_id: NodeId,
    source: NodeIdentitySource,
    now: Timestamp,
) -> Result<NodeIdentity> {
    if let Some(existing) = node_identity(connection)? {
        if existing.node_id != node_id {
            return Err(StateError::InvalidValue("node identity is already set to a different value".into()));
        }
        return Ok(existing);
    }
    connection.execute(
        "INSERT INTO node_identity (id, node_id, source, created_at_ms) VALUES (1, ?1, ?2, ?3)",
        params![node_id.to_string(), source.as_str(), ms(now)],
    )?;
    Ok(NodeIdentity { node_id, source, created_at: now })
}
