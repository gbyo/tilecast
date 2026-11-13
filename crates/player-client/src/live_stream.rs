//! Ephemeral Studio Watch Live session (the Tilecast live-stream protocol).
//!
//! Studio holds a 15-second lease per screen while its Watch Live dialog is
//! open. The player reconciles `GET /api/v1/player/live-stream-session`,
//! naming the [`WatchLiveProfile`]s it can produce now, and the server
//! selects one. An MJPEG profile sends bounded JPEG frames as TCLS version 1
//! binary messages on the existing authenticated player WebSocket; an H.264
//! profile sends one Annex B access unit per TCLS version 2 message. Frames
//! and sessions are memory-only: they are never stored, logged, or reported.
//!
//! The profile vocabulary and the TCLS version 2 vectors are pinned by
//! `packages/player-contracts/fixtures/watch-live.json`.
//!
//! The Go server (`apps/server/internal/livestream`) is authoritative for
//! validation. This module additionally validates locally so malformed or
//! stale data is never intentionally emitted. An inactive, expired,
//! malformed, or incomplete session fails closed to no streaming.
//!
//! Bounds mirror the server maximum: 960x540, 100 KiB, 100 ms target
//! interval (about 8 FPS). Server numbers are never trusted for allocations
//! or timing: dimensions and byte limits are clamped to the local maximums,
//! and the capture cadence has a local lower bound.

use serde_json::Value;

/// Local maximum frame dimensions (the server's `MaxWidth`/`MaxHeight`).
pub const MAX_WIDTH: u32 = 960;
/// Local maximum frame dimensions (the server's `MaxWidth`/`MaxHeight`).
pub const MAX_HEIGHT: u32 = 540;
/// Local maximum encoded frame bytes (the server's `MaxFrameBytes`).
pub const MAX_FRAME_BYTES: usize = 100 * 1024;
/// Lower bound for the capture cadence: a faster server interval never speeds
/// captures beyond the protocol's 100 ms minimum.
pub const MIN_FRAME_INTERVAL_MILLIS: u64 = 100;
/// Safe defaults for older servers and missing capability fields.
pub const DEFAULT_FRAME_INTERVAL_MILLIS: u64 = 125;
pub const DEFAULT_WIDTH: u32 = 640;
pub const DEFAULT_HEIGHT: u32 = 360;
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

/// TCLS version 2 header length.
///
/// Layout (big-endian): 4 magic bytes, version 2, profile code, flags (bit
/// 0 keyframe; other bits zero), one reserved zero byte, 16 session UUID
/// bytes, u64 sequence, u64 timestamp in microseconds, u16 width, u16
/// height, u32 payload length.
pub const TCLS_V2_HEADER_LEN: usize = 48;
/// TCLS version for one H.264 access unit.
pub const TCLS_VERSION_H264: u8 = 2;
/// Largest H.264 access unit a TCLS version 2 message carries.
pub const MAX_ACCESS_UNIT_BYTES: usize = 512 * 1024;
/// The WebCodecs codec string of every H.264 profile: Constrained
/// Baseline, level 3.1 (enough for 1280x720 at 15 FPS).
pub const H264_CODEC: &str = "avc1.42e01f";

/// How a Watch Live profile reaches Studio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WatchLiveTransport {
    Mjpeg,
    H264,
}

/// One negotiated Watch Live mode. The declaration order is the preference
/// order, best first, so `a < b` means `a` is the better profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum WatchLiveProfile {
    H264_720p15,
    H264_540p15,
    H264_540p10,
    Mjpeg540p10,
    Mjpeg360p8,
}

impl WatchLiveProfile {
    /// Every profile, best first.
    pub const ALL: [WatchLiveProfile; 5] =
        [Self::H264_720p15, Self::H264_540p15, Self::H264_540p10, Self::Mjpeg540p10, Self::Mjpeg360p8];

