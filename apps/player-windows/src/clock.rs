//! The Windows host supplies wall time, monotonic time, and random IDs;
//! shared values only define their ports.

use player_types::Timestamp;
use player_types::time::{SharedClock, WallClock};
use std::sync::Arc;
use std::time::Instant;

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

/// [`player_core::activity::Clocks`] over the system clock and a monotonic
/// stopwatch.
#[derive(Debug, Clone)]
pub struct TaskClocks {
    started: Instant,
    clock: SharedClock,
}

impl TaskClocks {
    pub fn new(clock: SharedClock) -> Self {
        Self { started: Instant::now(), clock }
    }
}

impl player_core::ActivityClocks for TaskClocks {
    fn mono_ms(&self) -> i64 {
        self.started.elapsed().as_millis().try_into().unwrap_or(i64::MAX)
    }

    fn wall_ms(&self) -> i64 {
        self.clock.now().unix_millis()
    }

    fn uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// A uniform random number in `[0, 1)` for retry jitter.
pub fn jitter_unit() -> f64 {
    use ring::rand::SecureRandom as _;
    let mut bytes = [0_u8; 4];
    if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
        return 0.5;
    }
    f64::from(u32::from_le_bytes(bytes)) / (f64::from(u32::MAX) + 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_core::ActivityClocks as _;

    #[test]
    fn clocks_move_and_jitter_is_unit() {
        let clocks = TaskClocks::new(system_clock());
        assert!(clocks.wall_ms() > 0);
        assert!(clocks.mono_ms() >= 0);
        assert_eq!(clocks.uuid().len(), 36);
        for _ in 0..16 {
            let unit = jitter_unit();
            assert!((0.0..1.0).contains(&unit), "{unit}");
        }
    }
}
