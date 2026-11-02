//! Durable playlist resume. One checkpoint row per device: the last reliably
//! presented item of the current player relationship. The daemon writes it
//! on accepted item evidence and reads it once at cold start; every field
//! is revalidated against the live binding, manifest, and selection before
//! the starting order changes.

use player_types::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, ms};
use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybackCheckpoint {
    pub installation_id: String,
    pub screen_id: String,
    pub server_url: String,
    pub manifest_version: i64,
    pub manifest_digest: String,
    pub playlist_id: String,
    pub item_id: String,
    pub presented_at: Timestamp,
    pub updated_at: Timestamp,
}

pub fn get(connection: &Connection) -> Result<Option<PlaybackCheckpoint>> {
    type Row = (String, String, String, i64, String, String, String, i64, i64);
    let row: Option<Row> = connection
        .query_row(
            "SELECT installation_id, screen_id, server_url, manifest_version, manifest_digest,
                    playlist_id, item_id, presented_at_ms, updated_at_ms
             FROM playback_checkpoint WHERE id = 1",
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
                ))
            },
        )
        .optional()?;
    row.map(
        |(
            installation_id,
            screen_id,
            server_url,
            manifest_version,
            manifest_digest,
            playlist_id,
            item_id,
            presented_at,
            updated_at,
        )| {
            Ok(PlaybackCheckpoint {
                installation_id,
                screen_id,
                server_url,
                manifest_version,
                manifest_digest,
                playlist_id,
                item_id,
                presented_at: from_ms(presented_at)?,
                updated_at: from_ms(updated_at)?,
            })
        },
    )
    .transpose()
}

pub fn put(connection: &Connection, checkpoint: &PlaybackCheckpoint) -> Result<()> {
    connection.execute(
        "INSERT INTO playback_checkpoint (id, installation_id, screen_id, server_url, manifest_version,
                                          manifest_digest, playlist_id, item_id, presented_at_ms, updated_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (id) DO UPDATE SET
             installation_id = excluded.installation_id,
             screen_id = excluded.screen_id,
             server_url = excluded.server_url,
             manifest_version = excluded.manifest_version,
             manifest_digest = excluded.manifest_digest,
             playlist_id = excluded.playlist_id,
             item_id = excluded.item_id,
             presented_at_ms = excluded.presented_at_ms,
             updated_at_ms = excluded.updated_at_ms",
        params![
            checkpoint.installation_id,
            checkpoint.screen_id,
            checkpoint.server_url,
            checkpoint.manifest_version,
            checkpoint.manifest_digest,
            checkpoint.playlist_id,
            checkpoint.item_id,
            ms(checkpoint.presented_at),
            ms(checkpoint.updated_at),
        ],
    )?;
    Ok(())
}

pub fn clear(connection: &Connection) -> Result<()> {
    connection.execute("DELETE FROM playback_checkpoint WHERE id = 1", [])?;
    Ok(())
}
