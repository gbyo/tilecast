//! Linux free-space providers. The interface is owned by player-cas.

pub use player_cas::space::SpaceProbe;
use std::path::Path;

#[derive(Debug, Default, Clone, Copy)]
pub struct StatvfsProbe;

impl SpaceProbe for StatvfsProbe {
    fn available_bytes(&self, path: &Path) -> std::io::Result<u64> {
        edge_platform::disk::available_bytes(path)
    }
}

/// A fixed answer, for tests.
#[derive(Debug, Clone, Copy)]
pub struct FixedSpace(pub u64);

impl SpaceProbe for FixedSpace {
    fn available_bytes(&self, _path: &Path) -> std::io::Result<u64> {
        Ok(self.0)
    }
}
