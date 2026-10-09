# Tilecast agent guide

This file applies to the entire repository. Read it before changing Tilecast. More specific `AGENTS.md` files may be added beneath individual applications later; when present, the closest file takes precedence.

## Agent development discipline

Favor the smallest **complete** change that solves the requested problem, not the fewest lines at any cost.

- Read the affected flow before editing. Trace callers, shared owners, tests, fixtures, generated outputs, and compatibility or migration implications; fix root causes at the appropriate shared layer.
- Reuse existing Tilecast components, contracts, utilities, platform facilities, and dependencies before introducing new abstractions, configuration, or packages. Do not build speculative flexibility.
- Complete all affected paths, including relevant tests and documentation. Add a focused test for new non-trivial logic and validate the change with the applicable checks; report what was not verified.
- Never optimize away trust-boundary validation, error handling, accessibility, data safety, offline reliability, or hardware-specific requirements.
- All product, architecture, security, cross-platform, and release rules in this file and more specific guides take precedence over minimizing a diff. A larger shared implementation is preferable to a shorter platform-only workaround when ownership requires it.

These principles are self-contained. No external agent plugin or skill is required to contribute.

## Product and license

Tilecast is a polished, open-source, self-hosted digital signage platform.

- Product name: **Tilecast**
- Tagline: **Open signage, built to stay on.**
- License: **AGPL-3.0-only**
- Deployment model: one organization per installation
- Primary users: schools, libraries, churches, local governments, nonprofits, and small businesses
- Server must remain self-hostable without a proprietary cloud dependency

Use the Tilecast name consistently. The management browser application may be described as Tilecast Studio; the TV application is Tilecast Player.

## Current product and scope

Tilecast manages media, playlists, multi-zone layouts, schedules, widgets, data sources, and a fleet of screens. Activity, proof of play, health, remote control, previews, and Player configuration are operational features. Extensions include bundled plugins, Widgets V2, data-source modules, and separately distributed marketplace packages. Do not treat historical milestone exclusions as current product limits.

The Server remains self-hosted and the source of truth for organization, configuration, access, and scheduling. Keep one organization per installation and do not make proprietary cloud services a requirement. Do not add new product features as incidental work; confirm actual support and compatibility before presenting any platform, extension, or feature as generally available.

See [`docs/architecture.md`](docs/architecture.md), [`docs/player-protocol.md`](docs/player-protocol.md), [`docs/marketplace.md`](docs/marketplace.md), and [`docs/packages.md`](docs/packages.md) for current contracts. For proof-of-play and operational metrics, read [`docs/activity.md`](docs/activity.md) and [`docs/activity-event-contract.md`](docs/activity-event-contract.md); do not redefine their semantics in dashboards or Players.

## Repository map

```text
apps/server/                 Go/Chi Server, PostgreSQL, authentication, API, embedded Studio/Browser assets
apps/cli/                    Go remote-management CLI
apps/dashboard/              React/TypeScript Tilecast Studio and plugin host
apps/docs/                   public Astro/Starlight documentation site
apps/ios/                    SwiftUI iOS/iPadOS Studio host and native bridge
apps/player-android/         Android TV/Google TV/Fire TV Compose host + native Player Core adapter
apps/player-web/             experimental Browser Player
apps/player-windows/         Windows native Player host (Rust + WebView2)
apps/edge/                   Linux Edge host (Rust, WPE, systemd, hardware integration)
apps/player-linux/           legacy Linux Electron Player and helper; maintain compatibility/migration
crates/player-{types,state,cas,client,core}/  shared native Player crates
packages/presentation-model/ shared pure presentation decisions
packages/player-runtime/     shared presentation execution
packages/player-contracts/   cross-host conformance fixtures and contracts
packages/{manifest,layout,settings}-schema/  shared versioned contracts
packages/{plugin,widget,data-source,package}-sdk/  extension contracts and tools
packages/{widget-kit,design-tokens,api-schema,native-bridge-schema}/  shared UI and API contracts
plugins/                     bundled first-party plugin modules
widgets/                     widget modules and fixtures
data-sources/                data-source modules
marketplace/                 curated external package catalog
deploy/                      Docker and deployment integration
docs/                        engineering contracts and architecture decisions
scripts/                     generation, checks, and development tools
```

