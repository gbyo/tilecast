# Programmable control plane

This document is a binding engineering record. It defines the architecture
for the Tilecast programmable control plane. Later phases must follow it.
A later phase may amend this document in its own reviewable change. No phase
may contradict it silently.

Base: `origin/main` at `c683ce28`. The findings below describe that revision.
The local names are Tilecast Studio for the management browser application
and Tilecast Player for the TV application.

## North star

Tilecast Server holds the domain logic. The Server exposes one supported
HTTP API. An OpenAPI contract describes that API. A generated Go client
implements the transport. Two hand-designed surfaces use that client: the
`tilecast` CLI and the MCP interface.

```text
Tilecast Server
      |
domain logic
      |
supported HTTP API
      |
OpenAPI contract
      |
generated Go client
      |-----------|
      |           |
hand-designed hand-designed
CLI         MCP
```

The product rule is simple. If Tilecast Studio can do it, the supported API
must expose it, the CLI must represent it well, and ordinary operator
workflows must reach authorized agents through MCP.

The plugin rule is strict. A well-formed new plugin must gain CLI and MCP
participation without central code learning the plugin identifier.

## Non-negotiable rules

- Core code must not name a plugin identifier. This applies to command
  registration, MCP registration, Studio, and Server special cases.
- CLI and MCP fields must not enter the frozen Plugin API v1
  `tilecast.plugin.json`.
- OpenAPI must not become a CLI or MCP language. It describes HTTP transport
  only.
- `pluginctl` composes OpenAPI without interpreting command semantics. Keep
  that separation.
- CLI and MCP must not create a second API implementation. They use the
  supported API through the shared client.
- No `/api/v1/cli` or `/api/v1/mcp` copies of existing operations may exist.
- The remote CLI must not import Server internals, PostgreSQL code, or
  plugin implementation packages.
- `tci_...` integration tokens stay narrow. They must not become user or
  administrator credentials.
- Bearer-authenticated clients must not provide CSRF tokens. The Server must
  not require them.
- MCP must not spawn CLI subprocesses. MCP uses the shared Go client.
- MCP must not expose one tool per REST operation. MCP tools are semantic
  operator workflows.
- Break-glass restore and emergency MFA reset stay local. They never enter
  the remote API, CLI, or MCP.
- Tilecast must not become a general OAuth or OIDC provider. The Server acts
  as authorization server only for its own installation and its own clients.

## Contract ownership

The source-of-truth arrangement stays fixed:

```text
docs/openapi/core.yaml
+
plugins/*/api/openapi.yaml
        |
        v
     pluginctl
        |
        v
docs/openapi.yaml
```

- `docs/openapi/core.yaml` is core-owned. Core changes review it.
- Each `plugins/*/api/openapi.yaml` fragment is plugin-owned. It lives next
  to the plugin implementation.
- `docs/openapi.yaml` is generated. No hand edits may enter it.
- `packages/plugin-sdk/tools/pluginctl/openapi.ts` merges maps and rewrites
  references only. It does not interpret OpenAPI.
- OpenAPI describes the HTTP transport contract. It does not define the CLI
  or MCP user experience.

## Credential boundaries

Tilecast has four credential boundaries today. The control plane adds a
fifth. Each boundary uses its own middleware. No boundary accepts another
boundary credential.

| Boundary             | Credential                                                                                                        | Middleware                                                                         | CSRF                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------- |
| Dashboard session    | Opaque cookie, SHA-256 hash stored                                                                                | `requireSession` in `apps/server/internal/httpapi/server.go`                       | Required on unsafe requests |
| Player device        | `Authorization: Bearer <device-credential>` (public ID selects the record; random secret checks against its hash) | `requireDevice` in `apps/server/internal/httpapi/devices.go`                       | Never                       |
| Integration token    | `tci_...` scoped bearer                                                                                           | `requireIntegrationToken(scope)` in `apps/server/internal/httpapi/integrations.go` | Never                       |
| Release publish      | Bearer publish token or Owner session                                                                             | `requireReleasePublisher` in `apps/server/internal/httpapi/server.go`              | Session path only           |
| User API grant (new) | Short-lived opaque bearer, PAT                                                                                    | `requireUser` (Phase 8)                                                            | Never                       |

