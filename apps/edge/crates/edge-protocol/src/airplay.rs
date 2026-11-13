//! The control protocol of the AirPlay supervisor, `tilecast-airplay`
//! (docs/tilecast-edge-airplay.md §4.2).
//!
//! # Transport
//!
//! `tilecast-airplay.socket` listens on [`DEFAULT_SOCKET`] (`root:tilecast`,
//! 0660). The supervisor accepts one connection, from the `tilecast` account
//! in `tilecast-edge.service` only. When that connection closes, the
//! supervisor stops UxPlay and exits.
//!
//! # Framing
//!
//! One JSON object and a newline per message, at most [`MAX_LINE_BYTES`]
//! including the newline, in both directions. A message has a string `type`
//! member and no unknown members. `tilecastd` sends [`ControlRequest`]s; the
//! supervisor sends [`ControlEvent`]s. A line that does not decode is fatal:
//! the supervisor sends [`ControlEvent::Rejected`], stops UxPlay and closes.
//!
//! The supervisor and `tilecastd` come from the same release, and an update
//! restarts both, so the protocol has no version negotiation. A change to a
//! message is a change of this module, its fixtures in
//! `packages/edge-protocol/fixtures/airplay`, and both sides in one release.
//!
//! # Values
//!
//! No message carries a path, a program name, an option string or an
//! address. The two RTP ports are fixed ([`VIDEO_RTP_PORT`],
//! [`AUDIO_RTP_PORT`]); any other value does not decode. The PIN and the
//! device ID are secrets: their `Debug` output is redacted, and they must
//! never be logged.

use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::bounded::{SafeText, ShortToken};

/// The supervisor's socket (`tilecast-airplay.socket`).
pub const DEFAULT_SOCKET: &str = "/run/tilecast-airplay/control.sock";
/// The largest line in either direction, including the newline.
pub const MAX_LINE_BYTES: usize = 4096;
/// The forwarded H.264 RTP port on `127.0.0.1` (the AirPlay firewall
/// contract in docs/airplay-present.md).
pub const VIDEO_RTP_PORT: u16 = 42_000;
/// The forwarded L16 audio RTP port on `127.0.0.1`.
pub const AUDIO_RTP_PORT: u16 = 42_002;
/// UxPlay's AirPlay control and media ports, TCP and UDP.
pub const UXPLAY_PORTS: [u16; 3] = [37_000, 37_001, 37_002];
/// The Server limits a receiver name to 120 characters
/// (`cleanAirplayReceiverName`).
pub const MAX_RECEIVER_NAME_CHARS: usize = 120;
/// The UxPlay version that an Edge release carries.
pub const UXPLAY_BASELINE: &str = "1.73.7";

/// A version string, for example `1.73.7`.
pub type VersionText = SafeText<32>;

// ------------------------------------------------------------ values

/// Why a value was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ValueError {
    #[error("the session ID is not a canonical UUID")]
    SessionId,
    #[error("the receiver name is empty, too long, or has a character that is not allowed")]
    ReceiverName,
    #[error("the PIN is not four digits")]
    Pin,
    #[error("the device ID is not a locally administered unicast MAC address")]
    DeviceId,
    #[error("the port is not the fixed RTP port")]
    Port,
}

/// A Server session ID: a UUID in its canonical lowercase hyphenated form.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SessionId(String);

