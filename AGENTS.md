# Tilecast agent guide

This file applies to the entire repository. Read it before changing Tilecast. More specific `AGENTS.md` files may be added beneath individual applications later; when present, the closest file takes precedence.

## Product and license

Tilecast is a polished, open-source, self-hosted digital signage platform.

- Product name: **Tilecast**
- Tagline: **Open signage, built to stay on.**
- License: **AGPL-3.0-only**
- Deployment model: one organization per installation
- Primary users: schools, libraries, churches, local governments, nonprofits, and small businesses
- Server must remain self-hostable without a proprietary cloud dependency

Use the Tilecast name consistently. The management browser application may be described as Tilecast Studio; the TV application is Tilecast Player.

## Current product boundary

Milestones 1 and 2 establish the foundation and player enrollment path:

- Go/Chi server and a single PostgreSQL database
- embedded Goose migrations
- one-time organization and Owner setup
- Argon2id local accounts and revocable database sessions
- HttpOnly SameSite dashboard cookies and CSRF protection
- React/TypeScript/Vite management dashboard
- Docker Compose deployment and optional Cloudflare Tunnel profile
- permanent installation identity
- native Kotlin/Compose Android TV player
- LAN discovery and manual server address entry
- short-lived pairing sessions, approval, one-time enrollment, and per-device credentials
- WebSocket presence, fallback heartbeat, computed screen status, disable, and revocation

Milestone 2 intentionally does **not** contain media upload, media processing, playlists, layouts, schedules, player manifests, or content playback.

Milestone 8 adds a closed typed settings registry, organization branding, user preferences, deterministic group/screen player policies, independent player configuration synchronization, and safe system administration. Do not opportunistically begin multi-zone layouts, compositions, authenticated websites, proof-of-play, notifications, cloud accounts, billing, multi-tenancy, HDMI-CEC, automatic APK installation, or arbitrary configuration and execution.

Milestone 9 adds signed Tilecast Player APK updates from the fixed public GitHub repository. It does not add server, container, or operating-system updates; app-store distribution; silent-install claims; root or ADB installation; arbitrary update repositories; or arbitrary executable commands.

Multi-zone layouts and proof-of-play were deferred through milestone 9 and have since shipped. Activity now covers Player-confirmed proof of play, fleet health, incidents, expected-versus-actual playback compliance, and bounded player telemetry. Read [`docs/activity.md`](docs/activity.md) and [`docs/activity-event-contract.md`](docs/activity-event-contract.md) before changing anything in that area: the metric definitions there are load-bearing, and several of them exist specifically to replace an earlier measurement that was misleading.

## Repository map

```text
apps/server/                 Go application and embedded dashboard host
  cmd/tilecast/              process startup and graceful shutdown
  internal/auth/             local users, passwords, dashboard sessions, MFA
  internal/config/           validated environment configuration
  internal/database/         pgx pool and embedded Goose migrations
  internal/devices/          identity, pairing, credentials, screens, status
  internal/discovery/        optional mDNS/DNS-SD advertisement
  internal/httpapi/          Chi routes, middleware, JSON contracts, WebSocket
  internal/web/              embedded dashboard files and SPA fallback
apps/dashboard/              React, TypeScript, Vite, TanStack Query
  src/api/                   public browser contract types and fetch client
  src/auth/                  session state and forms
  src/content/               Widget and Data Source authoring controls
  src/navigation/            route metadata and workspace tab definitions
  src/pages/                 authenticated Studio routes
apps/player-android/         native Android TV application
  app/src/main/              Compose UI and production player code
  app/src/test/              JVM unit tests
  app/src/androidTest/       emulator/device tests
packages/api-schema/         reserved shared API contract boundary
packages/manifest-schema/    reserved for the later player manifest
packages/layout-schema/      reserved for renderer-neutral layouts
packages/design-tokens/      shared Studio visual tokens
deploy/docker/               multi-stage image and Compose setup
deploy/cloudflare/           optional Tunnel guidance
docs/                        architecture, API, pairing, deployment, TV setup
apps/docs/                   public documentation site (Astro Starlight)
```

The server is a modular monolith. Preserve small domain packages and thin HTTP handlers. Do not scatter SQL through React code or unrelated handler files.

## Server conventions

### Process and dependencies

- Go module: `github.com/tilecast/tilecast/apps/server`
- HTTP router: Chi
- database driver and pool: pgx v5
- migrations: Goose SQL files embedded into the server binary
- structured logging: `slog` JSON handler
- WebSocket library: `github.com/coder/websocket`
- mDNS library: `github.com/grandcat/zeroconf`

