//! Durable Player update jobs (`migrations/0006_update_jobs.sql`).
//!
//! The `install_player_update` handler writes a job with [`accept`] and
//! returns; the update coordinator in `tilecastd` owns every later step and
//! saves each transition with [`save`] before it acts on it. A job is keyed by
//! the server's deployment ID, so a redelivered or retried command finds the
//! same job instead of starting a second update.

use edge_protocol::Sha256Digest;
use rusqlite::{Connection, params};

use super::parse;
use crate::{Result, StateError};

/// Rows kept. Only finished jobs whose result the server has are removed.
pub const MAX_ROWS: usize = 20;
pub const MAX_ENVELOPE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    /// Written by the command handler; nothing fetched yet.
    Accepted,
    /// The release metadata and its signed envelope verified.
    Verified,
    /// The archive is in the content store, verified and pinned.
    Downloaded,
    /// The update helper installed it under `/opt/tilecast-edge/<version>/`.
    Staged,
    /// Written before the helper is asked to activate.
    Activating,
    /// The candidate runs and has not confirmed.
    Provisional,
    /// Download-only: staged, and finished.
    StagedOnly,
    Confirmed,
    RolledBack,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Verified => "verified",
            Self::Downloaded => "downloaded",
            Self::Staged => "staged",
            Self::Activating => "activating",
            Self::Provisional => "provisional",
            Self::StagedOnly => "staged_only",
            Self::Confirmed => "confirmed",
            Self::RolledBack => "rolled_back",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "accepted" => Self::Accepted,
            "verified" => Self::Verified,
            "downloaded" => Self::Downloaded,
            "staged" => Self::Staged,
            "activating" => Self::Activating,
            "provisional" => Self::Provisional,
            "staged_only" => Self::StagedOnly,
            "confirmed" => Self::Confirmed,
            "rolled_back" => Self::RolledBack,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            other => return Err(StateError::InvalidValue(format!("update job state {other}"))),
        })
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::StagedOnly | Self::Confirmed | Self::RolledBack | Self::Failed | Self::Cancelled)
    }

    /// Whether the helper may already have changed what runs.
    pub fn is_activated(self) -> bool {
        matches!(self, Self::Activating | Self::Provisional)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    DownloadOnly,
    InstallNow,
    MaintenanceWindow,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DownloadOnly => "download_only",
            Self::InstallNow => "install_now",
            Self::MaintenanceWindow => "maintenance_window",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "download_only" => Some(Self::DownloadOnly),
            "install_now" => Some(Self::InstallNow),
            "maintenance_window" => Some(Self::MaintenanceWindow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewJob {
    pub deployment_id: uuid::Uuid,
    pub release_id: uuid::Uuid,
    pub command_id: uuid::Uuid,
    pub expected_version_code: u64,
    pub expected_artifact: Sha256Digest,
    pub mode: Mode,
    pub window_start_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateJob {
    pub deployment_id: uuid::Uuid,
    pub release_id: uuid::Uuid,
    pub command_id: uuid::Uuid,
    pub expected_version_code: u64,
    pub expected_artifact: Sha256Digest,
    pub mode: Mode,
    pub window_start_ms: Option<i64>,
    pub state: JobState,
    pub version_name: Option<String>,
    pub artifact_size_bytes: Option<u64>,
    pub envelope: Option<Vec<u8>>,
    pub envelope_signature: Option<Vec<u8>>,
    pub downloaded_bytes: u64,
    pub reason_code: Option<String>,
    /// The job state whose status report the server accepted last.
    pub reported_state: Option<String>,
    pub report_closed: bool,
    pub attempts: u32,
    pub next_attempt_at_ms: Option<i64>,
    pub activation_requested_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl UpdateJob {
    /// The content-store pin holder for this job's archive.
    pub fn pin_holder(&self) -> String {
        format!("update:{}", self.deployment_id)
    }
}

/// What [`accept`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accepted {
    New,
    /// A redelivery or a second command for the same deployment: the job
    /// goes on where it is.
    Existing(JobState),
    /// A retry of a failed, rolled-back or cancelled job starts it again.
    Restarted,
}

const COLUMNS: &str = "deployment_id, release_id, command_id, expected_version_code, expected_artifact_sha256, \
    installation_mode, maintenance_window_start_ms, state, version_name, artifact_size_bytes, envelope, \
    envelope_signature, downloaded_bytes, reason_code, reported_state, report_closed, attempts, \
    next_attempt_at_ms, activation_requested_at_ms, created_at_ms, updated_at_ms";

struct Raw {
    deployment_id: String,
    release_id: String,
    command_id: String,
    expected_version_code: i64,
    expected_artifact: String,
    mode: String,
    window_start_ms: Option<i64>,
    state: String,
    version_name: Option<String>,
    artifact_size_bytes: Option<i64>,
    envelope: Option<Vec<u8>>,
    envelope_signature: Option<Vec<u8>>,
    downloaded_bytes: i64,
    reason_code: Option<String>,
    reported_state: Option<String>,
    report_closed: i64,
    attempts: i64,
    next_attempt_at_ms: Option<i64>,
    activation_requested_at_ms: Option<i64>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Raw> {
    Ok(Raw {
        deployment_id: row.get(0)?,
        release_id: row.get(1)?,
        command_id: row.get(2)?,
        expected_version_code: row.get(3)?,
        expected_artifact: row.get(4)?,
        mode: row.get(5)?,
        window_start_ms: row.get(6)?,
        state: row.get(7)?,
        version_name: row.get(8)?,
        artifact_size_bytes: row.get(9)?,
        envelope: row.get(10)?,
        envelope_signature: row.get(11)?,
        downloaded_bytes: row.get(12)?,
        reason_code: row.get(13)?,
        reported_state: row.get(14)?,
        report_closed: row.get(15)?,
        attempts: row.get(16)?,
        next_attempt_at_ms: row.get(17)?,
        activation_requested_at_ms: row.get(18)?,
        created_at_ms: row.get(19)?,
        updated_at_ms: row.get(20)?,
    })
}

fn job(raw: Raw) -> Result<UpdateJob> {
    let unsigned = |n: i64| u64::try_from(n).map_err(|_| StateError::InvalidValue("update job number".into()));
    Ok(UpdateJob {
        deployment_id: parse(&raw.deployment_id, "deployment id")?,
        release_id: parse(&raw.release_id, "release id")?,
        command_id: parse(&raw.command_id, "command id")?,
        expected_version_code: unsigned(raw.expected_version_code)?,
        expected_artifact: Sha256Digest::parse(&raw.expected_artifact)
            .map_err(|_| StateError::InvalidValue("update job digest".into()))?,
        mode: Mode::parse(&raw.mode).ok_or_else(|| StateError::InvalidValue("update job mode".into()))?,
        window_start_ms: raw.window_start_ms,
        state: JobState::parse(&raw.state)?,
        version_name: raw.version_name,
        artifact_size_bytes: raw.artifact_size_bytes.map(unsigned).transpose()?,
        envelope: raw.envelope,
        envelope_signature: raw.envelope_signature,
        downloaded_bytes: unsigned(raw.downloaded_bytes)?,
        reason_code: raw.reason_code,
        reported_state: raw.reported_state,
        report_closed: raw.report_closed != 0,
        attempts: u32::try_from(raw.attempts).unwrap_or(u32::MAX),
        next_attempt_at_ms: raw.next_attempt_at_ms,
        activation_requested_at_ms: raw.activation_requested_at_ms,
        created_at_ms: raw.created_at_ms,
        updated_at_ms: raw.updated_at_ms,
    })
}

fn query(connection: &Connection, filter: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<UpdateJob>> {
    let sql = format!("SELECT {COLUMNS} FROM update_jobs {filter}");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(args, row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(job).collect()
}

pub fn get(connection: &Connection, deployment: uuid::Uuid) -> Result<Option<UpdateJob>> {
    Ok(query(connection, "WHERE deployment_id = ?1", &[&deployment.to_string()])?.into_iter().next())
}

pub fn all(connection: &Connection) -> Result<Vec<UpdateJob>> {
    query(connection, &format!("ORDER BY created_at_ms DESC, deployment_id LIMIT {MAX_ROWS}"), &[])
}

/// The job the coordinator works on: one the helper may already be running
/// first, otherwise the newest unfinished one.
pub fn active(connection: &Connection) -> Result<Option<UpdateJob>> {
    let jobs = all(connection)?;
    Ok(jobs
        .iter()
        .find(|job| job.state.is_activated())
        .or_else(|| jobs.iter().find(|job| !job.state.is_terminal()))
        .cloned())
}

/// The most recently changed job, for status.
pub fn latest(connection: &Connection) -> Result<Option<UpdateJob>> {
    Ok(query(connection, "ORDER BY updated_at_ms DESC, deployment_id LIMIT 1", &[])?.into_iter().next())
}

/// Records an accepted `install_player_update` command.
pub fn accept(connection: &mut Connection, new: &NewJob, now_ms: i64) -> Result<Accepted> {
    let transaction = connection.transaction()?;
    let existing =
        query(&transaction, "WHERE deployment_id = ?1", &[&new.deployment_id.to_string()])?.into_iter().next();
    let outcome = match existing {
        Some(job) if matches!(job.state, JobState::Failed | JobState::RolledBack | JobState::Cancelled) => {
            transaction.execute(
                "UPDATE update_jobs SET command_id = ?2, state = 'accepted', reason_code = NULL, reported_state = NULL,
                     report_closed = 0, attempts = 0, next_attempt_at_ms = NULL, activation_requested_at_ms = NULL,
                     downloaded_bytes = 0, updated_at_ms = ?3
                 WHERE deployment_id = ?1",
                params![new.deployment_id.to_string(), new.command_id.to_string(), now_ms],
            )?;
            Accepted::Restarted
        }
        Some(job) => {
            transaction.execute(
                "UPDATE update_jobs SET command_id = ?2 WHERE deployment_id = ?1",
                params![new.deployment_id.to_string(), new.command_id.to_string()],
            )?;
            Accepted::Existing(job.state)
        }
        None => {
            transaction.execute(
                "INSERT INTO update_jobs (deployment_id, release_id, command_id, expected_version_code,
                     expected_artifact_sha256, installation_mode, maintenance_window_start_ms, state,
                     created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'accepted', ?8, ?8)",
                params![
                    new.deployment_id.to_string(),
                    new.release_id.to_string(),
                    new.command_id.to_string(),
                    i64::try_from(new.expected_version_code).unwrap_or(i64::MAX),
                    new.expected_artifact.to_hex(),
                    new.mode.as_str(),
                    new.window_start_ms,
                    now_ms,
                ],
            )?;
            Accepted::New
        }
    };
    if outcome != Accepted::Existing(JobState::Activating) && outcome != Accepted::Existing(JobState::Provisional) {
        // A newer deployment replaces an older one that has not started to
        // change what runs; one the helper may be running finishes first.
        transaction.execute(
            "UPDATE update_jobs SET state = 'cancelled', reason_code = 'superseded', updated_at_ms = ?2
             WHERE deployment_id <> ?1 AND state IN ('accepted', 'verified', 'downloaded', 'staged')",
            params![new.deployment_id.to_string(), now_ms],
        )?;
    }
    prune(&transaction)?;
    transaction.commit()?;
    Ok(outcome)
}

/// Writes every mutable field of `job`.
pub fn save(connection: &Connection, job: &UpdateJob, now_ms: i64) -> Result<()> {
    if job.envelope.as_ref().is_some_and(|bytes| bytes.len() > MAX_ENVELOPE_BYTES) {
        return Err(StateError::InvalidValue("update envelope too large".into()));
    }
    let changed = connection.execute(
        "UPDATE update_jobs SET state = ?2, version_name = ?3, artifact_size_bytes = ?4, envelope = ?5,
             envelope_signature = ?6, downloaded_bytes = ?7, reason_code = ?8, reported_state = ?9,
             report_closed = ?10, attempts = ?11, next_attempt_at_ms = ?12, activation_requested_at_ms = ?13,
             updated_at_ms = ?14
         WHERE deployment_id = ?1",
        params![
            job.deployment_id.to_string(),
            job.state.as_str(),
            job.version_name,
            job.artifact_size_bytes.map(|n| i64::try_from(n).unwrap_or(i64::MAX)),
            job.envelope,
            job.envelope_signature,
            i64::try_from(job.downloaded_bytes).unwrap_or(i64::MAX),
            job.reason_code.as_deref().map(|reason| reason.chars().take(64).collect::<String>()),
            job.reported_state,
            i64::from(job.report_closed),
            i64::from(job.attempts),
            job.next_attempt_at_ms,
            job.activation_requested_at_ms,
            now_ms,
        ],
    )?;
    if changed == 1 { Ok(()) } else { Err(StateError::InvalidValue("update job missing".into())) }
}

/// Removes the oldest finished jobs beyond [`MAX_ROWS`] whose result the
/// server already has (or will never take).
fn prune(connection: &Connection) -> Result<()> {
    let total: i64 = connection.query_row("SELECT count(*) FROM update_jobs", [], |r| r.get(0))?;
    let excess = total - MAX_ROWS as i64;
    if excess > 0 {
        connection.execute(
            "DELETE FROM update_jobs WHERE deployment_id IN (
                 SELECT deployment_id FROM update_jobs
                 WHERE state IN ('staged_only', 'confirmed', 'rolled_back', 'failed', 'cancelled')
                   AND (report_closed = 1 OR state = 'cancelled' OR reported_state = state)
                 ORDER BY updated_at_ms LIMIT ?1)",
            params![excess],
        )?;
    }
    Ok(())
}
