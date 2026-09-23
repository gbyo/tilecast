//! Cached server manifests. The active document survives failed preparation;
//! promotion moves it to `previous` in the same SQLite transaction.

use edge_protocol::{InstallationId, ScreenId, Timestamp};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::{from_ms, ms};
use crate::{Result, StateError};

const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub installation_id: InstallationId,
    pub screen_id: ScreenId,
    pub server_url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredManifest {
    pub binding: Binding,
    pub version: i64,
    pub etag: String,
    pub document: Value,
    pub stored_at: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Pending,
    Active,
    Previous,
}

impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Previous => "previous",
        }
    }
}

pub fn get_for(connection: &Connection, stage: Stage, binding: &Binding) -> Result<Option<StoredManifest>> {
    let row: Option<(i64, String, String, i64)> = connection
        .query_row(
            "SELECT version, etag, document, stored_at_ms FROM manifests
             WHERE stage = ?1 AND installation_id = ?2 AND screen_id = ?3 AND server_url = ?4",
            params![
                stage.as_str(),
                binding.installation_id.to_string(),
                binding.screen_id.to_string(),
                binding.server_url
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    row.map(|(version, etag, document, stored_at)| {
        let document = serde_json::from_str(&document)
            .map_err(|_| StateError::InvalidValue("cached manifest document".to_owned()))?;
        Ok(StoredManifest { binding: binding.clone(), version, etag, document, stored_at: from_ms(stored_at)? })
    })
    .transpose()
}

fn write_stage(connection: &Connection, stage: Stage, manifest: &StoredManifest) -> Result<()> {
    let document = serde_json::to_string(&manifest.document)
        .map_err(|_| StateError::InvalidValue("manifest serialization".to_owned()))?;
    if manifest.version < 0 || manifest.etag.len() > 200 || document.len() > MAX_DOCUMENT_BYTES {
        return Err(StateError::InvalidValue("manifest bound".to_owned()));
    }
    connection.execute(
        "INSERT INTO manifests (stage, installation_id, screen_id, server_url, version, etag, document, stored_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (stage) DO UPDATE SET installation_id = excluded.installation_id,
             screen_id = excluded.screen_id, server_url = excluded.server_url,
             version = excluded.version, etag = excluded.etag,
             document = excluded.document, stored_at_ms = excluded.stored_at_ms",
        params![
            stage.as_str(),
            manifest.binding.installation_id.to_string(),
            manifest.binding.screen_id.to_string(),
            manifest.binding.server_url,
            manifest.version,
            manifest.etag,
            document,
            ms(manifest.stored_at)
        ],
    )?;
    Ok(())
}

/// Store only after CAS preparation succeeded. A stale server response cannot
/// replace a newer active manifest from the same binding.
pub fn put_pending(connection: &Connection, manifest: &StoredManifest) -> Result<()> {
    if get_for(connection, Stage::Active, &manifest.binding)?.is_some_and(|active| manifest.version < active.version) {
        return Err(StateError::InvalidValue("manifest version regressed".to_owned()));
    }
    write_stage(connection, Stage::Pending, manifest)
}

/// Atomic pending-to-active transition. A renderer transition still needs its
/// own acknowledgement and CAS pin drain before `previous` may be released.
pub fn promote_pending(connection: &Connection, binding: &Binding, version: i64) -> Result<bool> {
    let Some(pending) = get_for(connection, Stage::Pending, binding)? else { return Ok(false) };
    if pending.version != version {
        return Ok(false);
    }
    connection.execute_batch("SAVEPOINT promote_manifest")?;
    let result = (|| {
        if let Some(active) = get_for(connection, Stage::Active, binding)? {
            write_stage(connection, Stage::Previous, &active)?;
        } else {
            connection.execute("DELETE FROM manifests WHERE stage = 'previous'", [])?;
        }
        write_stage(connection, Stage::Active, &pending)?;
        connection.execute("DELETE FROM manifests WHERE stage = 'pending'", [])?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            connection.execute_batch("RELEASE promote_manifest")?;
            Ok(true)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK TO promote_manifest; RELEASE promote_manifest");
            Err(error)
        }
    }
}
