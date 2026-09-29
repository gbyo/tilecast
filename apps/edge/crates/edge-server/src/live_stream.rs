//! Ephemeral Studio Watch Live session (the Tilecast live-stream protocol).
//!
//! Studio holds a 15-second lease per screen while its Watch Live dialog is
//! open. The player reconciles `GET /api/v1/player/live-stream-session` and,
//! while the lease is active, sends bounded JPEG frames as TCLS version 1
//! binary messages on the existing authenticated player WebSocket. Frames and
//! sessions are memory-only: they are never stored, logged, or reported.
//!
//! The Go server (`apps/server/internal/livestream`) is authoritative for
//! validation. This module additionally validates locally so malformed or
//! stale data is never intentionally emitted. An inactive, expired,
//! malformed, or incomplete session fails closed to no streaming.
//!
//! Bounds mirrored from the server contract: 640x360, 100 KiB, 125 ms target
//! interval (about 8 FPS). Server numbers are never trusted for allocations
//! or timing: dimensions and byte limits are clamped to the local maximums,
//! and the capture cadence has a local lower bound.

use serde_json::Value;

/// Local maximum frame dimensions (the server's `MaxWidth`/`MaxHeight`).
pub const MAX_WIDTH: u32 = 640;
/// Local maximum frame dimensions (the server's `MaxWidth`/`MaxHeight`).
pub const MAX_HEIGHT: u32 = 360;
/// Local maximum encoded frame bytes (the server's `MaxFrameBytes`).
pub const MAX_FRAME_BYTES: usize = 100 * 1024;
/// Lower bound for the capture cadence: a faster server interval never speeds
/// captures up past the protocol's 125 ms target.
pub const MIN_FRAME_INTERVAL_MILLIS: u64 = 125;
/// Minimum pause between captures so a zero elapsed time cannot busy-loop.
pub const MIN_CAPTURE_PAUSE_MILLIS: u64 = 25;

/// TCLS version 1 binary header length.
///
/// Layout: 4 magic bytes, 1 version byte, 16 session UUID bytes, 8
/// big-endian capture milliseconds, 2 big-endian width, 2 big-endian height.
pub const TCLS_HEADER_LEN: usize = 33;
/// TCLS magic (`TCLS`) and the only supported version.
pub const TCLS_MAGIC: [u8; 4] = *b"TCLS";
/// TCLS protocol version the server accepts.
pub const TCLS_VERSION: u8 = 1;

/// A Studio live-stream lease, as the player sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveStreamSession {
    /// Session UUID when the lease is active; `None` otherwise.
    pub id: Option<uuid::Uuid>,
    /// Whether Studio currently holds the lease.
    pub active: bool,
    /// Lease expiry as the server's RFC 3339 timestamp, if any.
    pub expires_at: Option<String>,
    /// Target milliseconds between frames, floored at
    /// [`MIN_FRAME_INTERVAL_MILLIS`].
    pub frame_interval_millis: u64,
    /// Capture width bound, clamped to [`MAX_WIDTH`].
    pub max_width: u32,
    /// Capture height bound, clamped to [`MAX_HEIGHT`].
    pub max_height: u32,
    /// Frame byte bound, clamped to [`MAX_FRAME_BYTES`].
    pub max_frame_bytes: usize,
}

impl Default for LiveStreamSession {
    fn default() -> Self {
        Self {
            id: None,
            active: false,
            expires_at: None,
            frame_interval_millis: MIN_FRAME_INTERVAL_MILLIS,
            max_width: MAX_WIDTH,
            max_height: MAX_HEIGHT,
            max_frame_bytes: MAX_FRAME_BYTES,
        }
    }
}

impl LiveStreamSession {
    /// Whether this session authorizes capture now: active, with a session
    /// ID, and with an expiry strictly after `now_unix_millis`.
    pub fn is_active_at(&self, now_unix_millis: i64) -> bool {
        if !self.active || self.id.is_none() {
            return false;
        }
        let Some(expires_at) = self.expires_at.as_deref() else {
            return false;
        };
        let Ok(expires) = edge_protocol::Timestamp::parse(expires_at) else {
            return false;
        };
        expires.unix_millis() > now_unix_millis
    }
}

