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
//! * The activation trial ([`trial`]) records the pending manifest's trial
//!   outcome so that a restart neither forgets a failure nor retries a
//!   manifest that ended the process during its trial at once.
//!
//! The target is the server's latest answer even when its version is lower
//! than the committed one: a restored server database moves the version
//! counter back, and the player must converge to it without another change.
//!
//! A manifest is identified by the SHA-256 of its stable encoding. Every read
//! is bound to the installation, screen and normalized server URL.

use player_types::{InstallationId, ScreenId, Sha256Digest, Timestamp};
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

/// Records the server's latest valid manifest. The digest, not the version,
/// identifies it: a lower version than the committed presentation is still
/// the server's current answer (for example after a database restore).
pub fn put_target(connection: &mut Connection, target: &Target) -> Result<bool> {
    if target.etag.len() > 200 || target.version < 0 {
        return Err(StateError::InvalidValue("manifest target bound".to_owned()));
    }
    let tx = connection.transaction()?;
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
    Ok(true)
}

/// Stores a prepared manifest as pending only while it is still the target.
/// Returns false (and writes nothing) when a newer manifest superseded it
/// during preparation.
pub fn put_pending_for_target(connection: &mut Connection, manifest: &StoredManifest) -> Result<bool> {
    let tx = connection.transaction()?;
    if target(&tx, &manifest.binding)?.map(|target| target.digest) != Some(manifest.digest) {
        return Ok(false);
    }
    write_stage(&tx, Stage::Pending, manifest)?;
    tx.execute("DELETE FROM activation_trial WHERE digest != ?1", params![manifest.digest.to_hex()])?;
    tx.commit()?;
    Ok(true)
}

/// Drops a pending manifest that is no longer the target, with its trial.
pub fn discard_pending(connection: &mut Connection, binding: &Binding, digest: &Sha256Digest) -> Result<bool> {
    let tx = connection.transaction()?;
    let changed = tx.execute(
        "DELETE FROM manifests WHERE stage = 'pending' AND installation_id = ?1 AND screen_id = ?2
             AND server_url = ?3 AND digest = ?4",
        params![
            binding.installation_id.to_string(),
            binding.screen_id.to_string(),
            binding.server_url,
            digest.to_hex()
        ],
    )?;
    tx.execute("DELETE FROM activation_trial WHERE digest = ?1", params![digest.to_hex()])?;
    tx.commit()?;
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
    tx.execute("DELETE FROM activation_trial", [])?;
    tx.commit()?;
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrialState {
    /// Known, not on screen: never started, or suspended by a policy surface.
    Idle,
    /// On screen and awaiting acceptance and content evidence.
    Running,
    /// Failed; held back until `retry_at`.
    Failed,
}

impl TrialState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "idle" => Ok(Self::Idle),
            "running" => Ok(Self::Running),
            "failed" => Ok(Self::Failed),
            _ => Err(StateError::InvalidValue("activation trial state".to_owned())),
        }
    }
}

/// The pending manifest's trial outcome. Bound to the binding and digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationTrial {
    pub binding: Binding,
    pub digest: Sha256Digest,
    pub state: TrialState,
    /// Consecutive failed or interrupted trials of this digest.
    pub failures: u32,
    pub started_at: Option<Timestamp>,
    pub retry_at: Option<Timestamp>,
    pub reason: Option<String>,
}

const MAX_TRIAL_REASON: usize = 64;

