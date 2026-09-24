//! Accepted player configuration (`migrations/0003_commands_and_config.sql`).
//!
//! `current` is the last accepted document and `previous` the one it
//! replaced. [`accept`] promotes a document in one transaction and only at a
//! strictly greater revision than `current` under the same binding, so a
//! stale or replayed answer can never replace newer configuration. Every read
//! is bound to the installation, screen and normalized server URL; rows for
//! another binding are invisible and are replaced on the first acceptance.

use edge_protocol::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::manifests::Binding;
use super::{from_ms, from_ms_opt, ms};
use crate::{Result, StateError};

/// Far above a real configuration document (a few KiB); matches the
/// server client's response bound.
pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigStage {
    Current,
    Previous,
}

impl ConfigStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Previous => "previous",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredConfig {
    pub binding: Binding,
    pub schema_version: i64,
    pub revision: i64,
    pub etag: Option<String>,
    pub document: Value,
    pub accepted_at: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptOutcome {
    Accepted,
    /// `current` under this binding is at the same or a newer revision.
    NotNewer {
        current_revision: i64,
    },
}

fn encode(document: &Value) -> Result<String> {
    let text =
        serde_json::to_string(document).map_err(|_| StateError::InvalidValue("config serialization".to_owned()))?;
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(StateError::InvalidValue("config bound".to_owned()));
    }
    Ok(text)
}

pub fn get_for(connection: &Connection, stage: ConfigStage, binding: &Binding) -> Result<Option<StoredConfig>> {
    type Row = (i64, i64, Option<String>, String, i64);
    let row: Option<Row> = connection
        .query_row(
            "SELECT schema_version, config_revision, etag, document, accepted_at_ms FROM player_config
             WHERE stage = ?1 AND installation_id = ?2 AND screen_id = ?3 AND server_url = ?4",
            params![
                stage.as_str(),
                binding.installation_id.to_string(),
                binding.screen_id.to_string(),
                binding.server_url
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    row.map(|(schema_version, revision, etag, document, accepted)| {
        Ok(StoredConfig {
            binding: binding.clone(),
            schema_version,
            revision,
            etag,
            document: serde_json::from_str(&document)
                .map_err(|_| StateError::InvalidValue("stored config document".to_owned()))?,
            accepted_at: from_ms(accepted)?,
        })
    })
    .transpose()
}

/// Promotes a validated document to `current`, moving the former `current`
/// of the same binding to `previous`. Refuses a revision that is not
/// strictly greater than `current`'s.
pub fn accept(
    connection: &mut Connection,
    binding: &Binding,
    schema_version: i64,
    revision: i64,
    etag: Option<&str>,
    document: &Value,
    now: Timestamp,
) -> Result<AcceptOutcome> {
    let encoded = encode(document)?;
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some(current) = get_for(&transaction, ConfigStage::Current, binding)?
        && current.revision >= revision
    {
        return Ok(AcceptOutcome::NotNewer { current_revision: current.revision });
    }
    let (installation, screen) = (binding.installation_id.to_string(), binding.screen_id.to_string());
    // Rows of another binding are never promoted to `previous`: they
    // describe a different screen.
    transaction.execute(
        "DELETE FROM player_config WHERE NOT (installation_id = ?1 AND screen_id = ?2 AND server_url = ?3)",
        params![installation, screen, binding.server_url],
    )?;
    transaction.execute("DELETE FROM player_config WHERE stage = 'previous'", [])?;
    transaction.execute("UPDATE player_config SET stage = 'previous', etag = NULL WHERE stage = 'current'", [])?;
    transaction.execute(
        "INSERT INTO player_config (stage, installation_id, screen_id, server_url, schema_version, config_revision,
                                    etag, document, accepted_at_ms)
         VALUES ('current', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![installation, screen, binding.server_url, schema_version, revision, etag, encoded, ms(now)],
    )?;
    transaction.commit()?;
    Ok(AcceptOutcome::Accepted)
}

/// Records the validator the server sent for the revision already current.
/// The document is not touched.
pub fn set_current_etag(connection: &Connection, binding: &Binding, revision: i64, etag: &str) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE player_config SET etag = ?5
         WHERE stage = 'current' AND installation_id = ?1 AND screen_id = ?2 AND server_url = ?3
           AND config_revision = ?4",
        params![binding.installation_id.to_string(), binding.screen_id.to_string(), binding.server_url, revision, etag],
    )?;
    Ok(changed == 1)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConfigStatus {
    pub last_fetched_at: Option<Timestamp>,
    pub last_error_code: Option<String>,
    pub last_error_at: Option<Timestamp>,
}

pub fn status(connection: &Connection) -> Result<ConfigStatus> {
    let row: Option<(Option<i64>, Option<String>, Option<i64>)> = connection
        .query_row(
            "SELECT last_fetched_at_ms, last_error_code, last_error_at_ms FROM player_config_status WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match row {
        None => Ok(ConfigStatus::default()),
        Some((fetched, code, error_at)) => Ok(ConfigStatus {
            last_fetched_at: from_ms_opt(fetched)?,
            last_error_code: code,
            last_error_at: from_ms_opt(error_at)?,
        }),
    }
}

/// Records one reconciliation outcome: `error` is `None` after a successful
/// fetch (modified or not) and a bounded reason code otherwise.
pub fn record_outcome(connection: &Connection, error: Option<&str>, now: Timestamp) -> Result<()> {
    let error = error.map(|code| super::commands::truncate_bytes(code, 64));
    connection.execute(
        "INSERT INTO player_config_status (id, last_fetched_at_ms, last_error_code, last_error_at_ms, updated_at_ms)
         VALUES (1, CASE WHEN ?1 IS NULL THEN ?2 END, ?1, CASE WHEN ?1 IS NULL THEN NULL ELSE ?2 END, ?2)
         ON CONFLICT (id) DO UPDATE SET
             last_fetched_at_ms = CASE WHEN excluded.last_error_code IS NULL THEN excluded.updated_at_ms
                                       ELSE last_fetched_at_ms END,
             last_error_code = excluded.last_error_code,
             last_error_at_ms = excluded.last_error_at_ms,
             updated_at_ms = excluded.updated_at_ms",
        params![error, ms(now)],
    )?;
    Ok(())
}
