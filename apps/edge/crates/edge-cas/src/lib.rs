//! Linux adapters for the shared Player content store.
//! Generic CAS behavior lives in player-cas; Edge supplies free-space facts
//! and secure file opening.

pub use player_cas::*;
pub use secure::UnixSecureOpener;
pub mod secure;
pub mod space;