    pub fn id(self) -> &'static str {
        match self {
            Self::H264_720p15 => "h264-720p15",
            Self::H264_540p15 => "h264-540p15",
            Self::H264_540p10 => "h264-540p10",
            Self::Mjpeg540p10 => "mjpeg-540p10",
            Self::Mjpeg360p8 => "mjpeg-360p8",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|profile| profile.id() == id)
    }

    /// The TCLS version 2 profile code; zero for MJPEG profiles.
    pub fn code(self) -> u8 {
        match self {
            Self::H264_720p15 => 1,
            Self::H264_540p15 => 2,
            Self::H264_540p10 => 3,
            Self::Mjpeg540p10 | Self::Mjpeg360p8 => 0,
        }
    }

    pub fn transport(self) -> WatchLiveTransport {
        if self.code() == 0 { WatchLiveTransport::Mjpeg } else { WatchLiveTransport::H264 }
    }

    pub fn max_dimensions(self) -> (u32, u32) {
        match self {
            Self::H264_720p15 => (1280, 720),
            Self::H264_540p15 | Self::H264_540p10 | Self::Mjpeg540p10 => (960, 540),
            Self::Mjpeg360p8 => (640, 360),
        }
    }

    pub fn fps(self) -> u32 {
        match self {
            Self::H264_720p15 | Self::H264_540p15 => 15,
            Self::H264_540p10 | Self::Mjpeg540p10 => 10,
            Self::Mjpeg360p8 => 8,
        }
    }

    pub fn frame_interval_millis(self) -> u64 {
        match self.fps() {
            15 => 67,
            10 => 100,
            _ => 125,
        }
    }

    /// Initial encoder target in bits per second; zero for MJPEG.
    pub fn target_bitrate(self) -> u32 {
        match self {
            Self::H264_720p15 => 1_500_000,
            Self::H264_540p15 => 900_000,
            Self::H264_540p10 => 700_000,
            Self::Mjpeg540p10 | Self::Mjpeg360p8 => 0,
        }
    }
}

/// The profiles a Player can produce now, in preference order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchLiveCapabilities {
    profiles: Vec<WatchLiveProfile>,
}

impl WatchLiveCapabilities {
    /// What every Player can do: the legacy 640x360 MJPEG profile.
    pub fn legacy() -> Self {
        Self { profiles: vec![WatchLiveProfile::Mjpeg360p8] }
    }

    /// A sorted, de-duplicated set that always keeps the legacy profile.
    pub fn new(profiles: impl IntoIterator<Item = WatchLiveProfile>) -> Self {
        let mut profiles: Vec<_> = profiles.into_iter().chain([WatchLiveProfile::Mjpeg360p8]).collect();
        profiles.sort();
        profiles.dedup();
        Self { profiles }
    }

    pub fn profiles(&self) -> &[WatchLiveProfile] {
        &self.profiles
    }

    pub fn contains(&self, profile: WatchLiveProfile) -> bool {
        self.profiles.contains(&profile)
    }

    /// Only the profiles worse than `profile`: what a session that degraded
    /// out of `profile` still offers.
    pub fn below(&self, profile: WatchLiveProfile) -> Self {
        Self::new(self.profiles.iter().copied().filter(|candidate| *candidate > profile))
    }

    /// The session GET query: one repeated `profile` value per profile. An
    /// older server ignores it; `captureProfile=edge-540p10` keeps 960x540
    /// MJPEG on an older server for a Player that can capture it.
    pub fn query(&self) -> String {
        let mut query = self.profiles.iter().map(|profile| format!("profile={}", profile.id())).collect::<Vec<_>>();
        if self.contains(WatchLiveProfile::Mjpeg540p10) {
            query.push("captureProfile=edge-540p10".to_owned());
        }
        query.join("&")
    }
}

