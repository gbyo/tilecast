# Tilecast API

Milestone 1 exposes JSON endpoints under `/api/v1`. Successful responses use `{"data": ...}`. Errors use `{"error":{"code":"...","message":"..."}}`. Unknown JSON fields and request bodies over 1 MiB are rejected.

Milestone 9 adds Player release check/cache endpoints, Owner-only GitHub device-authorization start/poll/disconnect endpoints, deployment list/detail/create/cancel/retry endpoints, and device-authenticated update metadata, byte-range APK, and status endpoints. Only targeted screens can retrieve APK data. GitHub access tokens are never included in API responses. See [player-updates.md](player-updates.md) and `openapi.yaml`.

Every Player release has a family (`android`, `electron-linux` or `edge`) and, for Tilecast Edge, an architecture (`x86_64` or `aarch64`). `GET /api/v1/player-releases` and the deployment list and detail return `playerFamily` and `architecture`. The upload accepts a Tilecast Edge archive with its signed envelope `tilecast-edge-update.json`. A deployment targets only screens that report the release's family and architecture in their heartbeat (`playerFamily`, `playerArchitecture`); other screens of the family are `incompatible`, and a deployment with no compatible target is refused with `422`. `GET /api/v1/player/updates/{releaseId}` returns the signed envelope (`signedManifest`, `manifestSignature`), `architecture` and `stateSchemaVersion` for an Edge release, and `GET /api/v1/player/updates/{releaseId}/artifact` serves the archive of every Linux family with range requests. `POST /api/v1/player/update-deployments/{deploymentId}/status` accepts `succeeded` only for an Edge release; it is the only way an Edge target settles. The Edge contract is in [tilecast-edge.md](tilecast-edge.md) §15 and its security review in [tilecast-edge-update-threat-review.md](tilecast-edge-update-threat-review.md).

Playlist items may reference either a ready Asset (`assetId`) or a published Layout (`layoutId`), never both. Layout items require a positive `durationMs`, play fullscreen for that interval, and use stream delivery because their referenced media and widgets are projected separately into the Player manifest. A Layout that transitively contains the destination playlist is rejected to prevent recursive playback.

Milestone 10 adds `GET /screens/{id}/reliability` for capability-versus-requested-state diagnostics and `PUT /screens/{id}/power-assist` for explicit administrator confirmation of physical sleep, wake, TV, input-selection, and startup test results. Persistent commands add `retry_player_recovery`, `exit_safe_mode`, `power_assist_sleep`, and `power_assist_wake`; all use empty typed payloads and remain Owner/Administrator-only.

Installable built-in plugins are listed at `GET /plugins`: every plugin the release offers, each with `installed`, `configured`, `active`, `instanceCount`, and advisory `attention`, plus `unsupportedInstallations` for rows a newer release left behind. Owner or Administrator with CSRF install a plugin with `POST /plugins/{pluginId}/install` (`201` the first time, `200` when repeated, `404 plugin_not_found` for an unknown identifier) and remove one with `DELETE /plugins/{pluginId}/installation` (`204`, idempotent). Removal never deletes plugin data and answers `409 plugin_in_use`, with the remaining resources in `error.details`, while the plugin still owns any. Configuration routes answer `409 plugin_not_installed` for a plugin that is not installed rather than installing it. The catalog includes Forms, whose existing form and record endpoints remain below `/forms` and `/data-sources/{id}`, and Player-facing plugins such as Countdown Bar and Brand Bug / Watermark. The Dependency Explorer is a Studio system tool, not a plugin; its read-only dependency graph API remains at `GET /plugins/dependency-graph`. The graph returns typed nodes and directed edges from each dependency to its consumer across Data Sources, media, Widgets, Layouts, playlists, Campaigns, schedules, sync groups, and screens. Countdown Bar instances are managed below `/plugins/countdown-bar/instances`, Brand Bug instances below `/plugins/brand-bug/instances`, and Noise Meter instances below `/plugins/noise-meter/instances`; Owner or Administrator and CSRF are required for create, replace, and delete. Noise Meter levels are a relative 0-100 scale measured by the Linux Player's own microphone, not calibrated decibels, and no audio or sample is ever sent to the server. Its history is read below `/plugins/noise-meter/instances/{id}/history/` — summary, series, daily, screens, and `export.csv` — and is written only by Players, on the ordinary `POST /player/heartbeat`, in its optional `noiseMeter` object. The heartbeat response reports `data.noiseHistory.accepted`, and a Player keeps its batch until it sees that count. See [Installable built-in plugins](plugins.md) for plugin behavior, installation, and boundaries.

## System

- `GET /healthz` — process liveness; does not depend on PostgreSQL.
- `GET /readyz` — readiness; returns 503 when PostgreSQL, writable media storage, FFmpeg, or FFprobe is unavailable.
- `GET /api/v1/system/health` — versioned liveness response.
- `GET /api/v1/system/identity` — public, safe installation bootstrap identity.

## Linux provisioning

Provisioning routes are public because a new player has no credential until it
pairs. They are rate-limited and expose only embedded installer assets or
verified artifacts selected by the operator.

- `GET /install.sh` — Tilecast Linux Player installer with this server's public URL embedded.
- `GET /install-airplay.sh` — AirPlay support installer with this server's public URL embedded.
- `GET /install/tilecast-player.service` — managed Linux user-service template.
- `GET /api/v1/install/linux` — metadata and SHA-256 for the latest stable, verified, cached Linux Player release.
- `GET|HEAD /api/v1/install/linux/artifact` — that verified AppImage.
- `GET|HEAD /api/v1/install/airplay/uxplay` — embedded UxPlay 1.73.6 source archive.
- `GET /api/v1/install/airplay/uxplay.sha256` — pinned SHA-256 for that archive.
- `GET /install-presentation-network.sh` — Linux installer for the root-owned
  `tilecast-networkd` helper.
- `GET /install/tilecast-networkd.service` — the helper's systemd unit.
- `GET|HEAD /api/v1/install/presentation-network/helper` and
  `GET /api/v1/install/presentation-network/helper.sha256` — the embedded,
  checksum-pinned helper and its checksum.

The AirPlay installer verifies the published checksum against its own pinned
value before downloading and again against the archive bytes before building.
It does not direct the signage player to GitHub or any other source-code host.

## Presentation Networks

Presentation Networks are organization-level Wi-Fi definitions for supported
Linux Players. The normal dashboard routes require an Owner or Administrator;
every mutation requires the session's `X-CSRF-Token`. Responses contain SSID,
authentication metadata, revision, assignment count, and `credentialSet`, but
never the PSK/password or its encrypted database envelope.

- `GET /api/v1/presentation-networks` — list redacted networks, whether the
  server encryption key is available, and the supported authentication types.
- `POST /api/v1/presentation-networks` — create a network. The body requires
  `name`, `ssid`, `hidden`, `security`, and a write-only `secret`.
- `GET /api/v1/presentation-networks/{id}` — read redacted network detail and
  assignments.
- `PATCH /api/v1/presentation-networks/{id}` — update metadata. Include
  `secret` only to rotate the credential; omitting it retains the saved value.
- `DELETE /api/v1/presentation-networks/{id}` — delete the network, cascade its
  assignments, and revise affected player configuration.
