//! Peers observed on the mesh (bounded by pruning).

use edge_protocol::{NodeId, ScreenId, Timestamp};
use rusqlite::{Connection, params};

use super::{from_ms, ms, parse};
use crate::Result;

pub const FORGET_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRecord {
    pub node_id: NodeId,
    pub screen_id: Option<ScreenId>,
    pub edge_version: Option<String>,
    pub blob_endpoint: Option<String>,
    pub certificate_fingerprint: Option<String>,
    pub last_seen_at: Timestamp,
}

/// Records a verified observation of a peer (from a signed node statement).
pub fn observe(connection: &Connection, peer: &PeerRecord) -> Result<()> {
    connection.execute(
        "INSERT INTO peers (node_id, screen_id, edge_version, blob_endpoint, certificate_fingerprint,
                            first_seen_at_ms, last_seen_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (node_id) DO UPDATE SET
             screen_id = excluded.screen_id,
             edge_version = excluded.edge_version,
             blob_endpoint = excluded.blob_endpoint,
             certificate_fingerprint = excluded.certificate_fingerprint,
             last_seen_at_ms = MAX(last_seen_at_ms, excluded.last_seen_at_ms)",
        params![
            peer.node_id.to_string(),
            peer.screen_id.map(|s| s.to_string()),
            peer.edge_version,
            peer.blob_endpoint,
            peer.certificate_fingerprint,
            ms(peer.last_seen_at),
        ],
    )?;
    Ok(())
}

pub fn list(connection: &Connection) -> Result<Vec<PeerRecord>> {
    let mut statement = connection.prepare(
        "SELECT node_id, screen_id, edge_version, blob_endpoint, certificate_fingerprint, last_seen_at_ms
         FROM peers ORDER BY last_seen_at_ms DESC LIMIT 1000",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    rows.map(|row| {
        let (node, screen, version, endpoint, fingerprint, seen) = row?;
        Ok(PeerRecord {
            node_id: parse(&node, "node_id")?,
            screen_id: screen.map(|s| parse(&s, "screen_id")).transpose()?,
            edge_version: version,
            blob_endpoint: endpoint,
            certificate_fingerprint: fingerprint,
            last_seen_at: from_ms(seen)?,
        })
    })
    .collect()
}

pub fn prune(connection: &Connection, now: Timestamp) -> Result<usize> {
    Ok(connection.execute("DELETE FROM peers WHERE last_seen_at_ms < ?1", params![ms(now) - FORGET_AFTER_MS])?)
}
