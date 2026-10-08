# Tilecast Edge: hardware qualification procedure

CI cannot operate HDMI displays, TVs, Wi-Fi adapters, or CEC/DDC
hardware. This procedure covers what software tests cannot. Nothing in
this file has passed yet. Do not mark an item available because its
software adapter exists.

Reference hardware (minimum set):

- x86-64 Mini PC with Intel iGPU, 8 GB RAM, 64 GB SSD, Ethernet and Wi-Fi
- ARM64 board with VideoCore/Mali class GPU, 4 GB RAM, 32 GB storage
- one consumer TV with HDMI-CEC and one commercial display with DDC/CI
- one display with analog or HDMI audio output for soundtrack checks

Install the release under test with the default DRM deployment (no
desktop environment). Pair each screen to a qualification server and
record the release version, board, kernel, and display model for every
result.

## 1. Display output

| Check | Pass rule |
|---|---|
| Cold boot to first content | Content on screen without login or desktop |
| Hotplug while playing | Playback resumes on the display within 30 s |
| Unsupported mode or no display | Explicit status surface, no crash loop |
| Rotation 90/270 | Layout fills the panel, no clipping |

## 2. Media

Load one playlist with images, H.264 video (720p, 1080p), transitions,
a Website item, a YouTube item, and one multi-zone layout with two
videos. Then check:

| Check | Pass rule |
|---|---|
| Images and transitions | No tearing, no stuck frames over 50 transitions |
| H.264 720p/1080p | Plays without sustained frame drops |
| Software decode fallback | Plays when hardware decode is unavailable |
| Unmuted video soundtrack | Audible output, volume follows DDC volume |
| Website item | Renders and refreshes, no helper crash |
| YouTube item | Plays with audio for 5 minutes |
| Remote web Widget | Frame updates within 2 s of source change |
| Long playback | 24 h without a renderer restart |

Watch `tilecastctl status` renderer restarts and the daemon log for
`renderer recovery` events during the run.

## 3. Remote web helper

| Check | Pass rule |
|---|---|
| GPU-backed frames | Frames arrive, no CPU-only fallback warning |
| Stall and recovery | A hung page recovers without daemon restart |
| Audio routing | Page audio reaches the display output |
| Resource use | Helper RSS stays under 512 MB for 24 h |
| Sandbox | Helper has no credential, state, or content socket |

## 4. Display control

| Check | Pass rule |
|---|---|
| CEC power on/off/input | Command succeeds on the reference TV |
| DDC brightness/volume/mute | Readback confirms each change |
| Readback accuracy | `tilecastctl status` matches the physical state |
| Unsupported adapter | Command reports unsupported, no crash |
| Active hours | Display sleeps and wakes on schedule |

## 5. Network

| Check | Pass rule |
|---|---|
| Presentation Network provisioning | Client joins, captive portal works |
| Wi-Fi authentication and recovery | Reconnects after AP reboot |
| Ethernet default route | Provisioning never breaks the uplink |

## 6. Span and synchronized groups

Use two or more physical players and one rotated panel.

| Check | Pass rule |
|---|---|
| Group playback alignment | Transitions within 500 ms across members |
| Group transitions | Takeover and return stay aligned |
| Rotated panel | Span viewport covers the rotated panel |
| Restart one member | Rejoins the group without operator action |
| Network loss on one member | Offline playback continues, rejoins on return |

## 7. Power and updates on hardware

| Check | Pass rule |
|---|---|
| Power loss during playback | Content resumes unattended after boot |
| Power loss during provisional update | Guard rolls back, playback resumes |
| Schema-advancing update then rollback | Previous release restores playback |
| Migration from Legacy | Identity, binding, and media carry over |
| Migration rollback | Legacy player resumes during settlement |

## 8. Soak

Run `scripts/ci/edge-soak.sh` against the qualification server for
24-72 h with the media playlist, intermittent network loss, remote
commands, Studio monitoring, one update and rollback, and induced
renderer crashes. Track process RSS and CPU, renderer and helper
restart counts, playback evidence continuity, preview freshness, Watch
Live recovery, and reconnection. Acceptable: zero unattended playback
stops, zero unmanaged restarts, bounded memory growth, and continuous
proof-of-play evidence. The soak has not run yet.