Facts that constrain the design:

- `requireRoles` reads `auth.Session` from the request context. Management
  authorization is coupled to the session type today. Phase 4 introduces a
  principal that both sessions and bearer grants produce.
- `requireEnrollment` closes the dashboard group to sessions that owe MFA
  enrollment. The `/me/security` endpoints sit outside that group so the
  user can enroll. Bearer grants never enter the enrollment flow.
- Integration scopes today are `data_source:write` and `activity:read`
  (`apps/server/internal/integrations/integrations.go`). Grants for users are
  a separate model with role and screen-scope intersection, not an extension
  of these scopes.
- The pairing poll uses a private poll secret, never the visible
  six-character code. The device credential hash check uses constant-time
  comparison. These invariants stay unchanged.

## CLI, API, and MCP responsibilities

- The API owns domain logic, validation, authorization, and state. The
  Server remains authoritative for settings inheritance, revision conflicts,
  and idempotency.
- The generated Go client owns transport: auth headers, server URL, request
  IDs, pagination helpers, typed errors, revision conflicts, streaming, and
  version detection. It owns no domain logic.
- The CLI owns names, grouping, flags, help, tables, prompts, and
  confirmations. Commands are handwritten Cobra commands.
- MCP owns semantic operator workflows. Tools map to operator intent, not to
  HTTP operations.
- Plugin `automation.yaml` owns presentation mapping only: operation ID to
  CLI path and MCP action, plus risk class. It redefines no HTTP path,
  schema, authorization, or validation.

## Core CLI philosophy

Core commands are handwritten. Examples of the target shape:

```text
tilecast screen list
tilecast screen get
tilecast settings get
tilecast settings set
tilecast playlist publish
tilecast schedule create
```

The API client and types may be generated. Command names, grouping, flags,
help text, interactive behavior, table output, confirmations, and workflows
are designed in Go. The style follows mature tools such as the GitHub CLI
and kubectl: shared typed lower layers with explicit user-facing commands.
The core command tree is never generated from OpenAPI.

From the first command slice, the CLI establishes shared conventions:
`--json`, `--plain`, `--quiet`, `--context`, `--timeout`, and `--no-input`.
Standard output carries result data. Standard error carries progress and
warnings. A non-TTY invocation never prompts unexpectedly. UUIDs always
work. Unique human names may work. Ambiguous names are errors, never
guesses.

## Core MCP philosophy

Core MCP tools are hand-designed semantic workflows. The expected families
are screens, settings, content, playlists and layouts, scheduling, fleet
operations, activity, and users and administration. MCP never exposes one
tool per REST operation.

Risk annotations may describe a tool. They never replace Server
authorization. The Server enforces every action for the authenticated user,
role, screen scope, and grant.

## Plugin automation architecture

Core must not know plugin identifiers, so plugins need a generic path.
After the first handwritten core CLI slice proves what metadata matters,
the project introduces a versioned plugin automation contract:

```text
plugins/<plugin>/automation.yaml
```

Finalized shape (Phase 12). The schema source is
`packages/plugin-sdk/src/automation.ts`, with the portable
`schema/tilecast-automation.schema.json` and the worked example in
`plugins/countdown-bar/automation.yaml`:

```yaml
apiVersion: 1

operations:
  - operationId: listCountdownBarInstances
    risk: read
    cli:
      path: [instance, list]
    mcp:
      action: list_instances
```

Constraints:

- The file maps existing OpenAPI operations to automation presentation. It
  redefines no HTTP path, request schema, response schema, authorization,
  validation rule, or business logic.
- It carries its own version. It is not part of Plugin API v1.
- Its schema and validation live with `packages/plugin-sdk` and `pluginctl`,
  in a new automation module. `openapi.ts` keeps composing only.
- Operations that must stay out of automation use explicit exclusions with a
  reason, for example `browser-only-security-ceremony`.
- Generic behavior stays predictable. Complex structured input uses
  `--input` or `--file` rather than growth of the automation language.

