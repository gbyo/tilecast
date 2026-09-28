# Player pairing and connection protocol

The bootstrap identity endpoint is public and returns only the product identifier, permanent installation ID, organization name, API version, and whether pairing is enabled. A configured player verifies the installation ID before sending any stored device credential.

## Pairing

1. The player reads `GET /api/v1/system/identity`.
2. It creates a pairing session with device metadata and the expected installation ID.
3. The server returns a six-character visible code, a separate private poll secret, an expiry, and an approval URL.
4. An authenticated Owner or Administrator resolves the visible code, reviews the metadata, and approves or rejects it.
5. The player polls with `Authorization: Pairing <poll-secret>`. The visible code cannot poll.
6. The first approved poll atomically marks the session claimed and returns a one-time enrollment token.
7. The player exchanges that token once. The server creates `tc_device_<public-id>.<secret>`, stores only the secret hash, clears the enrollment-token hash, and returns the credential once.
8. The player stores the credential with Android Keystore and removes all temporary pairing secrets.

Pairing sessions expire after ten minutes. Codes use an unambiguous alphabet and are compared through indexed SHA-256 hashes. Expired records are marked during pairing activity and may be removed by later maintenance.

### Pairing recovery

The player installation UUID remains stable across upgrades and is used to recognize a previously paired screen. Studio shows the existing screen name and requires the deliberate **Repair and replace credential** action when that screen still has an active credential. Approval records the authorization but does not revoke the old credential. Only a successful one-time enrollment creates the replacement credential and revokes the previous active credentials in the same database transaction. The existing screen ID, assignments, groups, schedules, policies, and history remain unchanged.

### Screen replacement

Hardware replacement is a separate approval mode from pairing recovery. Studio can select **Replace hardware for an existing screen** for a new player installation. The server records the target logical screen ID in the pairing session but leaves its name, location, Display Group membership and geometry, assignments, schedules, policies, scopes, and snapshots untouched. The target screen is updated with the new physical metadata only during successful one-time enrollment.

The new credential is inserted before the old credential is retired. The hardware update, history transition, old-credential revocation, and enrollment-token consumption commit together; any failure rolls back the whole replacement and leaves the old player usable. `screen_player_history` stores the installation ID, platform, version, hardware metadata, pairing time, retirement time, and reason. Credential repair continues to use the stable player installation UUID and does not create a hardware-replacement history row.

Only the latest pending or approved pairing session for a player installation is actionable. Tilecast Player stores its session ID, private poll secret, visible code, expiry, and polling interval in Room, resumes that session after activity or process recreation, and clears it after enrollment or expiry. A stored device credential is attempted first and is cleared only after an authenticated endpoint confirms that it is invalid or revoked.

## Authenticated connection

Player endpoints accept `Authorization: Bearer <device-credential>`. Dashboard cookies are never accepted. `/api/v1/player/socket` uses protocol version 1 and supports `player.hello`, `player.status`, `server.ping`, and `player.pong`. The `server.ping` `timestamp` is RFC 3339 with sub-second precision (servers before this change sent whole seconds), so a player can sample its clock offset from it. `/api/v1/player/heartbeat` is the lower-frequency fallback.

The same authenticated socket carries bounded binary `TCLS` version 1 frames
only while Studio holds an ephemeral live-stream lease. The fixed header is
magic plus version, session UUID, capture time in Unix milliseconds, unsigned
width and height, followed by a JPEG of at most 100 KiB. The server accepts a
frame only for the socket's own screen and its current in-memory session.
Frames never enter the preview, snapshot, Activity, audit, or backup paths.
See [Ephemeral live streaming](live-streaming.md).

Authenticated `player.status` messages and HTTP heartbeats share the same contact and Activity derivation path. The server records socket contact even when optional status metadata cannot be decoded or validated, while rejecting that metadata and logging only the error, screen ID, and invalid field names. A bad optional field therefore cannot leave an active Player with a stale `lastContactAt`, and it cannot silently bypass uptime measurement. Replacing a socket also uses connection-scoped cleanup, so the old socket cannot mark the replacement as disconnected.

### Heartbeat identifier contract

Every identifier field in a heartbeat (`currentItemId`, `currentAssetId`, `currentPlaylistId`, `currentScheduleId`, `currentWebsiteAssetId`, `currentWidgetId`, `activeTakeoverId`, `assignedPlaylistId`, `lastCommandId`, `currentUpdateDeploymentId`) is a UUID. A player that has no valid UUID for one of them omits the field; it must never send a synthetic renderer key such as `layout-<uuid>`, and the server never accepts a non-UUID string in a UUID field. Renderer-local keys belong in bounded string telemetry (`POST /api/v1/player/telemetry` carries `currentItemId` as free text), not in the heartbeat contract. Tilecast Player for Linux validates each identifier before assigning it, logs the omission at debug level, and translates the synthetic key of a directly assigned Layout back to that Layout's UUID.

