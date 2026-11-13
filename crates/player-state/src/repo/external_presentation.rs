//! The single-screen AirPlay Present session on Tilecast Edge
//! (docs/tilecast-edge-airplay.md §6). One row. The PIN and the device ID
//! are secrets: they live only in this row and are deleted with it, and
//! `Debug` never shows them.

use rusqlite::{Connection, OptionalExtension, params};

use super::parse;
use crate::{Result, StateError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Stored, and the receiver may not run yet.
    Prepared,
    /// The receiver advertised the session at least once.
    Started,
    /// A stop began. A restart finishes it and never resumes the session.
    Stopping,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Started => "started",
            Self::Stopping => "stopping",
        }
    }
}

impl std::str::FromStr for SessionState {
    type Err = ();
    fn from_str(value: &str) -> std::result::Result<Self, ()> {
        match value {
            "prepared" => Ok(Self::Prepared),
            "started" => Ok(Self::Started),
            "stopping" => Ok(Self::Stopping),
            _ => Err(()),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ExternalPresentation {
    pub session_id: String,
    pub receiver_name: String,
    pub pin: String,
    pub device_id: String,
    pub profile: String,
    pub audio_mode: String,
    pub presentation_network_id: Option<String>,
    pub expires_at_ms: i64,
    pub state: SessionState,
    pub stop_reason: Option<String>,
}

impl std::fmt::Debug for ExternalPresentation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalPresentation")
            .field("session_id", &self.session_id)
            .field("receiver_name", &self.receiver_name)
            .field("pin", &"<redacted>")
            .field("device_id", &"<redacted>")
            .field("profile", &self.profile)
            .field("audio_mode", &self.audio_mode)
            .field("presentation_network_id", &self.presentation_network_id)
            .field("expires_at_ms", &self.expires_at_ms)
            .field("state", &self.state)
            .field("stop_reason", &self.stop_reason)
            .finish()
    }
}

pub fn get(connection: &Connection) -> Result<Option<ExternalPresentation>> {
    type Row = (String, String, String, String, String, String, Option<String>, i64, String, Option<String>);
    let row: Option<Row> = connection
        .query_row(
            "SELECT session_id, receiver_name, pin, device_id, profile, audio_mode, presentation_network_id,
                    expires_at_ms, state, stop_reason
             FROM external_presentation WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(session_id, receiver_name, pin, device_id, profile, audio_mode, network, expires_at_ms, state, reason)| {
            Ok(ExternalPresentation {
                session_id,
                receiver_name,
                pin,
                device_id,
                profile,
                audio_mode,
                presentation_network_id: network,
                expires_at_ms,
                state: parse(&state, "external presentation state")?,
                stop_reason: reason,
            })
        },
    )
    .transpose()
}

/// Stores a new session, replacing any other. The caller has stopped the
/// other one first.
pub fn put(connection: &Connection, session: &ExternalPresentation, now_ms: i64) -> Result<()> {
    connection.execute(
        "INSERT INTO external_presentation (singleton, session_id, receiver_name, pin, device_id, profile, audio_mode,
                                            presentation_network_id, expires_at_ms, state, stop_reason, updated_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (singleton) DO UPDATE SET
             session_id = excluded.session_id, receiver_name = excluded.receiver_name, pin = excluded.pin,
             device_id = excluded.device_id, profile = excluded.profile, audio_mode = excluded.audio_mode,
             presentation_network_id = excluded.presentation_network_id, expires_at_ms = excluded.expires_at_ms,
             state = excluded.state, stop_reason = excluded.stop_reason, updated_at_ms = excluded.updated_at_ms",
        params![
            session.session_id,
            session.receiver_name,
            session.pin,
            session.device_id,
            session.profile,
            session.audio_mode,
            session.presentation_network_id,
            session.expires_at_ms,
            session.state.as_str(),
            session.stop_reason,
            now_ms,
        ],
    )?;
    Ok(())
}

/// Moves the stored session to `state`, only when it is still `session_id`
/// and not already stopping. Returns whether the row changed.
pub fn set_state(
    connection: &Connection,
    session_id: &str,
    state: SessionState,
    reason: Option<&str>,
    now_ms: i64,
) -> Result<bool> {
    if reason.is_some_and(|reason| reason.len() > 64) {
        return Err(StateError::InvalidValue("stop reason".into()));
    }
    let changed = connection.execute(
        "UPDATE external_presentation SET state = ?2, stop_reason = COALESCE(?3, stop_reason), updated_at_ms = ?4
         WHERE singleton = 1 AND session_id = ?1 AND state <> 'stopping'",
        params![session_id, state.as_str(), reason, now_ms],
    )?;
    Ok(changed == 1)
}

/// Deletes the session, with its PIN and device ID. Returns whether a row
/// for `session_id` existed.
pub fn delete(connection: &Connection, session_id: &str) -> Result<bool> {
    Ok(connection
        .execute("DELETE FROM external_presentation WHERE singleton = 1 AND session_id = ?1", params![session_id])?
        == 1)
}