pub fn trial(connection: &Connection, binding: &Binding) -> Result<Option<ActivationTrial>> {
    type Row = (String, String, i64, Option<i64>, Option<i64>, Option<String>);
    let row: Option<Row> = connection
        .query_row(
            "SELECT digest, state, failures, started_at_ms, retry_at_ms, reason FROM activation_trial
             WHERE singleton = 1 AND installation_id = ?1 AND screen_id = ?2 AND server_url = ?3",
            params![binding.installation_id.to_string(), binding.screen_id.to_string(), binding.server_url],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()?;
    row.map(|(digest, state, failures, started, retry, reason)| {
        Ok(ActivationTrial {
            binding: binding.clone(),
            digest: parse_digest(&digest)?,
            state: TrialState::parse(&state)?,
            failures: u32::try_from(failures)
                .map_err(|_| StateError::InvalidValue("activation trial failures".to_owned()))?,
            started_at: super::from_ms_opt(started)?,
            retry_at: super::from_ms_opt(retry)?,
            reason,
        })
    })
    .transpose()
}

fn write_trial(connection: &Connection, trial: &ActivationTrial) -> Result<()> {
    if trial.reason.as_ref().is_some_and(|reason| reason.len() > MAX_TRIAL_REASON) {
        return Err(StateError::InvalidValue("activation trial reason".to_owned()));
    }
    connection.execute(
        "INSERT INTO activation_trial (singleton, installation_id, screen_id, server_url, digest, state, failures,
             started_at_ms, retry_at_ms, reason)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (singleton) DO UPDATE SET installation_id = excluded.installation_id,
             screen_id = excluded.screen_id, server_url = excluded.server_url, digest = excluded.digest,
             state = excluded.state, failures = excluded.failures, started_at_ms = excluded.started_at_ms,
             retry_at_ms = excluded.retry_at_ms, reason = excluded.reason",
        params![
            trial.binding.installation_id.to_string(),
            trial.binding.screen_id.to_string(),
            trial.binding.server_url,
            trial.digest.to_hex(),
            trial.state.as_str(),
            i64::from(trial.failures),
            trial.started_at.map(ms),
            trial.retry_at.map(ms),
            trial.reason,
        ],
    )?;
    Ok(())
}

/// The trial row for exactly this pending manifest, or a fresh one. Another
/// digest's row (or another binding's) never carries its failures over.
fn trial_for_pending(
    connection: &Connection,
    binding: &Binding,
    digest: &Sha256Digest,
) -> Result<Option<ActivationTrial>> {
    if get_for(connection, Stage::Pending, binding)?.is_none_or(|pending| pending.digest != *digest) {
        return Ok(None);
    }
    let existing = trial(connection, binding)?.filter(|trial| trial.digest == *digest);
    Ok(Some(existing.unwrap_or(ActivationTrial {
        binding: binding.clone(),
        digest: *digest,
        state: TrialState::Idle,
        failures: 0,
        started_at: None,
        retry_at: None,
        reason: None,
    })))
}

/// Marks the pending manifest's trial as running, before the host shows it,
/// so a process that ends during the trial is known after a restart. Returns
/// false when `digest` is no longer the pending manifest.
pub fn begin_trial(
    connection: &mut Connection,
    binding: &Binding,
    digest: &Sha256Digest,
    now: Timestamp,
) -> Result<bool> {
    let tx = connection.transaction()?;
    let Some(mut trial) = trial_for_pending(&tx, binding, digest)? else { return Ok(false) };
    trial.state = TrialState::Running;
    trial.started_at = Some(now);
    trial.retry_at = None;
    write_trial(&tx, &trial)?;
    tx.commit()?;
    Ok(true)
}

/// Records one failed (or interrupted) trial and holds the manifest back
/// until `retry_at`. Returns the consecutive failure count, or None when
/// `digest` is no longer the pending manifest.
pub fn fail_trial(
    connection: &mut Connection,
    binding: &Binding,
    digest: &Sha256Digest,
    reason: &str,
    retry_at: Timestamp,
) -> Result<Option<u32>> {
    let tx = connection.transaction()?;
    let Some(mut trial) = trial_for_pending(&tx, binding, digest)? else { return Ok(None) };
    trial.state = TrialState::Failed;
    trial.failures = trial.failures.saturating_add(1);
    trial.retry_at = Some(retry_at);
    trial.reason = Some(reason.chars().take(MAX_TRIAL_REASON).collect());
    write_trial(&tx, &trial)?;
    tx.commit()?;
    Ok(Some(trial.failures))
}

/// A policy surface replaced a running trial before it could prove itself.
/// That is not a failure; the failure count and reason stay as they were.
pub fn suspend_trial(connection: &mut Connection, binding: &Binding, digest: &Sha256Digest) -> Result<()> {
    let tx = connection.transaction()?;
    if let Some(mut trial) = trial_for_pending(&tx, binding, digest)?.filter(|trial| trial.state == TrialState::Running)
    {
        trial.state = TrialState::Idle;
        write_trial(&tx, &trial)?;
        tx.commit()?;
    }
    Ok(())
}