/// What the Player must produce for a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamMode {
    /// TCLS version 1 JPEG frames within these bounds.
    Mjpeg { frame_interval_millis: u64, max_width: u32, max_height: u32, max_frame_bytes: usize },
    /// TCLS version 2 H.264 access units for this profile.
    H264(WatchLiveProfile),
}

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
    /// The selected profile, when the server negotiated one. `None` from an
    /// older server, which only ever means MJPEG.
    pub profile: Option<WatchLiveProfile>,
    /// Increases each time the server degrades the session.
    pub profile_generation: u64,
}

impl Default for LiveStreamSession {
    fn default() -> Self {
        Self {
            id: None,
            active: false,
            expires_at: None,
            frame_interval_millis: DEFAULT_FRAME_INTERVAL_MILLIS,
            max_width: DEFAULT_WIDTH,
            max_height: DEFAULT_HEIGHT,
            max_frame_bytes: MAX_FRAME_BYTES,
            profile: None,
            profile_generation: 0,
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
        let Ok(expires) = player_types::Timestamp::parse(expires_at) else {
            return false;
        };
        expires.unix_millis() > now_unix_millis
    }

    /// What this session asks the Player to produce. H.264 is used only when
    /// the server explicitly selected an H.264 profile; anything else is the
    /// MJPEG path within the parsed bounds.
    pub fn mode(&self) -> StreamMode {
        match self.profile {
            Some(profile) if profile.transport() == WatchLiveTransport::H264 => StreamMode::H264(profile),
            _ => StreamMode::Mjpeg {
                frame_interval_millis: self.frame_interval_millis,
                max_width: self.max_width,
                max_height: self.max_height,
                max_frame_bytes: self.max_frame_bytes,
            },
        }
    }
}

/// Parses `GET /api/v1/player/live-stream-session` data. Unknown or
/// out-of-range server numbers fail closed to the local bounds; a malformed
/// session ID or timestamp deactivates the session rather than producing a
/// partial one.
pub(crate) fn live_stream_session(data: &Value) -> LiveStreamSession {
    let active = data.get("active").and_then(Value::as_bool).unwrap_or(false);
    let id =
        data.get("id").and_then(Value::as_str).and_then(|value| player_types::ids::parse_canonical_uuid(value).ok());
    let expires_at = data.get("expiresAt").and_then(Value::as_str).map(str::to_owned);
    let frame_interval_millis = data
        .get("frameIntervalMillis")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_FRAME_INTERVAL_MILLIS, |millis| millis.max(MIN_FRAME_INTERVAL_MILLIS));
    let max_width = data
        .get("maxWidth")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_WIDTH, |width| (width.min(u64::from(MAX_WIDTH)) as u32).max(1));
    let max_height = data
        .get("maxHeight")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_HEIGHT, |height| (height.min(u64::from(MAX_HEIGHT)) as u32).max(1));
    let max_frame_bytes = data
        .get("maxFrameBytes")
        .and_then(Value::as_u64)
        .map_or(MAX_FRAME_BYTES, |bytes| (bytes.min(MAX_FRAME_BYTES as u64) as usize).max(1));
    let profile_generation = data.get("profileGeneration").and_then(Value::as_u64).unwrap_or(0);
    let mut session = LiveStreamSession {
        id,
        active,
        expires_at,
        frame_interval_millis,
        max_width,
        max_height,
        max_frame_bytes,
        profile: None,
        profile_generation,
    };
    // An unknown profile is a newer server's vocabulary: stay on MJPEG. An
    // H.264 profile must be stated consistently (transport and codec), or
    // the session fails closed: the Player never guesses an encoding.
    if let Some(profile) = data.get("profile").and_then(Value::as_str).and_then(WatchLiveProfile::from_id) {
        let transport = data.get("transport").and_then(Value::as_str);
        match profile.transport() {
            WatchLiveTransport::H264 => {
                if transport == Some("h264") && data.get("codec").and_then(Value::as_str) == Some(H264_CODEC) {
                    session.profile = Some(profile);
                } else {
                    session.active = false;
                }
            }
            WatchLiveTransport::Mjpeg => {
                if transport.is_none_or(|transport| transport == "mjpeg") {
                    session.profile = Some(profile);
                } else {
                    session.active = false;
                }
            }
        }
    }
    if !session.active || session.id.is_none() {
        session.active = false;
        session.id = None;
    }
    session
}

