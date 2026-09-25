//! Tilecast Edge local IPC, protocol version 1.
//!
//! This is the contract between `tilecastd` and local clients: the WPE
//! renderer (`tilecast-renderer-wpe`), `tilecastctl`, and the user-session
//! bridge (`tilecast-session-bridge`). It is renderer-engine neutral; nothing here is WPE-specific.
//!
//! # Transport
//!
//! AF_UNIX stream socket, default `/run/tilecast-edge/edge.sock`, owned
//! `tilecast:tilecast`, mode `0660`. The daemon additionally checks the peer
//! UID with `SO_PEERCRED` and rejects UIDs outside its allowlist even when the
//! filesystem permissions would admit them.
//!
//! # Framing ([`frame`])
//!
//! ```text
//! u32 big-endian payload length | payload: one UTF-8 JSON object
//! ```
//!
//! * A length of 0 or greater than [`MAX_FRAME_BYTES`] (4 MiB) is a fatal
//!   protocol error; the receiver closes without reading the payload.
//! * The payload must be a JSON object with a string `type` member.
//! * Every frame type rejects unknown members and malformed field types.
//!
//! # Handshake and version negotiation
//!
//! 1. The client sends [`message::Hello`] as its first frame, within
//!    [`HANDSHAKE_TIMEOUT_MS`]. Anything else first is fatal.
//! 2. The daemon chooses the highest version in both
//!    `[client.min, client.max]` and `[DAEMON_MIN, DAEMON_MAX]`
//!    ([`negotiate_version`]). With no overlap it replies
//!    [`message::Rejected`] with code `unsupported_protocol_version` and the
//!    range it supports, then closes. Unknown versions fail closed.
//! 3. The daemon checks the role against the peer UID. A role that is not
//!    permitted or not yet enabled is rejected the same way.
//! 4. Otherwise it replies [`message::Welcome`] with the negotiated version,
//!    the session's features (the intersection of what the client asked for
//!    and what the daemon supports for that role), and limits. Unknown
//!    requested features are ignored, not errors: features are how optional
//!    behavior is added inside a protocol version.
//!
//! # After the handshake
//!
//! * **Requests** flow client → daemon only and carry a client-chosen `id`
//!   (≤ 64 characters). Each gets exactly one **response** with the same
//!   `id`, either `result` or `error`. The daemon never sends requests.
//! * **Events** flow in either direction, are fire-and-forget, and carry a
//!   per-direction `seq` that starts at 1 and increases by one. A gap or
//!   repeat in received `seq` is a protocol error (it means a buggy peer, not
//!   a lossy link: the stream is reliable).
//! * Each event and method names its permitted roles and direction. Anything
//!   else is a protocol error, answered with an `error` response for
//!   requests and a close for events.
//! * **Goodbye** may be sent by either side just before closing, with a
//!   reason code.
//!
//! # State on reconnect
//!
//! The daemon is the source of truth. When a renderer connects (or
//! reconnects), the daemon sends `renderer.configure` immediately. After the
//! renderer reports `renderer.ready` (which carries the features it can
//! show), the daemon sends the current `presentation.activate` with its
//! original `activationId` and `generation`, if the renderer supports every
//! feature it requires. A renderer that is already showing that activation
//! must not reload it. A renderer never assumes anything survived a
//! disconnect.
//!
//! # What never crosses this socket
//!
//! Device credentials, Presentation Network secrets, raw server responses,
//! arbitrary filesystem paths from a client,
//! executables, shell fragments, and media bytes. Media is addressed by
//! SHA-256 in the daemon-owned content store.

pub mod event;
pub mod frame;
pub mod message;
pub mod method;
pub mod presentation;
pub mod status;

use serde::{Deserialize, Serialize};

/// Lowest protocol version this build accepts.
pub const DAEMON_MIN_PROTOCOL_VERSION: u32 = 1;
/// Highest protocol version this build speaks.
pub const DAEMON_MAX_PROTOCOL_VERSION: u32 = 1;
/// Largest frame payload either side may send.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// A client must complete its hello within this long.
pub const HANDSHAKE_TIMEOUT_MS: u64 = 5_000;
/// Largest request `id`.
pub const MAX_REQUEST_ID_CHARS: usize = 64;

/// Who is on the other end of a session. Closed set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// A display engine that renders prepared presentations.
    Renderer,
    /// The local administration CLI.
    Tilecastctl,
    /// `tilecast-session-bridge`, the user-session PipeWire bridge: audio
    /// inventory and derived Noise Meter levels, never audio. Only the
    /// daemon's own account may take it.
    SessionBridge,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Renderer => "renderer",
            Role::Tilecastctl => "tilecastctl",
            Role::SessionBridge => "session_bridge",
        }
    }
}

/// Which way a message travels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    DaemonToClient,
    ClientToDaemon,
}

/// Picks the negotiated version, or `None` when the ranges do not overlap.
pub fn negotiate_version(client_min: u32, client_max: u32) -> Option<u32> {
    if client_min > client_max {
        return None;
    }
    let low = client_min.max(DAEMON_MIN_PROTOCOL_VERSION);
    let high = client_max.min(DAEMON_MAX_PROTOCOL_VERSION);
    (low <= high).then_some(high)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation() {
        assert_eq!(negotiate_version(1, 1), Some(1));
        assert_eq!(negotiate_version(1, 7), Some(1));
        assert_eq!(negotiate_version(2, 3), None);
        assert_eq!(negotiate_version(0, 0), None);
        assert_eq!(negotiate_version(3, 1), None);
    }
}
