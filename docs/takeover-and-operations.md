# Takeover, NWS alerts, and player operations

Studio keeps two operator flows distinct:

- **Takeover** is the manual “show this now” action on Screens. Its defaults
  live in Settings → Takeovers and commands.
- **US Weather Alerts** is a plugin, at Plugins → US Weather Alerts, that
  configures automatic responses to matching U.S. National Weather Service alerts.
  It is a feature an installation opts into and configures, not an
  organization default, which is why it is not in Settings.

For automatic emergencies, each weather event rule defaults to a Tilecast-owned
fullscreen alert presentation populated from the matching live NWS alert. It
shows the event, headline, severity, affected area, instructions, issuing
office, and expiration without requiring the operator to author content.
Organizations can instead select a separate, non-empty custom playlist for a
rule. The plugin page links to playlist management, back to Screens for a
manual Takeover, and to the takeover and command defaults in Settings. Automatic emergencies reuse the same bounded playback-override
machinery, but Studio does not present a manual Takeover as an emergency rule.

A rule may answer with a ticker bar instead of taking the screen over. The bar
carries the same live alert text along the bottom of the screen and leaves
whatever is playing in place — pushing the content up, or overlaying its bottom
edge — which suits alerts that should inform a room without interrupting it. A
ticker raises no Takeover and needs no playlist, so playback needs no restoring
when the alert clears: the bar is withdrawn by revising the targeted manifests,
and a Countdown Bar that was waiting for the slot returns immediately. It is
delivered through the Player plugin channel described in
[plugins.md](plugins.md), alongside the Countdown Bar, and takes the bar slot
from any countdown while the alert is live.

Takeover is an explicit, temporary fullscreen override. It is not a priority-1000 schedule. Resolution is active Takeover, normal schedule, direct fallback, then no content. Activation requires a ready non-empty playlist, at least one screen or group target, and an expiration no more than `TILECAST_MAX_TAKEOVER_DURATION_HOURS` (24 by default). Overlapping screens move to the newly activated Takeover; unaffected screens remain on the older Takeover.

The server stores per-screen preparation and activation state and increments only affected manifests. Manifest v4 carries the Takeover ID, playlist ID, activation instant, and expiration instant. Its released JSON field remains `emergency` for wire compatibility; current server and player models expose it as Takeover. The player verifies Download-policy assets before atomic activation. Working playback remains visible if preparation fails. A received Takeover continues offline until its half-open expiration `[activatedAt, expiresAt)`; then the player evaluates the current normal schedule instead of resuming stale content. An offline player that never received the Takeover cannot display it, and a badly incorrect device clock can affect offline expiration.

## National Weather Service monitoring

The US Weather Alerts plugin contains the NWS monitor. An Owner or
Administrator selects a state or territory by name. Studio then loads the
saved NWS county and forecast-zone list for that area, so the operator can
monitor the whole state or add specific locations without looking up codes.
Each rule has exact NWS event names (or all events), minimum alert severity and
urgency, a response of takeover or ticker, a built-in live display or custom
ready playlist for a takeover, bar placement, height, and speed for a ticker,
explicit screen/group targets, and a duration ceiling.

The server requests the official NWS zone catalog for the selected area and
caches the result in Studio. The background worker requests the official
active-alert GeoJSON feed using an identifying User-Agent. Area and zone scopes
are fetched separately and unioned by NWS alert ID. Repeated polls update both
the existing `(alert, rule)` activation and its built-in live data rather than
raising duplicates. A new match raises a Takeover, or publishes a ticker to the
rule's targets; the earlier of the alert's end/expiry and the rule ceiling
determines expiration either way. Repeated polls revise a ticker's manifests when
the alert text or the office's own end time changes, but not when the rule ceiling
supplied the expiry, since that is recomputed on every poll and would re-push a
bar that reads the same. When an alert is no longer active, or its rule
is deleted, Tilecast cancels only the Takeover raised by that activation and
restores current scheduling, or revises the targeted manifests to drop the bar.

Poll time, last success, safe error code, and match count are visible in Studio. Response bodies are not logged. The integration is best-effort and must not replace Wireless Emergency Alerts, weather radios, evacuation systems, or local emergency procedures.

## Persistent commands

Operational commands are persisted per screen, expire, and are retrieved through device-authenticated endpoints after a lightweight `commands.available` WebSocket notification. Commands are acknowledged before execution and report a safe result. Idempotency keys and player-side completed-command storage prevent duplicate execution after reconnect or restart. Completed commands are retained for 30 days by default.

Supported commands are `sync_now`, `reload_playback`, `identify_screen`, `clear_media_cache`, `clear_website_data`, `disable_playback`, and `enable_playback`. Payloads are type-specific; only identify accepts `durationSeconds` (10–120 by default). There is no arbitrary command, URL, or executable payload.

Cache clearing preserves content protected by the active or pending manifest. Playback disable leaves pairing and networking active. A Takeover overrides the ordinary disabled screen; after expiration the player returns to disabled until an enable command succeeds.

Owners and Administrators may activate or cancel Takeovers, configure NWS rules, and send commands. Editors and Viewers have read-only operational visibility. Administrative mutations require CSRF protection.
