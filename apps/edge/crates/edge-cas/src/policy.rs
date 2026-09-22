//! Eviction policy.

use edge_protocol::Sha256Digest;
use edge_state::repo::cas::ObjectRecord;

/// Chooses unpinned objects to evict. `candidates` are already unpinned and
/// ordered by oldest access first; the policy returns digests to remove, in
/// order, until at least `bytes_needed` would be freed (or all it is willing
/// to evict).
pub trait EvictionPolicy: Send + Sync + std::fmt::Debug {
    fn select(&self, candidates: &[ObjectRecord], bytes_needed: u64) -> Vec<Sha256Digest>;
}

/// Least recently used, evicting cheaper domains first (media before Edge
/// objects before release artifacts), per RFC §14.10.
#[derive(Debug, Default, Clone, Copy)]
pub struct LruByDomain;

impl EvictionPolicy for LruByDomain {
    fn select(&self, candidates: &[ObjectRecord], bytes_needed: u64) -> Vec<Sha256Digest> {
        let mut ordered: Vec<&ObjectRecord> = candidates.iter().collect();
        ordered.sort_by_key(|record| (record.domain.eviction_priority(), record.last_accessed_at));
        let mut freed = 0u64;
        let mut selected = Vec::new();
        for record in ordered {
            if freed >= bytes_needed {
                break;
            }
            freed = freed.saturating_add(record.size_bytes);
            selected.push(record.sha256);
        }
        selected
    }
}