- `PUT /api/v1/presentation-networks/{id}/screens` — replace the assigned
  Linux screen IDs (at most 500).
- `GET /api/v1/screens/{id}/presentation-network` — read server-derived
  readiness, helper, Wi-Fi, revision, failure, and wired-address state.
- `PUT /api/v1/screens/{id}/presentation-network` — assign one network to a
  Linux screen.
- `DELETE /api/v1/screens/{id}/presentation-network` — remove that assignment.
- `POST /api/v1/presentation-networks/{id}/test` — queue a bounded connection
  test for an assigned Linux screen. Its durable command carries only the
  network ID, timeout, and screen ID; it never carries a credential.

Readiness states include `not_applicable`, `network_manager_unavailable`,
`helper_missing`, `helper_unhealthy`, `unsupported`,
`wifi_adapter_unavailable`, `unassigned`, `reporting_pending`, `connected`,
`failed`, `configuration_pending`, and `ready`. Failure codes such as
`authentication_failed`, `ssid_not_found`, `dhcp_timeout`, and
`ethernet_default_route_lost` are safe, bounded identifiers from the Linux
Player and are translated into operator-facing detail by the server.

The only secret-bearing route is `GET /api/v1/player/presentation-network`.
It requires the permanent device Bearer credential, derives the network from
the authenticated screen's assignment, accepts no network ID, and returns
`Cache-Control: no-store` and `Pragma: no-cache`. A dashboard cookie is not a
player credential, and a player credential is not a dashboard session. The
plaintext credential is returned only to that assigned player so it can create
the temporary NetworkManager profile; it is never included in `/player/config`,
AirPlay commands, audit metadata, logs, or Studio responses. See
[Presentation Networks](presentation-networks.md) for the external encryption
key and recovery implications.

## Authentication

- `GET /api/v1/auth/status` — returns `setupRequired`, `authenticated`, `passkeysAvailable`, `passkeysUnavailableReason`, and, for a valid session, the user, CSRF token, `authMethod`, and `mfaEnrollmentRequired`.
- `POST /api/v1/auth/setup` — creates the single organization and first owner. Available exactly once.
- `POST /api/v1/auth/login` — verifies a password. Creates a session, or returns a multi-factor challenge.
- `POST /api/v1/auth/logout` — revokes the current session. Requires the session cookie and `X-CSRF-Token` header.

Setup body:

```json
{
  "organizationName": "North Library",
  "ownerName": "Taylor Morgan",
  "username": "owner@example.org",
  "password": "a long unique password"
}
```

Login body:

```json
{ "username": "owner@example.org", "password": "a long unique password" }
```

In Demo Mode (`TILECAST_ENV=demo`), the status response also contains `"demoMode": true`, and a request with no valid session receives a new session for the demo Owner with `authMethod` `demo`. Two Demo Mode endpoints exist only on such an installation:

- `GET /api/v1/demo` — returns the scenario and the state of each simulated player.
- `POST /api/v1/demo/reset` — replaces all data with a scenario, for example `{ "scenario": "basic" }`. Requires the Owner role and `X-CSRF-Token`. Refer to [`demo-mode.md`](demo-mode.md).

Authentication and setup are rate-limited per directly connected client address. When a reverse proxy is introduced, keep it on a trusted network; configurable trusted-proxy address handling will be added before internet-facing player APIs.

## Multi-factor authentication

A correct password on an account with a confirmed second factor does **not** create a session. The response instead carries a single-use challenge, and no cookie is set until the second factor is presented:

```json
{
  "data": {
    "mfaRequired": true,
    "challengeToken": "…",
    "methods": ["totp", "passkey", "recovery_code"]
  }
}
```

Challenges expire after ten minutes, are stored only as a SHA-256 hash, and are destroyed after five incorrect attempts.

- `POST /api/v1/auth/mfa/verify` — completes a challenge with `{ "challengeToken": "…", "code": "…" }`. The code may be an authenticator code or a recovery code; the server decides which.
- `POST /api/v1/auth/mfa/passkey/options` — exchanges a pending challenge for a WebAuthn assertion request restricted to that account's credentials.
- `POST /api/v1/auth/passkey/login/options` — starts a discoverable (username-free) WebAuthn ceremony.
- `POST /api/v1/auth/passkey/login` — posts the raw WebAuthn assertion with the challenge in an `X-MFA-Challenge` header. A verified passkey satisfies multi-factor authentication on its own.

Every path that produces a session returns the same shape:

```json
{
  "data": {
    "user": {},
    "csrfToken": "…",
    "authMethod": "totp",
    "mfaEnrollmentRequired": false
  }
}
```

`authMethod` is one of `password`, `totp`, `passkey`, or `recovery_code`.

When `security.mfa_required_scope` covers a user's role and that user has no factor, the session is issued with `mfaEnrollmentRequired: true`. Such a session reaches only `/auth/*` and `/me/security/*`; every other dashboard route answers `403 mfa_enrollment_required` until a factor is enrolled. The flag clears in place, so enrollment does not require signing in again.

### Managing your own factors

These endpoints require the session cookie, and mutations require `X-CSRF-Token`. Removing a factor and generating recovery codes additionally require the account password in the body, so a borrowed session cannot weaken sign-in security on its own.

- `GET /api/v1/me/security` — enrollment state, passkey list, remaining recovery codes, passkey availability, and the `relyingPartyId` and `userHandle` the browser needs to report accepted credentials back to the user's passkey provider.
- `POST /api/v1/me/security/totp` — returns a provisioning URI and typed secret for a new, unconfirmed authenticator.
- `POST /api/v1/me/security/totp/confirm` — activates it with `{ "code": "123456" }`.
- `POST /api/v1/me/security/totp/remove` — requires `{ "password": "…" }`.
- `POST /api/v1/me/security/recovery-codes` — replaces every unused code and returns the ten new ones exactly once.
- `POST /api/v1/me/security/passkeys/options` — begins WebAuthn registration.
- `POST /api/v1/me/security/passkeys` — posts the raw credential with `X-MFA-Challenge`. The passkey is named from the authenticator's AAGUID; no name is accepted.
- `PATCH /api/v1/me/security/passkeys/{id}` — renames a passkey.
- `POST /api/v1/me/security/passkeys/{id}/remove` — requires `{ "password": "…" }`.

### Administrative reset

- `POST /api/v1/users/{id}/security/reset` — Owner/Administrator only, with the same role rules as editing that user. Clears the authenticator, every passkey, and all recovery codes, revokes the account's sessions, and writes an `auth.mfa.reset` audit entry.
- `DELETE /api/v1/users/{id}` deactivates an account and revokes its sessions. `DELETE /api/v1/users/{id}/permanent` permanently removes an already-inactive account, its account-owned preferences and credentials, and clears its attribution from retained records. Both operations use the normal user-management role hierarchy, require CSRF, forbid deleting the current account, and write audit entries.

Passkeys require a secure browser context and a registrable domain. On a plain-HTTP LAN installation the ceremonies are refused with `409 passkeys_unavailable` and the reason is reported through `passkeysUnavailableReason` so Studio can hide the affordance. Authenticator apps and recovery codes work on every installation. See [multi-factor-authentication.md](multi-factor-authentication.md).

## Player bootstrap and authentication

