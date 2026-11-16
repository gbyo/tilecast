//! Linux adapters for the shared Player content store.
//! Generic CAS behavior, including the Unix no-follow `UnixSecureOpener`,
//! lives in player-cas; Edge supplies free-space facts.

pub use player_cas::*;
pub mod space;
