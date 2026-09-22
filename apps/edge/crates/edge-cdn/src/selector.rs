//! Peer ranking (RFC §14.6, §14.9).
//!
//! A simple weighted score with failure cooldown, not an optimizer:
//!
//! * recent effective throughput (EWMA), with a neutral prior for peers
//!   never measured;
//! * consecutive failures (cooldown doubles from 30 s up to 10 min);
//! * same-subnet preference and the peer's reported transfer load.
//!
//! Integrity failures suppress that peer *for that object* for an hour and
//! are counted; a single disk fault never revokes anyone. `NotFound`
//! suppresses the peer for that object briefly (its availability claim was
//! stale). State is in memory and bounded; losing it on restart only costs
//! a few extra attempts.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use edge_cas::fetch::AttemptOutcome;
use edge_cas::{BlobSource, FetchObserver, SourceKind};
use edge_protocol::{NodeId, Sha256Digest};

use crate::client::PeerEndpoint;

const MAX_PEERS: usize = 1_024;
const MAX_SUPPRESSIONS: usize = 4_096;
const BASE_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_COOLDOWN: Duration = Duration::from_secs(600);
const INTEGRITY_SUPPRESSION: Duration = Duration::from_secs(3_600);
const STALE_CLAIM_SUPPRESSION: Duration = Duration::from_secs(300);
/// Throughput assumed for a peer with no measurement (bytes per second).
const PRIOR_THROUGHPUT: f64 = 20_000_000.0;

/// A peer that answered an availability query for an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCandidate {
    pub endpoint: PeerEndpoint,
    pub same_subnet: bool,
    /// Transfers the peer reported in progress.
    pub load: u32,
}

#[derive(Debug, Clone, Default)]
struct PeerStats {
    throughput: Option<f64>,
    consecutive_failures: u32,
    integrity_failures: u32,
    cooldown_until: Option<Instant>,
    last_used: Option<Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PeerReport {
    pub node_id: NodeId,
    pub throughput_bytes_per_second: Option<f64>,
    pub consecutive_failures: u32,
    pub integrity_failures: u32,
    pub cooling_down: bool,
}

#[derive(Debug, Default)]
pub struct PeerSelector {
    peers: Mutex<HashMap<NodeId, PeerStats>>,
    suppressed: Mutex<HashMap<(NodeId, Sha256Digest), Instant>>,
}

impl PeerSelector {
    pub fn new() -> Self {
        Self::default()
    }

    fn score(stats: Option<&PeerStats>, candidate: &PeerCandidate) -> f64 {
        let throughput = stats.and_then(|s| s.throughput).unwrap_or(PRIOR_THROUGHPUT);
        let failures = stats.map_or(0, |s| s.consecutive_failures) as f64;
        let mut score = throughput / 1_000_000.0;
        score -= 10.0 * failures;
        score -= 5.0 * f64::from(candidate.load.min(64));
        if candidate.same_subnet {
            score += 10.0;
        }
        score
    }

    /// Orders candidates best first, dropping peers in cooldown or
    /// suppressed for this object. The origin is not a candidate: callers
    /// append it last.
    pub fn rank(&self, digest: &Sha256Digest, candidates: &[PeerCandidate], now: Instant) -> Vec<PeerCandidate> {
        let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        let suppressed = self.suppressed.lock().unwrap_or_else(|e| e.into_inner());
        let mut usable: Vec<(f64, PeerCandidate)> = candidates
            .iter()
            .filter(|c| {
                let node = c.endpoint.node_id;
                let cooling = peers.get(&node).and_then(|s| s.cooldown_until).is_some_and(|until| until > now);
                let blocked = suppressed.get(&(node, *digest)).is_some_and(|until| *until > now);
                !cooling && !blocked
            })
            .map(|c| (Self::score(peers.get(&c.endpoint.node_id), c), *c))
            .collect();
        usable.sort_by(|a, b| b.0.total_cmp(&a.0));
        usable.dedup_by_key(|(_, c)| c.endpoint.node_id);
        usable.into_iter().map(|(_, c)| c).collect()
    }

