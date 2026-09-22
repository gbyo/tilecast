//! Edge trust material, node certificates and the revocation set.
//!
//! Only public material is stored. Private keys are files named by their
//! public-key fingerprint (see `edge-identity`), referenced from
//! `node_certificates.key_fingerprint`.

use edge_protocol::signed::PublicKey;
use edge_protocol::signed::change::AuthorityKey;
use edge_protocol::{InstallationId, NodeId, ScreenId, Timestamp};
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, ms, parse};
use crate::{Result, StateError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustRecord {
    pub installation_id: InstallationId,
    pub ca_certificate_der: Vec<u8>,
    pub ca_fingerprint: String,
    pub mesh_protocol_version: u32,
    pub latest_sequence_at_enrollment: u64,
    pub authority_keys: Vec<AuthorityKey>,
}

/// Replaces the pinned trust material. Callers must only pass material that
/// arrived in an authenticated server response.
pub fn put_trust(connection: &mut Connection, trust: &TrustRecord, now: Timestamp) -> Result<()> {
    let tx = connection.transaction()?;
    tx.execute(
        "INSERT INTO edge_trust (id, installation_id, ca_certificate_der, ca_fingerprint,
                                 mesh_protocol_version, latest_sequence_at_enrollment, updated_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET
             installation_id = excluded.installation_id,
             ca_certificate_der = excluded.ca_certificate_der,
             ca_fingerprint = excluded.ca_fingerprint,
             mesh_protocol_version = excluded.mesh_protocol_version,
             latest_sequence_at_enrollment = excluded.latest_sequence_at_enrollment,
             updated_at_ms = excluded.updated_at_ms",
        params![
            trust.installation_id.to_string(),
            trust.ca_certificate_der,
            trust.ca_fingerprint,
            trust.mesh_protocol_version,
            trust.latest_sequence_at_enrollment as i64,
            ms(now),
        ],
    )?;
    for key in &trust.authority_keys {
        tx.execute(
            "INSERT INTO authority_keys (epoch, key_id, public_key, added_at_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (epoch) DO UPDATE SET key_id = excluded.key_id, public_key = excluded.public_key",
            params![key.epoch, key.public_key.key_id(), key.public_key.raw().as_slice(), ms(now)],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn get_trust(connection: &Connection) -> Result<Option<TrustRecord>> {
    let row: Option<(String, Vec<u8>, String, u32, i64)> = connection
        .query_row(
            "SELECT installation_id, ca_certificate_der, ca_fingerprint, mesh_protocol_version,
                    latest_sequence_at_enrollment
             FROM edge_trust WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((installation, ca, fingerprint, mesh, latest)) = row else {
        return Ok(None);
    };
    let mut statement = connection.prepare("SELECT epoch, public_key FROM authority_keys ORDER BY epoch")?;
    let keys = statement
        .query_map([], |row| Ok((row.get::<_, u32>(0)?, row.get::<_, Vec<u8>>(1)?)))?
        .map(|row| {
            let (epoch, raw) = row?;
            let public_key =
                PublicKey::from_slice(&raw).ok_or_else(|| StateError::InvalidValue("authority public key".into()))?;
            Ok(AuthorityKey { epoch, public_key })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(TrustRecord {
        installation_id: parse(&installation, "installation_id")?,
        ca_certificate_der: ca,
        ca_fingerprint: fingerprint,
        mesh_protocol_version: mesh,
        latest_sequence_at_enrollment: latest as u64,
        authority_keys: keys,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertificateState {
    Pending,
    Active,
    Superseded,
}

impl CertificateState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Superseded => "superseded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateRecord {
    pub fingerprint: String,
    pub serial_number: String,
    pub certificate_der: Vec<u8>,
    pub key_fingerprint: String,
    pub installation_id: InstallationId,
    pub node_id: NodeId,
    pub screen_id: Option<ScreenId>,
    pub not_before: Timestamp,
    pub not_after: Timestamp,
}

/// Stores a newly issued certificate as the active one, superseding the
/// previous active certificate in the same transaction. Superseded rows
/// beyond the newest two are deleted; their key files become orphans that
/// [`referenced_key_fingerprints`] no longer lists.
pub fn activate_certificate(connection: &mut Connection, record: &CertificateRecord, now: Timestamp) -> Result<()> {
    let tx = connection.transaction()?;
    tx.execute("UPDATE node_certificates SET state = 'superseded' WHERE state = 'active'", [])?;
    tx.execute(
        "INSERT INTO node_certificates (fingerprint, serial_number, certificate_der, key_fingerprint,
                                        installation_id, node_id, screen_id, not_before_ms, not_after_ms,
                                        state, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (fingerprint) DO UPDATE SET state = excluded.state",
        params![
            record.fingerprint,
            record.serial_number,
            record.certificate_der,
            record.key_fingerprint,
            record.installation_id.to_string(),
            record.node_id.to_string(),
            record.screen_id.map(|s| s.to_string()),
            ms(record.not_before),
            ms(record.not_after),
            CertificateState::Active.as_str(),
            ms(now),
        ],
    )?;
    tx.execute(
        "DELETE FROM node_certificates WHERE state = 'superseded' AND fingerprint NOT IN (
             SELECT fingerprint FROM node_certificates WHERE state = 'superseded'
             ORDER BY created_at_ms DESC LIMIT 2)",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn active_certificate(connection: &Connection) -> Result<Option<CertificateRecord>> {
    type Row = (String, String, Vec<u8>, String, String, String, Option<String>, i64, i64);
    let row: Option<Row> = connection
        .query_row(
            "SELECT fingerprint, serial_number, certificate_der, key_fingerprint, installation_id,
                    node_id, screen_id, not_before_ms, not_after_ms
             FROM node_certificates WHERE state = 'active'",
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
    row.map(|(fingerprint, serial, der, key, installation, node, screen, before, after)| {
        Ok(CertificateRecord {
            fingerprint,
            serial_number: serial,
            certificate_der: der,
            key_fingerprint: key,
            installation_id: parse(&installation, "installation_id")?,
            node_id: parse(&node, "node_id")?,
            screen_id: screen.map(|s| parse(&s, "screen_id")).transpose()?,
            not_before: from_ms(before)?,
            not_after: from_ms(after)?,
        })
    })
    .transpose()
}

/// Key fingerprints still referenced by a stored certificate. Any other key
/// file in the identity directory is an orphan.
pub fn referenced_key_fingerprints(connection: &Connection) -> Result<Vec<String>> {
    let mut statement = connection.prepare("SELECT DISTINCT key_fingerprint FROM node_certificates")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
}

pub fn revocation_generation(connection: &Connection) -> Result<u64> {
    let value: Option<i64> = connection
        .query_row("SELECT generation FROM revocation_state WHERE id = 1", [], |row| row.get(0))
        .optional()?;
    Ok(value.unwrap_or(0) as u64)
}

/// Records a revoked node. Generations only move forward.
pub fn record_revocation(
    connection: &Connection,
    node_id: NodeId,
    generation: u64,
    revoked_at: Timestamp,
    forget_after: Timestamp,
) -> Result<()> {
    connection.execute(
        "INSERT INTO revocations (node_id, generation, revoked_at_ms, forget_after_ms) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (node_id) DO UPDATE SET
             generation = MAX(generation, excluded.generation),
             forget_after_ms = MAX(forget_after_ms, excluded.forget_after_ms)",
        params![node_id.to_string(), generation as i64, ms(revoked_at), ms(forget_after)],
    )?;
    connection.execute(
        "INSERT INTO revocation_state (id, generation, updated_at_ms) VALUES (1, ?1, ?2)
         ON CONFLICT (id) DO UPDATE SET generation = MAX(generation, excluded.generation),
                                        updated_at_ms = excluded.updated_at_ms",
        params![generation as i64, ms(revoked_at)],
    )?;
    Ok(())
}

pub fn revoked_node_ids(connection: &Connection) -> Result<Vec<NodeId>> {
    let mut statement = connection.prepare("SELECT node_id FROM revocations ORDER BY node_id")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| parse(&row?, "node_id")).collect()
}

/// Every stored revocation as (node, generation, forget after), to rebuild
/// the in-memory revocation set at startup.
pub fn revocation_entries(connection: &Connection) -> Result<Vec<(NodeId, u64, Timestamp)>> {
    let mut statement =
        connection.prepare("SELECT node_id, generation, forget_after_ms FROM revocations ORDER BY node_id")?;
    let rows =
        statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))?;
    rows.map(|row| {
        let (node, generation, forget) = row?;
        Ok((parse(&node, "node_id")?, generation as u64, from_ms(forget)?))
    })
    .collect()
}

/// Forgets revocations whose certificates have all expired.
pub fn prune_revocations(connection: &Connection, now: Timestamp) -> Result<usize> {
    Ok(connection.execute("DELETE FROM revocations WHERE forget_after_ms < ?1", params![ms(now)])?)
}

pub fn from_certificate_row_timestamp(value: i64) -> Result<Timestamp> {
    from_ms(value)
}
