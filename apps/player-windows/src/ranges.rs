//! HTTP `Range` parsing for `tcmedia` responses. Video seeks arrive as
//! single-range `bytes=` requests; anything else gets the whole object with
//! `200`, exactly as the reference hosts answer. Only one range is ever
//! honored — multipart ranges are refused — and unsatisfiable ranges answer
//! `416` with the object's size, so the video element can recover.

/// The byte interval to serve, inclusive on both ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn content_range(&self, complete: u64) -> String {
        format!("bytes {}-{}/{}", self.start, self.end, complete)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    /// No `Range` header, or one that asks for everything: serve `200`.
    Entire,
    /// Serve `206` with this interval.
    Partial(ByteRange),
    /// The range cannot be satisfied: answer `416`.
    Unsatisfiable,
}

/// Parses a `Range` header value for an object of `complete` bytes.
pub fn parse_range(header: Option<&str>, complete: u64) -> RangeOutcome {
    let Some(header) = header else { return RangeOutcome::Entire };
    let header = header.trim();
    if complete == 0 {
        return RangeOutcome::Unsatisfiable;
    }
    let Some(spec) = header.strip_prefix("bytes=") else { return RangeOutcome::Entire };
    // One range only; multipart is refused as unsatisfiable rather than
    // answered partially.
    if spec.contains(',') {
        return RangeOutcome::Unsatisfiable;
    }
    let spec = spec.trim();
    let (start, end) = match spec.split_once('-') {
        Some(pair) => pair,
        None => return RangeOutcome::Entire,
    };
    if start.is_empty() {
        // A suffix range: the last N bytes.
        let Ok(suffix) = end.parse::<u64>() else { return RangeOutcome::Entire };
        if suffix == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        let start = complete.saturating_sub(suffix);
        return RangeOutcome::Partial(ByteRange { start, end: complete - 1 });
    }
    let Ok(start) = start.parse::<u64>() else { return RangeOutcome::Entire };
    if start >= complete {
        return RangeOutcome::Unsatisfiable;
    }
    if end.is_empty() {
        return RangeOutcome::Partial(ByteRange { start, end: complete - 1 });
    }
    let Ok(end) = end.parse::<u64>() else { return RangeOutcome::Entire };
    if end < start {
        return RangeOutcome::Unsatisfiable;
    }
    RangeOutcome::Partial(ByteRange { start, end: end.min(complete - 1) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_follow_browser_semantics() {
        assert_eq!(parse_range(None, 100), RangeOutcome::Entire);
        assert_eq!(parse_range(Some("bytes=0-"), 100), RangeOutcome::Partial(ByteRange { start: 0, end: 99 }));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), RangeOutcome::Partial(ByteRange { start: 10, end: 19 }));
        // The end clamps to the object; the video element copes.
        assert_eq!(parse_range(Some("bytes=90-999"), 100), RangeOutcome::Partial(ByteRange { start: 90, end: 99 }));
        // A suffix range takes the tail.
        assert_eq!(parse_range(Some("bytes=-10"), 100), RangeOutcome::Partial(ByteRange { start: 90, end: 99 }));
        assert_eq!(parse_range(Some("bytes=-1000"), 100), RangeOutcome::Partial(ByteRange { start: 0, end: 99 }));
        // Garbage means the whole object; only genuinely unsatisfiable
        // ranges answer 416.
        assert_eq!(parse_range(Some("bytes=abc"), 100), RangeOutcome::Entire);
        assert_eq!(parse_range(Some("items=0-10"), 100), RangeOutcome::Entire);
        assert_eq!(parse_range(Some("bytes=100-"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=50-40"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-0,-1"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 100), RangeOutcome::Unsatisfiable);
        // An empty object serves 200 with an empty body; only a range set
        // against it is unsatisfiable.
        assert_eq!(parse_range(None, 0), RangeOutcome::Entire);
        assert_eq!(parse_range(Some("bytes=0-"), 0), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn content_ranges_are_exact() {
        assert_eq!(ByteRange { start: 0, end: 99 }.content_range(100), "bytes 0-99/100");
        assert_eq!(ByteRange { start: 0, end: 0 }.len(), 1);
    }
}
