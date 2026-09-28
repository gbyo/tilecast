//! The server installation this player is bound to.

use edge_protocol::{InstallationId, ScreenId, Timestamp};
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, from_ms_opt, ms, parse};
use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialState {
    None,
    Stored,
    /// The server confirmed the credential invalid or revoked.
    Rejected,
}

impl CredentialState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Stored => "stored",
            Self::Rejected => "rejected",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "stored" => Self::Stored,
            "rejected" => Self::Rejected,
            _ => Self::None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerBinding {
    /// Normalized origin (scheme, host, optional port).
    pub server_url: String,
    pub installation_id: InstallationId,
    pub organization_name: Option<String>,
    pub screen_id: Option<ScreenId>,
    pub screen_name: Option<String>,
    pub credential_state: CredentialState,
    pub identity_verified_at: Option<Timestamp>,
    pub bound_at: Timestamp,
}

pub fn get(connection: &Connection) -> Result<Option<ServerBinding>> {
    type Row = (String, String, Option<String>, Option<String>, Option<String>, String, Option<i64>, i64);
    let row: Option<Row> = connection
        .query_row(
            "SELECT server_url, installation_id, organization_name, screen_id, screen_name,
                    credential_state, identity_verified_at_ms, bound_at_ms
             FROM server_binding WHERE id = 1",
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
                ))
            },
        )
        .optional()?;
    row.map(|(url, installation, org, screen, name, credential, verified, bound)| {
        Ok(ServerBinding {
            server_url: url,
            installation_id: parse(&installation, "installation_id")?,
            organization_name: org,
            screen_id: screen.map(|s| parse(&s, "screen_id")).transpose()?,
            screen_name: name,
            credential_state: CredentialState::parse(&credential),
            identity_verified_at: from_ms_opt(verified)?,
            bound_at: from_ms(bound)?,
        })
    })
    .transpose()
}

pub fn put(connection: &Connection, binding: &ServerBinding, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT INTO server_binding (id, server_url, installation_id, organization_name, screen_id, screen_name,
                                     credential_state, identity_verified_at_ms, bound_at_ms, updated_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (id) DO UPDATE SET
             server_url = excluded.server_url,
             installation_id = excluded.installation_id,
             organization_name = excluded.organization_name,
             screen_id = excluded.screen_id,
             screen_name = excluded.screen_name,
             credential_state = excluded.credential_state,
             identity_verified_at_ms = excluded.identity_verified_at_ms,
             updated_at_ms = excluded.updated_at_ms",
        params![
            binding.server_url,
            binding.installation_id.to_string(),
            binding.organization_name,
            binding.screen_id.map(|s| s.to_string()),
            binding.screen_name,
            binding.credential_state.as_str(),
            binding.identity_verified_at.map(ms),
            ms(binding.bound_at),
            ms(now),
        ],
    )?;
    Ok(())
}

pub fn mark_identity_verified(connection: &Connection, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE server_binding SET identity_verified_at_ms = ?1, updated_at_ms = ?1 WHERE id = 1",
        params![ms(now)],
    )?;
    Ok(())
}

pub fn set_credential_state(connection: &Connection, state: CredentialState, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE server_binding SET credential_state = ?1, updated_at_ms = ?2 WHERE id = 1",
        params![state.as_str(), ms(now)],
    )?;
    Ok(())
}
