# Deployment

## Local network

Copy `deploy/docker/.env.example` to `deploy/docker/.env`, set a strong PostgreSQL password, leave `TILECAST_COOKIE_SECURE=false` for plain HTTP, and start the Compose file. Restrict port 8080 to the trusted LAN with the host firewall.

Docker bridge networking does not reliably publish multicast DNS on every Linux distribution, so `TILECAST_MDNS_ENABLED` is disabled in the Compose example. Players can always use the server's LAN address manually. Advanced Linux installations may enable mDNS when the container has appropriate host-network multicast access.

## HTTPS reverse proxy

Set `TILECAST_PUBLIC_URL` to the external URL and `TILECAST_COOKIE_SECURE=true`. Forward HTTP to `server:8080` on a private Docker network. Preserve WebSocket upgrade headers when player notifications are introduced.

This is also what makes passkeys possible. Browsers refuse WebAuthn outside a secure context and reject an IP address as a relying party identifier, so a plain-HTTP LAN installation can offer authenticator apps and recovery codes but not passkeys. `TILECAST_PUBLIC_URL` must be the address browsers actually use. When the proxy's external hostname differs from what the server sees, set `TILECAST_WEBAUTHN_RP_ID` (a bare hostname) and `TILECAST_WEBAUTHN_ORIGINS` (comma-separated, with scheme) together. The server logs the reason at startup whenever passkeys are disabled. See [multi-factor-authentication.md](multi-factor-authentication.md).

## Cloudflare Tunnel

Cloudflare is optional. Follow [`deploy/cloudflare/README.md`](../deploy/cloudflare/README.md) to enable the profile. The Tunnel route should target `http://server:8080`. Do not publish PostgreSQL.

Do not apply a Cloudflare Access login policy to the hostname that players use. A player cannot complete an Access login or send Access service-token headers. Players using a Tunnel normally enter its public HTTPS hostname manually. LAN discovery advertises local services only and is not a Tunnel discovery mechanism.

The dashboard CSP permits Cloudflare Web Analytics' beacon when a proxied deployment injects it. Automatic injection reports to the same origin. Keep `script-src` free of `unsafe-inline` when applying a custom CSP.

## Presentation Networks

If the installation uses Presentation Networks, set
`TILECAST_PRESENTATION_NETWORK_KEY` in the server environment. It must decode
to exactly 32 bytes as 64-character hex or standard/raw URL-safe Base64. Keep
the key in the deployment secret store and outside the Compose file, database
backup, and settings export; the example environment file includes the empty
placeholder for clarity. The database stores only AES-256-GCM ciphertext, so a
database restore without the same external key requires every saved Wi-Fi
credential to be entered again in Studio. See [Presentation Networks](presentation-networks.md).

## Marketplace

To show marketplace listings in Explore, set
`TILECAST_MARKETPLACE_CATALOG_URL` and `TILECAST_MARKETPLACE_PUBLIC_KEY`
together in the server environment. The Server refuses to start when
only one value is set. The catalog URL must use https, except on
loopback addresses for development. The public key must be a base64
Ed25519 public key of 32 bytes. The example environment file includes
empty placeholders. The Server fetches the signed catalog
automatically, refreshes it while it is stale, and keeps serving the
last verified listings during an outage. See
[Marketplace](marketplace.md).

## Server releases

Tilecast Server ships two release channels. Stable is the recommended channel for normal self-hosted installs. Development tracks `main` and may change frequently or break. Tilecast as a whole is still pre-1.0, so Stable means stable relative to Development, not a maturity claim. There are no other channels.

Stable releases are GitHub Releases cut from `server-vX.Y.Z` tags by `.github/workflows/server-release.yml`. Each release publishes one image under three aliases that always refer to the same artifact:

- `ghcr.io/gbyo/tilecast-server:X.Y.Z`
- `ghcr.io/gbyo/tilecast-server:stable`
- `ghcr.io/gbyo/tilecast-server:latest` (compatibility alias for the latest Stable release)

Development builds from `main` publish `development` and `sha-<commit>` tags through `.github/workflows/server-image.yml`. That workflow never moves `stable` or `latest`.

Normal installs run a published image. `TILECAST_VERSION` in `deploy/docker/.env` is the one place that selects the installed server version. Keep `stable` to follow Stable releases, or pin an explicit release for controlled upgrades. Never point production installs at `development` unless the intent is to track `main`. A Stable upgrade is a version change:

```sh
# Take and verify a backup first.
# Set TILECAST_VERSION in deploy/docker/.env to the desired release.
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml pull
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d
```

