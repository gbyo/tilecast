//! Single-range parsing for the peer blob endpoint (RFC §14.3).
//!
//! Only one `bytes=` range is accepted: `a-b`, `a-` or the suffix form `-n`.
//! Anything else is refused explicitly instead of parsed approximately.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeRequest {
    /// No `Range` header (or an `If-Range` that does not match): whole object.
    Full,
    /// Inclusive byte positions within the object.
    Partial { start: u64, end: u64 },
    /// Syntactically valid but outside the object: 416.
    Unsatisfiable,
    /// Malformed, multi-range or a unit other than bytes: 400.
    Invalid,
}

pub fn parse(header: Option<&str>, size: u64) -> RangeRequest {
    let Some(header) = header else { return RangeRequest::Full };
    let Some(spec) = header.trim().strip_prefix("bytes=") else { return RangeRequest::Invalid };
    if spec.contains(',') || spec.len() > 41 {
        return RangeRequest::Invalid;
    }
    let Some((first, last)) = spec.split_once('-') else { return RangeRequest::Invalid };
    let number = |value: &str| -> Option<u64> {
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        value.parse().ok()
    };
    match (first.is_empty(), last.is_empty()) {
        (true, true) => RangeRequest::Invalid,
        // Suffix: the last n bytes.
        (true, false) => match number(last) {
            None => RangeRequest::Invalid,
            Some(0) => RangeRequest::Unsatisfiable,
            Some(_) if size == 0 => RangeRequest::Unsatisfiable,
            Some(n) => RangeRequest::Partial { start: size.saturating_sub(n), end: size - 1 },
        },
        (false, open) => {
            let Some(start) = number(first) else { return RangeRequest::Invalid };
            let end = if open {
                size.saturating_sub(1)
            } else {
                match number(last) {
                    Some(end) if end >= start => end.min(size.saturating_sub(1)),
                    _ => return RangeRequest::Invalid,
                }
            };
            if start >= size { RangeRequest::Unsatisfiable } else { RangeRequest::Partial { start, end } }
        }
    }
}

/// Parses `Content-Range: bytes a-b/total` from a peer response.
pub fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_ranges_only() {
        assert_eq!(parse(None, 10), RangeRequest::Full);
        assert_eq!(parse(Some("bytes=0-4"), 10), RangeRequest::Partial { start: 0, end: 4 });
        assert_eq!(parse(Some("bytes=5-"), 10), RangeRequest::Partial { start: 5, end: 9 });
        assert_eq!(parse(Some("bytes=5-100"), 10), RangeRequest::Partial { start: 5, end: 9 });
        assert_eq!(parse(Some("bytes=-3"), 10), RangeRequest::Partial { start: 7, end: 9 });
        assert_eq!(parse(Some("bytes=-30"), 10), RangeRequest::Partial { start: 0, end: 9 });
        assert_eq!(parse(Some("bytes=10-"), 10), RangeRequest::Unsatisfiable);
        assert_eq!(parse(Some("bytes=-0"), 10), RangeRequest::Unsatisfiable);
        for invalid in ["bytes=0-1,3-4", "bytes=4-2", "items=0-1", "bytes=-", "bytes=a-", "bytes= 1-2", "bytes=+1-2"] {
            assert_eq!(parse(Some(invalid), 10), RangeRequest::Invalid, "{invalid}");
        }
    }

    #[test]
    fn content_range() {
        assert_eq!(parse_content_range("bytes 5-9/10"), Some((5, 9, 10)));
        assert_eq!(parse_content_range("bytes 5-10/10"), None);
        assert_eq!(parse_content_range("bytes */10"), None);
    }
}
