# Tilecast Plugin API v1

This document is the architecture decision record and the engineering contract
for first-party Tilecast plugins. [plugins.md](plugins.md) describes the
behavior of each built-in plugin. This document describes how a plugin is
built, discovered, and hosted.

Status: accepted. The foundation is implemented. The built-in plugins move to
the new structure one at a time; see [Migration status](#migration-status).

## Context

Before Plugin API v1, the then-current built-in plugins had one shared installation
lifecycle, but their behavior was spread across Tilecast. A new plugin needed
edits in the server registry, the status query, the removal switch, the
manifest projection list, the playlist asset projection, the manifest
invalidation query, the Studio router, the Studio route list, the Studio icon
map, the Player runtime renderer, the documentation sidebar, and the OpenAPI
file.

The goal of Plugin API v1 is this: a well-formed new bundled plugin is one new
directory below `plugins/`. Other changes are generated files only.

## Decision summary

- A plugin is a vertical feature module in `plugins/<name>/`. Its manifest,
  server code, migrations, OpenAPI fragment, Studio code, runtime code,
  documentation, and tests are in that directory.
- `tilecast.plugin.json` describes the plugin. A Zod schema is the source of
  truth. The portable JSON Schema (Draft 2020-12) is generated from it. The Go
  SDK parses the same file.
- Plugins are compiled into the Tilecast release. They are trusted
  first-party code. Plugin API v1 is an architectural boundary, not a sandbox.
- Plugins depend on the plugin SDK. They do not depend on Tilecast Server
  internals. The Go toolchain and `pluginctl` enforce this rule.
- The host asks each plugin through small optional contribution interfaces.
  The host never switches on a plugin identifier.
- Go has no compile-time import glob, so `pluginctl` generates the Go
  registry. Studio and the Player runtime use Vite `import.meta.glob`. The
  docs site uses one Astro `glob()` loader.
- Plugin migrations live in the plugin directory, but they use the one global
  Goose version sequence.

## Source layout

```text
plugins/
  go.mod                      module github.com/tilecast/tilecast/plugins
  registry_gen.go             generated Bundled() list
  review-eligibility.json     handles that GitHub can request for review
  <name>/                     name = plugin ID with "_" replaced by "-"
    tilecast.plugin.json      manifest
    plugin.go                 Go entry point: embeds the manifest, func New()
    plugin_test.go            plugintest.Conformance
    server/                   optional Go packages
    migrations/               optional Goose SQL files
    api/openapi.yaml          OpenAPI fragment for the plugin routes
    studio/index.tsx          defineStudioPlugin(...)
    runtime/index.ts          defineRuntimePlugin(...) for the shared Player runtime
    runtime/*.css             runtime stylesheets, scoped to .tc-<name>
    docs/*.mdx                public documentation pages
packages/plugin-sdk/
  src/manifest.ts             Zod manifest schema
  schema/                     generated JSON Schema
  go/                         Go SDK module: plugin, plugintest
  tools/pluginctl/            the repository tool
  testdata/manifests/         fixtures shared by the Zod and Go parsers
```

The dependency direction is this:

```text
Tilecast Server, Studio, Player runtime  ->  plugin SDK  <-  plugins/*
Tilecast Server (generated registry)     ->  plugins/*
```

The `plugins` Go module requires only the SDK module. The Go compiler refuses
an import of `apps/server/internal` from another module. `pluginctl check`
also refuses every other `apps/` import, an import of another plugin, and a
TypeScript import that leaves the plugin directory.

## Manifest

The schema is `packages/plugin-sdk/src/manifest.ts`. The main fields are:

| Field                   | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `apiVersion`            | Version of the Tilecast Plugin API. This release supports `1`.               |
| `id`                    | Stable identifier, stored in `plugin_installations`. It never changes.       |
| `definitionVersion`     | Version of the plugin's persisted and Player-facing definition.              |
| `name`, `description`   | Catalog text.                                                                |
| `category`, `icon`      | Catalog category and a bounded icon hint.                                    |
| `maintainers`           | Subject-matter stewards (`@user` or `@org/team`).                            |
| `instanceNoun`          | Singular and plural noun for the instance count.                             |
| `requirements`          | Advice shown before installation. Never evaluated.                           |
| `uses`                  | Catalog "what it uses" text. The catalog API publishes it as `capabilities`. |
| `capabilities`          | Machine-readable declarations. See below.                                    |
| `server.entrypoint`     | The Go entry point, `./plugin.go`. Required for a bundled plugin.            |
| `migrations`            | The migration directory.                                                     |
| `api.basePaths`         | Route prefixes below `/api/v1` that the plugin can register.                 |
| `api.openapi`           | The OpenAPI fragment that describes those routes.                            |
| `studio.route`          | The Studio route. It must be `/plugins/<name>`.                              |
| `runtime.manifestTypes` | Player manifest entry types the plugin projects and renders.                 |
| `runtime.surfaces`      | Runtime surface slots the plugin draws in.                                   |
| `runtime.tier`          | Arbitration tier of the plugin's surfaces.                                   |
| `docs.pages`            | Public docs pages, their slugs, and their sidebar group.                     |
| `docs.reference`        | The engineering reference, published as the catalog documentation link.      |

The entry points are fixed. `server.entrypoint` must be `./plugin.go`,
`studio.entrypoint` must be `./studio/index.tsx`, and `runtime.entrypoint`
must be `./runtime/index.ts`. The builds find plugin code at these paths: the
Go registry generator reads `plugin.go`, and Studio and the Player runtime use
Vite `import.meta.glob`. Thus a manifest cannot name a file that the build does
not find. The Zod schema, the Go parser, and `pluginctl check` apply this rule.
`pluginctl check` also refuses a conventional file that the manifest does not
declare.

`capabilities` has these members:

| Capability          | Required when the plugin                              |
| ------------------- | ----------------------------------------------------- |
| `playerManifest`    | projects manifest entries or reports asset dependents |
| `backgroundWorkers` | implements `WorkerProvider`                           |
| `network`           | contacts a host from Tilecast Server (hostnames only) |
| `hardware`          | uses Player hardware (`microphone`)                   |
| `heartbeat`         | consumes a named optional Player heartbeat section    |

`plugin.CheckDeclarations` compares the implemented interfaces with these
declarations. The host refuses to start a plugin that fails the check.

### Two version concepts

`apiVersion` is the version of the contract between Tilecast and the plugin.
`definitionVersion` is the version of one plugin's own definition. The audit
events for install and remove record `definitionVersion`. A bundled plugin
has no separate package version: it ships with the Tilecast release.

### Maintainers and review routing

`maintainers` names stewards. Anybody can change any plugin. Core maintainers
keep architecture and merge authority. Branch protection does not require
code-owner approval.

`pluginctl generate` writes `.github/CODEOWNERS` from the manifests. GitHub
requests review only from a handle that has write access. Thus the generator
writes only the handles in `plugins/review-eligibility.json` as owners. It
writes the other maintainers in a comment. A handle without write access is
still a maintainer.

## Server contract

The Go SDK is `packages/plugin-sdk/go/plugin`. The only required interface is
`Plugin` with `Manifest()`. A plugin embeds `plugin.Bundle`, which gives
`Manifest()` and `Migrations()`.

| Contribution       | Interface             | Called by the host                                   |
| ------------------ | --------------------- | ---------------------------------------------------- |
| Host services      | `Initializer`         | once, before any other contribution                  |
| Migrations         | `Migrator`            | at startup, with the core migrations                 |
| Catalog status     | `StatusReporter`      | for every catalog request                            |
| Removal blockers   | `RemovalGuard`        | in the Remove transaction, after the row lock        |
| Dashboard routes   | `RouteProvider`       | when the router is built                             |
| Manifest entries   | `ManifestProjector`   | per screen, only while installed                     |
| Manifest media     | `AssetResolver`       | per entry, on its `Config`, during manifest assembly |
| Media dependents   | `AssetDependent`      | when an asset changes, only while installed          |
| Background workers | `WorkerProvider`      | started after migrations, stopped at shutdown        |
| Maintenance        | `MaintenanceProvider` | on the periodic maintenance pass                     |
| Heartbeat sections | `HeartbeatConsumer`   | for each declared section in a Player heartbeat      |

A plugin implements only the interfaces it needs. Forms does not implement
`ManifestProjector`. Countdown Bar does not implement `WorkerProvider`.

### Host services

`Init` receives `plugin.Host`. The host binds each service to the plugin:

| Service        | Use                                                                          |
| -------------- | ---------------------------------------------------------------------------- |
| `DB`           | The PostgreSQL pool. A plugin queries only its own tables.                   |
| `Installation` | `Installed`, `Require`, and `LockInTx` for the plugin.                       |
| `Audit`        | `RecordInTx` writes an audit event in the caller's transaction.              |
| `Manifests`    | `InvalidateResourceInTx` and `InvalidateAllInTx` use the core revision path. |
| `Targets`      | `ValidateInTx` checks screen, sync group, and location targets.              |
| `Screens`      | `PairedPlatforms` counts screens by platform.                                |
| `Organization` | `ID` returns the installation's organization.                                |
| `Clock`        | The server clock. Tests replace it.                                          |
| `Logger`       | A structured logger with the plugin identifier.                              |

`Host` is a struct, not an interface. The core can add a service without a
break in existing plugins. A plugin that needs a core fact that no service
gives must extend the SDK. It must not read core tables.

`plugin.Target` and `plugin.ScreenTargetFilter` implement the targeting
convention: an instances table with `target_scope` and a targets table with
`(instance_id, target_type, target_id)`. The core owns the SQL of the filter.

### Studio translations

A plugin keeps its Studio strings in `studio/locales/<language>.json`. They
form the namespace `plugin.<id>`. `usePluginTranslation(id, english)` returns a
`t` function that checks keys against the English file. The locale test
requires every supported language for every plugin namespace. Shared plugin
strings (for example the targeting controls) stay in the Studio `plugins`
namespace.

### Routes

A plugin registers routes with `Router.Handle(method, pattern, access,
handler)`. The pattern is below `/api/v1`, starts with one of
`api.basePaths`, and uses plain segments and `{name}` parameters only.

| Access          | Check before the handler                                                 |
| --------------- | ------------------------------------------------------------------------ |
| `AccessViewer`  | Enrolled dashboard session. `GET` and `HEAD` only.                       |
| `AccessManager` | Owner or Administrator, and the session CSRF token.                      |
| `AccessSession` | Enrolled session. The CSRF token on unsafe methods. The handler decides. |

The handler gets the user from `plugin.PrincipalFrom`. It returns an error for
the host to write: `plugin.ErrNotFound` gives `404 plugin_instance_not_found`,
`plugin.ErrInvalid` gives `400 invalid_plugin_configuration`,
`plugin.ErrNotInstalled` gives `409 plugin_not_installed`, and a
`*plugin.APIError` is written as given. `plugin.DecodeJSON` applies the strict
request contract. The host refuses to start when a plugin route overlaps a
core route or a route of another plugin. Overlap is structural: the host
compares the segments of the patterns, so `/things/{id}` overlaps
`/things/install`, and `/foo/{id}` overlaps `/foo/{name}`, for the same
method. Core routes are read from the registered Chi route tree. Inside one
plugin, a plain segment can be next to a parameter, but two patterns with the
same shape are refused.

### Status and removal

The core owns installation state, authorization, audit, and the catalog
transport. The plugin answers the plugin-specific questions:

- `Status` gives configured, active, instance count, and attention notes.
- `RemovalBlockers` gives each remaining resource kind with a count, nouns,
  and a resolution: `delete`, `disable`, or `wait`. The catalog API adds the
  resolution to each resource in `409 plugin_in_use`, and Studio uses it to
  explain the next step.

An installation row for a plugin that this release does not know stays inert
and removable, as before. Rows for the retired `brand_bug` and `noise_meter`
plugins are also inert and removable, but the catalog marks them as retired
rather than as plugins from a newer release. Removing a row preserves its
historical data.

## Migrations

A plugin keeps its migrations in its own directory. The files use versions
from the one global sequence:

1. `npm run plugins:migration -- <plugin_id> <name>` reserves the next
   version after every core and plugin migration.
2. The plugin embeds the directory (`//go:embed migrations/*.sql`) and gives
   it to `plugin.NewBundle`.
3. `database.Catalog` joins the core and plugin migrations. Goose reads them
   as one directory.

Thus there is one `goose_db_version` history. `LatestMigrationVersion`,
`MigrateTo`, and exact-version backup restore do not change. A plugin
migration runs during the release upgrade, not when an administrator installs
the plugin. Installation stays a logical activation.

`pluginctl generate` writes
`apps/server/internal/database/migrations.lock.json` with the version, owner,
and SHA-256 of every migration. A server test compares the compiled catalog
with the lock. The test fails when plugin migrations are not embedded, when
two owners use one version, or when the content of a moved migration changes.
A shipped migration can move into a plugin directory without a change to its
content. It must not be edited.

## OpenAPI

`docs/openapi/core.yaml` describes the core API. Each server plugin with
routes has `api/openapi.yaml`. The fragment is a valid OpenAPI document. It
refers to shared core components through the core file, for example
`../../../docs/openapi/core.yaml#/components/schemas/Error`.

`pluginctl generate` merges the fragments into `docs/openapi.yaml`, the
canonical description. The merge changes only maps and references. It refuses
a path outside the plugin's `api.basePaths`, a path that is already described,
and a component name that is already defined. The docs site and every other
consumer read `docs/openapi.yaml`. Do not edit that file.

## Studio

`apps/dashboard/src/plugin-host/discovery.ts` finds every
`plugins/*/tilecast.plugin.json` and `plugins/*/studio/index.tsx` with
`import.meta.glob`. It pairs them by directory. A plugin entry point exports
`defineStudioPlugin({ id, icon, routes, search })` from `@tilecast/studio`.

The host mounts the routes below the manifest's `studio.route`. It adds the
plugin name as the breadcrumb and wraps the subtree in the install gate. A
plugin route gives its English breadcrumb in `handle.breadcrumb` and its
translation key in `handle.breadcrumbKey`. The key is in the plugin
namespace. The host adds the namespace to the key, and the Studio topbar
resolves the label with `t()` when it renders. An
uninstalled plugin's page shows how to install it. The catalog uses the
discovered routes and icons, so Studio has no central plugin route list and
no central icon map.

`@tilecast/studio` (`src/plugin-host/kit.ts`) is the Studio surface for
plugins. It gives `PluginPage` (the shared page chrome), the install gate, the
Remove menu, and the catalog hooks. Plugins can also give fully custom pages.

## Player runtime

The contract is `@tilecast/plugin-sdk/runtime`
(`packages/plugin-sdk/src/runtime.ts`). The host that implements it is
`packages/player-runtime/src/plugins`. Electron and WPE load the same runtime.

A plugin owns what it draws. The runtime host owns everything around it.

| The host owns                                                         | The plugin owns                                 |
| --------------------------------------------------------------------- | ----------------------------------------------- |
| Discovery and the check against the manifest                          | How it reads its manifest entries               |
| Claim validation and arbitration (tier, then priority, then ID)       | Which of its own instances it claims a slot for |
| One long-lived container for each declared surface                    | Its elements inside those containers            |
| Slot geometry: strip height, push and overlay insets, the corner lift | Its own layout inside the container             |
| The corrected clock, its timers, reduced motion, and frozen frames    | Its behavior and animation on those clocks      |
| Evaluation scheduling, sleep and wake, disposal                       | The text that the conformance probe reports     |

### Discovery

The runtime build finds `plugins/*/tilecast.plugin.json` and
`plugins/*/runtime/index.ts` with `import.meta.glob`. It loads no code at run
time. `runtime/index.ts` default-exports `defineRuntimePlugin({ id, tier,
manifestTypes, surfaces, create })`. The ID, the tier, the manifest types, and
the surfaces must be the same as the manifest's `id`, `runtime.tier`,
`runtime.manifestTypes`, and `runtime.surfaces`. The host leaves out a
definition that does not agree, with a diagnostic. It does not stop the
Player. The runtime tests fail on any discovery diagnostic, so a mismatch
cannot get into a release.

### Tiers and claims

A plugin declares one tier in `runtime.tier`:

| Tier        | For                                  | Example          |
| ----------- | ------------------------------------ | ---------------- |
| `emergency` | Safety messages that must be visible | Emergency Alerts |
| `scheduled` | Planned, time-bound messages         | Countdown Bar    |

On each evaluation, the host calls `update` with the entries of the plugin's
manifest types. The plugin returns its claims: at most one for each slot,
with a `priority` and, for a strip, `heightPx` and `displayMode`. A claim
cannot name a tier. The plugin selects among its own instances before it
claims. The host compares plugins, not instances.

The host refuses a claim, with a diagnostic, when:

- the slot is not in the plugin's `runtime.surfaces`, or the plugin already
  claimed the slot,
- the claim names a tier,
- the priority is not a finite number between -1,000,000 and 1,000,000,
- a strip height is not a finite number above 0 and at most 540 CSS pixels,
  or the display mode is not `overlay` or `push`,
- a corner or overlay claim has a strip field.

A refused claim loses. A plugin that throws in `create`, `mount`, `update`,
`render`, or a timer callback loses its slots. Playback continues.

For each slot independently, the host selects the strongest tier, then the
highest priority, then the lowest plugin ID. A configured priority cannot
lift a plugin above a stronger tier.

### Surfaces and geometry

The slots are `strip.top`, `strip.bottom`, `corner.top-left`,
`corner.top-right`, `corner.bottom-left`, `corner.bottom-right`, and
`overlay`. The host creates one container for each slot that a plugin
declares and calls `mount` once for each. The plugin builds its elements
there and keeps them. A plugin that loses a slot hides its elements; the host
does not remove them. Thus media is not decoded again and animations do not
restart.

The host alone changes geometry:

- A strip container is a full-width band at the top or bottom, as tall as
  its plugin's claim.
- A `push` strip that holds its slot insets the content stage by its height
  (`--tc-stage-top`, `--tc-stage-bottom`). An `overlay` strip does not.
- Corner containers stop clear of the strips that are held: the corner lift
  (`topLiftPx`, `bottomLiftPx` in the grant).
- The overlay container covers the screen.

A plugin never changes the content stage.

### Evaluation and time

A manifest change, sleep, and wake evaluate at once. The host tick (about
one second) and `invalidate()` ask for an evaluation, and requests are
coalesced into one pass. An `invalidate()` during an evaluation schedules
exactly one more pass. The host never calls `update` again from inside
`update`. A plugin that invalidates during every pass waits for the next tick
after a few passes, with a diagnostic.

A pass calls `update` for every plugin, validates the claims, arbitrates the
slots, applies the geometry, and then calls `render` with each plugin's grant.

A plugin keeps time with `context.clock`: `now()` is the corrected server
time, `after` and `every` are timers that belong to the plugin. The host
cancels them when it disposes the plugin. Conformance runs freeze the wall
clock, advance it manually, and set `animationScale` to 0.
`context.reducedMotion()` is true for a frozen run and when the platform asks
for reduced motion. `context.awake()` is false outside active hours; a plugin
stops work that it does not need while asleep.

`@tilecast/plugin-sdk/runtime/testing` gives a plugin's own tests a context
with a manual clock.

### Microphone

The runtime contract still defines `context.microphone` for a plugin that
declares microphone hardware. No plugin in this release uses it. The older
Noise Meter's host-level messages and native Edge capture code remain only as
inactive compatibility infrastructure; they do not make Noise Meter an
available plugin.

### Stylesheets

A plugin stylesheet is `runtime/*.css`. The Player document policy refuses
inline styles, so the runtime build appends each plugin stylesheet to the
fixed `runtime.css` artifact, in path order. A plugin sets dynamic values
through the CSSOM (`setStyles`), which the policy permits on Electron and WPE.
Every selector must start with `.tc-<name>` and every `@keyframes` name with
`tc-<name>-`, where `<name>` is the plugin directory. `pluginctl check`
refuses other selectors and global rules such as `@import` and `@font-face`.

### Migration adapters

The Emergency Alerts ticker remains a migration adapter in
`packages/player-runtime/src/plugins/builtin`. It uses the same contract,
and discovery checks it against its manifest. Its manifest declares
`runtime.surfaces` and `runtime.tier` without `runtime.entrypoint`.
`pluginctl check` permits this only for plugins in
`TRANSITIONAL_RUNTIME_ADAPTERS`. Every other plugin that declares surfaces
must have `runtime/index.ts`.

## Documentation

A plugin declares its public pages in `docs.pages`. The docs site reads the
manifests in `apps/docs/plugin-docs.mjs`. One Astro `glob()` loader loads the
Starlight pages and the plugin pages together, because a collection loader
owns all entries of its collection. Core pages keep the IDs that Starlight's
own loader gives. A plugin page uses the slug from its manifest, so a moved
page keeps its public URL. The sidebar lists plugin pages in the group that
the page names. The edit link goes to the plugin-owned source file.

## Conformance

The Official Tilecast Plugin Conformance suite is pass or fail. It uses the
existing test tools:

| Check                                           | Where                                      |
| ----------------------------------------------- | ------------------------------------------ |
| Manifest schema, ID and directory, entry points | `pluginctl check`                          |
| Route prefixes, OpenAPI fragments, docs slugs   | `pluginctl check`                          |
| Migration names, versions, and Goose sections   | `pluginctl check`, `database` tests        |
| Host boundaries (Go and TypeScript imports)     | `pluginctl check`                          |
| Generated files are current                     | `pluginctl check`                          |
| Tests next to implementation                    | `pluginctl check`                          |
| Declarations match implementation, routes, Init | `plugintest.Conformance` in each plugin    |
| Install, status, removal, projection, routes    | server host tests with the sample plugin   |
| Studio discovery and routes                     | Vitest in `apps/dashboard/src/plugin-host` |

A plugin's integration tests use `apps/server/pluginharness`. The harness
migrates the test database, creates an organization, and hosts the plugin with
the real host services. It is the only Tilecast Server package that plugin
code can import, and only in `_test.go` files. This is the same arrangement
as a test harness that a host application publishes for its extensions.

`packages/plugin-sdk/go/plugintest/sampleplugin` is a test-only plugin that
implements every contribution point. No core code knows it. The host tests
load it to prove the generic paths work without a special case.

## Boundaries

The core owns authentication, authorization, CSRF, the installation
lifecycle, database connections, migration execution, audit, screen targeting
primitives, manifest transport and revisions, offline caching, Player host
interfaces, runtime surface arbitration, the Studio shell and router, the
Starlight host, and backup and restore.

A plugin owns its metadata, its domain schema, its storage and queries, its
routes, its status, its removal blockers, its background behavior, its Studio
pages, its runtime component, its manifest projection, its API description,
its user documentation, and its tests.

## Compatibility

- Plugin identifiers do not change. The directory name is the identifier with
  hyphens.
- Existing endpoints keep their paths and their responses. The
  `409 plugin_in_use` resources get the new `resolution` field.
- The catalog lists plugins by name. There is no central list to give an
  order. The manifest `plugins` array follows the same order; Players choose
  what to show from priorities in the entries, not from the array order.
- `plugin_installations` rows, plugin data, and the migration history do not
  change. A moved migration keeps its version and its content.
- Removal still never deletes plugin data.
- Old cached Player manifest entries for `brand_bug` and `noise_meter` are
  ignored. Legacy `noiseMeter` heartbeat fields are accepted and ignored;
  they do not create history or status updates.

## Rejected alternatives

- **HashiCorp `go-plugin` and other process plugins.** The built-in plugins
  ship with the release and are trusted. RPC and subprocesses add failure
  modes and give no isolation that a bundled plugin needs.
- **Wasm with Extism.** The same reason. A sandbox is for code that Tilecast
  does not ship.
- **Reflection or `init()` side-effect registration.** A generated list is
  explicit, can be reviewed, and CI checks that it is current.
- **Separate migration histories for each plugin.** This would break the one
  schema version that exact-version restore uses.
- **A package version for each bundled plugin.** A bundled plugin cannot be
  updated without the release, so a second version would not have a meaning.
- **One schema object for storage, API, form state, and runtime payload.**
  These are different boundaries with explicit mappings. Go validation stays
  authoritative for server writes.

## Future third-party plugins

Plugin API v1 does not load third-party code. The contract keeps a path open:

- The manifest is data. It names entry points inside the plugin directory,
  capabilities, and API version. A future loader can check the manifest
  before it runs code.
- Host services are narrow interfaces. A future process or Wasm host (for
  example Extism) can give the same services across a boundary.
- A plugin can be distributed as an OCI artifact from a normal or private
  registry with ORAS, and signed with Sigstore cosign. Tilecast must not
  require a central plugin service.
- Trust classes such as Official, Verified, and Community can be added later.
  Every bundled plugin is Official.

## Deviations from the plan

- **Android Player.** The Android Player is native Kotlin and does not run the
  shared runtime. Its plugin code stays in the Android application. It
  ignores plugin types that it does not render.
- **Edge daemon profile.** `tilecastd` compiles its renderer feature list,
  which names plugin types. The list declares what the installed renderer
  supports. It does not decide rendering. It stays in the Edge release.
- **Catalog order.** The catalog uses plugin names in alphabetical order.

## Migration status

| Milestone | Scope                                                            | Status  |
| --------- | ---------------------------------------------------------------- | ------- |
| 1         | Layout, manifest, SDKs, host, discovery, tooling, CODEOWNERS, CI | Done    |
| 2         | Countdown Bar in `plugins/countdown-bar/`                        | Done    |
| 3         | Generic runtime surface host                                     | Done    |
| 4         | Retire Brand Bug and Noise Meter with compatibility shims        | Done    |
| 5         | Emergency Alerts                                                 | Planned |
| 6         | Forms                                                            | Planned |
| 7         | Remove the remaining special cases                               | Planned |

Until a plugin moves, `apps/server/internal/plugins` answers its status,
removal blockers, and projection through the legacy functions in that
package. Countdown Bar has moved completely, including its Player renderer.
Brand Bug and Noise Meter are retired: their old installation rows and data
remain, but neither is cataloged, configured, projected, or rendered. The
Emergency Alerts ticker remains a migration adapter in the runtime package;
see [Migration adapters](#migration-adapters).