## Security model

- Human passwords use Argon2id. All temporary secrets use high-entropy
  cryptographic randomness. Hash lookups use constant-time comparison.
- The Server stores credential hashes only. No full device credential, poll
  secret, enrollment token, or API secret lives in PostgreSQL or in logs.
- A correct password on an MFA-enrolled account yields a single-use
  ten-minute challenge, not a session. No cookie is set until the factor
  verifies.
- Authorization is always the intersection of the current user, current
  role, current screen scope, and grant restrictions. The Server never
  snapshots permanent role authority into a grant. A disabled user, role
  downgrade, or scope narrowing takes effect immediately.
- Cookie-backed browser requests require the session CSRF token on unsafe
  methods. Bearer-authenticated requests never use CSRF. OpenAPI must
  represent these alternatives correctly.
- Audit events carry the human user, calling surface (`studio`, `cli`,
  `mcp`), API grant, client identity, and request ID. Audit metadata never
  carries secrets.
- High-impact actions require explicit confirmation semantics in CLI and
  MCP. Break-glass actions have no remote path at all.

## Risk classes

The project uses one small durable risk model for CLI paths and MCP
actions:

| Class               | Meaning                          | Examples                             |
| ------------------- | -------------------------------- | ------------------------------------ |
| `read`              | Read-only                        | List screens, read settings          |
| `routine`           | Low-impact change                | Change active hours                  |
| `sensitive`         | Affects one screen or account    | Restart one screen                   |
| `high-impact`       | Fleet-wide or externally visible | Fleet restart, emergency takeover    |
| `security-critical` | Changes account security         | Reset MFA factors, manage tokens     |
| `break-glass`       | Local recovery only              | Offline restore, emergency MFA reset |

Break-glass operations never enter MCP. `tilecast mcp --read-only` must
permit only the `read` class. Risk annotations describe; the Server
authorizes.

## Version compatibility

The CLI performs a version and capability handshake on first use against a
server. It reports clear errors for a server that is too old, a CLI that is
too old, an unsupported operation, an unavailable plugin, and a feature the
target Player does not support. The project documents a compatibility
window and fails clearly outside it. It does not promise indefinite
forward and backward compatibility. A new Tilecast release with a new
bundled plugin must require no manual central CLI or MCP registration in
that same release.

## Break-glass boundary

`apps/server/cmd/tilecast` is a Server and local recovery utility. Phase 2
formalizes it as `tilecast-server` with `serve`, `backup create`, `backup
verify`, `backup inspect`, `restore verify`, `restore apply`, and `mfa
reset`. Restore application and MFA reset stay local and break-glass. They
never enter the remote CLI or MCP.

The existing Owner-only HTTP backup and restore endpoints remain Studio
operations. They are out of automation scope: no CLI command and no MCP
tool may invoke them. The emergency MFA reset has no HTTP path at all; the
local `tilecast-server mfa reset` command is the only path.

## Unified user principal

Management authorization reads `auth.Session` from the request context
today. Phase 4 introduces a durable authenticated-user principal that
separates the user from the credential mechanism:

```go
type Principal struct {
    User User

    CredentialKind CredentialKind
    AuthMethod     string

    GrantID        *uuid.UUID
    ClientID       string
    ClientInstance string

    EnrollmentPending bool
}
```

Browser sessions produce this principal first. Role checks, screen scope,
list scoping, and actor-based rate limiting move to it. Session-only
concerns stay session-only: logout, MFA management, passkey registration,
and browser security enrollment. Studio must behave identically after the
change.

The host translates the unified principal into the frozen Plugin API
principal (`packages/plugin-sdk/go/plugin/http.go`):

```go
plugin.Principal{
    UserID: principal.User.ID,
    Role:   principal.User.Role,
}
```

Plugin implementations do not change. There is no Plugin API v2. The
generic plugin route host (`mountPluginRoutes` in
`apps/server/internal/httpapi/plugin_routes.go`) adapts once, so the
`AccessViewer`, `AccessManager`, and `AccessSession` semantics hold for
both session and bearer credentials.