/// Parses `GET /api/v1/player/live-stream-session` data. Unknown or
/// out-of-range server numbers fail closed to the local bounds; a malformed
/// session ID or timestamp deactivates the session rather than producing a
/// partial one.
pub(crate) fn live_stream_session(data: &Value) -> LiveStreamSession {
    let active = data.get("active").and_then(Value::as_bool).unwrap_or(false);
    let id =
        data.get("id").and_then(Value::as_str).and_then(|value| edge_protocol::ids::parse_canonical_uuid(value).ok());
    let expires_at = data.get("expiresAt").and_then(Value::as_str).map(str::to_owned);
    let frame_interval_millis = data
        .get("frameIntervalMillis")
        .and_then(Value::as_u64)
        .map_or(MIN_FRAME_INTERVAL_MILLIS, |millis| millis.max(MIN_FRAME_INTERVAL_MILLIS));
    let max_width = data
        .get("maxWidth")
        .and_then(Value::as_u64)
        .map_or(MAX_WIDTH, |width| (width.min(u64::from(MAX_WIDTH)) as u32).max(1));
    let max_height = data
        .get("maxHeight")
        .and_then(Value::as_u64)
        .map_or(MAX_HEIGHT, |height| (height.min(u64::from(MAX_HEIGHT)) as u32).max(1));
    let max_frame_bytes = data
        .get("maxFrameBytes")
        .and_then(Value::as_u64)
        .map_or(MAX_FRAME_BYTES, |bytes| (bytes.min(MAX_FRAME_BYTES as u64) as usize).max(1));
    let mut session =
        LiveStreamSession { id, active, expires_at, frame_interval_millis, max_width, max_height, max_frame_bytes };
    if !active || session.id.is_none() {
        session.active = false;
        session.id = None;
    }
    session
}

/// Whether `jpeg` is a complete JPEG: it starts with SOI and ends with EOI.
/// Mirrors the server's `validateFrame` marker check.
pub fn is_complete_jpeg(jpeg: &[u8]) -> bool {
    jpeg.len() >= 4
        && jpeg.len() <= MAX_FRAME_BYTES
        && jpeg[0] == 0xFF
        && jpeg[1] == 0xD8
        && jpeg[jpeg.len() - 2] == 0xFF
        && jpeg[jpeg.len() - 1] == 0xD9
}