- `POST /api/v1/player/pairing-sessions` — public, rate-limited pairing request.
- `GET /api/v1/player/pairing-sessions/{id}` — requires `Authorization: Pairing <poll-secret>`.
- `POST /api/v1/player/enroll` — exchanges a one-time enrollment token.
- `POST /api/v1/player/heartbeat` — requires a device Bearer credential.
- `POST /api/v1/player/liveness` — requires a device Bearer credential and updates only the authenticated contact timestamp; it accepts an empty JSON object and never replaces playback status.
- `GET /api/v1/player/socket` — authenticated WebSocket protocol version 1.

Device authentication errors use distinct codes: `device_credential_required`, `device_credential_invalid`, `device_credential_revoked`, and `screen_disabled`. Device credentials cannot authenticate dashboard endpoints.

## Screen administration

All screen routes require a dashboard session. Mutations also require `X-CSRF-Token`. Approval, rejection, updates, disable, enable, and revocation require Owner or Administrator.

Locations are reusable building or campus records. `GET /api/v1/locations` returns structured addresses, optional decimal coordinates, timestamps, and an assigned-screen count. Owner and Administrator may `POST /api/v1/locations`, `PATCH /api/v1/locations/{id}`, and `DELETE /api/v1/locations/{id}`. Names are unique case-insensitively within the installation. A location with assigned screens cannot be deleted and returns `409`; screens must first be reassigned or unassigned.

Screens reference an optional `locationId` and carry independent optional `roomName` and `roomNumber` values. Screen responses include the resolved location name for compact compatibility plus `locationDetails` for structured address display. Pairing approval and screen updates accept `locationId`, `roomName`, and `roomNumber`; they no longer store a duplicated free-text building name. Migration 51 trims existing names, merges case-insensitive duplicates, creates one reusable record per normalized name, and preserves every screen relationship.

- `GET /api/v1/screens`
- `GET /api/v1/screens/{id}`
- `GET /api/v1/screens/pairing/pending`
- `POST /api/v1/screens/pairing/resolve`
- `POST /api/v1/screens/pairing/{id}/approve` — accepts `replaceExistingCredential` (default `false`) for credential repair, or `replaceHardware` plus `replacementScreenId` for hardware replacement. Hardware replacement preserves the selected logical screen and retires the previous credential only after enrollment succeeds. An existing active credential otherwise returns `pairing_recovery_required`.
- `POST /api/v1/screens/pairing/{id}/reject`
- `GET /api/v1/screens/{id}/player-history` — returns current and retired physical player records for the logical screen.
- `PATCH /api/v1/screens/{id}`
- `POST /api/v1/screens/{id}/disable`
- `POST /api/v1/screens/{id}/enable`
- `POST /api/v1/screens/{id}/revoke`
- `GET /api/v1/locations`
- `POST /api/v1/locations`
- `PATCH /api/v1/locations/{id}`
- `DELETE /api/v1/locations/{id}`

The machine-readable subset is in [`openapi.yaml`](openapi.yaml).

## Media uploads and library

All routes below require a dashboard session. Owner, Administrator, and Editor may mutate media; Viewer is read-only. Every mutation requires `X-CSRF-Token`.

- `POST /api/v1/uploads` creates a 24-hour resumable session.
- `HEAD /api/v1/uploads/{id}` returns `Upload-Offset`, `Upload-Length`, `Upload-Status`, and `Upload-Expires`.
- `PATCH /api/v1/uploads/{id}` accepts `application/offset+octet-stream` and requires the exact `Upload-Offset`. A mismatch returns `409 upload_offset_mismatch` without moving the accepted offset.
- `POST /api/v1/uploads/{id}/complete` validates size, synchronizes the file, hashes it, detects its actual type, atomically promotes it, creates the asset and original variant, and queues inspection. Repeating completion after success returns the same asset.
- `DELETE /api/v1/uploads/{id}` cancels an unfinished upload and removes temporary bytes.
- `GET /api/v1/assets` is paginated and supports `search`, `type`, `status`, `folderId`, `collectionId`, `tagId`, `sort`, `page`, and `pageSize` (maximum 100). Active content is returned by default; `archived=true` returns manually archived content plus content whose `expiresAt` has elapsed. This time-based transition is computed against the database clock, so it needs no cleanup job or browser session.
- `POST /api/v1/assets/archive` moves 1–100 unused assets out of the active library without deleting their files or folder, collection, and tag organization. The transaction is rejected if any selected asset is missing or still used by a playlist, Layout, Widget, or shared setting.
- `POST /api/v1/assets/restore` returns 1–100 archived or expired assets to the active library while preserving organization. Restoring expired content clears its elapsed `expiresAt`; restoring manually archived content preserves a future expiration.
- `GET` and `PATCH /api/v1/assets/{id}` read or edit an active asset. `DELETE /api/v1/assets/{id}` permanently soft-deletes an active or archived asset and queues file cleanup; Studio presents this operation only from Archive.
- `POST /api/v1/assets/{id}/retry` retries a failed processing pipeline.
- `GET /api/v1/assets/{id}/thumbnail` streams the authenticated thumbnail or poster.
- `GET` and `HEAD /api/v1/assets/{id}/preview` stream the authenticated, player-compatible image or video variant for Studio previews, including byte-range requests.

Uploaded filenames are display metadata only. API responses never include a storage key or filesystem path. Safe media errors include `unsupported_media_type`, `upload_too_large`, `upload_offset_mismatch`, `upload_expired`, `upload_incomplete`, `insufficient_storage`, `media_inspection_failed`, `media_processing_failed`, and `media_variant_unavailable`.

### Content organization

Folders, collections, and tags are installation-scoped metadata. Authenticated users can list them through `GET /api/v1/content-folders`, `/content-collections`, and `/content-tags`. Owner, Administrator, and Editor mutations require CSRF. Creation and deletion use the matching collection route; folders also support `PATCH /content-folders/{id}` for hierarchy and details.

`POST /api/v1/assets/bulk-organize` accepts 1–250 unique `assetIds`, an optional folder assignment, and tag or collection additions/removals. It validates every asset and referenced organization record before applying an all-or-nothing transaction. Deleting a folder moves its direct content to Unfiled and moves child folders to the root. Deleting a tag or collection removes only its relationships and never deletes content; deleting a tag referenced by a tag-driven playlist is refused until the playlist rule is changed. Tag changes invalidate affected tag-driven playlist manifests; folders and collections remain Studio-only metadata.

## Player media delivery

`GET` and `HEAD /api/v1/player/assets/{assetId}/variants/{variantId}` require an active device Bearer credential. Only ready, non-deleted, player-compatible variants are served. Disabled screens and revoked credentials are rejected before file access.

Responses include a hash-derived ETag, correct MIME type and length, and `Accept-Ranges: bytes`. Standard full, initial, middle, suffix, unsatisfiable, `If-Range`, and `If-None-Match` behavior is provided without loading the complete file into memory. Range reads are not audit events.

## Playlists, assignments, and manifests

Owner, Administrator, and Editor may create, edit, duplicate, reorder, or delete unassigned playlists; Viewer is read-only. `POST /api/v1/playlists` requires a `sourceType` of `static` or `tag`, so Studio can create a standard manual timeline or an initially empty tag-driven playlist in one operation. Items accept only ready image/video assets with a player-compatible variant. Images require a positive duration, video offsets must remain within trusted duration, and reordering must contain every item exactly once. An image item that omits `durationMs` without opting into Player defaults receives the `player.playback.default_image_duration_seconds` organization setting (10 seconds when unset); an explicit zero or negative duration is still rejected.