## Audit attribution foundation

Direct `INSERT INTO audit_logs` calls are scattered across some forty files
in `apps/server/internal` today, covering auth, devices, media, settings,
fleet operations, plugins, and most handler files. Phase 5 does not rewrite
them at once. It adds one shared audit-writing path that enriches events
from request context: human user, calling surface, API grant, client,
client instance, and request ID. `Host.Audit.RecordInTx` flows through that
path so plugin events gain attribution automatically.

Rules after the helper exists:

- Every domain that new CLI functionality touches must use the shared path
  before that functionality ships.
- Untouched domains may keep legacy writes temporarily.
- New direct production `INSERT INTO audit_logs` calls are prohibited.
- Audit metadata never carries secrets. The `metadata_sensitive` marking in
  `activity_audit.go` exists for that purpose; writers must use it.

## Capability inventory

### API route classification

Every route family below is read from `routes()` in
`apps/server/internal/httpapi/routes.go` at the base revision.

| Family                        | Routes                                                                                                                                                                                                                                                                                                                      | Class                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Public and bootstrap          | `GET /healthz`, `GET /readyz`, `GET /api/v1/system/health`, `GET /api/v1/system/identity`, `GET /api/v1/auth/status`, `POST /api/v1/auth/setup`, `POST /api/v1/auth/login`, MFA verify and passkey login                                                                                                                    | public/bootstrap          |
| User management               | `/users` list, create, update, delete, permanent delete, `POST /users/{id}/security/reset`, `/integration-tokens` CRUD, `/me/preferences`                                                                                                                                                                                   | user management           |
| Player protocol               | `/player/pairing-sessions` create and poll, `/player/enroll`, `/player/heartbeat`, `/player/socket`, `/player/manifest`, `/player/commands`, `/player/config`, `/player/assets/...`, `/player/span-panels/...`, `/player/updates/...`, `/player/presentation-network`, `/screens/pairing/*`, `POST /player-releases/upload` | player protocol           |
| Integration                   | `PUT /integration/data-sources/{id}/rows`, `GET /integration/activity/fleet`, `GET /integration/metrics`                                                                                                                                                                                                                    | integration               |
| Provisioning                  | `/install.sh`, `/install-airplay.sh`, `/install-presentation-network.sh`, `/install/*`, `/api/v1/install/*` (install rate limit, unauthenticated by design)                                                                                                                                                                 | provisioning              |
| Browser and security ceremony | `POST /auth/logout`, `/me/security/*` (TOTP, recovery codes, passkeys), passkey registration, enrollment gate                                                                                                                                                                                                               | browser/security ceremony |
| Local and break-glass         | `tilecast-server serve`, `backup create`, `backup verify`, `backup inspect`, `restore verify`, `restore apply`, `mfa reset` (no HTTP path)                                                                                                                                                                                  | local/break-glass         |
| Internal and demo             | `demoRoutes` behind dashboard checks, `demoState` and `resetDemo` operations                                                                                                                                                                                                                                                | internal/demo             |

Dashboard management routes (session plus enrollment gate, CSRF on unsafe
methods, role and screen-scope checks per route) cover screens, screen
groups, locations, presentation networks and overrides, AirPlay sessions,
live streams, snapshots, settings and policies, schedules, playlists,
layouts, campaigns, content and uploads, widgets, data sources, content
reviews, takeovers, fleet bulk operations, notifications and webhooks,
player releases and update deployments, users, plugins lifecycle, system
status and maintenance, backup management, activity and incidents, and
telemetry. Plugin dashboard routes mount last through the generic host and
cannot shadow a core route; a collision stops startup.

### Studio parity tracking

Each Studio capability tracks five columns toward the north star: supported
API state today, CLI coverage, MCP coverage, intentional exclusion, and
risk class. API states are `supported` (stable operation ID and typed
contract), `partial` (works in Studio, contract needs hardening), and
`ceremony` (browser-only by design).

