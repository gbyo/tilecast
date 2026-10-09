# Tilecast architecture

Tilecast is a self-hosted modular monolith with one organization per installation. The Server compiles into one Go binary. It serves the versioned REST API, applies embedded SQL migrations at startup, and serves the compiled Studio application. PostgreSQL is the source of truth. This document describes the current architecture. The linked domain documents define the exact contracts.

## Boundaries

- `cmd/tilecast-server` owns process startup, graceful shutdown, local backup and restore, and emergency MFA reset. The remote `tilecast` CLI lives in `apps/cli` and never links server code.
- `internal/config` validates environment configuration.
- `internal/database` owns the connection pool and Goose migrations.
- `internal/auth` owns password hashing, first-owner setup, users, opaque sessions, and multi-factor authentication.
- `internal/httpapi` translates versioned HTTP contracts to application operations. Database rows are not serialized directly.
- `internal/presentnet` owns Presentation Network validation, AES-256-GCM credential envelopes, organization network definitions, Linux screen assignments, and player provisioning material. Its only plaintext-secret path is the authenticated player endpoint; Studio, audit, command, and configuration contracts use redacted metadata.
- `internal/media` owns resumable upload state, generated storage keys, local storage, trusted inspection, compatibility decisions, persistent jobs, and delivery metadata.
- `internal/playlists` owns ordered playlists, direct assignments, per-screen manifest versions, manifest contracts, and summarized synchronization status.
- `internal/plugins` hosts the bundled Plugin API registry and installation lifecycle. Plugin-owned implementation stays below `plugins/<plugin>/`; installation gates its contributed routes, background work, definitions, and Player projection. Brand Bug and Noise Meter are retired compatibility rows. `internal/extensions` owns external package resolution, provenance, activation, contributions, sandbox frames, and the isolated WebAssembly package runtime.
- `internal/web` serves immutable dashboard assets and the SPA fallback.
- `packages/api-schema` owns the generated OpenAPI TypeScript contract. `apps/dashboard/src/api/transport.ts` owns the typed first-party JSON transport. Domain modules in `apps/dashboard/src/api/domains/` expose operations to Studio. Dynamic plugin operations use the plugin API boundary.
- `apps/dashboard/src/data` owns domain query keys and `queryOptions()` factories. Screen queries preserve the existing cache keys during adoption.

- `apps/dashboard/src/data/content.ts` owns Content catalog query keys and options. Asset pages use the actual request filters as their cache key. The library and picker share pagination and processing refresh. The API domain module retains response normalization.
- `apps/dashboard/src/data/layouts.ts` owns Layout query keys and options. The editor, popup preview, and Screen content dependencies share normalized detail data. Revision history uses a detail child key. Local draft history and autosave remain editor state.
- `apps/dashboard/src/data/playlists.ts` owns Playlist query keys and options. Complete lists and infinite pages use different keys. The editor, popup preview, and Screen content dependencies share normalized Playlist detail data. API domain modules retain response normalization.
- `apps/dashboard/src/data/schedules.ts` owns Schedule query keys and options. Infinite pages and complete lists use different keys. Schedule previews include the Screen, timestamp, and proposed input in their keys. The Server remains the schedule selection authority.
- Schedule mutation options own typed requests and cache invalidation. The editor owns confirmation, feedback, and navigation. Domain success handlers remain active after a UI observer disconnects.
- `apps/dashboard/src/data/settings.ts` owns the organization settings document query. Settings, regional formatting, policy definitions, and Takeover defaults share this cache. A successful settings save updates the shared document. `apps/dashboard/src/data/account.ts` owns the separate account preferences query. Both queries cancel through the typed transport. Local drafts remain in the editor.

- Presentation Network Wi-Fi is a sidecar to a Linux Player's Ethernet path. The narrowly scoped root-owned `tilecast-networkd` helper owns only Tilecast-named NetworkManager profiles and never changes the existing Ethernet profile. Linux Legacy reaches it through the unprivileged Electron client; Edge uses its native typed client. Neither Player receives general NetworkManager or root access.
- `packages/*-schema` own versioned cross-application contracts. Player manifest schemas and presentation capabilities are defined in `packages/manifest-schema`.