Installations that still use the former Compose file with a `build:` section under `server` must update the deployment files once before the first image-based upgrade; pulling them in the existing checkout is the simplest path. After that one-time transition, production upgrades must not use `git pull`, `git checkout`, or `docker compose up --build`. To build and run the server from source instead, add the development override:

```sh
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml -f deploy/docker/compose.dev.yml up -d --build
```

The running server reports its build identity through `tilecastVersion`, `channel`, `buildCommit`, and `buildDate` in the system status response. Stable builds report the bare tag version with channel `stable`. Development builds report `0.0.0-dev` with channel `development` plus their real commit, so they are never mistaken for a Stable release. The same identity is stamped into backup manifests (`tilecastVersion`, `serverChannel`, `buildCommit`, `buildDate`); archives written before these fields existed remain valid and decode with empty values.

To cut a Stable release, update `main`, tag it (`git tag server-vX.Y.Z`), and push the tag. The first release under this system will be `server-v0.11.0`, not `server-v0.10.0`, because development builds historically hard-coded `0.10.0`. No source-version-bump commit is needed: the tag is the authoritative Stable version and the release workflow injects it into the binary at build time. The workflow rejects malformed tags, rejects versions that do not increase, requires the tag to point at a commit that is part of `main` (main may advance after tagging; a tag on an unmerged side branch is rejected), and gates publishing on the full server shipping bundle: server, Studio, container, browser, plugins, widgets, data sources, and generated-contract validation. All Stable releases serialize through one global concurrency group so two tags can never race the shared aliases. The workflow publishes only the immutable versioned image first, resolves and verifies its digest, records that digest in the GitHub Release, and only then creates `stable` and `latest` from the verified digest without rebuilding. A rerun after a promotion failure recovers the recorded digest from the existing release instead of resolving the version tag again.

## Data and upgrades

The `postgres_data` volume stores relational state. The `tilecast_data` volume stores originals, playback variants, thumbnails, posters, and temporary resumable uploads beneath `/data/media`. It must remain mounted across server/container recreation. The media tree is never served directly by the container.

The production image includes FFmpeg and FFprobe and runs as the unprivileged `tilecast` user. Readiness checks database access, writable media storage, and both executables. Configure limits with `TILECAST_MAX_UPLOAD_BYTES`, `TILECAST_MEDIA_WORKERS`, `TILECAST_MEDIA_RESERVED_FREE_BYTES`, `TILECAST_VIDEO_MAX_WIDTH`, `TILECAST_VIDEO_MAX_HEIGHT`, `TILECAST_VIDEO_MAX_FRAME_RATE`, and `TILECAST_KEEP_ORIGINALS`.

A complete backup requires:

- the PostgreSQL database.
- `/data/media/originals`.
- `/data/media/variants` and `/data/media/thumbnails` (or time to regenerate them in a future recovery tool).
- deployment configuration, excluding copied secrets from documentation or source control.

Also preserve the external `TILECAST_PRESENTATION_NETWORK_KEY` separately when
Presentation Networks are in use. It is not stored in Tilecast backups. A
database/media restore is incomplete until the key is restored and assigned
players have reconciled their current network revision.

The database holds every enrolled authenticator secret. Unlike a password or a device credential, a TOTP secret cannot be hashed, so anyone who can read a database backup can generate codes for any enrolled account. Protect backup archives accordingly. Passkeys store only a public key and do not carry this risk.

Upload finalization is journaled in PostgreSQL. Keep both the database and
media volume available during upgrades so the reconciliation worker can finish
a storage move or recover a move whose database commit was interrupted. The
recovery operation is idempotent; it does not create a second asset/variant,
and abandoned temporary data is cleaned only after its recovery window. Do not
manually delete rows in `finalizing` while recovery is running.

Take database and media snapshots from a consistent maintenance window. Restoring only PostgreSQL produces missing-file errors. Restoring only media produces unreferenced files. Pin released Tilecast image tags rather than `latest`, back up both volumes before upgrades, and review migration notes. Automated backup/restore tooling remains a Milestone 9 deliverable.
Scheduling limits are configured with `TILECAST_MAX_SCHEDULES` (1000), `TILECAST_MAX_SCHEDULE_TARGETS` (250), `TILECAST_MAX_GROUPS_PER_SCREEN` (50), `TILECAST_SCHEDULE_PREFETCH_DAYS` (14), `TILECAST_SCHEDULE_ACTIVATION_GRACE_SECONDS` (30), and `TILECAST_CLOCK_SKEW_WARNING_SECONDS` (300). Players need reasonably accurate clocks and current timezone data. Studio surfaces reported skew rather than changing offline evaluation time.
Website defaults are `TILECAST_WEBSITE_ALLOW_PRIVATE_HTTP=false`, `TILECAST_WEBSITE_DEFAULT_TIMEOUT_SECONDS=20`, `TILECAST_WEBSITE_MAX_TIMEOUT_SECONDS=120`, `TILECAST_WEBSITE_MIN_REFRESH_SECONDS=30`, `TILECAST_WEBSITE_MAX_ALLOWED_HOSTS=25`, and `TILECAST_WEBSITE_MAX_ASSETS=500`. Enabling private HTTP is appropriate only for trusted LAN destinations. It does not permit public HTTP or nonstandard ports.