| Studio capability                                | API today                                                                                                     | CLI                                                                 | MCP                                | Intentional exclusion                 | Risk                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- | ------------------------------------- | ---------------------------------- |
| System identity and status                       | supported (`installationIdentity`, `health`, `ready`)                                                         | `tilecast status` (Phase 11)                                        | fleet family                       | none                                  | read                               |
| Current user and preferences                     | partial (no stable current-user operation ID)                                                                 | `tilecast whoami` (Phase 9)                                         | users family                       | none                                  | read                               |
| Screen list and get                              | supported (`listScreens`, `getScreen`)                                                                        | Phase 11 slice                                                      | screens family                     | none                                  | read                               |
| Screen manage (update, disable, enable, revoke)  | supported                                                                                                     | fleet group (shipped)                                               | screens family                     | none                                  | sensitive                          |
| Pairing approve, reject, resolve                 | supported (`approvePairing`, `rejectPairing`, `resolvePairingCode`, `listPendingPairings`)                    | fleet group (shipped)                                               | screens family                     | none                                  | sensitive                          |
| Organization settings read and update            | partial (`/settings` has no stable operation IDs; revision semantics proven: expected revision, 409 conflict) | Phase 11 slice                                                      | settings family                    | none                                  | routine                            |
| Group and screen policy, effective policy        | partial                                                                                                       | Phase 11 `settings effective`                                       | settings family                    | none                                  | routine                            |
| Plugin catalog and install state                 | supported (`listPlugins`, `installPlugin`, `removePlugin`, `getPluginAutomation`, dependency graph)           | `tilecast plugin list/get/install/remove` (shipped)                 | plugin family per installed plugin | none                                  | routine for lifecycle              |
| Countdown Bar instances                          | supported (5 stable typed operations, resolved `automation.gen.json` embedded and served)                     | generic dispatcher (shipped)                                        | generic family (shipped)           | none                                  | routine                            |
| Emergency Alerts                                 | partial (fragment has 7 operation IDs; no `automation.yaml` yet)                                              | blocked on `automation.yaml` (generic path ready)                   | generic plugin action              | none                                  | high-impact for activation         |
| Forms workflow and records                       | partial (30 operation IDs, light schemas; no `automation.yaml` yet)                                           | generic dispatcher once mapped                                      | generic family once mapped         | none                                  | routine, sensitive for transitions |
| Brand Bug, Noise Meter instances                 | partial                                                                                                       | generic plugin CLI                                                  | generic plugin action              | none                                  | routine                            |
| Playlists, layouts, campaigns                    | supported to partial (`publishPlaylist` pinned)                                                               | playlist list/get/publish (shipped); layouts/campaigns open         | content family                     | none                                  | routine, sensitive for publish     |
| Schedules and publication                        | supported to partial                                                                                          | schedule list/get/create (shipped)                                  | scheduling family                  | none                                  | routine, high-impact for takeover  |
| Media, uploads, widgets, data sources            | supported to partial                                                                                          | content group (Phase 15)                                            | content family                     | none                                  | routine                            |
| Fleet bulk, commands, snapshots, display control | supported to partial                                                                                          | fleet group (Phase 15)                                              | fleet family                       | none                                  | high-impact for bulk and restarts  |
| Users, screen scopes, integration tokens         | supported                                                                                                     | token list/create (shipped); user management open (thin server API) | users family                       | token values shown once only          | security-critical                  |
| Activity, incidents, proof of play               | supported to partial                                                                                          | overview/uptime/incidents/compliance (shipped); proof-of-play open  | activity family                    | none                                  | read                               |
| MFA enrollment and passkeys                      | ceremony                                                                                                      | none                                                                | none                               | browser-only security ceremony        | security-critical                  |
| Login, logout, password change                   | ceremony                                                                                                      | browser login flow only                                             | none                               | credential entry stays in the browser | security-critical                  |
| Backup create, verify, inspect (local)           | local                                                                                                         | `tilecast-server` only (Phase 2)                                    | none                               | break-glass                           | break-glass                        |
| Restore apply, emergency MFA reset               | local, no HTTP                                                                                                | `tilecast-server` only (Phase 2)                                    | never                              | break-glass                           | break-glass                        |
| Owner-only HTTP backup restore and download      | supported                                                                                                     | none                                                                | never                              | remote restore stays Studio-only      | high-impact                        |
| Demo and internal routes                         | internal                                                                                                      | none                                                                | never                              | demo only                             | read                               |

