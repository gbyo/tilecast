//! Wall-clock timestamps and clock injection.
//!
//! Tilecast Edge keeps two kinds of time apart:
//!
//! * **Wall time** ([`Timestamp`]) answers "when": schedule boundaries,
//!   certificate validity, expiry of statements, report timestamps. It is
//!   always UTC on the wire and comes from a [`WallClock`], never from
//!   `OffsetDateTime::now_utc()` scattered through code, so tests can control
//!   it and the Clock Authority can later substitute a corrected clock.
//! * **Monotonic time** (`std::time::Instant` / `tokio::time::Instant`)
//!   answers "how long": timeouts, backoff, progression of an already-running
//!   presentation. It is never serialized and never compared across processes.
//!
//! Ordering of server state never uses either clock: it uses signed server
//! sequences and revisions.

use std::fmt;
use std::sync::Arc;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime, UtcOffset};

/// A UTC instant with RFC 3339 wire form.
///
/// Parsing accepts any RFC 3339 offset and converts to UTC; formatting always
/// emits `Z`. Signed bodies produced by the server use whole seconds
/// (`2026-09-22T19:00:00Z`); see [`Timestamp::to_signed_form`].
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(OffsetDateTime);

impl Timestamp {
    pub fn from_offset_datetime(value: OffsetDateTime) -> Self {
        Self(value.to_offset(UtcOffset::UTC))
    }

    pub fn from_unix_seconds(seconds: i64) -> Option<Self> {
        OffsetDateTime::from_unix_timestamp(seconds).ok().map(Self)
    }

    pub fn from_unix_millis(millis: i64) -> Option<Self> {
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
            .ok()
            .map(Self)
    }

    pub fn parse(value: &str) -> Result<Self, time::error::Parse> {
        OffsetDateTime::parse(value, &Rfc3339).map(Self::from_offset_datetime)
    }

    pub fn as_offset_datetime(&self) -> OffsetDateTime {
        self.0
    }

    pub fn unix_seconds(&self) -> i64 {
        self.0.unix_timestamp()
    }

    pub fn unix_millis(&self) -> i64 {
        (self.0.unix_timestamp_nanos() / 1_000_000) as i64
    }

    pub fn saturating_add(self, duration: Duration) -> Self {
        Self(self.0.saturating_add(duration))
    }

    pub fn saturating_sub(self, duration: Duration) -> Self {
        Self(self.0.saturating_sub(duration))
    }

    /// Signed-duration difference `self - earlier`.
    pub fn since(&self, earlier: Timestamp) -> Duration {
        self.0 - earlier.0
    }

    /// Truncated to whole seconds. Signed bodies carry this form so the
    /// canonical bytes never depend on sub-second formatting differences
    /// between Go and Rust.
    pub fn truncate_to_seconds(self) -> Self {
        Self(self.0.replace_nanosecond(0).unwrap_or(self.0))
    }

    /// `YYYY-MM-DDTHH:MM:SSZ`.
    pub fn to_signed_form(&self) -> String {
        self.truncate_to_seconds().to_string()
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0.format(&Rfc3339) {
            Ok(value) => f.write_str(&value),
            Err(_) => Err(fmt::Error),
        }
    }
}

impl fmt::Debug for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Timestamp({self})")
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.len() > 40 {
            return Err(D::Error::custom("timestamp is too long"));
        }
        Self::parse(&value).map_err(D::Error::custom)
    }
}

/// Source of wall-clock time.
///
/// Production code receives a `SharedClock` rather than reading the system
/// clock directly. Today the implementation is [`SystemClock`]; the Clock
/// Authority (RFC §20) will provide a corrected clock behind the same trait.
pub trait WallClock: Send + Sync + fmt::Debug {
    fn now(&self) -> Timestamp;
}

pub type SharedClock = Arc<dyn WallClock>;

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl WallClock for SystemClock {
    fn now(&self) -> Timestamp {
        Timestamp(OffsetDateTime::now_utc())
    }
}

pub fn system_clock() -> SharedClock {
    Arc::new(SystemClock)
}

/// A settable clock for tests.
#[cfg(any(test, feature = "test-util"))]
#[derive(Debug)]
pub struct ManualClock(std::sync::Mutex<Timestamp>);

#[cfg(any(test, feature = "test-util"))]
impl ManualClock {
    pub fn new(start: Timestamp) -> Arc<Self> {
        Arc::new(Self(std::sync::Mutex::new(start)))
    }

    pub fn set(&self, value: Timestamp) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = value;
    }

    pub fn advance(&self, duration: Duration) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        *guard = guard.saturating_add(duration);
    }
}

#[cfg(any(test, feature = "test-util"))]
impl WallClock for ManualClock {
    fn now(&self) -> Timestamp {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_offsets_and_formats_utc() {
        let parsed = Timestamp::parse("2026-09-22T16:10:00-04:00").expect("valid");
        assert_eq!(parsed.to_string(), "2026-09-22T20:10:00Z");
        let fractional = Timestamp::parse("2026-09-22T20:10:00.250Z").expect("valid");
        assert_eq!(fractional.to_signed_form(), "2026-09-22T20:10:00Z");
        assert_eq!(fractional.unix_millis() % 1000, 250);
        assert!(Timestamp::parse("2026-09-22 20:10:00").is_err());
    }

    #[test]
    fn manual_clock_advances() {
        let clock = ManualClock::new(Timestamp::from_unix_seconds(1_000).expect("valid"));
        clock.advance(Duration::seconds(5));
        assert_eq!(clock.now().unix_seconds(), 1_005);
    }
}