/// A lightweight Annex B check, mirroring the server: the access unit
/// starts with a start code, NAL headers are well formed, a keyframe
/// carries SPS and PPS before its IDR slice, and a delta access unit carries
/// a non-IDR slice and no IDR slice.
pub fn is_valid_access_unit(payload: &[u8], keyframe: bool) -> bool {
    if payload.len() < 4 || payload.len() > MAX_ACCESS_UNIT_BYTES {
        return false;
    }
    if !(payload.starts_with(&[0, 0, 1]) || payload.starts_with(&[0, 0, 0, 1])) {
        return false;
    }
    let (mut sps, mut pps, mut idr, mut slice) = (false, false, false, false);
    let mut offset = 0;
    while let Some(index) = payload[offset..].windows(3).position(|window| window == [0, 0, 1]) {
        let header = offset + index + 3;
        let Some(&nal) = payload.get(header) else { return false };
        if nal & 0x80 != 0 {
            return false;
        }
        match nal & 0x1f {
            7 => sps = true,
            8 => pps = true,
            5 => {
                if !sps || !pps {
                    return false;
                }
                idr = true;
            }
            1 => slice = true,
            _ => {}
        }
        offset = header + 1;
    }
    if keyframe { sps && pps && idr } else { slice && !idr }
}

/// One TCLS version 2 message's header fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkHeader {
    pub session_id: uuid::Uuid,
    pub profile: WatchLiveProfile,
    pub sequence: u64,
    pub timestamp_micros: u64,
    pub width: u32,
    pub height: u32,
    pub keyframe: bool,
}