    pub fn record(
        &self,
        node: NodeId,
        digest: &Sha256Digest,
        outcome: AttemptOutcome,
        bytes: u64,
        elapsed: Duration,
        now: Instant,
    ) {
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        if peers.len() >= MAX_PEERS && !peers.contains_key(&node) {
            // Forget the least recently used peer.
            if let Some(oldest) = peers.iter().min_by_key(|(_, s)| s.last_used).map(|(id, _)| *id) {
                peers.remove(&oldest);
            }
        }
        let stats = peers.entry(node).or_default();
        stats.last_used = Some(now);
        let mut suppress = None;
        match outcome {
            AttemptOutcome::Completed => {
                stats.consecutive_failures = 0;
                stats.cooldown_until = None;
                if bytes > 0 && elapsed > Duration::ZERO {
                    let sample = bytes as f64 / elapsed.as_secs_f64();
                    stats.throughput = Some(match stats.throughput {
                        Some(previous) => previous * 0.7 + sample * 0.3,
                        None => sample,
                    });
                }
            }
            AttemptOutcome::NotFound => suppress = Some(STALE_CLAIM_SUPPRESSION),
            AttemptOutcome::IntegrityFailure => {
                stats.integrity_failures = stats.integrity_failures.saturating_add(1);
                suppress = Some(INTEGRITY_SUPPRESSION);
            }
            AttemptOutcome::Unauthorized | AttemptOutcome::Transient | AttemptOutcome::ProtocolFailure => {
                stats.consecutive_failures = stats.consecutive_failures.saturating_add(1);
                let factor = 1u32 << stats.consecutive_failures.saturating_sub(1).min(5);
                stats.cooldown_until = Some(now + (BASE_COOLDOWN * factor).min(MAX_COOLDOWN));
            }
        }
        drop(peers);
        if let Some(duration) = suppress {
            let mut suppressed = self.suppressed.lock().unwrap_or_else(|e| e.into_inner());
            suppressed.retain(|_, until| *until > now);
            if suppressed.len() < MAX_SUPPRESSIONS {
                suppressed.insert((node, *digest), now + duration);
            }
        }
    }

    pub fn report(&self, now: Instant) -> Vec<PeerReport> {
        let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<PeerReport> = peers
            .iter()
            .map(|(node, stats)| PeerReport {
                node_id: *node,
                throughput_bytes_per_second: stats.throughput,
                consecutive_failures: stats.consecutive_failures,
                integrity_failures: stats.integrity_failures,
                cooling_down: stats.cooldown_until.is_some_and(|until| until > now),
            })
            .collect();
        out.sort_by_key(|r| r.node_id);
        out
    }

    /// A fetch observer that records peer attempts for `digest`.
    pub fn observer<'a>(&'a self, digest: Sha256Digest) -> SelectorObserver<'a> {
        SelectorObserver { selector: self, digest }
    }
}

#[derive(Debug)]
pub struct SelectorObserver<'a> {
    selector: &'a PeerSelector,
    digest: Sha256Digest,
}

impl FetchObserver for SelectorObserver<'_> {
    fn attempt(&self, source: &dyn BlobSource, outcome: AttemptOutcome, bytes: u64, elapsed: Duration) {
        if source.kind() != SourceKind::Peer {
            return;
        }
        if let Ok(node) = source.label().parse::<NodeId>() {
            if outcome == AttemptOutcome::IntegrityFailure {
                tracing::warn!(component = "cdn", event = "peer_integrity_failure", peer = %node, sha256 = %self.digest.short());
            }
            self.selector.record(node, &self.digest, outcome, bytes, elapsed, Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(port: u16, same_subnet: bool, load: u32) -> PeerCandidate {
        PeerCandidate {
            endpoint: PeerEndpoint { node_id: NodeId::new_random(), address: ([10, 0, 0, 1], port).into() },
            same_subnet,
            load,
        }
    }

    #[test]
    fn ranks_by_score_and_honors_cooldown_and_suppression() {
        let selector = PeerSelector::new();
        let digest = Sha256Digest::of(b"x");
        let now = Instant::now();
        let (near, far, busy) = (candidate(1, true, 0), candidate(2, false, 0), candidate(3, true, 8));
        let ranked = selector.rank(&digest, &[far, busy, near], now);
        assert_eq!(ranked, vec![near, far, busy]);

        selector.record(near.endpoint.node_id, &digest, AttemptOutcome::Transient, 0, Duration::ZERO, now);
        assert_eq!(selector.rank(&digest, &[near, far], now), vec![far]);
        assert_eq!(selector.rank(&digest, &[near, far], now + Duration::from_secs(31)), vec![near, far]);

        selector.record(far.endpoint.node_id, &digest, AttemptOutcome::IntegrityFailure, 10, Duration::ZERO, now);
        assert_eq!(selector.rank(&digest, &[far], now), vec![]);
        let other = Sha256Digest::of(b"y");
        assert_eq!(selector.rank(&other, &[far], now), vec![far], "suppression is per object");
        let report = selector.report(now);
        assert_eq!(report.iter().find(|r| r.node_id == far.endpoint.node_id).map(|r| r.integrity_failures), Some(1));
    }

    #[test]
    fn measured_throughput_wins_over_the_prior() {
        let selector = PeerSelector::new();
        let digest = Sha256Digest::of(b"x");
        let now = Instant::now();
        let (slow, fast) = (candidate(1, false, 0), candidate(2, false, 0));
        selector.record(slow.endpoint.node_id, &digest, AttemptOutcome::Completed, 1_000, Duration::from_secs(1), now);
        selector.record(
            fast.endpoint.node_id,
            &digest,
            AttemptOutcome::Completed,
            100_000_000,
            Duration::from_secs(1),
            now,
        );
        assert_eq!(selector.rank(&digest, &[slow, fast], now), vec![fast, slow]);
    }
}
