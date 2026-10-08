//! Installation mismatch evidence. When the server's installation ID stops
//! matching the binding, the daemon records the server URL, both IDs, the
//! detection time, the last successful contact, and where the quarantined
//! caches went. One row, replaced in place; a re-pair, an unpair, or a
//! recovered server clears it.

use player_types::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, from_ms_opt, ms};
use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallationMismatch {
    pub server_url: String,
    pub expected_installation_id: String,
    pub actual_installation_id: String,
    pub detected_at: Timestamp,
    pub last_contact_at: Option<Timestamp>,
    pub quarantined_cas_dir: Option<String>,
    pub quarantined_partial_dir: Option<String>,
}

pub fn get(connection: &Connection) -> Result<Option<InstallationMismatch>> {
    type Row = (String, String, String, i64, Option<i64>, Option<String>, Option<String>);
    let row: Option<Row> = connection
        .query_row(
            "SELECT server_url, expected_installation_id, actual_installation_id, detected_at_ms,
                    last_contact_at_ms, quarantined_cas_dir, quarantined_partial_dir
             FROM installation_mismatch WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()?;
    row.map(|(server_url, expected, actual, detected, contact, cas, partial)| {
        Ok(InstallationMismatch {
            server_url,
            expected_installation_id: expected,
            actual_installation_id: actual,
            detected_at: from_ms(detected)?,
            last_contact_at: from_ms_opt(contact)?,
            quarantined_cas_dir: cas,
            quarantined_partial_dir: partial,
        })
    })
    .transpose()
}

pub fn put(connection: &Connection, mismatch: &InstallationMismatch) -> Result<()> {
    connection.execute(
        "INSERT INTO installation_mismatch (id, server_url, expected_installation_id, actual_installation_id,
                                            detected_at_ms, last_contact_at_ms, quarantined_cas_dir,
                                            quarantined_partial_dir)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET
             server_url = excluded.server_url,
             expected_installation_id = excluded.expected_installation_id,
             actual_installation_id = excluded.actual_installation_id,
             detected_at_ms = excluded.detected_at_ms,
             last_contact_at_ms = excluded.last_contact_at_ms,
             quarantined_cas_dir = excluded.quarantined_cas_dir,
             quarantined_partial_dir = excluded.quarantined_partial_dir",
        params![
            mismatch.server_url,
            mismatch.expected_installation_id,
            mismatch.actual_installation_id,
            ms(mismatch.detected_at),
            mismatch.last_contact_at.map(ms),
            mismatch.quarantined_cas_dir,
            mismatch.quarantined_partial_dir,
        ],
    )?;
    Ok(())
}

pub fn clear(connection: &Connection) -> Result<()> {
    connection.execute("DELETE FROM installation_mismatch WHERE id = 1", [])?;
    Ok(())
}
