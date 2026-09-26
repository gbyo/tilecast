//! The Noise Meter history queue (migration 0005): completed ten-second
//! aggregates waiting for the server, a port of the reference player's
//! `NoiseHistoryQueue` (`apps/player-linux/src/core/noise-history.ts`).
//!
//! Nothing leaves because a request was attempted: [`acknowledge`] removes
//! only what a heartbeat response said the server accepted. Nothing grows
//! without bound: [`add`] prunes past the retention window and beyond
//! [`MAX_RECORDS`], oldest first.

use rusqlite::{Connection, params};

use crate::Result;

/// The fixed aggregation window.
pub const BUCKET_MS: i64 = 10_000;
/// Records per heartbeat (twenty minutes of history).
pub const BATCH: usize = 120;
/// A week of continuous monitoring.
pub const MAX_RECORDS: i64 = 60_480;
pub const DEFAULT_RETENTION_DAYS: u32 = 7;
/// History from the future is refused beyond this skew.
const MAX_FUTURE_MS: i64 = 120_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Bucket {
    pub started_at_ms: i64,
    pub average_level: f64,
    pub peak_level: f64,
    pub monitored_ms: u32,
    pub warning_ms: u32,
    pub loud_ms: u32,
    pub trigger_count: u32,
}

fn level(value: f64) -> Option<f64> {
    value.is_finite().then(|| value.clamp(0.0, 100.0))
}

/// The reference player's `sanitizeNoiseHistoryBucket`: aligned to the grid,
/// nothing from the future or past retention, durations that add up, and a
/// peak no lower than the average.
pub fn sanitize(bucket: &Bucket, now_ms: i64, retention_days: u32) -> Option<Bucket> {
    let retention_ms = i64::from(retention_days.clamp(1, 30)) * 86_400_000;
    if bucket.started_at_ms > now_ms + MAX_FUTURE_MS || bucket.started_at_ms < now_ms - retention_ms {
        return None;
    }
    let average_level = level(bucket.average_level)?;
    let peak_level = level(bucket.peak_level)?.max(average_level);
    let limit = BUCKET_MS as u32;
    let (monitored_ms, warning_ms, loud_ms) =
        (bucket.monitored_ms.min(limit), bucket.warning_ms.min(limit), bucket.loud_ms.min(limit));
    if monitored_ms == 0 || warning_ms + loud_ms > monitored_ms {
        return None;
    }
    Some(Bucket {
        started_at_ms: bucket.started_at_ms.div_euclid(BUCKET_MS) * BUCKET_MS,
        average_level,
        peak_level,
        monitored_ms,
        warning_ms,
        loud_ms,
        trigger_count: bucket.trigger_count.min(1_000),
    })
}

/// Queues one sanitized bucket. A repeat of a slot replaces it, so a runtime
/// reload mid-bucket cannot produce two records for the same ten seconds.
/// Returns how many old records were pruned.
pub fn add(connection: &mut Connection, bucket: &Bucket, now_ms: i64, retention_days: u32) -> Result<u64> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO noise_history (started_at_ms, average_level, peak_level, monitored_ms, warning_ms, loud_ms,
                                    trigger_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (started_at_ms) DO UPDATE SET
             average_level = excluded.average_level, peak_level = excluded.peak_level,
             monitored_ms = excluded.monitored_ms, warning_ms = excluded.warning_ms,
             loud_ms = excluded.loud_ms, trigger_count = excluded.trigger_count",
        params![
            bucket.started_at_ms,
            bucket.average_level,
            bucket.peak_level,
            bucket.monitored_ms,
            bucket.warning_ms,
            bucket.loud_ms,
            bucket.trigger_count
        ],
    )?;
    let pruned = prune(&transaction, now_ms, retention_days)?;
    transaction.commit()?;
    Ok(pruned)
}

fn prune(connection: &Connection, now_ms: i64, retention_days: u32) -> Result<u64> {
    let oldest = now_ms - i64::from(retention_days.clamp(1, 30)) * 86_400_000;
    let mut pruned = connection.execute("DELETE FROM noise_history WHERE started_at_ms < ?1", params![oldest])?;
    pruned += connection.execute(
        "DELETE FROM noise_history WHERE started_at_ms NOT IN
             (SELECT started_at_ms FROM noise_history ORDER BY started_at_ms DESC LIMIT ?1)",
        params![MAX_RECORDS],
    )?;
    Ok(pruned as u64)
}

/// The oldest batch, without removing anything.
pub fn peek(connection: &Connection, limit: usize) -> Result<Vec<Bucket>> {
    let mut statement = connection.prepare(
        "SELECT started_at_ms, average_level, peak_level, monitored_ms, warning_ms, loud_ms, trigger_count
         FROM noise_history ORDER BY started_at_ms LIMIT ?1",
    )?;
    let rows = statement.query_map(params![limit.clamp(1, BATCH) as i64], |row| {
        Ok(Bucket {
            started_at_ms: row.get(0)?,
            average_level: row.get(1)?,
            peak_level: row.get(2)?,
            monitored_ms: row.get(3)?,
            warning_ms: row.get(4)?,
            loud_ms: row.get(5)?,
            trigger_count: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn count(connection: &Connection) -> Result<u64> {
    let count: i64 = connection.query_row("SELECT count(*) FROM noise_history", [], |row| row.get(0))?;
    Ok(count as u64)
}

/// Removes the first `accepted` of the records that were sent, and only
/// those. A partial acknowledgement leaves the rest queued.
pub fn acknowledge(connection: &mut Connection, sent: &[i64], accepted: u64) -> Result<u64> {
    let consumed = sent.len().min(usize::try_from(accepted).unwrap_or(usize::MAX));
    let transaction = connection.transaction()?;
    let mut removed = 0;
    for started_at in &sent[..consumed] {
        removed += transaction.execute("DELETE FROM noise_history WHERE started_at_ms = ?1", params![started_at])?;
    }
    transaction.commit()?;
    Ok(removed as u64)
}
