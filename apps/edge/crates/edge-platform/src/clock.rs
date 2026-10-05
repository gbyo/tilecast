//! The Linux host supplies wall time; shared values only define its port.

use player_types::Timestamp;
use player_types::time::{SharedClock, WallClock};
use std::sync::Arc;

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl WallClock for SystemClock {
    fn now(&self) -> Timestamp {
        Timestamp::from_offset_datetime(time::OffsetDateTime::now_utc())
    }
}

pub fn system_clock() -> SharedClock {
    Arc::new(SystemClock)
}
