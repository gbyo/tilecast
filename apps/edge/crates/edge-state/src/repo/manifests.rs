//! Server manifests: the target and the prepared stages.
//!
//! * The target ([`put_target`]) is the server's latest valid answer from the
//!   ordinary manifest endpoint. Preparation works only toward it.
//! * `pending` is written only after every object it needs is verified, and
//!   only while it is still the target ([`put_pending_for_target`]); a
//!   preparation that finishes after a newer manifest arrived is discarded.
//! * `active` changes only through [`promote_pending`], after renderer
//!   acceptance and meaningful evidence, and again only while the manifest is
//!   still the target. The former active document moves to `previous` in the
//!   same transaction.
//!
//! A manifest is identified by the SHA-256 of its stable encoding. Every read
//! is bound to the installation, screen and normalized server URL.

use edge_protocol::{InstallationId, ScreenId, Sha256Digest, Timestamp};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::{from_ms, ms};
use crate::{Result, StateError};

const MAX_DOCUMENT_BYTES: usize = 6 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub installation_id: InstallationId,
    pub screen_id: ScreenId,
    pub server_url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredManifest {
    pub binding: Binding,
    /// SHA-256 of the manifest's stable encoding.
    pub digest: Sha256Digest,
    /// The server's manifest version (heartbeat semantics).
    pub version: i64,
    pub document: Value,
    pub stored_at: Timestamp,
}

/// The server's latest valid manifest answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub binding: Binding,
    pub digest: Sha256Digest,
    pub version: i64,
    /// The conditional-request validator for the next fetch.
    pub etag: String,
    pub document: Value,
    pub fetched_at: Timestamp,
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

fn parse_digest(value: &str) -> Result<Sha256Digest> {
    Sha256Digest::parse(value).map_err(|_| StateError::InvalidValue("manifest digest".to_owned()))
}

fn encode(document: &Value) -> Result<String> {
    let text =
        serde_json::to_string(document).map_err(|_| StateError::InvalidValue("manifest serialization".to_owned()))?;
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(StateError::InvalidValue("manifest bound".to_owned()));
    }
    Ok(text)
}

fn decode(text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|_| StateError::InvalidValue("cached manifest document".to_owned()))
}

