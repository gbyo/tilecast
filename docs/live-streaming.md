# Ephemeral live streaming (Watch Live)

Tilecast Studio can open a temporary, video-like view of an online Player from
the screen detail page. This is a separate transport from both the 20-second
[live preview](live-previews.md) and [snapshot history](snapshots.md). Live
preview stays a JPEG capture. Watch Live uses H.264 when the Player, the
Studio browser, and the server all support it, and MJPEG otherwise.

## Lifecycle

Pressing **Watch live** creates one in-memory session for the screen. The
session has a 15-second lease that Studio renews every three seconds while the
dialog stays open. Closing the dialog explicitly ends the session. The lease
is the backstop when a browser disappears without running cleanup.

Only one live-stream session is active per screen. Starting another replaces
the previous session and closes its viewer. Studio distinguishes that
replacement from an expired session: an expired session can be recreated
automatically, while an older viewer never steals the session back from a
newer viewer.

The server tracks only two in-memory health hints for the active session: the
arrival time of the last accepted frame and a monotonically increasing frame
count. Studio observes those hints during lease renewal. A healthy renewal
does not wake the Player. If accepted frames stop for five seconds, the server
sends a rate-limited session-change nudge and Studio reconnects the relay with
bounded exponential backoff. A lost session after expiry or a server restart
is recreated with bounded backoff. A transient relay failure is retried
automatically before Studio shows the manual **Retry stream** action. The
same rules apply to the MJPEG and the H.264 relay.

Changing Studio language does not restart the live-stream lease.

## Profiles

A session uses one profile from a closed vocabulary. The order is the
preference order:

| Profile        | Transport | Maximum size | Frame rate | Initial encoder target | TCLS v2 code |
| -------------- | --------- | -----------: | ---------: | ---------------------: | -----------: |
| `h264-720p30`  | H.264     |     1280×720 |     30 FPS |             2.5 Mbit/s |            4 |
| `h264-720p15`  | H.264     |     1280×720 |     15 FPS |             1.5 Mbit/s |            1 |
| `h264-540p15`  | H.264     |      960×540 |     15 FPS |             900 kbit/s |            2 |
| `h264-540p10`  | H.264     |      960×540 |     10 FPS |             700 kbit/s |            3 |
| `mjpeg-540p10` | MJPEG     |      960×540 |     10 FPS |  up to 100 KiB a frame |            — |
| `mjpeg-360p8`  | MJPEG     |      640×360 |      8 FPS |  up to 100 KiB a frame |            — |

The preference order is `720p30 → 720p15 → 540p15 → 540p10 → MJPEG`.
`h264-720p30` is the normal best profile, and the server selects it when the
Player and Studio both offer it. There is no quality switch in Studio.

The order and the profile code are two different things. A profile code is a
permanent identity on the wire. It is not a rank. `h264-720p30` was added
after the others, so it has code 4, and codes 1 to 3 keep the meaning they
had in earlier releases. Never renumber a code: a rolling upgrade has older
Studio, server, and Player releases that still use them.

The bitrates are initial encoder targets, not contract rates. Capture,
encoding, Player load, and network latency can lower the actual frame rate.
`packages/player-contracts/fixtures/watch-live.json` is the source of truth.
The server (`internal/livestream`), `player-client`, and Studio
(`src/live-stream`) test against it.

H.264 profiles are Constrained Baseline, 8-bit 4:2:0, with no B-frames, an
IDR about once a second, and no audio. The WebCodecs codec string is
`avc1.42e01f` (Constrained Baseline, level 3.1). Level 3.1 allows 27,648,000
luma samples each second. 1280×720 at 30 FPS is exactly 27,648,000, so level
3.1 is enough for every profile and Tilecast does not raise the level.

## Negotiation

Three parties take part, and the server selects:

1. **Studio** lists the profiles it can consume in the start request:
   `POST /api/v1/screens/{id}/live-stream` with
   `{"acceptProfiles": [...]}`. A request without a body (an older Studio)
   means MJPEG only. Studio lists an H.264 profile only when
   `window.isSecureContext` is true, `VideoDecoder` exists, and
   `VideoDecoder.isConfigSupported()` accepts `avc1.42e01f` at that
   profile's size. The decoder configuration has no frame rate, so 720p30 and
   720p15 share one check, and each distinct size is asked once. This is
   feature detection, never user-agent sniffing.