Structured Source fetch defaults are `TILECAST_SOURCE_ALLOW_PRIVATE_NETWORKS=false`, a 15-second timeout, 2 MiB response limit, three redirects, five-minute minimum refresh, and one-day maximum refresh. Enable private networks only when administrators intentionally need an internal ICS endpoint. The fetcher never uses calendar credentials or environment HTTP proxies.

Air Quality uses `TILECAST_AIR_QUALITY_BASE_URL`, defaulting to `https://air-quality-api.open-meteo.com`. The hosted endpoint is accepted only when a source explicitly acknowledges noncommercial use. Commercial installations must point this setting at an operator-managed self-hosted compatible endpoint. Tilecast does not store Open-Meteo API keys.

Transit accepts public GTFS Static ZIP and GTFS Realtime protobuf feeds. Static archives are cached for 6–168 hours while realtime departures refresh every 30–300 seconds. CAP Alerts accepts public CAP 1.2 XML or bounded Atom/RSS indexes.

Weather Data Sources are optional and make outbound HTTPS requests from Tilecast Server to MET Norway. Each Weather source stores a contact email or HTTPS URL for the required identifying User-Agent, uses conditional cache headers, keeps last-known-good prepared records, and projects “Data from MET Norway” attribution. Coordinates and contact details never enter Player manifests. Weather does not become a required Tilecast cloud dependency.

Deploy the v13-capable Player before the declarative server/dashboard release. The server remains in dual-projection mode: capability-reporting Players receive v13 while older Players continue receiving v11/v12. Presentation compiler catalog changes invalidate manifests automatically and do not install code on Players.
Takeover and command limits use `TILECAST_MAX_TAKEOVER_DURATION_HOURS`, `TILECAST_MAX_TAKEOVER_TARGETS`, `TILECAST_MAX_PENDING_COMMANDS_PER_SCREEN`, `TILECAST_DEFAULT_COMMAND_EXPIRY_MINUTES`, `TILECAST_IDENTIFY_SCREEN_MAX_SECONDS`, and `TILECAST_COMMAND_RETENTION_DAYS`.

Automated NWS monitoring is configured in Studio under Plugins → Emergency Alerts. The server needs outbound HTTPS access to `api.weather.gov` for the state/county/forecast-zone picker and active alerts. Monitoring is disabled by default, identifies the installation in its User-Agent, polls no more frequently than once per minute, records upstream health without response bodies or secrets, and is not a replacement for local life-safety systems.

Database URLs, bind addresses, storage roots, executable paths, worker limits, logging, tunnel tokens, signing keys, and hard security limits remain deployment configuration. Studio shows only safe configured/healthy status and cannot read or edit secret values. Runtime settings may narrow but never exceed these hard limits.

Player updates use `TILECAST_UPDATE_MANIFEST_PUBLIC_KEY` (base64 raw Ed25519 public key), `TILECAST_UPDATE_ROOT` (default `/data/updates`), `TILECAST_UPDATE_MAX_APK_BYTES` (default 512 MiB), and `TILECAST_UPDATE_RETENTION_DAYS` (default 90). Set `TILECAST_GITHUB_CLIENT_ID` to the public client ID of a device-flow-enabled GitHub OAuth App to let an Owner connect GitHub from Studio. `TILECAST_GITHUB_TOKEN` remains an optional environment-managed alternative for higher API limits and takes precedence over Studio authorization. GitHub synchronization itself is optional because Owners can upload signed release bundles directly. `TILECAST_RELEASE_PUBLISH_TOKEN` optionally enables the narrowly scoped CI release-upload endpoint. Tokens are not returned by diagnostics. Never install an OAuth client secret, update-manifest private key, or Android keystore on Tilecast Server. Preserve `/data/updates` through the existing `/data` volume because it contains verified APKs and any locally authorized GitHub credential.