/// Encodes one TCLS version 2 message. Returns `None` without allocating
/// when the inputs cannot produce a packet the server would accept.
pub fn encode_live_stream_chunk(header: &ChunkHeader, access_unit: &[u8]) -> Option<Vec<u8>> {
    let (max_width, max_height) = header.profile.max_dimensions();
    if header.profile.transport() != WatchLiveTransport::H264
        || header.session_id.is_nil()
        || header.width < 16
        || header.height < 16
        || !header.width.is_multiple_of(2)
        || !header.height.is_multiple_of(2)
        || header.width > max_width
        || header.height > max_height
        || header.timestamp_micros > 1 << 53
        || !is_valid_access_unit(access_unit, header.keyframe)
    {
        return None;
    }
    let mut packet = Vec::with_capacity(TCLS_V2_HEADER_LEN + access_unit.len());
    packet.extend_from_slice(&TCLS_MAGIC);
    packet.push(TCLS_VERSION_H264);
    packet.push(header.profile.code());
    packet.push(u8::from(header.keyframe));
    packet.push(0);
    packet.extend_from_slice(header.session_id.as_bytes());
    packet.extend_from_slice(&header.sequence.to_be_bytes());
    packet.extend_from_slice(&header.timestamp_micros.to_be_bytes());
    packet.extend_from_slice(&(header.width as u16).to_be_bytes());
    packet.extend_from_slice(&(header.height as u16).to_be_bytes());
    packet.extend_from_slice(&(access_unit.len() as u32).to_be_bytes());
    debug_assert_eq!(packet.len(), TCLS_V2_HEADER_LEN);
    packet.extend_from_slice(access_unit);
    Some(packet)
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

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../packages/player-contracts/fixtures/watch-live.json")).unwrap()
    }

    fn hex(value: &str) -> Vec<u8> {
        (0..value.len()).step_by(2).map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn profiles_match_the_shared_corpus() {
        let fixture = fixture();
        assert_eq!(fixture["codec"], H264_CODEC);
        assert_eq!(fixture["maxAccessUnitBytes"], MAX_ACCESS_UNIT_BYTES);
        assert_eq!(fixture["maxMjpegFrameBytes"], MAX_FRAME_BYTES);
        assert_eq!(fixture["tclsV2HeaderBytes"], TCLS_V2_HEADER_LEN);
        let profiles = fixture["profiles"].as_array().unwrap();
        assert_eq!(profiles.len(), WatchLiveProfile::ALL.len());
        for (want, profile) in profiles.iter().zip(WatchLiveProfile::ALL) {
            assert_eq!(want["id"], profile.id());
            assert_eq!(want["code"], profile.code());
            assert_eq!(
                want["transport"],
                if profile.transport() == WatchLiveTransport::H264 { "h264" } else { "mjpeg" }
            );
            assert_eq!(
                (want["maxWidth"].as_u64().unwrap() as u32, want["maxHeight"].as_u64().unwrap() as u32),
                profile.max_dimensions()
            );
            assert_eq!(want["fps"], profile.fps());
            assert_eq!(want["frameIntervalMillis"], profile.frame_interval_millis());
            assert_eq!(want["targetBitrate"], profile.target_bitrate());
            assert_eq!(WatchLiveProfile::from_id(profile.id()), Some(profile));
        }
    }

    #[test]
    fn tcls_v2_matches_the_shared_vectors_and_refuses_invalid_access_units() {
        let fixture = fixture();
        for vector in fixture["tclsV2"]["valid"].as_array().unwrap() {
            let header = ChunkHeader {
                session_id: vector["sessionId"].as_str().unwrap().parse().unwrap(),
                profile: WatchLiveProfile::from_id(vector["profile"].as_str().unwrap()).unwrap(),
                sequence: vector["sequence"].as_u64().unwrap(),
                timestamp_micros: vector["timestampMicros"].as_u64().unwrap(),
                width: vector["width"].as_u64().unwrap() as u32,
                height: vector["height"].as_u64().unwrap() as u32,
                keyframe: vector["keyframe"].as_bool().unwrap(),
            };
            let packet = encode_live_stream_chunk(&header, &hex(vector["payloadHex"].as_str().unwrap())).unwrap();
            assert_eq!(packet, hex(vector["packetHex"].as_str().unwrap()), "{}", vector["name"]);
        }
        for vector in fixture["tclsV2"]["invalid"].as_array().unwrap() {
            let payload = hex(vector["payloadHex"].as_str().unwrap());
            assert!(!is_valid_access_unit(&payload, vector["keyframe"].as_bool().unwrap()), "{}", vector["name"]);
        }
    }

    #[test]
    fn tcls_v2_refuses_headers_the_server_would_reject() {
        let key = hex("0000000167420028ffff0000000168ce3c800000016588840000");
        let base = ChunkHeader {
            session_id: SESSION_ID.parse().unwrap(),
            profile: WatchLiveProfile::H264_540p15,
            sequence: 1,
            timestamp_micros: 0,
            width: 960,
            height: 540,
            keyframe: true,
        };
        assert!(encode_live_stream_chunk(&base, &key).is_some());
        for header in [
            ChunkHeader { profile: WatchLiveProfile::Mjpeg540p10, ..base },
            ChunkHeader { session_id: uuid::Uuid::nil(), ..base },
            ChunkHeader { width: 1280, height: 720, ..base },
            ChunkHeader { width: 959, ..base },
            ChunkHeader { width: 8, height: 8, ..base },
            ChunkHeader { keyframe: false, ..base },
            ChunkHeader { timestamp_micros: u64::MAX, ..base },
        ] {
            assert!(encode_live_stream_chunk(&header, &key).is_none(), "{header:?}");
        }
        let oversized = [key.clone(), vec![0; MAX_ACCESS_UNIT_BYTES]].concat();
        assert!(encode_live_stream_chunk(&base, &oversized).is_none());
    }

    #[test]
    fn capabilities_query_is_bounded_and_keeps_older_servers_working() {
        let all = WatchLiveCapabilities::new(WatchLiveProfile::ALL);
        assert_eq!(
            all.query(),
            "profile=h264-720p15&profile=h264-540p15&profile=h264-540p10&profile=mjpeg-540p10&profile=mjpeg-360p8&captureProfile=edge-540p10"
        );
        assert_eq!(WatchLiveCapabilities::legacy().query(), "profile=mjpeg-360p8");
        let degraded = all.below(WatchLiveProfile::H264_720p15);
        assert!(!degraded.contains(WatchLiveProfile::H264_720p15) && degraded.contains(WatchLiveProfile::H264_540p15));
        let mjpeg = all.below(WatchLiveProfile::H264_540p10);
        assert_eq!(mjpeg.profiles(), [WatchLiveProfile::Mjpeg540p10, WatchLiveProfile::Mjpeg360p8]);
        assert_eq!(all.below(WatchLiveProfile::Mjpeg360p8).profiles(), [WatchLiveProfile::Mjpeg360p8]);
    }

    fn active(extra: serde_json::Value) -> LiveStreamSession {
        let mut data = serde_json::json!({
            "id": SESSION_ID, "active": true, "expiresAt": "2026-07-30T12:00:15Z",
            "frameIntervalMillis": 67, "maxWidth": 1280, "maxHeight": 720, "maxFrameBytes": 524288,
        });
        data.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        live_stream_session(&data)
    }

    #[test]
    fn h264_is_used_only_when_the_server_selects_it_consistently() {
        let h264 = active(serde_json::json!({
            "profile": "h264-720p15", "transport": "h264", "codec": H264_CODEC, "profileGeneration": 2,
        }));
        assert!(h264.active);
        assert_eq!(h264.mode(), StreamMode::H264(WatchLiveProfile::H264_720p15));
        assert_eq!(h264.profile_generation, 2);
        // An older server says nothing about profiles: MJPEG within the
        // local bounds, never TCLS version 2.
        let old = active(serde_json::json!({}));
        assert!(old.active);
        assert!(matches!(old.mode(), StreamMode::Mjpeg { max_width: MAX_WIDTH, max_height: MAX_HEIGHT, .. }));
        let unknown = active(serde_json::json!({"profile": "av1-1080p30", "transport": "av1"}));
        assert!(unknown.active && matches!(unknown.mode(), StreamMode::Mjpeg { .. }));
        for inconsistent in [
            serde_json::json!({"profile": "h264-720p15", "transport": "mjpeg", "codec": H264_CODEC}),
            serde_json::json!({"profile": "h264-720p15", "transport": "h264"}),
            serde_json::json!({"profile": "h264-720p15", "transport": "h264", "codec": "avc1.640028"}),
            serde_json::json!({"profile": "mjpeg-540p10", "transport": "h264"}),
        ] {
            assert!(!active(inconsistent.clone()).active, "{inconsistent}");
        }
        let mjpeg = active(serde_json::json!({"profile": "mjpeg-540p10", "transport": "mjpeg"}));
        assert_eq!(mjpeg.profile, Some(WatchLiveProfile::Mjpeg540p10));
        assert!(matches!(mjpeg.mode(), StreamMode::Mjpeg { .. }));
    }

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
        assert!(encode_live_stream_frame(&session_id, 1, 961, 360, &jpeg).is_none());
        assert!(encode_live_stream_frame(&session_id, 1, 640, 541, &jpeg).is_none());
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
        let expiry = player_types::Timestamp::parse("2026-07-30T12:00:15Z").unwrap().unix_millis();
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
        assert_eq!(empty.frame_interval_millis, DEFAULT_FRAME_INTERVAL_MILLIS);
    }
}