impl SessionId {
    pub fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = value.into();
        let canonical = uuid::Uuid::try_parse(&value).map_err(|_| ValueError::SessionId)?.hyphenated().to_string();
        if canonical == value { Ok(Self(value)) } else { Err(ValueError::SessionId) }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The name that AirPlay senders show.
///
/// The supervisor writes it into UxPlay's `-rc` startup file. That file has
/// one option per line, and UxPlay splits a line into words at spaces unless
/// a word is quoted with `"` or `'`. A quoted word ends at its quote
/// character when a space or the end of the line follows. So the name must
/// have no line break and no control character (no second option), must not
/// start with `-` (UxPlay reads that as a missing value), and must not have
/// both quote characters (then no quote character can enclose it without a
/// way to end the word early). Leading and trailing white space is refused,
/// because the Server trims it.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ReceiverName(String);

impl ReceiverName {
    pub fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = value.into();
        let count = value.chars().count();
        let allowed = (1..=MAX_RECEIVER_NAME_CHARS).contains(&count)
            && !value.chars().any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
            && !value.starts_with(char::is_whitespace)
            && !value.ends_with(char::is_whitespace)
            && !value.starts_with('-')
            && !(value.contains('"') && value.contains('\''));
        if allowed { Ok(Self(value)) } else { Err(ValueError::ReceiverName) }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The quote character that encloses this name in the `-rc` file: the
    /// one that the name does not contain.
    pub fn rc_quote(&self) -> char {
        if self.0.contains('"') { '\'' } else { '"' }
    }
}

impl fmt::Debug for ReceiverName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

/// The four-digit session PIN. A secret: never logged.
#[derive(Clone, PartialEq, Eq)]
pub struct AirplayPin(String);

impl AirplayPin {
    pub fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = value.into();
        if value.len() == 4 && value.bytes().all(|b| b.is_ascii_digit()) {
            Ok(Self(value))
        } else {
            Err(ValueError::Pin)
        }
    }

    /// The digits, for UxPlay's `-rc` file only.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AirplayPin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AirplayPin(<redacted>)")
    }
}

/// The session's AirPlay device ID: a locally administered unicast MAC
/// address, new for each session. A secret: never logged.
#[derive(Clone, PartialEq, Eq)]
pub struct AirplayDeviceId(String);

impl AirplayDeviceId {
    pub fn new(value: impl Into<String>) -> Result<Self, ValueError> {
        let value = value.into();
        let bytes = value.as_bytes();
        let shape = bytes.len() == 17
            && bytes.iter().enumerate().all(|(i, b)| if i % 3 == 2 { *b == b':' } else { b.is_ascii_hexdigit() });
        if !shape {
            return Err(ValueError::DeviceId);
        }
        let first = u8::from_str_radix(&value[..2], 16).map_err(|_| ValueError::DeviceId)?;
        if first & 0x02 == 0 || first & 0x01 != 0 {
            return Err(ValueError::DeviceId);
        }
        Ok(Self(value))
    }

    /// The address, for UxPlay's `-rc` file only.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AirplayDeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AirplayDeviceId(<redacted>)")
    }
}

macro_rules! string_value {
    ($($name:ident),*) => {$(
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
            }
        }
    )*};
}

string_value!(SessionId, ReceiverName, AirplayPin, AirplayDeviceId);

/// The mirrored video profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VideoProfile {
    #[serde(rename = "1080p30")]
    P1080p30,
    #[serde(rename = "720p30")]
    P720p30,
}

impl VideoProfile {
    /// Width, height and frames per second.
    pub fn dimensions(self) -> (u16, u16, u8) {
        match self {
            Self::P1080p30 => (1920, 1080, 30),
            Self::P720p30 => (1280, 720, 30),
        }
    }
}

/// Whether UxPlay forwards the sender's audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioMode {
    /// Forward audio as L16 RTP to [`AUDIO_RTP_PORT`].
    GatewayOnly,
    /// No audio (`-as 0`).
    None,
}

macro_rules! fixed_port {
    ($name:ident, $value:expr) => {
        #[doc = concat!("A port that decodes only as `", stringify!($value), "`.")]
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $name;

        impl $name {
            pub const fn get(self) -> u16 {
                $value
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_u16($value)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                if u16::deserialize(deserializer)? == $value {
                    Ok(Self)
                } else {
                    Err(D::Error::custom(ValueError::Port))
                }
            }
        }
    };
}

fixed_port!(VideoRtpPort, VIDEO_RTP_PORT);
fixed_port!(AudioRtpPort, AUDIO_RTP_PORT);

// ------------------------------------------------------------ messages

/// What `tilecastd` asks the supervisor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ControlRequest {
    /// Start UxPlay for a session. A `start` for the session that already
    /// runs is answered again with its current state and changes nothing.
    Start {
        session_id: SessionId,
        receiver_name: ReceiverName,
        pin: AirplayPin,
        device_id: AirplayDeviceId,
        profile: VideoProfile,
        audio_mode: AudioMode,
        video_port: VideoRtpPort,
        audio_port: AudioRtpPort,
    },
    /// Stop UxPlay for a session. Stopping a session that does not run is
    /// answered with `stopped`.
    Stop { session_id: SessionId },
    /// Report whether UxPlay and avahi-daemon are usable.
    Probe {},
}

