//! CAS object, partial and pin metadata. File operations belong to
//! `edge-cas`; this module only records what the store has verified.

use edge_protocol::{Sha256Digest, Timestamp};
use rusqlite::{Connection, OptionalExtension, params};

use super::{from_ms, ms, parse};
use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Domain {
    Media,
    EdgeObject,
    Update,
    RendererBundle,
    LegacyState,
}

impl Domain {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Media => "media",
            Self::EdgeObject => "edge_object",
            Self::Update => "update",
            Self::RendererBundle => "renderer_bundle",
            Self::LegacyState => "legacy_state",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "edge_object" => Self::EdgeObject,
            "update" => Self::Update,
            "renderer_bundle" => Self::RendererBundle,
            "legacy_state" => Self::LegacyState,
            _ => Self::Media,
        }
    }

    /// Eviction preference: lower values are evicted first.
    pub fn eviction_priority(&self) -> u8 {
        match self {
            Self::Media => 0,
            Self::EdgeObject => 1,
            Self::LegacyState => 2,
            Self::RendererBundle => 3,
            Self::Update => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Origin,
    Peer,
    LegacyImport,
    Local,
}

impl SourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Origin => "origin",
            Self::Peer => "peer",
            Self::LegacyImport => "legacy_import",
            Self::Local => "local",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "peer" => Self::Peer,
            "legacy_import" => Self::LegacyImport,
            "local" => Self::Local,
            _ => Self::Origin,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyState {
    Verified,
    /// Re-hash before the next use (set for every object after an unclean
    /// shutdown, because a write-back cache may not have reached the disk).
    Suspect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectRecord {
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
    pub domain: Domain,
    pub content_type: Option<String>,
    pub peerable: bool,
    pub source_kind: SourceKind,
    pub verify_state: VerifyState,
    pub verified_at: Timestamp,
    pub created_at: Timestamp,
    pub last_accessed_at: Timestamp,
}

fn object_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawObject> {
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
}

type RawObject = (String, i64, String, Option<String>, i64, String, String, i64, i64, i64);

fn object_from_raw(raw: RawObject) -> Result<ObjectRecord> {
    let (sha, size, domain, content_type, peerable, source, verify, verified, created, accessed) = raw;
    Ok(ObjectRecord {
        sha256: parse(&sha, "sha256")?,
        size_bytes: size as u64,
        domain: Domain::parse(&domain),
        content_type,
        peerable: peerable == 1,
        source_kind: SourceKind::parse(&source),
        verify_state: if verify == "suspect" { VerifyState::Suspect } else { VerifyState::Verified },
        verified_at: from_ms(verified)?,
        created_at: from_ms(created)?,
        last_accessed_at: from_ms(accessed)?,
    })
}

const OBJECT_COLUMNS: &str = "sha256, size_bytes, domain, content_type, peerable, source_kind, verify_state, verified_at_ms, created_at_ms, last_accessed_at_ms";

pub fn get_object(connection: &Connection, digest: &Sha256Digest) -> Result<Option<ObjectRecord>> {
    let raw = connection
        .query_row(
            &format!("SELECT {OBJECT_COLUMNS} FROM cas_objects WHERE sha256 = ?1"),
            params![digest.to_hex()],
            object_from_row,
        )
        .optional()?;
    raw.map(object_from_raw).transpose()
}

/// Records a verified object. Idempotent: re-recording an existing digest
/// refreshes verification and upgrades `peerable` only when asked.
pub fn put_object(connection: &Connection, record: &ObjectRecord) -> Result<()> {
    connection.execute(
        &format!(
            "INSERT INTO cas_objects ({OBJECT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'verified', ?7, ?8, ?9)
             ON CONFLICT (sha256) DO UPDATE SET
                 verify_state = 'verified',
                 verified_at_ms = excluded.verified_at_ms,
                 peerable = MAX(peerable, excluded.peerable),
                 content_type = COALESCE(content_type, excluded.content_type)"
        ),
        params![
            record.sha256.to_hex(),
            record.size_bytes as i64,
            record.domain.as_str(),
            record.content_type,
            i64::from(record.peerable),
            record.source_kind.as_str(),
            ms(record.verified_at),
            ms(record.created_at),
            ms(record.last_accessed_at),
        ],
    )?;
    Ok(())
}

pub fn delete_object(connection: &Connection, digest: &Sha256Digest) -> Result<()> {
    connection.execute("DELETE FROM cas_objects WHERE sha256 = ?1", params![digest.to_hex()])?;
    Ok(())
}

pub fn mark_verified(connection: &Connection, digest: &Sha256Digest, now: Timestamp) -> Result<()> {
    connection.execute(
        "UPDATE cas_objects SET verify_state = 'verified', verified_at_ms = ?2 WHERE sha256 = ?1",
        params![digest.to_hex(), ms(now)],
    )?;
    Ok(())
}

/// After an unclean shutdown every object must be re-hashed before use.
pub fn mark_all_suspect(connection: &Connection) -> Result<usize> {
    Ok(connection.execute("UPDATE cas_objects SET verify_state = 'suspect'", [])?)
}

/// Applies batched access times (RFC §8.3: never one write per read).
pub fn touch_many(connection: &mut Connection, touches: &[(Sha256Digest, Timestamp)]) -> Result<()> {
    let tx = connection.transaction()?;
    {
        let mut statement =
            tx.prepare("UPDATE cas_objects SET last_accessed_at_ms = MAX(last_accessed_at_ms, ?2) WHERE sha256 = ?1")?;
        for (digest, at) in touches {
            statement.execute(params![digest.to_hex(), ms(*at)])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn all_digests(connection: &Connection) -> Result<Vec<Sha256Digest>> {
    let mut statement = connection.prepare("SELECT sha256 FROM cas_objects")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| parse(&row?, "sha256")).collect()
}

/// Unpinned objects, oldest access first.
pub fn eviction_candidates(connection: &Connection, limit: usize) -> Result<Vec<ObjectRecord>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {OBJECT_COLUMNS} FROM cas_objects o
         WHERE NOT EXISTS (SELECT 1 FROM cas_pins p WHERE p.sha256 = o.sha256)
         ORDER BY last_accessed_at_ms ASC LIMIT ?1"
    ))?;
    let rows = statement.query_map(params![limit as i64], object_from_row)?;
    rows.map(|row| object_from_raw(row?)).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub object_count: u64,
    pub used_bytes: u64,
    pub pinned_bytes: u64,
    pub partial_bytes: u64,
}

pub fn usage(connection: &Connection) -> Result<Usage> {
    let (count, used): (i64, i64) =
        connection.query_row("SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM cas_objects", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    let pinned: i64 = connection.query_row(
        "SELECT COALESCE(SUM(size_bytes), 0) FROM cas_objects o
         WHERE EXISTS (SELECT 1 FROM cas_pins p WHERE p.sha256 = o.sha256)",
        [],
        |row| row.get(0),
    )?;
    let partial: i64 =
        connection.query_row("SELECT COALESCE(SUM(bytes_present), 0) FROM cas_partials", [], |row| row.get(0))?;
    Ok(Usage {
        object_count: count as u64,
        used_bytes: used as u64,
        pinned_bytes: pinned as u64,
        partial_bytes: partial as u64,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialRecord {
    pub sha256: Sha256Digest,
    pub expected_size: u64,
    pub bytes_present: u64,
    pub last_source: Option<String>,
    pub source_validator: Option<String>,
}

pub fn get_partial(connection: &Connection, digest: &Sha256Digest) -> Result<Option<PartialRecord>> {
    let row: Option<(i64, i64, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT expected_size, bytes_present, last_source, source_validator FROM cas_partials WHERE sha256 = ?1",
            params![digest.to_hex()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    Ok(row.map(|(expected, present, source, validator)| PartialRecord {
        sha256: *digest,
        expected_size: expected as u64,
        bytes_present: present as u64,
        last_source: source,
        source_validator: validator,
    }))
}

pub fn put_partial(connection: &Connection, record: &PartialRecord, now: Timestamp) -> Result<()> {
    connection.execute(
        "INSERT INTO cas_partials (sha256, expected_size, bytes_present, last_source, source_validator, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (sha256) DO UPDATE SET
             expected_size = excluded.expected_size,
             bytes_present = excluded.bytes_present,
             last_source = excluded.last_source,
             source_validator = excluded.source_validator,
             updated_at_ms = excluded.updated_at_ms",
        params![
            record.sha256.to_hex(),
            record.expected_size as i64,
            record.bytes_present as i64,
            record.last_source,
            record.source_validator,
            ms(now),
        ],
    )?;
    Ok(())
}

pub fn delete_partial(connection: &Connection, digest: &Sha256Digest) -> Result<()> {
    connection.execute("DELETE FROM cas_partials WHERE sha256 = ?1", params![digest.to_hex()])?;
    Ok(())
}

pub fn all_partials(connection: &Connection) -> Result<Vec<PartialRecord>> {
    let mut statement = connection
        .prepare("SELECT sha256, expected_size, bytes_present, last_source, source_validator FROM cas_partials")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    rows.map(|row| {
        let (sha, expected, present, source, validator) = row?;
        Ok(PartialRecord {
            sha256: parse(&sha, "sha256")?,
            expected_size: expected as u64,
            bytes_present: present as u64,
            last_source: source,
            source_validator: validator,
        })
    })
    .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinReason {
    ActivePresentation,
    PendingPresentation,
    Prefetch,
    Takeover,
    Update,
    RendererRelease,
    Migration,
    Manual,
}

impl PinReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ActivePresentation => "active_presentation",
            Self::PendingPresentation => "pending_presentation",
            Self::Prefetch => "prefetch",
            Self::Takeover => "takeover",
            Self::Update => "update",
            Self::RendererRelease => "renderer_release",
            Self::Migration => "migration",
            Self::Manual => "manual",
        }
    }
}

pub fn pin(
    connection: &Connection,
    digest: &Sha256Digest,
    reason: PinReason,
    holder: &str,
    now: Timestamp,
    expires_at: Option<Timestamp>,
) -> Result<()> {
    connection.execute(
        "INSERT INTO cas_pins (sha256, reason, holder, created_at_ms, expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (sha256, reason, holder) DO UPDATE SET expires_at_ms = excluded.expires_at_ms",
        params![digest.to_hex(), reason.as_str(), holder, ms(now), expires_at.map(ms)],
    )?;
    Ok(())
}

pub fn unpin(connection: &Connection, digest: &Sha256Digest, reason: PinReason, holder: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM cas_pins WHERE sha256 = ?1 AND reason = ?2 AND holder = ?3",
        params![digest.to_hex(), reason.as_str(), holder],
    )?;
    Ok(())
}

/// Replaces every pin held by `holder` for `reason` with exactly `digests`.
/// Used when a presentation activation changes its content set atomically.
pub fn replace_pins(
    connection: &mut Connection,
    reason: PinReason,
    holder: &str,
    digests: &[Sha256Digest],
    now: Timestamp,
) -> Result<()> {
    let tx = connection.transaction()?;
    tx.execute("DELETE FROM cas_pins WHERE reason = ?1 AND holder = ?2", params![reason.as_str(), holder])?;
    for digest in digests {
        tx.execute(
            "INSERT OR IGNORE INTO cas_pins (sha256, reason, holder, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
            params![digest.to_hex(), reason.as_str(), holder, ms(now)],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn is_pinned(connection: &Connection, digest: &Sha256Digest) -> Result<bool> {
    Ok(connection
        .query_row("SELECT 1 FROM cas_pins WHERE sha256 = ?1 LIMIT 1", params![digest.to_hex()], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn expire_pins(connection: &Connection, now: Timestamp) -> Result<usize> {
    Ok(connection
        .execute("DELETE FROM cas_pins WHERE expires_at_ms IS NOT NULL AND expires_at_ms < ?1", params![ms(now)])?)
}