## Authentication model

The first successful setup request acquires a PostgreSQL advisory transaction lock, creates the single organization and owner, records an audit event, and issues a session atomically. Passwords use Argon2id with a unique random salt. The browser receives a random opaque session token in an HttpOnly, SameSite=Strict cookie; PostgreSQL stores only its SHA-256 hash. Authenticated state-changing requests also require a session-specific CSRF token.

Sessions are revocable database records rather than self-contained tokens. This is intentionally compatible with later user deactivation and administrative session revocation. OIDC may be added behind the authentication boundary without changing resource APIs.

An account may carry a second factor: an authenticator app, one or more WebAuthn passkeys, or single-use recovery codes. A correct password on an enrolled account produces a short-lived single-use challenge rather than a session, and the cookie is issued only once the factor is verified. A passkey is both first and second factor, so a discoverable ceremony signs the user in with no username at all. Because WebAuthn requires a secure context and a registrable domain, passkeys are unavailable on the plain-HTTP LAN installations Tilecast also has to support; the server resolves this at startup and reports the reason rather than offering a control that cannot work. The organization-wide enrollment requirement is a session flag rather than a login refusal, so tightening policy can never lock an installation out of itself. See [multi-factor-authentication.md](multi-factor-authentication.md).

## Database evolution

Goose migrations are embedded in the binary and run before the Server accepts traffic. Goose records applied versions. Migrations must be forward-safe. Player manifest schemas have separate versioned compatibility rules. See [player-protocol.md](player-protocol.md).

## Dashboard delivery

During development Vite runs separately and proxies `/api` to the server. The container build compiles the dashboard first and embeds the resulting hashed assets into the Go server, leaving one application process to deploy.

Studio text is localized in the browser with react-i18next. English is bundled and each other language is a separate lazily loaded chunk, so the server embeds every locale but a browser only downloads the one it uses. The server API stays English; each person's language is the `preference.language` user preference. See [localization](localization.md).

## Player enrollment and playback

The accepted native Player extraction contract is
[`player-core.md`](player-core.md). It separates shared native behavior from
host integration. Presentation decisions and execution remain with
Presentation Model and Player Runtime. Generic native values are implemented in
`crates/player-types`, and durable metadata in `crates/player-state`. Historical
Edge repository APIs remain outside the shared crate. Verified storage lives in
`crates/player-cas`. Server transport lives in `crates/player-client`; Edge owns
its private file stores and Electron import. The Core foundation owns native
selection, command idempotency, Activity sessions, and the CAS origin adapter.
Core also owns renderer recovery decisions and meaningful-evidence rules.
Each native host executes renderer actions through its RendererPort adapter
and keeps its current process and security boundaries.

The Android Player uses Kotlin/Compose for platform UI and lifecycle, a native Rust Player Core host for pairing, connection, manifests, offline state, and recovery, and the shared Player Runtime in its trusted WebView. Android Keystore protects the device credential. Room is not a production state store; migration tests use the legacy database format. Linux Edge and Windows likewise host shared native Player Core and Player Runtime through platform-specific renderers. The experimental Browser Player shares the presentation model and runtime but has a distinct browser-host authentication and offline model. See [Android development](android-development.md), [Native Player Core](player-core.md), and [Browser Player](browser-player.md).

The `devices` server package owns installation identity, pairing sessions, enrollment, credential replacement, screen administration, and status calculation. Pairing codes, poll secrets, enrollment tokens, and device credentials have distinct purposes. A stable player installation ID maps recovery requests back to the original screen; explicit repair approval is stored on the session, while previous credentials are revoked only in the successful enrollment transaction. Active WebSocket membership is kept in a process-local presence hub and is the strongest online signal; PostgreSQL timestamps provide recent, stale, and offline status after a restart.