/// What the supervisor reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ControlEvent {
    /// The answer to `probe`. `limitation` is the first failed dependency as
    /// a stable code ([`limitation`]); it is absent when AirPlay can run.
    /// The renderer reports the H.264 decoder, because UxPlay does not
    /// decode in RTP mode.
    ProbeResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uxplay_version: Option<VersionText>,
        avahi_available: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limitation: Option<ShortToken>,
    },
    /// UxPlay runs and its server sockets are open.
    Advertising { session_id: SessionId },
    /// A sender started mirroring.
    ClientConnected { session_id: SessionId },
    /// The sender stopped mirroring or its connection was lost.
    ClientDisconnected { session_id: SessionId },
    /// The session cannot continue. UxPlay is stopped. `code` is a stable
    /// code ([`failure`]).
    Failed { session_id: SessionId, code: ShortToken },
    /// UxPlay for the session has stopped.
    Stopped { session_id: SessionId },
    /// The last request was malformed. The supervisor closes the connection
    /// after this event.
    Rejected { code: ShortToken },
}

/// The stable `limitation` codes of `probe_result`, in the order in which
/// they are checked (the Electron Player's order).
pub mod limitation {
    pub const UXPLAY_MISSING: &str = "uxplay_missing";
    pub const UXPLAY_NOT_EXECUTABLE: &str = "uxplay_not_executable";
    pub const UXPLAY_VERSION_FAILED: &str = "uxplay_version_failed";
    pub const UXPLAY_VERSION_UNRECOGNIZED: &str = "uxplay_version_unrecognized";
    pub const UXPLAY_VERSION_UNSUPPORTED: &str = "uxplay_version_unsupported";
    pub const AVAHI_UNAVAILABLE: &str = "avahi_unavailable";
}

/// The stable `failed` and `rejected` codes.
pub mod failure {
    /// A line did not decode as a request.
    pub const INVALID_REQUEST: &str = "invalid_request";
    /// `start` for a second session while one runs.
    pub const SESSION_ACTIVE: &str = "session_active";
    /// The `-rc` file could not be written.
    pub const SESSION_FILE_FAILED: &str = "session_file_failed";
    /// UxPlay could not be started.
    pub const UXPLAY_START_FAILED: &str = "uxplay_start_failed";
    /// UxPlay did not open its server sockets in time.
    pub const UXPLAY_START_TIMEOUT: &str = "uxplay_start_timeout";
    /// UxPlay exited during the session.
    pub const UXPLAY_EXITED: &str = "uxplay_exited";
    /// `rejected`: another connection is being served.
    pub const CONNECTION_BUSY: &str = "connection_busy";
    /// `rejected`: the peer is not `tilecastd` (`edge_platform::peer`).
    pub const PEER_NOT_ALLOWED: &str = "peer_not_allowed";
    /// `rejected`: the peer's credentials could not be read.
    pub const PEER_UNKNOWN: &str = "peer_unknown";
}

impl ControlRequest {
    pub fn decode(line: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(line)
    }
}

impl ControlEvent {
    pub fn decode(line: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(line)
    }

    /// A `failed` event with a code from [`failure`].
    pub fn failed(session_id: &SessionId, code: &'static str) -> Self {
        Self::Failed { session_id: session_id.clone(), code: token(code) }
    }

    /// The session that the event is about, if any.
    pub fn session_id(&self) -> Option<&SessionId> {
        match self {
            Self::Advertising { session_id }
            | Self::ClientConnected { session_id }
            | Self::ClientDisconnected { session_id }
            | Self::Failed { session_id, .. }
            | Self::Stopped { session_id } => Some(session_id),
            Self::ProbeResult { .. } | Self::Rejected { .. } => None,
        }
    }
}