Media assets may define optional `availableFrom` and `expiresAt` RFC 3339 timestamps through `PATCH /api/v1/assets/{id}` with `availabilitySet: true`. The start is inclusive and expiration is exclusive. The manifest carries both values on every playlist item, and the Player filters and reevaluates them against its server-corrected clock, including from a cached manifest while offline. Layout placements, layout backgrounds, Widget/fallback images, branding assets, and plugin assets use the same exact-variant and availability rules.

Playlist item inputs may set `usePlayerDefaults: true`. The effective Player configuration then supplies volume, fit, image duration, transition, audio, and resume behavior on both Android and Linux, including items inside layout playlist zones. The flag is explicit so authored item values remain deterministic when it is false.

`PUT /api/v1/playlists/{id}/tag-rule` switches a playlist between a manual timeline and an automatically populated media timeline. An enabled rule contains 1–20 tag IDs, `match: "any" | "all"`, and an image duration from one second through 24 hours. Tag playlists include only ready library images and videos with a playable variant, sort deterministically by name and ID, use full-length video, and retain their manual items so switching back to manual restores the previous timeline. Direct item mutations are rejected while the tag rule is active.

Tilecast Studio can open a playlist preview in a separate authenticated browser window. The preview follows the saved item order, durations, fit, transitions, video trim points, audio settings, and looping behavior without assigning the playlist to a screen. Images and videos use their playable variants; Widget and Layout items use their generated Studio preview image when available. This browser preview is an authoring aid and does not replace validation on an Android TV or Fire TV device.

Direct assignment routes remain `/api/v1/screens/{id}/playlist-assignment` for compatibility; only Owner and Administrator may mutate them. A `PUT` body contains exactly one of `playlistId` or `layoutId`, and a Layout must have a published revision. For a sync-group member the route updates the group-owned presentation and revises every member manifest. Sync groups use the same exclusive body on `/api/v1/screen-groups/{id}/playlist-assignment`. Existing playlist assignments remain intact after migration.

`GET /api/v1/player/manifest` requires an active device credential, supports stable ETags and 304, and returns manifest v11 with a root playlist or Layout presentation. Layout projection contains the immutable published document plus only its required Widgets, playlist zones, Data Sources (bounded cached datasets), and verified media variants. Span screens receive schema 15 with a logical `canvas` and per-screen `viewport`; video variants are server-prepared panel outputs and are not exposed until ready. Reads never advance the manifest version. Any transitive mutation of a referenced playlist, nested playlist, Layout, asset variant, Widget, Website fallback, Data Source, schedule, takeover, Presentation Override, plugin, branding asset, or effective player policy advances the screen manifest version, so a conditional request cannot retain a stale response.

## Display Groups and schedules

The API retains `/screen-groups` paths and legacy `syncGroupId` fields for compatibility, while Studio calls these resources Display Groups. Group responses include `displayMode`, which is `mirror` for existing installations. A database unique constraint permits each screen in at most one Display Group. Adding an already-grouped screen returns `409`; removing a screen preserves the group fallback as that screen's independent assignment. Span geometry is read at `GET /api/v1/screen-groups/{id}/span` and updated at the same path with one non-overlapping panel per member; panel preparation status is included. Authenticated read routes are `GET /api/v1/screen-groups`, `GET /api/v1/screen-groups/{id}`, `GET /api/v1/schedules`, and `GET /api/v1/schedules/{id}`. Owner and Administrator mutations use the documented CSRF header on group create/update/delete and membership routes, schedule create/update/delete, and enable/disable routes.

Owner and Administrator can preview group Display Control coverage at `GET /api/v1/screen-groups/{id}/display-control/preview?commandType=display_power_on` (also `display_power_off`, `display_mute`, or `display_unmute`). The response distinguishes selected, capability-supported, eligible, and unsupported members and includes a capability fingerprint. `POST /api/v1/screen-groups/{id}/display-control` accepts `commandType` and the preview `fingerprint`, then queues the typed command only for eligible members through the persistent Player command system. A changed fingerprint returns `409` so Studio can refresh the preview.

Schedule targets for a grouped screen are normalized to its sync group, so every member receives the same schedule set. Schedule create, update, and preview inputs contain exactly one of `playlistId`, `layoutId`, or `displayAction`. Display actions are the typed `display_power_on`, `display_power_off`, `display_set_input`, `display_set_volume`, `display_mute`, `display_unmute`, or `display_set_brightness` operations; probe is intentionally not a scheduled action. Existing content schedules remain intact. Android screens reject display-control-only schedules with `422 display_control_unsupported` until a matching capability exists; Linux reports its provider and applies the action. `POST /api/v1/schedules/preview` returns precedence-ordered applicable schedules, conflicts, fallback content, winner, and next transition using the production resolver. Players resolve content and Display Control policy windows locally, including while offline.

Weekly weekdays are integers `0` (Sunday) through `6` (Saturday). Times are `HH:MM`, dates are `YYYY-MM-DD`, timezones are IANA identifiers, and an end time less than or equal to its start denotes an overnight window.

## Quick Present

`GET /api/v1/presentation-overrides` lists active temporary **Show now** sessions. `POST /api/v1/presentation-overrides` accepts a `targetType` of `screen` or `group`, a ready `contentType` of `playlist`, `layout`, or `asset`, the corresponding IDs, a `durationMinutes` of `5`, `15`, `30`, `60`, or `0` for until stopped, `afterAction: "resume"`, and an explicit `wakeDisplay` boolean. `POST /api/v1/presentation-overrides/{id}/stop` ends a session. Owner and Administrator mutations require CSRF and use the same screen/Display Group authorization as assignment changes.

Quick Present is below Emergency Takeovers and external presentation, including the existing AirPlay runtime, and above normal schedules. An active AirPlay destination returns `409 presentation_conflict`; it is never silently interrupted. Quick Present uses the same nested readiness validator as assignment, schedules, takeovers, and manifest generation, and cannot succeed when the Player cannot produce a valid manifest. Expiration advances the affected manifests and causes Players to reevaluate current state rather than restore a saved playback snapshot. See [Quick Present](quick-present.md).

## Display Control

`POST /api/v1/screens/{id}/commands` accepts the capability-gated Display
Control command names documented in [Display Control](display-control.md).
Linux Players report provider and capability snapshots in their authenticated
heartbeat; Android and older Players may omit them. Reliability responses keep
Player status, display power state, policy state, command acknowledgement, and
state confirmation separate. Unsupported controls fail safely and never stop
playback.

## Website assets

`POST /api/v1/assets/websites` creates a ready configuration-only website asset. `PATCH /api/v1/assets/{id}/website` updates its normalized configuration and revises only affected screen manifests. `GET /api/v1/assets/{id}/website/diagnostics` returns safe load timestamps, categorized failure state, reporting screens, allowed hosts, and fallback configuration. Website pages are never fetched as part of save.

Website playlist items require `durationMs` and always use `deliveryPolicy: "stream"`. Manifest schema v3 carries relevant website settings and optional fallback image/variant references. It never includes dashboard users, audit data, credentials, filesystem paths, full player logs, or unrelated websites.