2. **The Player** lists the profiles it can produce now on its authoritative
   session poll: `GET /api/v1/player/live-stream-session?profile=...`,
   repeated, at most 16 values. A poll without `profile` (an older Player)
   gets the legacy `mjpeg-360p8` profile. The retired
   `captureProfile=edge-540p10` query means `mjpeg-540p10`. A newer Player
   sends both, so an older server keeps its 960×540 MJPEG.
3. **The server** selects the first profile in preference order that both
   lists contain. When they share nothing, it selects `mjpeg-360p8`.

Until the Player first polls, the session has no `profile` and carries the
legacy limits. A Studio that offered H.264 waits for the choice and renews
every 500 ms meanwhile. After selection, the session that Studio and the
Player read names the `profile`, `transport` (`h264` or `mjpeg`), `codec`
(H.264 only), `frameIntervalMillis`, `maxWidth`, `maxHeight`,
`maxFrameBytes`, `targetBitrate` (H.264 only), and `profileGeneration`.
Studio's target line shows the selected profile.

Compatibility:

- An older Studio with a newer server gets MJPEG.
- A newer Studio without WebCodecs gets MJPEG.
- A newer Studio with an older Player gets MJPEG.
- An older Studio (no `h264-720p30` in its list) with a newer server and
  Player gets `h264-720p15` or another profile both sides offer.
- A newer Studio with an older server: the older server ignores the unknown
  `h264-720p30` ID, so `h264-720p15` stays available and is selected.
- A newer Studio and server with an older Edge: the older Edge never offers
  `h264-720p30`, so `h264-720p15` or a lower profile is selected.
- An unknown profile ID, or an unknown TCLS version 2 profile code, is
  ignored or refused as before. It never causes a different profile.
- A newer Player with an older server never sends TCLS version 2. The Player
  encodes H.264 only when the session explicitly selects an H.264 profile
  with transport `h264` and codec `avc1.42e01f`. An inconsistent H.264
  session fails closed to no streaming.

## Runtime downgrade

Watch Live is subordinate to playback. Core measures each H.264 stream in
memory only: output frames, capture time, encode time, frames dropped before
encoding, missed frame slots, and outbox resyncs. After a three-second
warm-up it judges five-second windows. A window is unsustainable when output
is below 60% of the profile frame rate, when 30% of frames missed their slot
or overran the frame budget, or when the outbox resynchronized twice. Two
consecutive unsustainable windows (hysteresis) degrade the session one
level: `720p30 → 720p15 → 540p15 → 540p10 → MJPEG`. An encoder that fails to
start or reports a failure degrades at once.

`h264-720p30` has a stricter policy. A 30 FPS stream that stays near 18 to
20 FPS is worse than a steady 15 FPS stream. For this profile a window is
unsustainable when output is below 80% of the rate (24 FPS), or when more
than 20% of frames missed their slot or overran the 33 ms budget. The
hysteresis is the same, so one short dip does not degrade the session. The
other profiles keep the values above: they are not made stricter.