/// A token from one of this module's constant code lists.
pub fn token(code: &'static str) -> ShortToken {
    ShortToken::new(code).unwrap_or_else(|_| unreachable!("code constants are valid tokens"))
}

/// Encodes a message as one line, newline included. `None` if it would be
/// longer than [`MAX_LINE_BYTES`].
pub fn encode_line<T: Serialize>(message: &T) -> Option<Vec<u8>> {
    let mut bytes = serde_json::to_vec(message).ok()?;
    bytes.push(b'\n');
    (bytes.len() <= MAX_LINE_BYTES).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receiver_names_that_could_add_an_option_are_refused() {
        for good in ["Lobby", "Room 204 \"North\"", "Café l'Été", "Board Room", "a", &"x".repeat(120)] {
            assert!(ReceiverName::new(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "Lobby\nvs autovideosink",
            "Lobby\rpin 0000",
            "Tab\there",
            "Line\u{2028}sep",
            "-Lobby",
            " Lobby",
            "Lobby ",
            "Both \" and '",
            &"x".repeat(121),
        ] {
            assert_eq!(ReceiverName::new(bad), Err(ValueError::ReceiverName), "{bad:?}");
        }
        assert_eq!(ReceiverName::new("Room \"A\"").unwrap().rc_quote(), '\'');
        assert_eq!(ReceiverName::new("Kim's room").unwrap().rc_quote(), '"');
    }

    #[test]
    fn pins_and_device_ids_are_strict_and_redacted() {
        assert!(AirplayPin::new("0420").is_ok());
        for bad in ["420", "04200", "04a0", "٠١٢٣", " 042"] {
            assert!(AirplayPin::new(bad).is_err(), "{bad}");
        }
        assert!(AirplayDeviceId::new("02:1a:2b:3c:4d:5e").is_ok());
        assert!(AirplayDeviceId::new("0A:1A:2B:3C:4D:5E").is_ok());
        for bad in
            ["00:1a:2b:3c:4d:5e", "03:1a:2b:3c:4d:5e", "02-1a-2b-3c-4d-5e", "02:1a:2b:3c:4d", "02:1a:2b:3c:4d:5g"]
        {
            assert!(AirplayDeviceId::new(bad).is_err(), "{bad}");
        }
        let request = ControlRequest::Start {
            session_id: SessionId::new("3f2504e0-4f89-41d3-9a0c-0305e82c3301").unwrap(),
            receiver_name: ReceiverName::new("Lobby").unwrap(),
            pin: AirplayPin::new("7319").unwrap(),
            device_id: AirplayDeviceId::new("02:1a:2b:3c:4d:5e").unwrap(),
            profile: VideoProfile::P1080p30,
            audio_mode: AudioMode::GatewayOnly,
            video_port: VideoRtpPort,
            audio_port: AudioRtpPort,
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("7319") && !debug.contains("1a:2b"), "{debug}");
    }

    #[test]
    fn session_ids_must_be_canonical() {
        assert!(SessionId::new("3f2504e0-4f89-41d3-9a0c-0305e82c3301").is_ok());
        for bad in [
            "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
            "3f2504e04f8941d39a0c0305e82c3301",
            "{3f2504e0-4f89-41d3-9a0c-0305e82c3301}",
            "urn:uuid:3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        ] {
            assert!(SessionId::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn every_code_is_a_token() {
        for code in [
            limitation::UXPLAY_MISSING,
            limitation::UXPLAY_NOT_EXECUTABLE,
            limitation::UXPLAY_VERSION_FAILED,
            limitation::UXPLAY_VERSION_UNRECOGNIZED,
            limitation::UXPLAY_VERSION_UNSUPPORTED,
            limitation::AVAHI_UNAVAILABLE,
            failure::INVALID_REQUEST,
            failure::SESSION_ACTIVE,
            failure::SESSION_FILE_FAILED,
            failure::UXPLAY_START_FAILED,
            failure::UXPLAY_START_TIMEOUT,
            failure::UXPLAY_EXITED,
            failure::CONNECTION_BUSY,
            failure::PEER_NOT_ALLOWED,
            failure::PEER_UNKNOWN,
        ] {
            assert!(ShortToken::new(code).is_ok(), "{code}");
        }
    }
}