Use the actual directory and its owning documentation as the source of truth; this map is a navigation aid, not a complete ownership matrix. The Server is a modular monolith: preserve small domain packages and thin HTTP handlers, and keep SQL out of Studio and unrelated handlers.

## Player architecture and platform ownership

Read [`docs/player-core.md`](docs/player-core.md) before shared native Player changes. Use [`docs/records/player-core-readiness.md`](docs/records/player-core-readiness.md) only for historical extraction evidence; current platform qualification comes from the platform contract and current test evidence.

- **Presentation Model** owns pure shared presentation decisions. **Player Runtime** owns presentation rendering and execution, across hosts.
- **Player Core** (`crates/player-core`) owns portable native policy: pairing, Server communication, commands, capture coordination, manifest/offline activation, telemetry, Activity, recovery, and other shared behavior as defined by the extraction contract. Pure types, state, CAS, and Server client behavior live in their respective shared crates.
- **Platforms** own OS integration, process lifecycle, storage and credentials, renderer hosting, hardware providers, network facilities, distribution, and update installation. Runtime payload presentation data stays opaque to Core.
- **Browser Player** uses its own browser host and session model while consuming shared presentation contracts; read [`docs/browser-player.md`](docs/browser-player.md). It is experimental, not automatically qualified for every browser.
- **Linux Edge** has binding process, privilege, sandbox, offline, and update guarantees in [`docs/tilecast-edge.md`](docs/tilecast-edge.md) and [`apps/edge/AGENTS.md`](apps/edge/AGENTS.md). Legacy Electron exists for migration and compatibility; do not introduce a second presentation implementation.
- **Android** uses a Kotlin/Compose host and a Rust Player Core adapter; read [`docs/android-development.md`](docs/android-development.md). **Windows** uses the shared native architecture; read [`docs/tilecast-windows.md`](docs/tilecast-windows.md). **iOS/iPadOS** hosts Studio rather than duplicating its application features; read [`docs/ios-app.md`](docs/ios-app.md).

Do not depend on Edge crates or Edge wire framing from shared Player crates. Keep independent platform behavior consistent through natural-owner contracts and conformance fixtures, not copied implementations. Preserve shipped SQLite migration bytes and all Edge security, offline, crash, update, and renderer-isolation guarantees. Host adapters provide time and random IDs; pure shared values do not perform I/O. Run `python3 scripts/ci/check-player-architecture.py` when changing the shared architecture.

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
- `awaiting_player`: enabled screen pending a Player connection during approved replacement/enrollment

Return computed status and `lastContactAt`. Do not duplicate the thresholds in React or Android. Preserve the `awaiting_player` distinction for screens waiting for replacement hardware.

### Plugins and extension packages

A **bundled** plugin is a directory below `plugins/`. Read [`docs/plugin-api.md`](docs/plugin-api.md) before you change a bundled plugin or its host. Marketplace packages are separately distributed and have distinct installation and trust boundaries; see [`docs/packages.md`](docs/packages.md) and [`docs/marketplace.md`](docs/marketplace.md). For Widgets V2 and data sources, use [`docs/widgets-v2.md`](docs/widgets-v2.md) and [`docs/data-source-modules.md`](docs/data-source-modules.md).

- Keep everything unique to a plugin in its directory. Do not add a plugin identifier to core code; extend the SDK contribution interfaces instead.
- Plugins import only the plugin SDK, `@tilecast/studio`, and their own files. `npm run plugins:check` enforces this.
- `tilecast.store.json` is presentation only. It must never carry identity, capabilities, requirements, or trust, which stay in the manifest. Store artwork is static WebP checked into the plugin's `store/` directory; do not add an artwork generator.
- Never edit generated files: `plugins/registry_gen.go`, `.github/CODEOWNERS`, `docs/openapi.yaml`, `packages/plugin-sdk/schema/tilecast-plugin.schema.json`, and `apps/server/internal/database/migrations.lock.json`. Run `npm run plugins:generate`.

### Database migrations

Migration files share one sequence. Core files are under `apps/server/internal/database/migrations`; a plugin's files are under `plugins/<name>/migrations`. Reserve a version with `npm run plugins:migration -- <plugin_id|core> <name>`.