pub fn get_for(connection: &Connection, stage: Stage, binding: &Binding) -> Result<Option<StoredManifest>> {
    let row: Option<(String, i64, String, i64)> = connection
        .query_row(
            "SELECT digest, version, document, stored_at_ms FROM manifests
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
    row.map(|(digest, version, document, stored_at)| {
        Ok(StoredManifest {
            binding: binding.clone(),
            digest: parse_digest(&digest)?,
            version,
            document: decode(&document)?,
            stored_at: from_ms(stored_at)?,
        })
    })
    .transpose()
}

fn write_stage(connection: &Connection, stage: Stage, manifest: &StoredManifest) -> Result<()> {
    if manifest.version < 0 {
        return Err(StateError::InvalidValue("manifest version".to_owned()));
    }
    connection.execute(
        "INSERT INTO manifests (stage, installation_id, screen_id, server_url, digest, version, document, stored_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (stage) DO UPDATE SET installation_id = excluded.installation_id,
             screen_id = excluded.screen_id, server_url = excluded.server_url, digest = excluded.digest,
             version = excluded.version, document = excluded.document, stored_at_ms = excluded.stored_at_ms",
        params![
            stage.as_str(),
            manifest.binding.installation_id.to_string(),
            manifest.binding.screen_id.to_string(),
            manifest.binding.server_url,
            manifest.digest.to_hex(),
            manifest.version,
            encode(&manifest.document)?,
            ms(manifest.stored_at)
        ],
    )?;
    Ok(())
}

pub fn target(connection: &Connection, binding: &Binding) -> Result<Option<Target>> {
    let row: Option<(String, i64, String, String, i64)> = connection
        .query_row(
            "SELECT digest, version, etag, document, fetched_at_ms FROM manifest_target
             WHERE singleton = 1 AND installation_id = ?1 AND screen_id = ?2 AND server_url = ?3",
            params![binding.installation_id.to_string(), binding.screen_id.to_string(), binding.server_url],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    row.map(|(digest, version, etag, document, fetched_at)| {
        Ok(Target {
            binding: binding.clone(),
            digest: parse_digest(&digest)?,
            version,
            etag,
            document: decode(&document)?,
            fetched_at: from_ms(fetched_at)?,
        })
    })
    .transpose()
}

/// Records the server's latest valid manifest. A lower version than the
/// committed presentation is refused: the server never moves a screen's
/// manifest version backwards.
pub fn put_target(connection: &mut Connection, target: &Target) -> Result<()> {
    if target.etag.len() > 200 || target.version < 0 {
        return Err(StateError::InvalidValue("manifest target bound".to_owned()));
    }
    let tx = connection.transaction()?;
    if get_for(&tx, Stage::Active, &target.binding)?.is_some_and(|active| target.version < active.version) {
        return Err(StateError::InvalidValue("manifest version regressed".to_owned()));
    }
    tx.execute(
        "INSERT INTO manifest_target (singleton, installation_id, screen_id, server_url, digest, version, etag,
             document, fetched_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (singleton) DO UPDATE SET installation_id = excluded.installation_id,
             screen_id = excluded.screen_id, server_url = excluded.server_url, digest = excluded.digest,
             version = excluded.version, etag = excluded.etag, document = excluded.document,
             fetched_at_ms = excluded.fetched_at_ms",
        params![
            target.binding.installation_id.to_string(),
            target.binding.screen_id.to_string(),
            target.binding.server_url,
            target.digest.to_hex(),
            target.version,
            target.etag,
            encode(&target.document)?,
            ms(target.fetched_at)
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// Stores a prepared manifest as pending only while it is still the target.
/// Returns false (and writes nothing) when a newer manifest superseded it
/// during preparation.
pub fn put_pending_for_target(connection: &mut Connection, manifest: &StoredManifest) -> Result<bool> {
    let tx = connection.transaction()?;
    if target(&tx, &manifest.binding)?.map(|target| target.digest) != Some(manifest.digest) {
        return Ok(false);
    }
    if get_for(&tx, Stage::Active, &manifest.binding)?.is_some_and(|active| manifest.version < active.version) {
        return Err(StateError::InvalidValue("manifest version regressed".to_owned()));
    }
    write_stage(&tx, Stage::Pending, manifest)?;
    tx.commit()?;
    Ok(true)
}

/// Drops a pending manifest that is no longer the target.
pub fn discard_pending(connection: &Connection, binding: &Binding, digest: &Sha256Digest) -> Result<bool> {
    let changed = connection.execute(
        "DELETE FROM manifests WHERE stage = 'pending' AND installation_id = ?1 AND screen_id = ?2
             AND server_url = ?3 AND digest = ?4",
        params![
            binding.installation_id.to_string(),
            binding.screen_id.to_string(),
            binding.server_url,
            digest.to_hex()
        ],
    )?;
    Ok(changed > 0)
}

/// Atomic pending-to-active transition for exactly `digest`, allowed only
/// while that manifest is still the target. A renderer transition still
/// needs its own acknowledgement and CAS pin drain before `previous` may be
/// released.
pub fn promote_pending(connection: &mut Connection, binding: &Binding, digest: &Sha256Digest) -> Result<bool> {
    let tx = connection.transaction()?;
    let Some(pending) = get_for(&tx, Stage::Pending, binding)? else { return Ok(false) };
    if pending.digest != *digest || target(&tx, binding)?.map(|target| target.digest) != Some(*digest) {
        return Ok(false);
    }
    if let Some(active) = get_for(&tx, Stage::Active, binding)? {
        write_stage(&tx, Stage::Previous, &active)?;
    } else {
        tx.execute("DELETE FROM manifests WHERE stage = 'previous'", [])?;
    }
    write_stage(&tx, Stage::Active, &pending)?;
    tx.execute("DELETE FROM manifests WHERE stage = 'pending'", [])?;
    tx.commit()?;
    Ok(true)
}