The reasons are `output_fps`, `frame_deadline`, `transport_resync`,
`encoder_start`, `encoder_failed`, `encoder_stopped`, and
`profile_unavailable`. They appear in the Player log (see "Diagnostics on a
Player").

To degrade, Core stops the encoder first. Its next poll carries
`degradedSession` and `degradedProfile`. The server then selects a lower
profile for that session only, increments `profileGeneration`, drops the
buffered GOP, and ends every relay request. Studio renews, sees the new
profile, and reconnects with the right transport. A degraded session never
upgrades again. A hint for another (replaced) session is ignored, and a new
session probes the best profile again. The server rejects data for any
profile other than the selected one: TCLS version 2 carries its profile code,
and TCLS version 1 is accepted only while the session is MJPEG.

## Wire formats

### TCLS version 1 (MJPEG, unchanged)

One JPEG frame per binary message on the Player's authenticated WebSocket:
`TCLS`, version 1, the 16-byte session UUID, u64 capture time in milliseconds,
u16 width, u16 height (33 bytes), then the complete JPEG. Every frame is at
most 100 KiB. The server checks the header, lease, profile bounds, and JPEG
markers.

### TCLS version 2 (H.264)

One complete H.264 Annex B access unit per binary message, after a fixed
48-byte big-endian header:

| Offset | Size | Field                                                 |
| -----: | ---: | ----------------------------------------------------- |
|      0 |    4 | `TCLS`                                                |
|      4 |    1 | version `2`                                           |
|      5 |    1 | profile code (1 720p15, 2 540p15, 3 540p10, 4 720p30) |
|      6 |    1 | flags: bit 0 keyframe; other bits must be zero        |
|      7 |    1 | reserved, zero                                        |
|      8 |   16 | session UUID                                          |
|     24 |    8 | sequence, increasing within a session                 |
|     32 |    8 | presentation timestamp in microseconds                |
|     40 |    2 | width (even, at least 16, within the profile)         |
|     42 |    2 | height (even, at least 16, within the profile)        |
|     44 |    4 | access-unit length (must equal the remaining bytes)   |

An access unit is at most 512 KiB. Every keyframe carries SPS and PPS before
its IDR slice, so a decoder can start at any keyframe without an earlier
configuration message. The server performs a light Annex B scan, not a
decode: the unit starts with a start code, NAL headers are well formed, a
keyframe has SPS and PPS before its IDR, and a delta unit has a non-IDR slice
and no IDR slice. Sequence numbers must increase and timestamps must not go
backwards. A delta after a sequence gap depends on a frame the server never
saw, so the server refuses deltas until the next keyframe. A delta cannot
change the dimensions. The server never transcodes. The WebSocket read limit
is one TCLS version 2 message plus 1 KiB.

## Backpressure and GOP model

A slow Studio or network must never build an unbounded queue or affect
playback. JPEG frames are independent, so any stale JPEG can be dropped.
H.264 P-frames depend on every frame since their IDR, so dropping is
dependency-aware at every stage:

- **Host encoder to Core.** Hosts push access units into a bounded
  eight-entry sink. A full sink drops the unit, refuses deltas until the next
  keyframe, and asks the encoder for one. Every pushed unit takes a sequence
  number, so a drop is a visible gap downstream. Hosts drop raw frames
  before encoding when the encoder is busy.
- **Core to WebSocket.** The Watch Live outbox holds the newest JPEG, or the
  H.264 units in order, at most 30 units and 2 MiB. On overflow it clears the
  dependent GOP, waits for a keyframe, and asks the encoder for one. A
  keyframe supersedes unsent deltas. A send that fails or times out loses a
  unit the server needed, so the outbox waits for a keyframe again. The
  WebSocket stays single-owner in Core's server link; encoders never see it.
- **Server to Studio.** The server keeps only the current decodable GOP, at
  most 90 units and 4 MiB, for viewers that join. A GOP over the bound stops
  buffering for joiners (they wait for the next keyframe) but still reaches
  connected viewers. Each viewer has its own queue of at most 45 units and
  3 MiB. Overflow clears it and the viewer resumes at the next keyframe. A
  joining viewer starts at the buffered IDR or waits for the next one, never
  in the middle of a dependency chain. A connection that accepts no bytes for
  ten seconds is closed.
- **Studio.** Studio decodes the newest data only. If the decoder has more
  than 400 ms of frames queued (6 frames up to 15 FPS, 12 frames at 30 FPS),
  Studio skips to the next keyframe. Only the newest
  decoded frame is painted, and every `VideoFrame` is closed promptly.

## Studio transport

The MJPEG relay is `multipart/x-mixed-replace`, shown in an `<img>`.

The H.264 relay, `GET /api/v1/screens/{id}/live-stream/{sessionId}/h264`, is
`application/vnd.tilecast.live-h264`. Each record is a big-endian u32 length
followed by one TCLS version 2 packet exactly as the Player sent it. The
first record is always a keyframe. Studio reads the response incrementally
from `fetch().body`, parses records across any read boundary, and decodes
with WebCodecs `VideoDecoder` (`optimizeForLatency: true`). Each unit becomes
an `EncodedVideoChunk` of type `key` or `delta` with the protocol timestamp.
Frames are drawn to a canvas. The response ends when the session ends or
its profile changes; Studio then renews and reconnects.

Fallback: if WebCodecs is missing, the decoder cannot be configured, or
decoding fails three times in one stream, Studio ends the session and starts
a new one that offers MJPEG only, for as long as the viewer stays open. The
MJPEG endpoint stays. The native iOS presentation route renders the same
viewer.

## Platforms

| Player                | Watch Live                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tilecast Edge         | H.264 when its encoder probe finds a working encoder (up to `h264-720p30` for a hardware encoder, `h264-540p15` for software); otherwise `mjpeg-540p10`. |
| Windows native Player | `mjpeg-360p8`. H.264 through Media Foundation is a separate change.                                                                                      |
| Android Player        | `mjpeg-360p8`. H.264 through MediaCodec is a separate change.                                                                                            |
| Linux Legacy          | `mjpeg-360p8`, unchanged. Linux Legacy (Electron) does not get H.264.                                                                                    |

### Edge encoder

The WPE renderer owns the presented WPE buffer and already uses GStreamer.
It probes encoders at runtime on a worker thread, in this order:
`vah264lpenc`, `vah264enc`, `openh264enc`. Each installed candidate must
encode real frames into a Constrained Baseline keyframe with SPS, PPS, and an
IDR slice, and its SPS must say Constrained Baseline at level 3.1 or lower.
The probe uses the real frame rate and initial bitrate of the profile
(2.5 Mbit/s for 720p30, 1.5 Mbit/s for 720p15, 900 kbit/s for 540p15).

A hardware encoder (`vah264lpenc` or `vah264enc`) tries three stages and
keeps the first that passes:

| Stage       | Advertised profiles                                        |
| ----------- | ---------------------------------------------------------- |
| 1280×720@30 | `h264-720p30`, `h264-720p15`, `h264-540p15`, `h264-540p10` |
| 1280×720@15 | `h264-720p15`, `h264-540p15`, `h264-540p10`                |
| 960×540@15  | `h264-540p15`, `h264-540p10`                               |

A software encoder (OpenH264) only tries 960×540@15. 720p30 is
hardware-encoder-only on Edge, and software H.264 stays at the conservative
`h264-540p15` ceiling because 720p video would use too much CPU on a Player
without hardware encoding. When no candidate passes, the renderer advertises
no H.264 profile and Watch Live uses MJPEG. The probe result reaches
`tilecastd` as `renderer.live_capabilities`, and the renderer logs it once,
for example
`live-encoder: H.264 Watch Live uses vah264lpenc (hardware, up to 720p30)`,
`live-encoder: H.264 Watch Live uses vah264lpenc (hardware, up to 720p15)`, or
`live-encoder: H.264 Watch Live uses openh264enc (software, up to 540p15)`.

A probe proves that the encoder starts and makes a restartable keyframe at
the profile. It does not prove that capture, pixel conversion, and encoding
keep up for a long time. The runtime downgrade (above) judges that, and it
protects playback. The renderer also refuses a `live_encoder.start` for a
profile above the qualified stage.
Edge uses the GStreamer plugins that the Edge release carries, so the
encoders available depend on them and on the host's VA-API drivers.
Tilecast does not add `plugins-ugly` or x264.

`tilecastd` sends `live_encoder.start` only while an H.264 lease is active
and the screen is not protected, `live_encoder.keyframe` after a resync, and
`live_encoder.stop` the moment the lease ends, is replaced, degrades, or the
screen becomes protected. The renderer keeps one GStreamer pipeline per
stream (`appsrc ! videoconvert ! videoscale ! encoder ! h264parse ! appsink`).
A frame-rate timer copies the presented buffer, or reuses the last copy when
nothing new was presented. At most two raw frames wait for the encoder;
more are dropped and counted. A copy that takes more than a quarter of the
frame interval skips the next frames, so Watch Live never takes more than
about a quarter of the main loop. Conversion and encoding run on GStreamer
threads. `h264parse config-interval=-1` writes SPS and PPS before every IDR.
VA-API runs with CBR, no B-frames, one reference frame, and a key-frame
interval equal to the frame rate (30 frames at 30 FPS). The timer period is the
nearest whole millisecond and is never zero (33 ms at 30 FPS). The limit of
two raw frames in flight is 67 ms at 30 FPS: a slow chain drops frames and
degrades instead of building a queue. OpenH264 runs in
screen-content mode, low complexity, with bitrate control and a GOP of one
second. Each access unit reaches `tilecastd` as `renderer.live_chunk`.

Hardware qualification: the e2e image has OpenH264 only, so CI proves the
software ceiling (`up to 540p15`, never 720p). The probe ladder itself is unit
tested with a fake probe (`test-live-profiles`). VA-API encoders
(`vah264lpenc`, `vah264enc`) and the 720p profiles need a physical Edge
device to qualify. Until a device test, treat a hardware encoder's 720p30
advertisement as probed, not qualified. The 2012-era Intel HD 3000 devices
(Acer Veriton) are the reference test: see "Diagnostics on a Player".

## Diagnostics on a Player

Edge writes these lines to the journal. They hold names and numbers only,
never frames, access units, or credentials, and nothing is stored.

| Question                              | Where to look                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did VA-API qualify 720p30?            | Renderer: `live-encoder: H.264 Watch Live uses <encoder> (hardware, up to 720p30)`, and `live-encoder: <encoder> 720p30 probe passed … level_idc 31` or `did not qualify 720p30`. Daemon: `event=encoder_probe encoder=… hardware=… highest_profile=h264-720p30` |
| Did the session select 720p30?        | Daemon: `event=encoded_stream_started profile=h264-720p30 profile_generation=0 highest_offered=…`. Renderer: `live-encoder: stream started: h264-720p30 on <encoder> (hardware), 1280x720 at 30 fps …`                                                           |
| What output FPS did it sustain?       | Daemon, every five seconds after warm-up: `event=profile_window profile=… output_fps=… nominal_fps=30 late_percent=… resyncs=… verdict=…`                                                                                                                        |
| Did it fall back, and why?            | Daemon: `event=profile_degraded from=h264-720p30 to=h264-720p15 reason=output_fps`. `to` is the next profile the Player offers. The server confirms it with the next `encoded_stream_started`                                                                    |
| How many frames did the encoder drop? | Renderer, when the stream ends: `live-encoder: stream ended: N access units delivered, M raw frames dropped before encoding`                                                                                                                                     |

For example, on an Edge device:

```sh
journalctl -u tilecast-edge -u tilecast-renderer --since "10 min ago" \
  | grep -E 'live-encoder:|live_stream'
```

## Transport and storage boundary

The live-stream service has no database dependency:

- frames, access units, GOPs, and sessions exist only in process memory;
- they never enter `screen_previews` or `screen_snapshots`;
- they do not appear in Activity, proof-of-play, audit metadata, logs, or
  backups, and never enter SQLite or the content store on a Player;
- a server restart ends every stream;
- Player restart and browser disconnect are safe because the lease expires.

Downgrade metrics are in memory and are not persisted.

## Security and protected states

Studio start, renew, and stop operations require the dashboard session, CSRF
token, and access to the selected screen. Both relay responses require the
same dashboard session and screen scope, and send `Cache-Control: no-store,
private`, `X-Content-Type-Options: nosniff`, and `X-Accel-Buffering: no`.
The Player side uses only the permanent device credential and its
already-authenticated WebSocket. There is no public stream URL and no
permanent stream token. The renderer and page processes never receive a
credential.

Pairing, setup, local administration, maintenance, update approval,
identify, safe mode, and other protected states do not produce live frames.
Core checks the protected state before an encoder starts, while it runs, and
again before each access unit leaves for the outbox. The socket owner checks
again before each send. Entering a protected state stops the encoder and
discards in-flight output; leaving it starts a new encoder at a keyframe.

Android captures only Tilecast's activity window and its visible video
surfaces. Edge and Windows capture the final output of the Player itself.
Tilecast does not use `MediaProjection`, WebRTC, STUN, TURN, HLS, DASH, a
transcoder, public stream URLs, or a proprietary relay.

## Troubleshooting

- **Studio shows MJPEG on a capable Edge screen.** Check the renderer log
  for the `live-encoder:` probe line. "no working H.264 encoder" means no
  candidate passed. Check that Studio runs in a secure context (HTTPS or
  `localhost`): plain HTTP disables WebCodecs.
- **The profile drops during a session.** The Player could not sustain it.
  `tilecastd` logs `profile_degraded` with a reason (`output_fps`,
  `frame_deadline`, `transport_resync`, `encoder_start`, or
  `encoder_failed`). The next session starts at the best profile again.
- **The stream freezes briefly and recovers.** A backpressure resync dropped
  a GOP; the stream resumes at the next keyframe, within about a second.

## Endpoints

Studio:

- `POST /api/v1/screens/{id}/live-stream`
- `POST /api/v1/screens/{id}/live-stream/{sessionId}/renew`
- `DELETE /api/v1/screens/{id}/live-stream/{sessionId}`
- `GET /api/v1/screens/{id}/live-stream/{sessionId}/mjpeg`
- `GET /api/v1/screens/{id}/live-stream/{sessionId}/h264`

Paired Player:

- `GET /api/v1/player/live-stream-session`
- binary `TCLS` version 1 and version 2 messages on `/api/v1/player/socket`
