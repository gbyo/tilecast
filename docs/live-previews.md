# On-demand live screen previews

This feature is a periodically refreshed still image. The explicit,
higher-refresh **Watch live** dialog uses a separate, storage-free transport;
see [Ephemeral live streaming](live-streaming.md).

Tilecast Studio starts a temporary preview session whenever a screen detail page is open or its preview card is visible in the Screens grid. The session uses a 60-second lease. Studio renews the lease every 30 seconds and stops renewing it when the detail page closes or the card leaves the visible grid, so the player stops capturing automatically. Grid cards request an immediate first capture, poll for updated metadata while visible, and show the age of the latest snapshot. A 2 px rail between the preview and the card details shows the same age tones as the detail page: no rail for a capture of 45 seconds or less, an amber rail with one moving segment for 45 to 120 seconds, and a static destructive rail for more than 120 seconds or a `capture_error` status. The rail does not show for offline, disabled, revoked, loading, or unavailable previews. When the system or Studio reduced-motion setting is on, the moving segment is removed and the amber rail is static.

The player captures immediately after it observes a new session and then approximately every 20 seconds while the lease remains active. For updated native Players and Electron Linux, a `preview.session_changed` WebSocket notification wakes the preview coordinator immediately; the authenticated HTTP session remains authoritative, and periodic polling recovers missed notifications. Ordinary lease renewal without new capture demand does not send another notification. Preview captures are not player commands and do not create command-history records.

## Security and privacy

- Preview endpoints require an authenticated Studio session or the paired player's device credential.
- Every lookup is scoped through the screen and current organization.
- Preview images are served only through an authenticated, `no-store` endpoint. Tilecast does not issue permanent or public image URLs.
- The Android player captures only Tilecast's own activity window and visible video surfaces owned by that window.
- API 26 and newer use `PixelCopy`. Tilecast also copies visible `SurfaceView` layers owned by its activity so video playback appears in the preview instead of as a black frame. API 23 through 25 use `View.draw(Canvas)`.
- Nearly empty video frames are retried once and then reported as a capture failure rather than replacing the latest preview with a black JPEG.
- Tilecast does not use MediaProjection and cannot capture Android system screens or other applications.
- The Linux player captures the player's own display through Electron `desktopCapturer`. Reading the real framebuffer is required because hardware-overlay video, VA-API-decoded frames, and website `<webview>` layers are not visible to `webContents.capturePage()`. This uses no permission prompt on X11; on Wayland it needs the screen-share portal, so the player falls back to a DOM-only `capturePage()` capture there. Set `TILECAST_PREVIEW_SCREEN_CAPTURE=1` to force framebuffer capture (e.g. on a Wayland box with the portal configured) or `=0` to force the DOM-only path.
- Pairing, administrator PIN, commissioning, maintenance, update approval, identify, and other protected player states report an unavailable status instead of uploading an image.

## Image limits

For a stale Player without a cached image, Studio shows the offline preview state. If a cached image exists, Studio shows that image as stale. Studio uses the computed screen status for this decision.

The player preserves aspect ratio, never upscales, and resizes the capture to at most 960×540 before upload. It encodes JPEG near 75 percent quality and progressively reduces quality or dimensions only when needed to remain below the hard 500 KB limit.

The server stores one `screen_previews` row per screen. A successful capture replaces its last successful image. A failed capture updates only the attempt/error information, preserving those last-good bytes, so no preview history accumulates. Only explicitly recognized non-sensitive failure reasons may continue serving a previous image, clearly marked stale/failed. For old Players that report the ambiguous `unavailable` status, and for protected or unknown failures, the image endpoint fails closed even if an older image is retained. Capture metadata remains available only through authenticated screen endpoints.

Native Player Core's capture timeout circuit breaker now makes a single guarded recovery attempt after an initial 30-second cooldown instead of waiting ten minutes, extending backoff up to ten minutes for repeated renderer faults. Captures remain serialized and bounded so previews cannot monopolize rendering.

## Endpoints

### Studio

- `POST /api/v1/screens/{id}/preview-session` starts or renews the lease. Body: `{ "forceCapture": true|false }`.
- `GET /api/v1/screens/{id}/preview` returns capture metadata and status.
- `GET /api/v1/screens/{id}/preview/image` returns the latest image through the authenticated session.

### Paired player

- `GET /api/v1/player/preview-session` returns the active lease, capture interval, and manual-capture signal.
- `POST /api/v1/player/preview` uploads multipart capture metadata with an optional `preview` image or a bounded `failureStatus`.

Tracked metadata includes capture time, player version, width, height, file size, and capture failure status.