Server-side handling is deliberately asymmetric. A malformed **optional playback identifier** — the eight fields listed first above — is dropped, named in the warning log, and returned in `data.ignoredFields`; the rest of the heartbeat is then processed normally. This exists because the same message carries the lifecycle facts that settle a self-update (`playerVersion`, `playerVersionCode`, `lastHealthyPlaybackAt`, `playbackState`, `safeMode`), and one unusable telemetry field must not strand a deployment on a healthy screen. A malformed **required, deployment, command, or credential-bearing** field still rejects the whole heartbeat: `currentUpdateDeploymentId` or `lastCommandId` with an unreadable value would misattribute an update or a command result. Dropped values are recorded as absent, never coerced or substituted.

### Release family

A heartbeat may carry `playerFamily` (`android`, `electron-linux` or `edge`) and, for Tilecast Edge, `playerArchitecture` (`x86_64` or `aarch64`). The server records only these values; another value is recorded as absent and never rejects the heartbeat. Player Updates target a release only at screens of its family and architecture. A player that does not report a family keeps the family its platform always meant: `linux` is `electron-linux` and every other platform is `android`.

`install_player_update` payloads carry `playerFamily` and `expectedArtifactSha256` beside `expectedVersionCode` and the Android field `expectedApkSha256`. A player refuses a payload of another family and never downloads it: Tilecast Edge answers the command with `update_wrong_family`, and the Electron Linux Player reports the deployment `failed`.

For a Tilecast Edge release, a new version code in the heartbeat does not settle the update. Tilecast Edge keeps the new release provisional until it has held a live server link, a ready renderer and meaningful playback evidence for 120 seconds, and then reports `succeeded` to `POST /api/v1/player/update-deployments/{deploymentId}/status`. A release that does not confirm is rolled back on the screen, which reports `failed` with `installerStatus: "rolled_back"` and a reason code.

Status thresholds are centralized on the server: connected socket is `online`, contact within two minutes is `recent`, contact within fifteen minutes is `stale`, and older contact is `offline`. Administrative disable and credential revocation override those states.

Display Control is optional heartbeat metadata. A Linux Player may report
`displayControlProvider`, `displayControlProviders`,
`displayControlCapabilities` (capability-to-provider), `displayPowerState`,
`displayPowerStateConfirmed`, `displayPowerStateObservedAt`,
`displayControlPolicyState`, and a bounded `displayControlError`. These fields
never change the Player's connection status. A successful Display Control
command means that the Player accepted and attempted its fixed provider call;
state confirmation is a separate observation.

## Manifest synchronization and playback

`GET /api/v1/player/manifest` uses the active device credential. It returns schema version 1, a persisted per-screen version, a single-zone playlist or `null`, exact compatible variants, hashes, sizes, and authenticated relative download paths. `If-None-Match` returns 304 without incrementing the version.

Playback-relevant changes send only `{ "type": "manifest.changed", "manifestVersion": 12 }` on the authenticated socket. Players also reconcile every five minutes and on connection. They save a pending manifest, resume `.part` downloads with `Range` and `If-Range`, verify size and SHA-256, and atomically promote verified files. A replacement activates at the next item boundary; failed preparation never overwrites active content.

Synchronized playlists use that same boundary rule. Their monotonic shared timeline supplies the boundary, so rapid manifest revisions coalesce without remounting the current item several times. Takeovers and root Layout presentations still activate immediately; root Layouts do not emit playlist boundaries.

Delivery is deterministic: Download always caches; Stream requires connectivity; Automatic downloads images and videos up to 256 MiB when cache and reserved disk space permit, otherwise it streams video. The cache limit is 8 GiB, free-space reserve is 1 GiB, and at most two downloads run concurrently.

## Scheduled playback and offline limits

Manifest schema v2 is activated atomically only after all Download-policy content for the direct fallback and included schedules is verified. Selection uses `[start, end)` intervals. The player evaluates with one server-corrected clock shared by schedules, availability windows, takeovers, Presentation Overrides, transitions, plugins, and cached playback. The measured offset is persisted/reconstructed before cached selection after restart. Weekly schedules continue offline indefinitely while their definitions and assets remain cached. A future one-time schedule that was not received before disconnection cannot activate. Stream-policy media still requires connectivity and is not guaranteed offline.

Manifest schema v10 adds published Layout presentations. The Player validates the Layout document and its dependency references, prepares every required media file with size and SHA-256 checks, and activates the complete presentation atomically. Playlist zones advance independently, Apps use native provider renderers, and structured bindings reevaluate cached Source data at local date and clock transitions. A failed secondary placement is isolated; an invalid root Layout leaves the previous verified presentation active.

Clock changes, timezone changes, app foregrounding, startup, manifest activation, availability transitions, and transition wake-ups cause reevaluation. A malformed server timestamp leaves the last valid offset in force; players never silently replace the shared policy clock with an unrelated compile-time default.