Website data clearing is the typed `clear_website_data` persistent player command. It is Owner/Administrator-only and CSRF protected.

## Widgets and Data Sources

Tilecast separates renderable **Widgets** from non-visual **Data Sources**. See [widgets-and-layouts.md](widgets-and-layouts.md) for the full model.

`POST /api/v1/widgets` creates a reusable Widget from the release-owned definition catalog or a retained trusted legacy provider. Data-driven Widgets reference compatible Data Sources by ID; the server validates source existence, output kind, required fields and types, bounds, enums, colors, URLs, and media references.

Catalog entries with `kind: app` may provision one hidden managed Data Source together with the Widget. Responses expose `authorConfiguration` and `managedDataSourceId`; the normal `configuration` is the compiled server-side form used for dependency and manifest projection. App creation, editing, and duplication manage the source transactionally. Deleting an App deletes an unshared managed source or promotes a source with another consumer to an ordinary shared Data Source. Managed sources are omitted from the normal Data Source gallery but retain refresh diagnostics, usage tracking, manifest dependencies, and database backup behavior.

Widget requests and responses may include nullable authoring-only `presetId` metadata for Leaderboard, Status Board, Queue Board, Schedule / Departures, Opening Hours, and Directory. Presets compile through their underlying generic provider and `presetId` is omitted from Player presentation logic.

Studio freezes the actual 16:9 Widget editor render when a native Widget is saved. `PUT /api/v1/widgets/{id}/preview-image` accepts only a CSRF-protected 960×540 JPEG of at most 500 KB, validates the image bytes and dimensions server-side, and replaces the prior snapshot. `GET /api/v1/assets/{id}/thumbnail` serves that private snapshot through the normal asset thumbnail contract. Updating Widget configuration clears the old snapshot before the new render is stored, so the Widgets page never presents stale or hand-built approximations; Widgets without a captured render show an explicit unavailable state.

Layout cards follow the same frozen-render contract instead of rebuilding a simplified live SVG. After a draft save, Studio captures the real Layout editor canvas as an aspect-preserving JPEG with a maximum side of 960 pixels and uploads it through CSRF-protected `PUT /api/v1/layouts/{id}/preview-image?draftRevision={revision}`; the revision precondition prevents an older asynchronous capture from replacing a newer draft's image. Authenticated `GET` on the same path serves the image with private revalidation. Saving a changed draft clears the prior image before the replacement is stored, and the Layouts page shows an explicit unavailable state when no valid snapshot exists. Layout list and detail responses include `hasUnpublishedChanges`, which compares the current draft document with the currently published document; clients must use it instead of comparing the independent draft and published revision counters. Layout names and descriptions remain independently editable through `PATCH /api/v1/layouts/{id}` and do not invalidate an otherwise-current render.

`GET /api/v1/content-definitions` returns the Server-owned catalog used by Studio to build galleries, categories, defaults, forms, compatibility filters, field selectors, and validation guidance. Definitions are embedded in Tilecast releases; this endpoint does not accept uploads or third-party code. `GET /api/v1/provider-catalog` remains as a compatibility endpoint.

`GET /api/v1/data-sources` includes the established providers plus the release-defined School Status manual object Source. School Status emits Data Document v1 object fields `status`, `message`, `severity`, `effectiveAt`, `expiresAt`, and `updatedAt`. Player manifests never contain fetch URLs, uploaded CSV bytes, coordinates, contacts, source credentials, or upstream request details.

`POST /api/v1/data-sources/{provider}/preview` performs a bounded real fetch and returns sanitized prepared data plus diagnostics before save. JSON mappings use only RFC 6901 JSON Pointer; CSV uses exact header names. An optional `previewDate` evaluates configured date selection without changing saved data. `GET /api/v1/data-sources/{id}/diagnostics` returns bounded refresh and cache diagnostics without raw payloads.

`POST /api/v1/data-sources/{provider}/inspect` (`rss`, `atom`, `json`, `csv`) reads the connected data under the same fetch policy and reports what it contains: the detected fields (CSV header names or JSON Pointer paths) with up to three short sample values each, the detected CSV delimiter, a suggested mapping derived from field names, and which record fields the Source can actually fill. It intentionally does not require a valid mapping, because it exists to produce one — Studio offers detected fields rather than asking an author to recall column names, and hides display toggles for fields the connection cannot supply. Samples pass through the same sanitizer as records, and no raw payload is returned. `GET /api/v1/data-sources/{id}/inspect` does the same for a saved Source using its stored configuration, because an uploaded CSV's bytes stay on the server and are stripped from detail responses.

Manifest v11 and v12 remain accepted for staged upgrades. Compatible Players receive manifest v13, where provider-neutral typed documents may contain multiple named datasets and Widget presentations dispatch by kind and required capabilities rather than provider name. Date-only records remain calendar dates and timestamps remain RFC 3339.

Manifest v14 adds the optional `crossfade` playlist-item transition. Player version code 33 and later render the incoming item beneath the outgoing item, wait for its first visible frame, and then visually crossfade images, videos, websites, Widgets, or Layouts. Existing `none` and `fade` behavior is unchanged. For older Players the Server projects a stored `crossfade` as `fade`, so mixed-version installations remain valid; audio still changes at the item boundary rather than being mixed.

Manifest v15 adds optional video-wall canvas/viewport geometry and a bounded periodic `reload` object on constrained web presentations. Definitions requiring reload declare web runtime capability 2. The Server keeps emitting older schemas for compatible content and rejects assignment when a target Player cannot satisfy the exact presentation requirements.

The School Status Banner and School Status Source demonstrate the release-definition path. Studio generates their forms and gallery entries from the catalog, the Server validates and compiles the Banner to existing `surface`, `column`, `badge`, `text`, and `conditional` nodes, the Source runs through the generic `manual_object` adapter, and Android receives no provider-specific configuration or template. A new release-defined Widget (using existing Player capabilities) or `manual_object` Data Source (emitting Data Document v1) is added as a catalog definition alone: no Android update, no TypeScript provider-union edit, no Studio gallery code, and no database provider-constraint migration. The `provider` columns are constrained only by identifier shape; the catalog decides which providers are supported and rejects unknown IDs before insertion.

## Form Data Sources

A **Form** is a Data Source provider (`provider=form`, adapter `form_records`), not a separate content type. The `data_sources` row is the parent resource; form definitions, submissions, workflow, saved views, per-form grants, history, and attachments live in dedicated tables. Submission values are stored as validated JSONB referencing the immutable published revision used when the record was created. Editing a live form publishes a new revision and never mutates older submissions. Approved records are projected internally (one named typed dataset per saved view) into the cached payload Widgets and Players consume; only output-eligible records reach a manifest, so unapproved records and their image attachments never appear in Player content. Form Data Sources are created and edited through the routes below, not the generic `POST/PATCH /data-sources` path.

Discovery: `GET /api/v1/forms` returns every form the caller can access (a global Owner sees all; everyone else sees forms they created or hold a grant on), each with its name, description, published revision number, the caller's effective capabilities, and the caller's own submission counts (drafts, submitted, changes requested). It backs the lightweight Forms portal and the operator navigation without loading full form detail.

