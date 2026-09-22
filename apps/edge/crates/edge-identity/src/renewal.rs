//! Certificate renewal schedule (RFC §11.4).
//!
//! Renew when fewer than 30 days remain, retrying with bounded exponential
//! backoff. The old certificate stays in use until the replacement is stored
//! (`edge_state::repo::identity::activate_certificate` switches atomically).

use edge_protocol::Timestamp;
use time::Duration;

pub const RENEW_BEFORE: Duration = Duration::days(30);
pub const MIN_RETRY: Duration = Duration::minutes(5);
pub const MAX_RETRY: Duration = Duration::hours(6);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenewalDecision {
    /// Nothing to do until the given time.
    WaitUntil(Timestamp),
    /// Renew now; the current certificate is still valid.
    RenewNow,
    /// The certificate has expired: mesh participation stops until a new one
    /// is issued. Server playback is unaffected.
    Expired,
}

pub fn decide(now: Timestamp, not_after: Timestamp) -> RenewalDecision {
    if not_after <= now {
        RenewalDecision::Expired
    } else if not_after.saturating_sub(RENEW_BEFORE) <= now {
        RenewalDecision::RenewNow
    } else {
        RenewalDecision::WaitUntil(not_after.saturating_sub(RENEW_BEFORE))
    }
}

/// Delay before retry number `attempt` (0-based): 5 min, 10, 20, … ≤ 6 h.
pub fn retry_delay(attempt: u32) -> Duration {
    let factor = 1i32 << attempt.min(10);
    let delay = MIN_RETRY * factor;
    if delay > MAX_RETRY { MAX_RETRY } else { delay }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule() {
        let now = Timestamp::from_unix_seconds(1_000_000_000).expect("time");
        let far = now.saturating_add(Duration::days(100));
        assert_eq!(decide(now, far), RenewalDecision::WaitUntil(far.saturating_sub(RENEW_BEFORE)));
        assert_eq!(decide(now, now.saturating_add(Duration::days(10))), RenewalDecision::RenewNow);
        assert_eq!(decide(now, now), RenewalDecision::Expired);
        assert_eq!(retry_delay(0), Duration::minutes(5));
        assert_eq!(retry_delay(2), Duration::minutes(20));
        assert_eq!(retry_delay(30), MAX_RETRY);
    }
}
