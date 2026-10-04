//! The narrow free-space fact consumed by CAS reserve policy.

use std::path::Path;

/// Measures free space. A trait so CAS reserve logic can be tested without
/// filling a disk.
pub trait SpaceProbe: Send + Sync + std::fmt::Debug {
    fn available_bytes(&self, path: &Path) -> std::io::Result<u64>;
}