Media files use a provider interface with a local backend under `/data/media`. PostgreSQL owns asset, variant, upload, and job state; the filesystem stores bytes only under generated identifiers. Upload finalization hashes and identifies content before an asset is created. Workers claim durable jobs with PostgreSQL row locking and skip-locked semantics, so jobs survive restarts and multiple processes do not execute one claim concurrently.

FFprobe extracts trusted video metadata. FFmpeg is invoked directly, never through a shell, with local-file protocol restrictions, timeouts, metadata stripping, bounded worker concurrency, and generated input/output paths. Derivatives are written to temporary files and atomically promoted. The first compatibility profile is MP4/H.264/yuv420p/AAC-LC at no more than 1920×1080 and 60 fps, with fast-start and normalized rotation. Compatible originals are reused; otherwise Tilecast remuxes when possible and transcodes only when necessary.

Manifest versions are persisted per screen and advance only when its assignment or playback-relevant playlist revision changes. Reads are idempotent and use stable ETags. WebSockets carry only `manifest.changed`; players periodically reconcile as a fallback.

Player Core stores durable native manifest and activation state, while the platform supplies private storage and verified file access. A pending manifest activates only after required files pass size and SHA-256 verification and durable preparation. The previous active manifest remains available during preparation, and offline startup uses verified committed content. Android imports older Room state only through its legacy migration path.

Playback supports either a fullscreen playlist or a published Layout. Layouts render natively, scale landscape and portrait canvases without distortion, and run positioned playlist zones independently alongside Apps, Assets, and primitives. Publishing limits a Layout to one active video-capable placement or zone and one audio-emitting placement or zone. An invalid or incompletely prepared Layout never replaces the previous verified presentation.

## Scheduling and Display Groups

`packages/presentation-model` owns deterministic availability and item-default
decisions shared by Studio and Player Runtime. Runtime compatibility modules
re-export those functions. Studio's settings adapter stays in Studio. The
model has no mounting, storage, telemetry, or host APIs. See
[Presentation Model](presentation-model.md) for the current boundary and
shared fixtures.

Display Groups own synchronized fallback content and schedule targeting. Existing
groups migrate to `display_mode=mirror`, which is the current synchronized
behavior. A screen belongs to zero or one group; PostgreSQL enforces the
invariant with a unique membership constraint. Assigning content through any
member updates the group assignment, and a schedule aimed at a grouped screen
is normalized to the group target. Ungrouped screens keep independent
assignments and schedules. `internal/scheduling` remains the server authority
for half-open interval evaluation and deterministic precedence: priority,
target specificity, later effective start, then stable ID. Player Core and shared presentation contracts preserve deterministic offline behavior.

`scheduling.Explain` calls this same resolver. It returns a reason code for
each selected, inactive, or superseded schedule. Selection and explanation
use one precedence comparator. Disabled schedules do not contribute a next
transition. The supplied schedules describe a configuration at an explicit
instant; they do not establish a historical expectation. Historical reports
must use recorded expected playback windows.

`internal/playbackplan.Current` composes the assignment reader, schedule
explanation, and active Takeover and Quick Present readers. It selects content
in this order: Takeover, Quick Present, schedule, then assignment. Display-control
schedules do not select content. Inspection does not create manifest state or
expire temporary presentations. The next evaluation time is a boundary for
another evaluation; it does not guarantee a change in selected content.
This internal reader predicts selection from current configuration. It does
not establish content readiness, Player capability, or actual playback.

Span Display Groups extend this model with a logical canvas and one validated
viewport per member. The manifest adds optional canvas/viewport fields only for
Span screens; server-side panel preparation keeps legacy Linux hardware on
normal-resolution H.264 files. See [Span video walls](span-video-walls.md).

Player manifests contain only schedules relevant to the authenticated screen, its playlist or Layout fallback, referenced published Layout revisions, required Apps, playlist zones, structured datasets, media variants, server time, preparation policy, and optional sync-group playback epoch. Group members calculate the same current item and elapsed offset from the shared clock, including after reconnecting late. Recurring rules use calendar calculations rather than fixed-duration days. A repeated local time uses the earlier occurrence for a start and later occurrence for an end; a nonexistent local time advances to the first valid time after the DST gap.