- Every file needs `-- +goose Up` and a valid `-- +goose Down` section.
- Never edit a migration after it has shipped; add a new migration.
- Use application-generated UUIDs/secrets for security-sensitive records.
- Avoid unbounded heartbeat history. Update current screen timestamps and record only meaningful audit events.
- Preserve the one-organization schema. Do not add multi-tenant routing or tenant selectors.

Media rows must reference generated asset IDs. Uploaded filenames are metadata only and must never control filesystem paths.

## Studio conventions

- React and strict TypeScript, React Router, TanStack Query for Server state, React Hook Form and Zod for forms; use Zustand only for complex local editor state.
- Prefer the existing shadcn Base UI **Base Vega** components in `apps/dashboard/src/components/ui`, Geist, Lucide, and semantic tokens in `packages/design-tokens`. Read [`docs/design-system.md`](docs/design-system.md) before making UI changes.
- Preserve domain query ownership and typed API boundaries in `apps/dashboard/src/api/` and `apps/dashboard/src/data/`. Keep local draft state distinct from Server state; plugin-owned UI and operations stay inside their extension interfaces.
- Build for mobile and desktop together. Reuse established loading, empty, error, confirmation, and feedback patterns. Controls must be usable by keyboard/touch, never hover-only; respect focus order, contrast, and reduced motion.
- Keep Studio restrained and operational: useful density, clear hierarchy, neutral application chrome, restrained motion, no fabricated analytics or claims that unfinished features exist. Pair status color with text; do not use organization branding as Studio chrome.
- Studio supports English, Spanish, and Russian using react-i18next. Follow [`docs/localization.md`](docs/localization.md): new user-visible strings go through `t()` and all locale files, not hard-coded UI English. Preserve existing English copy during key conversion when tests rely on it, and run the relevant i18n scan.

Studio in the browser must remain functional without a native host. Native iOS routes and actions follow the bridge contract in [`docs/ios-app.md`](docs/ios-app.md), rather than adding feature-specific SwiftUI duplicates.

## Android Player conventions

- One application ID: `org.tilecast.player`, covering Fire TV, Google TV, Android TV, store releases, and sideloaded builds. Kotlin/Compose owns Android UI and host lifecycle; shared Player Runtime owns presentation. The native Rust Player Core adapter lives under `apps/player-android/native/`.
- Minimum API 23. Get current compile/target SDK, NDK, signing, and toolchain versions from `apps/player-android/app/build.gradle.kts`; do not freeze version numbers in this guide.
- Protect the device credential with the platform's secure storage. Verify Server installation identity before sending it. Use the established URL policy (HTTPS for public hosts; HTTP only for explicitly allowed local addresses); never downgrade silently.
- Keep temporary pairing state reconstructable. Do not fork shared Player policy in Kotlin or reimplement playback in Compose to work around the shared renderer.
- All player controls must work with D-pad focus and remote activation. Show clear paired, unassigned, offline, error, and recovery states instead of exceptions, raw IDs, debug JSON, or placeholders. Do not claim hardware compatibility without device verification.

Follow [`docs/android-development.md`](docs/android-development.md), [`docs/player-core.md`](docs/player-core.md), and [`docs/player-runtime.md`](docs/player-runtime.md) for implementation details and qualification.

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
- uploaded filenames never become filesystem paths; media processing uses generated paths
- media processing and FFmpeg must have bounded resources and generated input/output paths
- never leak credentials into website content, untrusted runtime data, URLs, logs, or screenshots; use the documented Website security boundary

## Build and verification

Use the smallest relevant test suite while developing; run the required broader checks before handoff. Commands below are entrypoints, not evidence that a platform was tested. See [`docs/testing.md`](docs/testing.md), platform READMEs, and the root `Makefile` for prerequisites and full scopes.

```sh
make doctor AREA=dashboard # or server|edge|windows|android|media|docs
make check                 # root integration checks (not a substitute for native/hardware tests)
make build                 # full workspace/Server/Android debug build; requires platform toolchains
make player-check player-test
make edge-check edge-test
make windows-check windows-test
make android-check
npm run build:player-web
npm run docs:build
```