Definition and workflow (per-form `manage`): `POST /api/v1/forms` creates a form (global `editor`+; the creator becomes its manager) — the server publishes the supplied draft as the form's first revision. `GET /api/v1/data-sources/{id}/form` returns the form detail with the caller's effective capabilities; non-managers receive the published schema as the visible draft schema so unpublished edits are never exposed. `PATCH /api/v1/data-sources/{id}/form` updates only the parent Data Source name and description (never provider or configuration). Publishing runs conservative compatibility checks: a previously published output field cannot be removed or change its output type (label, description, required status, default, options, bounds, order, and presentation-only `section`/`help_text` fields may change freely). `PATCH …/form/draft` edits the unpublished draft schema; `POST …/form/publish` snapshots it into a new immutable revision; `PUT …/form/workflow` **reconciles** a bounded, script-free set of states and transitions in place rather than dropping and recreating them (default states: `draft`, `submitted`, `changes_requested`, `approved`, `rejected`, `expired`). A state key referenced by any record or saved view's `includedStates` is immutable: it may have its label, order, terminal flag, and output eligibility changed, but it cannot be removed or renamed, and the initial state cannot move while records still occupy it. Transitions must reference declared states, exactly one state is initial, and at least one state is output-eligible. Eligibility changes re-derive record eligibility and rebuild projections immediately. A composite foreign key (`form_records.(data_source_id, state_key)` → `form_workflow_states`) is the database backstop guaranteeing a record's state always exists.