## Website playback

Website configuration is normalized in `website_assets`; no page data or credentials are stored. Manifest v3 includes only websites referenced by relevant playlists, plus optional fallback-image variants. The Android player isolates WebView policy, lifecycle, timeout/reload control, failure state, and data clearing from Compose playlist orchestration. Scheduling is unchanged.

The server validates URLs without fetching them, avoiding SSRF and network-topology assumptions. Top-level navigation uses an exact-host allowlist on the player. Subresource filtering is intentionally not claimed because Milestone 6 does not install a request-interception proxy.

## Apps and data Sources

Apps are reusable configured Content items backed by the closed Source/provider registry. The `sources` table remains the internal compatibility name and stores a built-in provider, provider configuration version, and validated JSON object; clients cannot invent provider names or arbitrary keys. Website and YouTube are Apps in Studio. Clock, Date, QR Code, and Ticker are native Apps. Calendar, RSS, Atom, JSON, and CSV may supply prepared data to a display App or render directly when their playback model supports it.

Layouts place generic references to Widgets, Media, and playlists; custom text primitives may bind to a Data Source field. A placement owns bounds, layer, opacity, and visibility; it never copies or silently edits the shared Widget configuration. Playlist zones remain a separate region type. Static text, shapes, lines, decorative images, groups, and background properties are native layout primitives rather than Widgets. Data Sources are never placed as content. See [widgets-and-layouts.md](widgets-and-layouts.md).

Manifest v12 introduces a renderer-neutral typed record boundary between Data Sources and native Widgets. Provider-specific acquisition and authoring configuration stays on the server; the Player receives only bounded fields, records, cache state, date policy, and attribution.

Manifest v13 extends that boundary into a declarative presentation runtime. The Server-owned release catalog in `internal/contentdefs` is the runtime source of truth for Widget and Data Source metadata, form schemas, output schemas, adapter IDs, presentation templates, and exact capability requirements. `internal/media` validates release-defined configuration and dispatches trusted acquisition through adapter IDs; `internal/playlists` resolves trusted placeholders into a provider-neutral native node tree before the manifest is sent. Android validates capabilities and interprets final documents instead of selecting a renderer from the provider name.

Widgets V2 (manifest v16 and v17) add first-class Widget components. A Widget module below `widgets/` carries its catalog entry and its component in one `tilecast.widget.json`; the Server embeds those files through the `widgets` Go module, and the Player Runtime and Studio discover the same modules when they are built. For each screen, `internal/playlists` sends schema 3 with the declared empty policy to a Player that reports schema 3 and the exact `widget.<type>` capability, schema 2 to an older component-capable Player, and the Widget's compatibility presentation to every other Player. See [widgets-v2.md](widgets-v2.md).

Catalog Apps extend that boundary without collapsing it. An App recipe atomically provisions a Widget and an explicitly owned, hidden Data Source, then stores the source ID in the compiled Widget configuration so the existing relational usage, invalidation, readiness, and manifest paths remain authoritative. Release-defined Web Integrations compile a closed host policy and built-in URL normalization into the provider-neutral web descriptor; manifest v15 adds bounded periodic reload and requires web runtime 2. Players remain provider-agnostic. See [Adding a Tilecast App](adding-a-tilecast-app.md).

## Form Data Sources

Forms is a bundled plugin. Its Server implementation lives in
`plugins/forms/server`, while `internal/plugins` supplies the host services and
installation gate. A Form's `data_sources` row remains the parent content
resource so ordinary Widget and Layout projection can consume approved views.

The plugin owns immutable published revisions, submissions, record history and
comments, saved views, per-form grants, and image attachments. It projects
approved output into `data_source_refresh_states.cached_payload` and invalidates
affected manifests through the normal Data Source path. The Player therefore
needs no Forms-specific renderer or protocol.