## Website playback

Manifest v3 adds `websites` and website playlist items. Website items have no media variant and are not included in download selection. A referenced fallback image does have normal asset/variant metadata and must be verified before manifest activation. Website failures never invalidate an otherwise prepared manifest.

The player reports only website asset ID, state, timestamps, safe failure category, blocked-navigation count, origin host, fallback state, and renderer recovery count. Full URLs and query strings are excluded. Website clearing uses the general persistent command protocol.

## Source playback

Manifest schema v5 adds `sources`, each with an asset ID, name, closed provider name, configuration version, and validated provider configuration. Website Sources are adapted into the existing hardened WebView path. YouTube Sources use the YouTube IFrame API with the Tilecast server origin and an origin referrer, require no API key, and report safe states such as ready, playing, paused, ended, autoplay blocked, and player error.

Source playlist items may run until the provider signals completion or for a fixed `durationMs`. Switching items disposes the provider renderer. A configured failure may show a verified fallback image, retain a safe placeholder, or advance to the next playlist item. Heartbeats report only Source ID, provider, safe state, and safe error code—not URLs or page contents.

## Takeover and command protocol

Manifest v4 may contain one active Takeover with its playlist and half-open activation/expiration interval. The released manifest retains the `emergency` property for backward compatibility; current heartbeat and activity contracts use Takeover names. The player prepares it atomically, interrupts normal playback when ready, and re-evaluates schedules on restoration. `commands.available` prompts authenticated retrieval; acknowledgement and safe result endpoints make delivery persistent and idempotent. Takeover overrides playback-disabled state, then returns to disabled after expiration.

Quick Present is carried as the optional `presentationOverride` field in the
same manifest. It references a projected playlist, Layout, or deterministic
one-item asset playlist and includes its start, optional expiration, and
playback anchor. Players select it below an active Takeover and above schedules,
reevaluate at both boundaries, and use the anchor for synchronized playback.
The field is optional so older Players continue their normal assigned or
scheduled presentation while the server stack is upgraded. AirPlay remains a
runtime presentation path and keeps its existing priority over this field.

Player configuration is retrieved separately from `/api/v1/player/config` with device authentication, ETag, schema version, and monotonic effective revision. `config.changed` contains only the revision. The player validates and stores current and previous valid configurations; it never receives administrative inheritance sources or deployment secrets.

Player-config v1 optionally includes organization-owned `playback.regionalFormat`: a canonical BCP-47 locale, IANA timezone, date-format preference, time-format preference, and resolved first day of week. It is added within the extensible `playback` object while the v1 top level stays closed. Existing v1 Players can ignore the unknown playback property and continue using the rest of the configuration. A new Player talking to an older Server receives no profile and preserves its previous platform behavior: Linux uses its old `en-US`/UTC formatter and Android uses the device locale/timezone. This is a compatibility fallback only; a new Server never uses the device locale to format signage. Settings changes still advance config and manifest revisions through the existing invalidation path.

Regional formatting changes do not add a Player-config version or a required field. This keeps a rolling upgrade safe in either direction: new Players accept old v1 responses, and old Players ignore the additive property in the extensible `playback` object. Organization-authored widgets with blank timezone and `locale` format inherit the regional profile; saved explicit timezone and 12/24-hour/date-style choices remain authoritative.

Currency remains field metadata rather than a locale default. Manual and typed data-source projections carry an optional ISO 4217 code through their field descriptors. A legacy field of type `currency` without that metadata renders as a locale-formatted number with no currency symbol; Players must not guess USD, EUR, or another currency.

Configuration v1 also carries typed `reliability`, `power`, `managedKiosk`, and `accessibility` sections. Status reports distinguish configured and effective reliability mode and include throttled foreground, boot attempts, commissioning step and completion, cached fallback, last healthy playback/sync/connection, lock-task, accessibility, active-hours, sleep/wake, recovery, safe-mode, self-test, update-readiness, and maintenance-session state. Foreground package is omitted from non-administrative diagnostics and is never retained as unbounded history.

The persistent command allowlist includes bounded recovery operations: retry or skip the current item, recreate the renderer or playback session, restart the activity or Player process, resynchronize content and configuration, clear safe mode, and run the local self-test. Payloads cannot specify applications, URLs, paths, or executable actions. Device reboot is not exposed without confirmed device-owner capability.

The same persistent command system carries `display_power_on`,
`display_power_off`, `display_set_input`, `display_set_volume`,
`display_mute`, `display_unmute`, `display_set_brightness`, and
`display_probe`. Payloads are closed and range-checked by the server and the
Player. Linux executes only fixed shell-free `cec-ctl` or `ddcutil` calls with
bounded time and output. A Display Control schedule uses the normal manifest
schedule entry with `displayAction`; it has no playlist or Layout and is
evaluated by the same timezone, priority, and offline transition resolver.
