# Ephemeral live streaming

Tilecast Studio can open a temporary, video-like view of an online Player from
the screen detail page. This is a separate transport from both the 20-second
[live preview](live-previews.md) and [snapshot history](snapshots.md).

## Lifecycle

Pressing **Watch live** creates one in-memory session for the screen. The
session has a 15-second lease that Studio renews every seven seconds while the
dialog remains open. Closing the dialog explicitly ends the session. The lease
is the backstop when a browser disappears without running cleanup.

Only one live-stream session is active per screen. Starting another replaces
the previous session and closes its viewer. Studio distinguishes that
replacement from an expired session: an expired session can be recreated
automatically, while an older viewer never steals the session back from a
newer viewer.

The server tracks only two in-memory health hints for the active session: the
arrival time of the last accepted frame and a monotonically increasing frame
sequence. Studio observes those hints during lease renewal. A healthy renewal
does not wake the Player; if accepted frames stop for five seconds, the server
sends a rate-limited session-change nudge and Studio reconnects the MJPEG
relay with bounded exponential backoff. A lost session after expiry or a
server restart is recreated with bounded backoff. A transient MJPEG connection
failure is retried automatically before Studio falls back to the manual
**Retry stream** action.

Changing Studio language does not restart the live-stream lease.

The target is 8 frames per second at no more than 640×360. Capture, JPEG
encoding, player performance, and network latency can lower the actual frame
rate. Each frame is limited to 100 KiB; real signage frames are usually much
smaller, but the hard theoretical payload ceiling is about 6.4 Mbit/s while the
dialog is open.

## Transport and storage boundary

The Player sends each JPEG as a binary message on its existing
device-authenticated WebSocket. A small fixed header carries the session UUID,
capture time, width, and height. The server validates that header, the active
lease, dimensions, size, and complete JPEG markers.

The server relays only the newest available frame to an authenticated Studio
request as `multipart/x-mixed-replace`. Slow viewers drop intermediate frames
instead of building a queue.

The live-stream service has no database dependency:

- frames and sessions exist only in process memory;
- frames never enter `screen_previews` or `screen_snapshots`;
- frames do not appear in Activity, audit metadata, logs, or backups;
- a server restart ends every stream;
- Player restart and browser disconnect are safe because the lease expires.

## Security and protected states

Studio start, renew, and stop operations require the dashboard session, CSRF
token, and access to the selected screen. The MJPEG response requires the same
dashboard session and screen scope. The Player side uses only the permanent
device credential and its already-authenticated WebSocket.

Android captures only Tilecast's activity window and its visible video
surfaces. Linux uses the same bounded framebuffer/window capture policy as live
preview. Pairing, local administration, commissioning, maintenance, update
approval, identify, safe mode, and other protected states do not produce live
frames.

Tilecast does not use `MediaProjection`, WebRTC, a TURN service, public stream
URLs, or a proprietary relay.

## Endpoints

Studio:

- `POST /api/v1/screens/{id}/live-stream`
- `POST /api/v1/screens/{id}/live-stream/{sessionId}/renew`
- `DELETE /api/v1/screens/{id}/live-stream/{sessionId}`
- `GET /api/v1/screens/{id}/live-stream/{sessionId}/mjpeg`

Paired Player:

- `GET /api/v1/player/live-stream-session`
- binary `TCLS` version 1 frames on `/api/v1/player/socket`