Published revisions remain immutable. The Server enforces per-form grants.
Unapproved records and their attachments never enter a manifest, and form
attachments are not selectable as ordinary public Media.

Compatibility is evaluated per assigned presentation across direct assignments, groups, schedules, Layout and playlist dependencies, and takeovers. A future catalog capability does not affect existing content unless an assigned presentation requires it. The presentation-catalog fingerprint is generated from embedded definition files, definition versions and schemas, templates, and the compiler version; catalog changes increment manifest versions and ETags.

Live information sources may expose multiple named datasets. Transit emits departures and alerts; Air Quality emits a current object and hourly time series. Source configuration, coordinates, endpoint details, and upstream request metadata are never projected to the Player.

Layout drafts are mutable JSON documents guarded by an optimistic draft revision. Publishing inserts an immutable revision with a canonical document SHA-256 and materialized App, Asset, and playlist dependencies. Published history is append-only; restoring history creates a new draft. This keeps usage checks relational and ensures Players can only activate a stable published document.

Editorial publication is shared by Playlists, Layouts, and Campaigns. A
submission stores the complete canonical snapshot a reviewer saw, so later
working-draft edits cannot change an approval or a scheduled deployment.
Playlist draft rows are separate from the normalized live rows used by
manifest assembly; Campaign releases are immutable scheduling snapshots that
materialize into ordinary `schedules` rows tagged with their Campaign and
release IDs. Publication history is append-only, and rollback creates a new
native revision/release rather than moving a live pointer backward. The
server-owned scheduler and manifest invalidation path remain the only runtime
boundary, so Players do not need to understand editorial objects.

Studio's Layout editor uses the same v1 document as the server validator. Its local command history supports undo/redo independently from autosaved server revisions; pointer and keyboard edits always resolve to canvas coordinates so portrait and landscape documents remain resolution-independent. Android's native renderer scales that canvas into the available display bounds without WebView, resolves structured bindings against cached date-aware data, and preserves global layer order across primitives, Apps, Assets, and playlist zones.

Manifest v5 contains only Sources referenced by playlists relevant to the authenticated screen. Source items use stream delivery; fallback images continue through the verified media-variant preparation path. The provider boundary is internal—Tilecast does not load third-party provider code or expose a marketplace.

Calendar Sources add a server-owned refresh boundary. `source_refresh_states` is both the restart-safe `SKIP LOCKED` claim queue and the bounded last-known-good cache; it stores only sanitized, expanded event occurrences and current diagnostics. Fetches use a dedicated no-proxy HTTP transport with DNS and dial-time private-address checks, timeouts, redirect and response limits, and content validation. Manifest v7 strips configured feed URLs and sends only the prepared data required by that screen. Android renders it natively in Compose and never opens structured calendar data in WebView.

Content organization remains inside the media domain. Folders are a nullable asset relationship with database-level `ON DELETE SET NULL`; collections and tags are many-to-many metadata. Bulk changes validate all referenced rows and commit atomically, with one bounded audit event per request. Organization metadata is intentionally absent from Player manifests, so rearranging Studio content cannot interrupt playback or invalidate otherwise unchanged manifests.

RSS, Atom, JSON, and CSV extend the Calendar refresh boundary rather than adding provider-specific workers. One `source_refresh_states` row is the restart-safe `SKIP LOCKED` queue, current typed diagnostics, and bounded last-known-good payload. Provider-specific parsers normalize into a renderer-neutral record contract; manifest v8 carries only prepared records. Android validates that contract and shares native list, agenda, card, and ticker primitives across all four providers.

Manifest v9 adds native Clock, Date, QR Code, and Ticker Apps plus date-aware structured Source configuration. The server prepares and bounds datasets, but the Player selects the active record from its current local calendar date and configured IANA timezone. It reevaluates without a manifest revision at calendar transitions, startup, and runtime clock changes; reuse of a previous record requires the explicit `last_known_good` policy.

## Operations