The server applies migrations before accepting traffic. The production container compiles the dashboard and copies hashed Vite assets into the server embed directory before compiling the Go binary.

### Public API shape

All application routes are versioned beneath `/api/v1`, except `/healthz` and `/readyz`.

Successful JSON:

```json
{ "data": {} }
```

Error JSON:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "Human-readable explanation."
  }
}
```

Use strict JSON decoding, reject unknown fields, cap request sizes, and return explicit HTTP status codes. Database rows are not public contracts; map them to typed API models.

### Authentication boundaries

Dashboard and player authentication are deliberately separate.

- Dashboard: opaque random cookie; only its SHA-256 hash is stored; unsafe requests require the session CSRF token.
- Player: `Authorization: Bearer tc_device_<public-id>.<secret>`; the public ID selects the record and the random secret is checked against its SHA-256 hash with constant-time comparison.
- Pairing poll: `Authorization: Pairing <poll-secret>`; never use the visible six-character code to poll.

Never accept a dashboard session as a player credential or vice versa. Never put a device credential, poll secret, or enrollment token in a URL or log message.

Dashboard accounts may carry a second factor. Preserve these properties:

- A correct password on an enrolled account produces a single-use, ten-minute challenge, not a session. No cookie is set until the factor is verified.
- Authenticator codes record the accepted time step and refuse anything not strictly newer, so a code cannot be replayed inside its own window.
- Recovery codes are Argon2id-hashed, consumed by a conditional update, and are never tried for input that looks like an authenticator code.
- Removing a factor or regenerating recovery codes requires the account password in addition to the session and CSRF token.
- The organization enrollment requirement is a session flag, never a login refusal, so a policy change cannot lock an installation out of itself. An unreadable policy value means "not required".
- Passkeys store only a public key, and each successful assertion writes the updated credential record back so sign-count clone detection keeps working.
- WebAuthn is unavailable on plain-HTTP and IP-address installations. Report the reason; do not present a control that cannot work. See `docs/multi-factor-authentication.md`.

### Pairing protocol invariants

The protocol is documented in `docs/player-protocol.md`. Preserve these invariants:

1. Read public installation identity first.
2. The player's saved installation ID must match before it sends a stored credential.
3. Visible pairing code and private poll secret serve different purposes.
4. Pairing sessions expire after ten minutes and are single-use.
5. The first approved private poll atomically produces one enrollment token.
6. Enrollment consumes that token once, clears its database hash, and returns the permanent device credential exactly once.
7. The server stores only credential hashes.
8. Revocation disconnects the active socket and permanently invalidates the credential.
9. Re-pairing reuses the screen record only when the old credential is no longer active.

Owner and Administrator can approve, reject, update, disable, enable, or revoke. Editor and Viewer may observe screen status but may not manage credentials.

### Screen status

Do not store or trust a player-supplied online string. `internal/devices/status.go` is the single status authority:

- `online`: active authenticated WebSocket in the process-local presence hub
- `recent`: no socket, last contact at most two minutes ago
- `stale`: last contact more than two and at most fifteen minutes ago
- `offline`: no contact for more than fifteen minutes, or never contacted
- `disabled`: administrative override
- `revoked`: no active credential

Return computed status and `lastContactAt`. Do not duplicate the thresholds in React or Android.

### Database migrations

Migration files are sequential under `apps/server/internal/database/migrations`.

- Every file needs `-- +goose Up` and a valid `-- +goose Down` section.
- Never edit a migration after it has shipped; add a new migration.
- Use application-generated UUIDs/secrets for security-sensitive records.
- Avoid unbounded heartbeat history. Update current screen timestamps and record only meaningful audit events.
- Preserve the one-organization schema. Do not add multi-tenant routing or tenant selectors.

Milestone 3 media tables should reference generated asset IDs. Uploaded filenames must remain metadata only and must never control a filesystem path.

## Dashboard conventions

- React with strict TypeScript
- React Router
- TanStack Query for server state
- React Hook Form and Zod for forms
- Zustand is reserved for complex local editor state
- design tokens come from `packages/design-tokens`

Keep UI state separate from API state. New server operations belong in `src/api/client.ts`; public types belong in `src/api/types.ts`. Polling is currently used for screen status, at a ten-second interval.

Studio is localized with react-i18next (English source, Spanish, Russian). Follow [`docs/localization.md`](docs/localization.md): new user-visible text goes through `t()` with keys added to every locale in `src/locales/`, never as a hard-coded English literal. Keep English copy unchanged when converting an existing string, because tests assert on it. `npm run i18n:scan -- --check <path>` must be clean for any file you convert.

The interface is restrained infrastructure software: compact spacing, visible controls, limited corner radii, no decorative gradients, no fake analytics, and no future feature presented as complete. Important operations must not be hover-only. Status must include text or an icon, not color alone.

When adding Milestone 3 media screens, show real processing states and real metadata. Do not add fabricated library totals or storage charts.

## Android player conventions

- package/application ID: `org.tilecast.player`
- Kotlin, Jetpack Compose, lifecycle ViewModel
- Room for durable non-secret configuration
- WorkManager only for low-frequency fallback work
- Android Keystore plus AES-GCM for the device credential
- OkHttp for REST and WebSockets
- standard `NsdManager` for `_tilecast._tcp.local` discovery
- no Google Play Services dependency
- minimum API 23; compile/target SDK 35
- one application for Fire TV, Google TV, Android TV, Play Store, and sideloaded APKs

`PlayerState` is the explicit connection state machine. Do not replace it with scattered booleans. Persist only durable configuration: player-generated UUID, normalized server URL, installation ID, organization, screen ID, and screen name. Temporary pairing/poll state must remain reconstructable and should not be stored after enrollment.

Manual URL security is centralized in `ServerUrlPolicy`:

- normalize whitespace and trailing slash
- preserve explicit ports
- only HTTP and HTTPS
- public hosts require HTTPS
- HTTP is allowed only for private IPv4, link-local, localhost, and `.local`
- never silently downgrade HTTPS

If the installation ID changes, do not send the credential. Show `ServerIdentityMismatch` and require an explicit reset.

All controls must work with D-pad focus and remote activation. Normal player UI must not display raw exceptions, internal IDs, debug JSON, or development placeholders. Until playback exists, paired state says “No content assigned.”

### Milestone 8 Android boundary

Milestone 8 itself was constrained to one fullscreen zone. Effective configuration is versioned separately from content, validated centrally, stored with a previous valid revision, and applied by category. Playlist-item values continue to override player defaults. Its original multi-zone and proof-of-play exclusions no longer describe the current product; retain the remaining boundaries on compositions, authenticated sites, arbitrary configuration, and simultaneous videos.

## LAN discovery and deployment

The service type is `_tilecast._tcp.local`. TXT data includes `base-url`, `installation-id`, `api-version`, and the identity path.

Discovery is optional convenience. Multicast may fail across VLANs, guest Wi-Fi, AP isolation, or Docker bridge networks. Manual URL entry must always remain functional. Compose disables mDNS by default because multicast behavior depends on host networking. Cloudflare Tunnel users normally type the public HTTPS hostname manually.

Do not make Cloudflare mandatory. Do not expose PostgreSQL. Outside a trusted LAN, use HTTPS and `TILECAST_COOKIE_SECURE=true`.

## Security rules that must not regress

- Argon2id for human passwords
- high-entropy cryptographic randomness for all credentials and temporary secrets
- constant-time comparison after hash lookup
- no full device credentials in PostgreSQL
- no secrets in logs, query parameters, audit metadata, screenshots, fixtures, or committed files
- one-time expiring pairing codes and enrollment
- rate limiting on login, setup, multi-factor verification, pairing creation, and code resolution
- multi-factor challenges stored only as SHA-256 hashes, single use, attempt-capped, and expiring
- TOTP secrets are the one recoverable credential in the schema; never log or export them, and keep the backup implications documented
- CSRF protection on dashboard mutations
- role checks on credential-management operations
- strict device metadata validation and body limits
- installation identity verification before credential use
- uploaded filenames never become paths in Milestone 3
- FFmpeg must eventually run with bounded resources and generated input/output paths
- website credentials remain out of scope

## Build and test commands

From the repository root:

```sh
npm install
make check
make build
```

Dashboard only:

```sh
npm run format:check
npm run lint
npm test
npm run build
```

Server only:

```sh
cd apps/server
gofmt -w $(find . -name '*.go' -type f)
go vet ./...
go test ./...
go build ./cmd/tilecast
```

PostgreSQL integration tests run when `TEST_DATABASE_URL` is set. Test packages use a shared PostgreSQL advisory lock so package-level integration tests do not truncate each other's fixtures.

```sh
TEST_DATABASE_URL='postgres://localhost:5432/tilecast_test?sslmode=disable' go test ./...
```

Android:

```sh
cd apps/player-android
./gradlew testDebugUnitTest lintDebug assembleDebug
./gradlew connectedDebugAndroidTest   # emulator or device required
./gradlew assembleRelease             # unsigned without local signing config
```

Docker:

```sh
docker compose --env-file deploy/docker/.env.example -f deploy/docker/compose.yml config --quiet
docker compose --env-file deploy/docker/.env.example -f deploy/docker/compose.yml build server
```

Do not claim a feature works until the relevant build and tests have run. For protocol changes, add both unit tests and a complete PostgreSQL integration path. For Android state behavior, prefer JVM tests with network/storage fakes; use instrumented tests for focus, launcher, and actual device behavior.

## Generated files and artifacts

Do not commit:

- `.env` files
- `node_modules`, Vite `dist`, Gradle `.gradle`, or Android `build`
- `apps/server/tilecast`
- private signing keys or signing passwords
- Android `local.properties`
- temporary PostgreSQL data

Expected local outputs:

- debug APK: `apps/player-android/app/build/outputs/apk/debug/app-debug.apk`
- unsigned release APK: `apps/player-android/app/build/outputs/apk/release/app-release-unsigned.apk`
- dashboard bundle: `apps/dashboard/dist`
- local server binary: `apps/server/tilecast`
- Docker image: `tilecast/server:local`

The source `apps/server/internal/web/static/index.html` is a development fallback. Docker and `make build` replace it with the compiled dashboard before building the production server binary. Avoid accidentally committing generated hashed assets there.

## Working-tree care

This repository may have user-owned uncommitted work. Inspect `git status` before editing. Preserve unrelated changes. Do not use `git reset --hard`, `git checkout --`, or other destructive cleanup commands. Use `apply_patch` for intentional source edits and formatters only for mechanical formatting.

Use `rg` and `rg --files` for searches. Keep modules focused and comments limited to behavior that is not obvious from the code.

## Documentation requirements

Update documentation with the implementation, not afterward as an approximation. Relevant files include:

- `README.md`
- `docs/architecture.md`
- `docs/api.md` and `docs/openapi.yaml`
- `docs/player-protocol.md`
- `docs/device-credential-security.md`
- `docs/android-development.md`
- `docs/mdns-discovery.md`
- `docs/deployment.md`
- `docs/troubleshooting.md`
- `docs/localization.md`

Tilecast has two documentation sets, and a change must update both where it applies:

- **Engineering docs** in `docs/` are the specifications and contracts listed above. They follow the ASD-STE100 rules in `docs/documentation-style.md`, checked by `make docs-check`.
- **The public docs site** in `apps/docs/src/content/docs/` is what installers, operators, and contributors read. Update it in the same change whenever you add or change something a user can see or do: a Studio feature, a setting, an install or upgrade step, a Player behavior, or a contributor workflow. It follows `apps/docs/STYLE.md`, not the ASD-STE100 rules. Register a new page in the sidebar in `apps/docs/astro.config.mjs`, link to the engineering doc for the exact contract instead of restating it, and run `npm run docs:build`, which also checks internal links.

A change that only touches internals with no user-visible effect does not need a public docs page.

For Milestone 3 also document media storage, upload limits, FFmpeg inspection/transcoding behavior, range requests, cleanup semantics, and backup implications.

## Verification ledger and known limitations

At the Milestone 2 handoff, verify and update this section if facts change:

- Go formatting, vet, unit tests, and PostgreSQL integration tests pass.
- Dashboard TypeScript build, ESLint, Prettier, Vitest, and Vite production build pass.
- Android JVM tests, lint, debug APK build, and Android TV emulator instrumented test pass.
- A Google Android TV API 34 ARM64 emulator is the current device-level test target.
- The emulator has completed manual server entry, visible local-HTTP confirmation, pairing, approval, enrollment, online presence, server-restart reconnection, live revocation, revoked-state recovery, and re-pairing.
- Physical Fire TV validation is outstanding; do not claim physical Fire TV compatibility based only on compilation/emulation.
- LAN discovery is implemented but depends on multicast network support and should be tested on the deployment LAN.
- Image/video playback and offline scheduling are implemented. Website playback is implemented but physical Fire TV and Google TV WebView validation remains outstanding.

Before each milestone handoff, rerun the full check suite and confirm pairing, server restart reconnection, credential revocation, re-pairing, downloaded playback, and offline scheduling remain green. Website work must not weaken or bypass device authentication.