Records: `GET/POST /api/v1/data-sources/{id}/records` lists (scoped to the caller's own submissions without `view_all`) and creates drafts. `GET/PATCH/DELETE …/records/{recordId}` reads, edits (optimistic concurrency via `version`; conflicts return `409 conflict`), and removes a record. The record detail (`GET …/records/{recordId}`) is decorated server-side for the caller so the UI never re-implements authorization: it includes the immutable **revision** (number and schema) the record was created against, the `canEdit`/`canComment`/`canDelete` flags, and `availableTransitions` — each with its destination state and label, required capability, and whether a note is required (the default `changes_requested` transition requires one, derived from the workflow rather than hardcoded keys). Record-level authorization is enforced in the server, not just the handler: a submitter may edit, submit, resubmit, and attach only to their **own** record and only while it is in a submitter-editable state (a state with an outgoing `submit` transition, i.e. `draft` or `changes_requested`); reviewers/approvers act per the transition's capability and can read all of a form's records (the `review`/`approve` capabilities imply `view_all` — you cannot review what you cannot see); a manager may edit any record. A record addressed under the wrong form, or one an unauthorized submitter may not see, returns `404 not_found` so existence is never revealed. `POST …/records/{recordId}/transitions` runs a workflow transition — authorized on the server for the transition's required capability, validated against current state and record version, requiring complete required fields before **any submit/resubmit transition and** when entering an output-eligible state — then records history, invalidates affected manifests, and rebuilds the affected views. A failed submit leaves the draft intact rather than advancing it. A transition that requires a note (the default changes_requested path, derived from the workflow) is rejected with `422` when the note is empty — the same rule the UI renders, enforced by one shared helper. `POST …/records/{recordId}/comments` adds a comment (the comment and its history event commit atomically). Image field values are never accepted from the client on create or update: they are owned by the attachment endpoints, preserved server-side across value edits, and a forged image value is rejected; a required image is satisfied only by a live attachment bound to the same record and field. PATCH bodies use tri-state semantics for `displayAt`/`expiresAt`: omitting a field preserves the stored value, explicit `null` clears it, and a value replaces it.

Attachments: `POST …/records/{recordId}/attachments` uploads an image (base64 `data` plus `fieldKey`, `fileName`, `contentType`) and creates a **dedicated** asset with `origin=form_attachment` from the start, bound to the record and a validated image field of the record's revision. It never reclassifies an existing library asset, rejects assets already used by playlists, layouts, Widgets, or other records, and never lets a form attachment appear in the public Media library or a manifest until an approving projection references it. Form attachments are excluded from every generic Media surface — asset detail, thumbnail, playback preview, update, retry, and delete all treat an `origin=form_attachment` asset as absent — so they are reachable only through the record-scoped endpoint below and authorized Player delivery. Upload and removal use **optimistic concurrency**: the caller sends the record's current `version` (a body field on upload, a `version` query parameter on removal); the server locks the record, compares the stored version, and returns `409 conflict` on a mismatch before mutating anything. On success it applies the change, increments the record version, and returns the updated record detail — so the client threads each returned version into the next attachment action. Because image fields are single-valued (a database `UNIQUE(record_id, field_key)` backs this), uploading to a field that already has an attachment **replaces** it: the prior attachment is unbound and its asset soft-deleted, and a freshly ingested asset is cleaned up if binding fails. When an attachment is replaced or removed on an output-eligible record, required fields are re-validated and the projection is rebuilt before the old asset is deleted, so cached signage output never references a deleted asset. `GET …/records/{recordId}/attachments/{attachmentId}/content` streams the image through this form-record-authorized endpoint (the only way to view a form attachment; they are never served from the Media library) applying the same visibility rules as reading the record. `DELETE …/records/{recordId}/attachments/{attachmentId}` removes an attachment and clears the field it backed. Upload, replace, and remove all return the updated record detail (with its new `version`); authorization matches record editing.

Saved views (per-form `manage` to edit): `GET /api/v1/data-sources/{id}/views` lists views; `PUT …/views` upserts one by key (included states, field filters, relative time filters such as start-before-now and end-after-now, sorting, record limit, and selected output fields); `DELETE …/views/{viewId}` removes one, but deletion is **blocked with `resource_in_use` (409)** when the view's dataset key is still referenced by a Widget (a chart Widget naming `dataSourceId`+`dataset`), so removing a view cannot silently break signage. `POST …/views/preview` projects an unsaved, proposed view and returns the resulting typed dataset **without saving or altering the cached projection** (manager-only); like every projection it contains only output-eligible records. View keys are immutable once saved. Time-based views are filtered server-side and the refresh state is rescheduled to the next window boundary so signage updates without a Player round trip.

Outputs: `GET /api/v1/data-sources/{id}/outputs` (available to `view_all` or `manage`) returns, per saved view, the generated dataset key, output fields and types, current record count, a bounded set of preview records (from the cached payload — only output-eligible records, never attachment binaries), and downstream Widget usage, plus form-level projection status: last successful projection, next scheduled refresh / time-window boundary, using-cached/stale flag, and any projection error. `POST …/outputs/rebuild` (manager-only, CSRF) manually re-runs the projection, invalidates affected manifests, and returns the refreshed status.

Workflow metadata: the workflow returned by `GET …/form` decorates each state with `recordCount` and a `removable` flag (false once any record or saved view references the state), so the Workflow editor can lock the key and deletion for referenced states — consistent with `PUT …/form/workflow` reconciliation.

Per-form grants (`manage`): `GET /api/v1/data-sources/{id}/grants`, `PUT …/grants`, and `DELETE …/grants/{grantId}` manage the capabilities `manage`, `submit`, `view_own`, `view_all`, `review`, and `approve`. Global roles are unchanged; a grant additionally authorizes one user on one Form Data Source (for example, a global Viewer allowed to submit to a single form). Owners and the form creator always have `manage`. Access management (`manage`): `GET /api/v1/data-sources/{id}/access` returns one entry per user with effective access — the creator and all active global Owners as implicit, uneditable managers, then each granted user with their collapsed (non-redundant) capability set; `PUT …/access/{userId}` **atomically replaces** one user's grants (in a single transaction with an audit entry, all-or-nothing), collapsing implied capabilities to a minimal generating set, refusing to edit the creator or a global Owner, and refusing to let a manager remove their own only management path. `GET …/user-directory?search=` is a bounded, manager-safe directory returning only `id`, `name`, `username`, and global `role` for active users — authorized per-form to the form's managers, never the Owner/Admin-only `/users` API. `GET /api/v1/approvals` returns the central inbox of records awaiting a review decision across every form the caller may review, approve, or manage; it is paginated (`page`, `pageSize`, with a `total`) rather than silently capped, and each item carries the form name, submission title, submitter, state (with its label), submission time, and display window.

## Layouts

`GET/POST /api/v1/layouts` lists or creates Layouts. `GET/PATCH /api/v1/layouts/{id}` reads or edits metadata, and `PUT /api/v1/layouts/{id}/draft` autosaves a validated renderer-neutral document with `expectedDraftRevision` optimistic concurrency. Successful draft reads and writes include an ETag. `POST /api/v1/layouts/{id}/publish` enters the common Draft → Review → Publish workflow: it publishes directly when policy permits, or returns a review submission when approval is required. Players never receive a draft.

`GET /api/v1/layouts/{id}/revisions` returns the native immutable history. Unified publication history is exposed below `/api/v1/content-history/layout/{id}/publications`, with semantic comparison, Restore as draft, and rollback actions. `POST /api/v1/layouts/{id}/revisions/{revisionId}/restore` remains a compatibility route and copies an old document into a new draft without changing live state. Duplicate and delete operations are `POST /api/v1/layouts/{id}/duplicate` and `DELETE /api/v1/layouts/{id}`. Validation errors use `layout_validation_failed`; stale draft writes use `layout_revision_conflict`.

Content responses include `layoutUsage` with stable Layout IDs, names, and published state. Content deletion returns `asset_in_use` when a draft or published revision depends on the item. Layout App placements contain only the Content ID and approved presentation overrides; shared provider configuration remains in Content.

Manifest v10 adds root and scheduled Layout presentations. A Layout entry includes its published revision, document SHA-256, validated document, and materialized dependencies. Layout deletion is blocked while assigned or scheduled; dependency deletion is blocked while referenced by a draft or published revision.

## Takeover, NWS alerts, and commands

Dashboard routes include `GET/POST /takeovers`, `GET /takeovers/{id}`, `POST /takeovers/{id}/cancel`, `GET/POST /screens/{id}/commands`, and command cancellation. Device-authenticated players use `GET /player/commands`, `POST /player/commands/{id}/acknowledge`, and `POST /player/commands/{id}/result`. Commands are typed, bounded, expiring, and scoped to the authenticated screen. The former one-off website clearing route is replaced by `clear_website_data`.

`GET /alerts/nws` returns the NWS monitor, automatic Takeover rules, poll health, and active matches. `GET /alerts/nws/zones?area=OH` returns the official county and forecast-zone choices for a state or territory. Owners and Administrators manage scope with `PUT /alerts/nws/monitor`, test retrieval with `POST /alerts/nws/poll`, and create, replace, or delete rules beneath `/alerts/nws/rules`. Rules use closed severity and urgency thresholds, a bounded duration, explicit screen/group targets, a `responseMode` of `takeover` or `ticker`, and a `presentationMode` of `builtin` or `playlist`. Built-in mode creates a hidden Tilecast-managed fullscreen alert presentation and updates it with the matching NWS event, headline, severity, affected area, instructions, sender, and expiry. Playlist mode requires a ready custom playlist. A matching alert raises one idempotent Takeover per rule; when it disappears from the active feed, Tilecast ends that Takeover and restores current playback.

Ticker mode answers instead with a bar along the bottom of the targeted screens, delivered through the manifest `plugins` array rather than as a Takeover, shaped by `tickerDisplayMode` (`overlay` or `push`), `tickerHeightPx` (40–320), and `tickerSpeed` (`slow`, `medium`, `fast`). It always shows the live alert: a ticker rule that also names a playlist is rejected with `alert_rule_invalid`. Bar geometry is stored for every rule so switching a rule between responses does not lose it.

## Settings and configuration

Organization settings use `GET/PATCH /settings` with optimistic revision checking. Preferences use `GET/PATCH /me/preferences`. Group and screen policies have typed GET/PUT/DELETE routes; `/screens/{id}/effective-policy` returns values and administrative sources. Players receive source-free effective values from `/player/config` with ETag support. System status and fixed maintenance actions expose health without secrets. Owner import/export requires preview before apply.

Stable settings errors include `unknown_setting`, `invalid_setting_value`, `setting_not_allowed_at_scope`, `setting_exceeds_hard_limit`, `settings_revision_conflict`, `settings_import_invalid`, `settings_import_version_unsupported`, and `branding_asset_invalid`.

## Snapshot history

`GET /screens/{id}/snapshots?limit=` returns snapshot metadata newest-first, plus whether history is enabled and the current caps, so Studio can distinguish "not kept" from "nothing happened". `GET /screens/{id}/snapshots/{snapshotId}/image` returns the stored frame; the screen id is part of the lookup, so the screen-scope middleware on the route also governs the image. `GET /system/snapshots/usage` reports total bytes and count for Owners and Administrators.

Snapshot history is off by default. Capture uses the ordinary live-preview
lease. Only screens that are currently reporting are asked. The per-screen cap
is applied on write and during the retention sweep. See [Snapshot history](snapshots.md).

## Drafts, submissions, and publication history

Playlist authoring writes a separate working draft. The published normalized Playlist rows remain the runtime source for manifests, schedules, and assignments. Editing an assigned Playlist therefore changes zero screens until publication. Layouts retain their existing draft/published split. A submission freezes the complete Playlist, Layout, or Campaign snapshot and its digest; later draft edits do not change what reviewers or scheduled publication will use.

`GET /api/v1/content-submissions?state=` lists explicit submissions (`in_review`, `changes_requested`, `approved`, `scheduled`, `published`, `publication_failed`, or `superseded`), and `GET /api/v1/content-submissions/{id}` reads one frozen snapshot. `POST /api/v1/content-submissions/{type}/{id}` snapshots the current draft; `expectedRevision` is optional optimistic concurrency. `POST /api/v1/content-submissions/{id}/approve` approves the immutable snapshot, while `POST /api/v1/content-submissions/{id}/request-changes` requires a note. `POST /api/v1/content-submissions/{id}/publish` publishes the approved snapshot (or a directly publishable one). `POST /api/v1/content-submissions/{id}/schedule` stores publication intent in PostgreSQL. `POST /api/v1/content-submissions/{id}/cancel-schedule` clears that intent and returns the submission to `approved`.

`GET /api/v1/content-history/{type}/{id}/publications` lists what was actually published, including the content revision, publisher, time, method, submission/release source, superseded publication, digest, and affected-screen count. `GET /api/v1/content-history/{type}/{id}/compare?fromPublicationId=…&toPublicationId=…` returns semantic changes. `POST .../publications/{publicationId}/restore-draft` copies a historical publication into the working draft without touching live state. `POST .../publications/{publicationId}/rollback` publishes that exact historical snapshot as a new publication, or creates a new in-review submission when policy requires approval. Rollback never deletes or rewrites later history.

The review policy is `content.review_policy=off|contributors|everyone`, with `content.allow_self_approval` and `content.auto_publish_on_approval` controls. The old `content.approval_required` setting migrates to `everyone` when true and `off` when false. Assignment still retains the server-side transactional gate: it checks the currently published revision's authorization while holding the revision-bearing row, so single, Display Group, and bulk assignment paths remain protected against edit/assignment races. See [Content review](content-review.md) and [Playlist history](playlist-history.md).

## Campaigns

Campaigns are scheduling containers, not a Player playback type. `GET/POST /api/v1/campaigns` lists or creates them; `GET /api/v1/campaigns/{id}` reads the draft; `PATCH /api/v1/campaigns/{id}/draft` updates it with `expectedDraftRevision`; `GET /api/v1/campaigns/{id}/preflight` runs readiness, target, root-revision, and schedule validation; and `DELETE /api/v1/campaigns/{id}` archives it. A Campaign draft contains a global time envelope, screen/Display Group destinations, and one or more Playlist/Layout schedule blocks.

`POST /api/v1/campaigns/{id}/publish` freezes and publishes a Campaign release when the caller may publish directly, or creates an immutable Campaign submission when review is required. The generic `/content-submissions` and `/content-history/campaign/{id}` endpoints provide Campaign review, scheduled publication, semantic comparison, Restore as draft, and rollback. `GET /api/v1/campaigns/{id}/releases` lists immutable releases, and `POST /api/v1/campaigns/{id}/releases/{releaseId}/restore` copies one into the draft.

Publication verifies that every referenced Playlist/Layout is still the root revision reviewed by the release, reruns preflight, then creates or retires only Campaign-owned ordinary scheduler rows in one database transaction. Every generated schedule carries `campaignId`, `campaignReleaseId`, and a block ID; manually-created schedules are never taken over. The transaction invalidates the union of old and new affected screens once and notifies Players after commit. Campaigns therefore reuse the existing scheduler, resolver, readiness, and manifest model; Players need no Campaign concept. A later normal publication of a referenced Playlist/Layout may affect a live Campaign through the ordinary published-content dependency path, while the release history retains the root revisions originally reviewed.

## Screen scopes

`GET /users/{id}/screen-scopes` and `PUT /users/{id}/screen-scopes` manage which locations and sync groups an account may operate screens in. No grants means the whole fleet; an Owner cannot be scoped, and nobody can change their own scope. Screen routes enforce it: an out-of-scope screen answers `404 screen_not_found` rather than `403`, so a scoped operator cannot enumerate the rest of the fleet, and an operation naming a mix answers `403 out_of_scope`. `GET /screens` is filtered by the same predicate that authorizes each operation. An update deployment is not a screen, so the update-deployment routes are scoped by the set of screens the deployment reaches: the reads narrow to the caller's screens and every count is a count of those, cancelling answers `403 out_of_scope` unless the caller reaches the whole deployment, a retry follows the single-screen rule, and a deployment reaching nothing in scope answers `404`. Activity reporting is deliberately not scoped. See [Screen scopes](screen-scopes.md).

## Integration tokens

Integration tokens are a third authentication boundary, separate from the dashboard cookie and the device credential. They authenticate with `Authorization: Bearer tci_<public-id>.<secret>`: the public part selects the record and the random secret is checked against its SHA-256 hash with a constant-time comparison. The secret is returned once by `POST /integration-tokens` and is never stored or readable afterwards. Every authentication failure answers `401 invalid_token`, so a revoked token is indistinguishable from an unknown one, and a missing scope answers `403 insufficient_scope`.

Scopes are a closed set: `data_source:write` and `activity:read`. Token routes take no session and no CSRF token, and each names the scope it needs:

- `PUT /integration/data-sources/{id}/rows` — replaces the rows of a Manual Table Data Source, at most 500 per write. Column keys must already exist on the source; a write cannot create or delete a source or change its columns. Routed through the ordinary update so the cached player payload, audit entry, and bound Widgets stay consistent.
- `GET /integration/activity/fleet` and `GET /integration/metrics` — bounded fleet counts as JSON and as Prometheus text. There is no `online` count: presence lives in the process-local socket hub, which these reads cannot see, so the field reported is `recent` (contacted within two minutes).

A token is attributed to the account that created it, and stops working if that account is removed. Owner-only management lives at `GET/POST /integration-tokens` and `DELETE /integration-tokens/{id}`; a token can never mint or revoke another. See [Integration tokens](integrations.md).

## Bulk screen operations

`POST /screens/bulk/preview` returns what a change would do without doing it: per-screen current and next state, whether each screen changes, why a screen is blocked, and which screens a sync group added to the selection. `POST /screens/bulk/apply` carries `expectedChangeCount` from the confirmed preview and returns `409 bulk_operation_stale` when the fleet no longer matches. `GET /screens/bulk/operations` lists recent operations; `POST /screens/bulk/operations/{id}/undo` reverses a reversible one inside a 15-minute window.

Actions are `assign_playlist`, `assign_layout`, `clear_assignment`, `set_enabled`, and `send_command`. Each routes through the same service call as the single-screen route, so the manifest bump, sync-group fan-out, player-version check, and audit entries do not diverge. Sending a command is never reversible. Owner or Administrator only; at most 500 screens per operation. See [Bulk changes](fleet-operations.md).

## Content health

`GET /content-health` returns Data Sources that have not refreshed within the configured window, media expiring inside the warning horizon, assigned playlists with nothing available to play, and enabled screens with no playlist. The first and third also open `data_source` and `content` incidents, so they reach notifications; the other two never open one, because neither is a fault.

## Notifications

`GET /notifications/status` reports whether the server can send email at all, why not when it cannot, and the pending and recent-failure counts. Any signed-in account may read it and may call `POST /notifications/test`, which sends only to that account's own notification address so an authenticated session cannot be used as a relay.

Owners and Administrators read the delivery log with `GET /notifications/deliveries?limit=` and manage receivers with `GET/POST /notifications/webhooks`, `PUT/DELETE /notifications/webhooks/{id}`, and `POST /notifications/webhooks/{id}/test`. `POST` returns the HMAC signing secret exactly once; no route reads it back. Requests carry `X-Tilecast-Signature: sha256=<hex>` over `timestamp + "." + body` and `X-Tilecast-Timestamp`. Stable errors include `email_not_configured`, `no_address`, `invalid_address`, `invalid_webhook`, `send_failed`, and `webhook_failed`.

Notification volume is derived from incidents, not from events: each incident notifies at most twice, once when it opens and once when it recovers. See [Notifications](notifications.md).

## Declarative presentation runtime

`GET /api/v1/provider-catalog` returns the legacy compatibility catalog. `GET /api/v1/content-definitions` returns the authoritative release definitions. `POST /api/v1/widgets/compile-preview` compiles an authorized draft into the same resolved declarative presentation document used by v13 manifests.

Player heartbeats may include `presentationSchemaVersions`, `nativePresentationCapabilities`, `webRuntimeVersion`, and `webBundleLimitBytes`. The server uses these bounded fields for v13 negotiation; they never authorize arbitrary executable features.