Takeovers are separate lifecycle records rather than schedules. Manifest v4 references a Takeover playlist and expiration only for affected screens; its released `emergency` JSON key remains a compatibility boundary. Optional NWS rules monitor official active alerts and raise bounded Takeovers using a hidden Tilecast-managed live alert presentation or an operator-selected playlist. Persistent typed player commands use PostgreSQL as the delivery source of truth; WebSockets only announce availability. See [takeover-and-operations.md](takeover-and-operations.md).

## Settings architecture

The closed typed registry separates organization settings, preferences, group policy, and screen policy. Effective player policy uses screen, group priority plus stable UUID, organization, then built-in precedence. A separate ETag-enabled player configuration document changes policy and branding without revising content manifests. See [settings.md](settings.md).

## Android reliability

`CommissioningController`, `ActiveHoursEngine`, `ReliabilitySupervisor`, `ReliabilityController`, and the accessibility return policy are independent of Compose playback UI. Boot recovery restores cached state and uses bounded launch retries. Watchdog escalation persists crash history, executes each recovery rung, and enters safe mode without deleting configuration. Managed Kiosk is capability-confirmed through Android device policy and lock task. Accessibility Control observes only foreground package transitions and applies a fixed excluded-package policy. Android Power Assist selects device-policy sleep, accessibility lock, or black-screen fallback; it never sends direct HDMI-CEC commands. Linux Display Control is a separate capability-gated provider path for host-attached displays. Studio stores human-confirmed physical-TV results separately from player-reported Android capability and shows a computed Zero-Touch Readiness panel. See [reliability-and-power.md](reliability-and-power.md).

## Player updates

The `updates` domain owns an optional fixed GitHub Releases provider, direct signed-release import, Ed25519-signed release manifests, Android APK-signature verification, private persistent cache, deployment snapshots, and per-screen state. Both release sources converge on one verified Player release model. Update commands reuse PostgreSQL command delivery; APK bytes use a device-authenticated range endpoint and never enter content manifests. Success remains provisional until the updated player reconnects with the expected version code. See [player-updates.md](player-updates.md).

## Tilecast Edge

Tilecast Edge is the Linux player that replaces the Electron Linux Player. The design is [`tilecast-edge.md`](tilecast-edge.md); the implementation state is in [`tilecast-edge-next.md`](tilecast-edge-next.md).

On each Linux player:

- `tilecastd` (Rust, `apps/edge`) runs as the fixed `tilecast` account. It owns the server relationship, the device credential, SQLite state, the content-addressed store and renderer supervision.
- `tilecast-renderer-wpe` (C, WPE WebKit 2.54+ on WPEPlatform) shows what `tilecastd` sends over a versioned Unix socket. It holds no credential.

The server stays the only authority, and Edge uses the ordinary player API: identity, pairing, heartbeat, the player WebSocket, manifests, commands and authenticated downloads. The server has no Edge-specific domain package or endpoint. A player keeps playing from its local state and verified content when the server is unreachable.

## Tilecast Player for Windows

The Windows Player (`apps/player-windows`) is the native Windows host of the same shared Player Core and Player Runtime: Player behavior is implemented once, not once per operating system. The platform contract is [`tilecast-windows.md`](tilecast-windows.md); physical qualification is tracked in [`tilecast-windows-qualification.md`](tilecast-windows-qualification.md).

On each Windows player, one Rust process owns the server relationship, pairing, configuration, manifests, selection, scheduling, offline activation, commands, Activity, and telemetry through the shared crates. It hosts the exact `packages/player-runtime` artifact in an Evergreen WebView2 view over the trusted `tilecast://runtime/` origin, serves verified media through opaque `tcmedia://cap/` grants, and shows remote Websites and YouTube in isolated child views of a separate WebView2 environment. User-scoped Windows DPAPI protects the device credential. Updates arrive as signed per-architecture MSIX packages through the ordinary Player Updates deployment flow.

The server has no Windows-specific domain package or endpoint: releases of the `windows` family (architecture `x86_64` or `aarch64`) travel the same signed-envelope, deployment, and heartbeat-settlement path as the other families.
