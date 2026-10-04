//! Edge-owned compatibility repositories over the shared physical Player database.
//! New shared consumers use player-state directly. Update jobs, Linux network
//! recovery, and legacy import records remain inaccessible to Player Core.

pub use player_state::*;
pub mod platform;
pub mod repo;