## Phase sequence

Phase 1 (this document) changes no production behavior. The binding order
after it:

1. Phase 2 separates `tilecast-server` (local administration) from the new
   remote `tilecast` CLI module (`apps/cli/`, Cobra, `version`, `help`,
   `completion` only).
2. Phase 3 hardens the supported OpenAPI slice: system identity and status,
   current user, screens list and get, organization and effective settings,
   plugin catalog and install state. Emergency Alerts gains stable
   operation IDs. CI validation blocks regression.
3. Phase 4 introduces the unified user principal behind the session
   boundary. Studio behaves identically.
4. Phase 5 adds the shared audit path with calling-surface attribution and
   migrates touched domains incrementally.
5. Phase 6 adds user API grants with narrow built-in OAuth (authorization
   code with PKCE S256, loopback redirect, explicit approval screen, opaque
   short-lived tokens with rotation and replay detection).
6. Phase 7 adds expiring PATs on the same grant model with a distinct
   prefix and `TILECAST_URL` plus `TILECAST_TOKEN` environment use.
7. Phase 8 introduces bearer-aware `requireUser` management
   authentication. CSRF stays cookie-only. The plugin route host adapts
   once. Plugin implementations do not change.
8. Phase 9 implements CLI login, contexts, credentials, and `whoami` with
   OS-native secure storage and no silent plaintext fallback.
9. Phase 10 generates the Go transport client with handwritten ergonomic
   wrappers shared by CLI and MCP.
10. Phase 11 ships the first handwritten CLI slice: status, screen list and
    get, settings get, set, and effective, with JSON and human output,
    request IDs, audit attribution, revision conflicts, and non-TTY safety.
11. Phase 12 finalizes Plugin Automation Contract v1 from Phase 11
    experience. Phase 13 adds `pluginctl` automation validation. Phase 14
    ships the generic plugin CLI: handwritten `tilecast plugin`
    lifecycle commands plus a dynamic dispatcher that builds installed
    plugins' command trees from their resolved automation documents at
    runtime, with `--input`/`--file` bodies, sensitive+ confirmations,
    and JSON output. No plugin identifier appears in CLI source; a new
    conforming plugin with an API and `automation.yaml` works without a
    CLI change. Phase 15 expands core resource groups deliberately:
    fleet management and pairing, playlists, schedules, personal access
    tokens, and activity reads are shipped; fleet bulk operations, media
    uploads, layouts, campaigns, user management, and proof-of-play
    remain open.
12. Phase 16 ships MCP after the API, client, and CLI have substantial
    real use: `tilecast mcp` over stdio with the official MCP Go SDK,
    semantic core tools mirroring the CLI groups (screens, pairing,
    settings, plugins, playlists, schedules, tokens, activity),
    generic per-plugin tool families (`<plugin_id>_<mcp_action>`) for
    installed plugins only, and `--read-only` registering just the read
    class. Risk annotations describe; the server authorizes. Sensitive
    and higher tools take an explicit `confirm=true` argument instead
    of prompting, and break-glass operations never enter MCP.

## Definition of done

The project is complete when Studio remains fully functional, the
supported API is machine-checkable, CLI login uses the browser and existing
Tilecast authentication, user credentials follow current role and screen
scope, integration tokens stay narrow and separate, CLI secrets use secure
storage, core CLI and MCP UX are deliberate rather than generated, plugins
participate without central code naming them, automation metadata
duplicates no API schema, browser requests keep CSRF protection, bearer
clients use none, audit names the human and the calling surface,
high-impact actions carry explicit safety semantics, break-glass work stays
local, and parity is tested continuously.

The architectural regression test is fixed: create a conforming new
bundled plugin with an API and `automation.yaml`. If its CLI and MCP
surface requires adding the plugin identifier to central handwritten code,
the boundary is violated. Stop and fix the boundary.