/// Encodes one TCLS version 1 frame: the 33-byte big-endian header followed
/// by the complete JPEG. Returns `None` without allocating when the inputs
/// cannot produce a frame the server would accept.
pub fn encode_live_stream_frame(
    session_id: &uuid::Uuid,
    captured_at_millis: i64,
    width: u32,
    height: u32,
    jpeg: &[u8],
) -> Option<Vec<u8>> {
    if width == 0 || width > MAX_WIDTH || height == 0 || height > MAX_HEIGHT {
        return None;
    }
    if !is_complete_jpeg(jpeg) {
        return None;
    }
    let mut frame = Vec::with_capacity(TCLS_HEADER_LEN + jpeg.len());
    frame.extend_from_slice(&TCLS_MAGIC);
    frame.push(TCLS_VERSION);
    frame.extend_from_slice(session_id.as_bytes());
    frame.extend_from_slice(&captured_at_millis.to_be_bytes());
    frame.extend_from_slice(&(width as u16).to_be_bytes());
    frame.extend_from_slice(&(height as u16).to_be_bytes());
    debug_assert_eq!(frame.len(), TCLS_HEADER_LEN);
    frame.extend_from_slice(jpeg);
    Some(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_ID: &str = "bffef4b1-f9b5-4b25-9d4f-864fba88d86d";

    #[test]
    fn encodes_the_bounded_header_the_server_expects_byte_for_byte() {
        let session_id = SESSION_ID.parse::<uuid::Uuid>().unwrap();
        let jpeg = [0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9];
        let frame = encode_live_stream_frame(&session_id, 1_775_000_000_123, 640, 360, &jpeg).unwrap();
        assert_eq!(frame.len(), TCLS_HEADER_LEN + jpeg.len());
        assert_eq!(&frame[0..4], b"TCLS");
        assert_eq!(frame[4], 1);
        assert_eq!(&frame[5..21], session_id.as_bytes());
        assert_eq!(&frame[21..29], &1_775_000_000_123i64.to_be_bytes());
        assert_eq!(&frame[29..31], &640u16.to_be_bytes());
        assert_eq!(&frame[31..33], &360u16.to_be_bytes());
        assert_eq!(&frame[33..], &jpeg);
    }

    #[test]
    fn refuses_inputs_the_server_would_reject() {
        let session_id = SESSION_ID.parse::<uuid::Uuid>().unwrap();
        let jpeg = [0xFF, 0xD8, 0x01, 0xFF, 0xD9];
        assert!(encode_live_stream_frame(&session_id, 1, 0, 360, &jpeg).is_none());
        assert!(encode_live_stream_frame(&session_id, 1, 641, 360, &jpeg).is_none());
        assert!(encode_live_stream_frame(&session_id, 1, 640, 361, &jpeg).is_none());
        assert!(encode_live_stream_frame(&session_id, 1, 640, 360, b"GIF89a").is_none());
        assert!(encode_live_stream_frame(&session_id, 1, 640, 360, &[0xFF, 0xD8, 0xFF]).is_none());
        assert!(encode_live_stream_frame(&session_id, 1, 640, 360, &[0xFF, 0xD8, 0x01, 0x02]).is_none());
        let oversized = vec![0u8; MAX_FRAME_BYTES + 1];
        assert!(encode_live_stream_frame(&session_id, 1, 640, 360, &oversized).is_none());
    }

    #[test]
    fn parses_an_active_session_within_local_bounds() {
        let session = live_stream_session(&serde_json::json!({
            "id": SESSION_ID, "active": true, "expiresAt": "2026-07-30T12:00:15Z",
            "frameIntervalMillis": 125, "maxWidth": 640, "maxHeight": 360, "maxFrameBytes": 102400,
        }));
        assert_eq!(session.id.unwrap().to_string(), SESSION_ID);
        assert!(session.active);
        assert_eq!(session.frame_interval_millis, 125);
        assert_eq!((session.max_width, session.max_height), (640, 360));
        assert_eq!(session.max_frame_bytes, MAX_FRAME_BYTES);
        let expiry = edge_protocol::Timestamp::parse("2026-07-30T12:00:15Z").unwrap().unix_millis();
        assert!(session.is_active_at(expiry - 1_000));
        assert!(!session.is_active_at(expiry));
        assert!(!session.is_active_at(expiry + 1_000));
    }

    #[test]
    fn server_numbers_never_widen_local_bounds_or_timing() {
        let session = live_stream_session(&serde_json::json!({
            "id": SESSION_ID, "active": true, "expiresAt": "2026-07-30T12:00:15Z",
            "frameIntervalMillis": 10, "maxWidth": 3840, "maxHeight": 2160, "maxFrameBytes": 99999999,
        }));
        assert!(session.active);
        assert_eq!(session.frame_interval_millis, MIN_FRAME_INTERVAL_MILLIS);
        assert_eq!((session.max_width, session.max_height), (MAX_WIDTH, MAX_HEIGHT));
        assert_eq!(session.max_frame_bytes, MAX_FRAME_BYTES);
    }

    #[test]
    fn inactive_expired_malformed_or_incomplete_sessions_fail_closed() {
        let inactive = live_stream_session(&serde_json::json!({
            "id": SESSION_ID, "active": false, "expiresAt": "2026-07-30T12:00:15Z",
            "frameIntervalMillis": 125, "maxWidth": 640, "maxHeight": 360, "maxFrameBytes": 102400,
        }));
        assert!(!inactive.active && inactive.id.is_none());
        let missing_id = live_stream_session(&serde_json::json!({
            "active": true, "expiresAt": "2026-07-30T12:00:15Z",
            "frameIntervalMillis": 125, "maxWidth": 640, "maxHeight": 360, "maxFrameBytes": 102400,
        }));
        assert!(!missing_id.active);
        let bad_id = live_stream_session(&serde_json::json!({
            "id": "NOT-A-UUID", "active": true, "expiresAt": "2026-07-30T12:00:15Z",
            "frameIntervalMillis": 125, "maxWidth": 640, "maxHeight": 360, "maxFrameBytes": 102400,
        }));
        assert!(!bad_id.active);
        let uppercase_id = live_stream_session(&serde_json::json!({
            "id": "BFFEF4B1-F9B5-4B25-9D4F-864FBA88D86D", "active": true,
            "expiresAt": "2026-07-30T12:00:15Z",
            "frameIntervalMillis": 125, "maxWidth": 640, "maxHeight": 360, "maxFrameBytes": 102400,
        }));
        assert!(!uppercase_id.active, "only canonical lowercase UUIDs are accepted");
        let missing_expiry = live_stream_session(&serde_json::json!({
            "id": SESSION_ID, "active": true,
            "frameIntervalMillis": 125, "maxWidth": 640, "maxHeight": 360, "maxFrameBytes": 102400,
        }));
        assert!(!missing_expiry.is_active_at(1_783_000_000_000));
        let malformed_expiry = live_stream_session(&serde_json::json!({
            "id": SESSION_ID, "active": true, "expiresAt": "soon",
            "frameIntervalMillis": 125, "maxWidth": 640, "maxHeight": 360, "maxFrameBytes": 102400,
        }));
        assert!(!malformed_expiry.is_active_at(1_783_000_000_000));
        let empty = live_stream_session(&serde_json::json!({}));
        assert!(!empty.active && empty.id.is_none());
        assert_eq!(empty.frame_interval_millis, MIN_FRAME_INTERVAL_MILLIS);
    }
}
