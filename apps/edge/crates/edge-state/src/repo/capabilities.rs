//! The current capability snapshot. Never history (RFC §21.3).

use edge_protocol::Timestamp;
use edge_protocol::capability::{Capability, CapabilitySnapshot};
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, ms};
use crate::{Result, StateError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCapabilities {
    pub snapshot: CapabilitySnapshot,
    /// Last revision the server acknowledged.
    pub reported_revision: u64,
}

pub fn load(connection: &Connection) -> Result<Option<StoredCapabilities>> {
    let meta: Option<(i64, i64, i64)> = connection
        .query_row("SELECT revision, reported_revision, updated_at_ms FROM capability_meta WHERE id = 1", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    let Some((revision, reported, updated)) = meta else {
        return Ok(None);
    };
    let mut statement = connection.prepare("SELECT document FROM capability_state ORDER BY capability_id")?;
    let capabilities = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|row| serde_json::from_str::<Capability>(&row?).map_err(|e| StateError::InvalidValue(e.to_string())))
        .collect::<Result<Vec<_>>>()?;
    let snapshot = CapabilitySnapshot::new(revision as u64, from_ms(updated)?, capabilities)
        .map_err(|e| StateError::InvalidValue(e.to_string()))?;
    Ok(Some(StoredCapabilities { snapshot, reported_revision: reported as u64 }))
}

/// Stores `capabilities` as the current set. The revision increases only
/// when the set differs materially from what is stored. Returns the stored
/// snapshot and whether the revision changed.
pub fn replace(
    connection: &mut Connection,
    capabilities: Vec<Capability>,
    now: Timestamp,
) -> Result<(CapabilitySnapshot, bool)> {
    let previous = load(connection)?;
    let mut next =
        CapabilitySnapshot::new(0, now, capabilities).map_err(|e| StateError::InvalidValue(e.to_string()))?;
    let (revision, changed) = match &previous {
        Some(stored) if !CapabilitySnapshot::materially_differs(&stored.snapshot.capabilities, &next.capabilities) => {
            (stored.snapshot.revision, false)
        }
        Some(stored) => (stored.snapshot.revision + 1, true),
        None => (1, true),
    };
    next.revision = revision;
    let tx = connection.transaction()?;
    tx.execute("DELETE FROM capability_state", [])?;
    for capability in &next.capabilities {
        let document = serde_json::to_string(capability).map_err(|e| StateError::InvalidValue(e.to_string()))?;
        tx.execute(
            "INSERT INTO capability_state (capability_id, document, changed_at_ms) VALUES (?1, ?2, ?3)",
            params![capability.id.as_str(), document, ms(now)],
        )?;
    }
    tx.execute(
        "INSERT INTO capability_meta (id, revision, reported_revision, updated_at_ms) VALUES (1, ?1, 0, ?2)
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, updated_at_ms = excluded.updated_at_ms",
        params![revision as i64, ms(now)],
    )?;
    tx.commit()?;
    Ok((next, changed))
}

pub fn mark_reported(connection: &Connection, revision: u64) -> Result<()> {
    connection.execute(
        "UPDATE capability_meta SET reported_revision = MAX(reported_revision, ?1) WHERE id = 1",
        params![revision as i64],
    )?;
    Ok(())
}