- For extensions, run `make plugins-check`, `make widgets-check`, and `make data-sources-check`, plus relevant package tests. Regenerate via the supported tools; do not edit generated contracts.
- For Server and authentication/protocol changes, run relevant Go tests and PostgreSQL integration tests with `TEST_DATABASE_URL`. The test role must be able to create and drop isolated test databases. Check authorization, credential revocation, and Server/Player compatibility.
- For Studio changes, run focused Vitest, typecheck/build, lint, i18n, and accessibility-relevant UI tests. For Browser Player changes, use its own tests and contract/e2e checks in [`docs/browser-player.md`](docs/browser-player.md).
- For Android native changes, run JVM tests and Rust host tests; use instrumented tests and real devices for focus, playback, WebView, and hardware behavior. For Edge, verify Linux WPE/systemd and device-specific behavior separately. For Windows, verify WebView2 on Windows.
- Test pairing, reconnect, identity mismatch, revocation, offline playback, and recovery when touching related code. Do not reuse historical green results as proof for a changed branch.

In the PR handoff, state the exact checks run, any failures or skips, and remaining device or release-qualification risks. Never claim CI, emulator, or physical-device coverage without evidence.

## Generated files and artifacts

Do not commit:

- `.env` files
- `node_modules`, Vite `dist`, Gradle `.gradle`, or Android `build`
- `apps/server/tilecast-server`
- `apps/cli/tilecast`
- private signing keys or signing passwords
- Android `local.properties`
- temporary PostgreSQL data

Expected local outputs:

- debug APK: `apps/player-android/app/build/outputs/apk/debug/app-debug.apk`
- unsigned release APK: `apps/player-android/app/build/outputs/apk/release/app-release-unsigned.apk`
- dashboard bundle: `apps/dashboard/dist`
- local server binary: `apps/server/tilecast-server`
- local remote CLI binary: `apps/cli/tilecast`
- Docker image: `tilecast/server:local`

The source `apps/server/internal/web/static/index.html` is a development fallback. Docker and `make build` replace it with the compiled dashboard before building the production server binary. Avoid accidentally committing generated hashed assets there.

## Working-tree care

This repository may have user-owned uncommitted work. Inspect `git status` before editing. Preserve unrelated changes. Do not use `git reset --hard`, `git checkout --`, or other destructive cleanup commands. Use `apply_patch` for intentional source edits and formatters only for mechanical formatting.

Use `rg` and `rg --files` for searches. Keep modules focused and comments limited to behavior that is not obvious from the code.

## Documentation requirements

Update documentation with the implementation, not afterward as an approximation. Relevant files include:

- `README.md`
- `docs/architecture.md`
- `docs/api.md`, `docs/openapi/core.yaml`, and each plugin's `api/openapi.yaml` (the composed `docs/openapi.yaml` is generated)
- `docs/plugin-api.md`
- `docs/player-protocol.md`
- `docs/device-credential-security.md`
- `docs/android-development.md`
- `docs/mdns-discovery.md`
- `docs/deployment.md`
- `docs/troubleshooting.md`
- `docs/localization.md`
- `docs/player-core.md`, `docs/browser-player.md`, `docs/ios-app.md`, and relevant platform contracts
- `docs/marketplace.md`, `docs/packages.md`, `docs/widgets-v2.md`, and `docs/data-source-modules.md`

Tilecast has two documentation sets, and a change must update both where it applies:

- **Engineering docs** in `docs/` are the specifications and contracts listed above. They follow the ASD-STE100 rules in `docs/documentation-style.md`, checked by `make docs-check`.
- **The public docs site** in `apps/docs/src/content/docs/` is what installers, operators, and contributors read. Update it in the same change whenever you add or change something a user can see or do: a Studio feature, a setting, an install or upgrade step, a Player behavior, or a contributor workflow. It follows `apps/docs/STYLE.md`, not the ASD-STE100 rules. When adding a public page, register it in the current docs navigation configuration, link to the engineering doc for the exact contract instead of restating it, and run `npm run docs:build`, which also checks internal links.

A change that only touches internals with no user-visible effect does not need a public docs page.

For media changes, document storage, upload limits, processing/transcoding, range requests, cleanup, and backup implications. Keep operator and API documentation aligned with implementation.
