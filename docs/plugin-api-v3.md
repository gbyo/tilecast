# Tilecast Plugin Manifest API 3

Status: accepted for phase 1 of [ADR: Plugin Model V3](adr/plugin-model-v3.md),
with the host connections of phase 2. Countdown Bar uses Plugin Manifest API 3. Emergency Alerts and Forms stay on
[Plugin API v1](plugin-api.md). Later phases of the ADR add more members to
this contract. This document does not describe a member that no phase has
implemented.

## Three supported generations

| Generation                  | `apiVersion` | Used by                    |
| --------------------------- | ------------ | -------------------------- |
| Plugin API v1               | 1            | Emergency Alerts, Forms    |
| [Plugin API v2](plugin-api-v2.md) | 2      | No bundled plugin          |
| Plugin Manifest API 3       | 3            | Countdown Bar, new plugins |

All three load from `plugins/<name>/` and use the same Server contribution
interfaces, Studio host, migrations, and generated files. Version 1 is frozen.
Version 2 is supported without change. Version 3 is additive. A version 3
manifest keeps every shared member of version 2, including the `player`
contribution.

## What changes for a plugin author

A plugin that stores ordinary instances no longer writes its own storage,
routes, OpenAPI, automation mapping, or Studio pages. The plugin declares
settings and instance kinds in its manifest. The host does the rest. The
plugin implements at most two hooks.

The host owns these items for each instance:

- storage in `plugin_instances` and `plugin_instance_targets`
- a revision, and the atomic comparison of `expectedRevision`
- enabled state, priority, and the schedule
- authorization of the stored target and of the new target
- audit events, and manifest invalidation for the affected screens only
- font usage for `font` fields and media usage for `media_asset` fields
- encrypted storage of `secret` fields
- status counts and removal blockers
- the dashboard routes, the OpenAPI operations, and the automation mapping
- the list, create, edit, and settings pages in Studio

## Trust model

A bundled plugin is first-party Go code in the Server process. The rules in
this document prevent mistakes. They do not contain a plugin that is
compromised. A bundled plugin keeps direct SQL on its own tables.

A bundled plugin does not receive new `Host` fields for version 3 features.
The `Host` struct stays for versions 1 and 2. A version 3 plugin reaches the
Server through the typed service client (see [Service client](#service-client)).

`npm run plugins:check` refuses a Plugin Manifest API 3 plugin that opens its
own network connection. It refuses `http.Client`, `http.Get`, `net.Dial`, and
the related calls in non-test Go files. A plugin sends requests through host
connections and `http.fetch@1` instead. This check finds mistakes. It is not a
security control.

## Manifest members

A version 3 manifest adds these members to the shared ones.

| Member               | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `services`           | Server services (`name@version`) that the typed client may call.     |
| `settings`           | Host-owned settings: `organization` and `screen` field lists.        |
| `instances`          | Instance kinds, at most four.                                        |
| `connections`        | Host-owned outbound connections, at most eight. See [Plugin connections](plugin-connections.md). |
| `studio.entrypoint`  | Optional. Omit it when the generated pages are enough.               |

A version 3 manifest does not accept `capabilities.playerManifest`,
`capabilities.network`, or `runtime`. It requires `api.basePaths` and a
`studio` route when it declares instances. A plugin that declares organization
settings and a Studio route also needs `api.basePaths`. The host mounts the
generated routes below the first base path and the generated pages at the Studio
route.

### Settings

`settings.organization` has one value for each field. `settings.screen` has one
value for each field and screen. The instance scope is the field list of an
instance kind. Fields use the [configuration schema](config-schema.md) with the
plugin profile.

### Instance kinds

| Member       | Meaning                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `kind`       | Identifier stored with each instance. It never changes.                                                    |
| `noun`       | Singular and plural names for Studio.                                                                      |
| `path`       | URL segment below the API base path and the Studio route.                                                  |
| `operations` | PascalCase names for the generated operations, for example `CountdownBarInstance`.                          |
| `targeting`  | `screens` or `none`.                                                                                       |
| `schedule`   | `none`, `window`, or `weekly`. A schedule needs `targeting: screens`.                                      |
| `priority`   | Optional `minimum`, `maximum`, and `default`. The host projects the strongest instance first.              |
| `fields`     | Configuration fields.                                                                                      |

The names `id`, `kind`, `plugin`, `name`, `enabled`, `priority`, `targetScope`,
`targetIds`, `schedule`, `revision`, `expectedRevision`, `secrets`,
`clearSecrets`, `createdAt`, `updatedAt`, and `createdBy` belong to the host. A
field key must not use them.

The reserved paths `settings`, `secrets`, `status`, `install`, `kinds`, and
`connections` are not valid kind paths.

#### Limit of four kinds

A plugin declares at most four instance kinds. Studio shows each kind as one tab
of the plugin page. Four is the most tabs that Studio already shows in one tab
list (the Widget inspector sections), and four tabs fit a phone-width page
without a scrolling tab list. Each kind also adds five API operations and five
automation commands. The limit is `MaxInstanceKinds` in the Go SDK and
`MAX_INSTANCE_KINDS` in the TypeScript schema. A test keeps them equal.

### Schedule modes

The schedule controls when the host projects an instance. The host owns these
semantics. A domain calendar, such as A and B days or a bell schedule, stays
plugin data.

- `window`: `startsAt` and `endsAt`, at most 366 days apart.
- `weekly`: `timezone`, `days` (0 is Sunday), `startTime`, and `endTime` as
  `HH:MM`. The end must be after the start on the same day.

The host stores the next start or end in `next_schedule_change_at`. A host
worker revises the manifests of the affected screens at that instant. The Player
state of a scheduled instance expires at the end of the current period, so an
offline Player stops showing it on time.

A plugin that needs its own timing keeps the schedule mode `none`. Countdown Bar
does this: its countdown schedule is configuration that the Player evaluates.

## API

For each kind, the host mounts these routes below the first base path. The API
uses one flat JSON object: the host members and the kind fields side by side.

| Route                              | Access                      |
| ---------------------------------- | --------------------------- |
| `GET    <base>/<path>`             | Viewer                      |
| `POST   <base>/<path>`             | `plugins.manage`            |
| `GET    <base>/<path>/{id}`        | Viewer                      |
| `PUT    <base>/<path>/{id}`        | `plugins.manage`            |
| `DELETE <base>/<path>/{id}`        | `plugins.manage`            |
| `GET/PUT <base>/settings/organization`   | Viewer / `plugins.manage` |
| `GET/PUT <base>/settings/screens/{screenId}` | Viewer / `plugins.manage` |

`pluginctl` writes the OpenAPI operations and the automation mapping from the
manifest. The operation names are `list<Plural>`, `get<Singular>`,
`create<Singular>`, `update<Singular>`, and `delete<Singular>`. The generated CLI
path is `tilecast plugin <plugin-dir> <kind> <list|get|create|update|delete>`.

### Revisions

Every instance and every settings document has a revision.

- A create returns revision 1. Each successful update adds 1.
- An update must send `expectedRevision`. A request without it answers `428`
  with `expected_revision_required`.
- The host compares the revision and changes the data in one transaction that
  holds the row lock. A stale revision answers `409` with
  `plugin_instance_revision_conflict`. The answer carries
  `details.currentRevision`. A stale update changes nothing: not the
  configuration, the targets, the schedule, the secrets, or the references.
- Settings that were never saved have revision 0. The host supplies the same
  defaults to Studio and to instance projections.

### Authorization

The host applies the capability and the screen rule of every other Studio
route.

- A write needs `plugins.manage`. Studio does not use the role name.
- An operator must be able to target the screens that an instance reaches now
  and the screens that it will reach. A scoped operator cannot move an instance
  out of its scope. The answer is `403 out_of_scope`.
- A screen setting uses the screen rule. A screen outside the operator's access
  answers `404`.
- A secret write needs the same capability as the owning write.

### Errors

The error shape is the Tilecast shape: `{ "error": { "code", "message" } }`.
Codes: `invalid_plugin_configuration` (`400`), `out_of_scope` (`403`),
`plugin_instance_not_found` (`404`), `plugin_not_installed` (`409`),
`plugin_instance_revision_conflict` (`409`), `plugin_settings_revision_conflict`
(`409`), `expected_revision_required` (`428`), and `secrets_unavailable`
(`503`).

## Plugin hooks

```go
type InstanceValidator interface {
    ValidateInstance(ctx context.Context, instance plugin.HostedInstance) error
}

type InstanceProjector interface {
    ProjectInstance(ctx context.Context, instance plugin.HostedInstance,
        target plugin.ProjectionTarget) (plugin.InstanceProjection, error)
}
```

`ValidateInstance` runs after the host checks every field against the schema.
It returns an error that wraps `plugin.ErrInvalid` to refuse an instance. It
judges the domain meaning, for example a rule between two fields.

`ProjectInstance` maps one eligible instance to Player state. The host chooses
the eligible instances: enabled, targeted at the screen, inside the schedule,
strongest priority first. The host does not ask the plugin about authorization,
targeting, or arbitration. The host sets the state ID to the instance ID, adds
the library fonts that the font fields choose, and limits `validUntil` to the end
of the schedule period.

`InstanceProjection.Legacy` is the optional Plugin API 1 entry for a Player
without the Plugin API 2 host. A plugin returns it only when it declares
`player.v1ManifestTypes`. The Player protocol does not change.

A plugin that implements `InstanceDemoSeeder` adds Demo Mode instances. The host
creates them through its own instance service.

The host counts the instances for the catalog and for the removal blockers with
its own queries. The plugin does not implement `StatusReporter` or
`RemovalGuard` for its instances. Every instance, enabled or not, blocks
removal.

## Service client

The package service registry in `apps/server/internal/extensions/services` is
the one Server service vocabulary. An installed package calls it through
`tilecast.call_v1`. A bundled version 3 plugin calls it through a generated,
typed Go client, in the Server process. See
[External package service capabilities](package-services.md).

A capability has callers: `package`, `bundled`, or both. A capability without a
caller list is for packages only, as before. Phase 1 gives bundled plugins:
`organization.read@1`, `instance.read@1`, `screens.read@1`, `targets.resolve@1`,
`targets.resolve@2`, `users.read-basic@1`, and the new `settings.read@1` and
`secrets.read@1`. Phase 2 adds `http.fetch@1`, `storage.kv@1`,
`timers.schedule@1`, `timers.cancel@1`, `feeds.publish@1`, and
`instances.read@1`. The new services are for bundled plugins only.
`instances.read@1` reads the plugin's own instances (`get` one, `list` up to
500, never a secret); a timer callback uses it, because a timer carries only
its key and payload.

The call uses the same dispatcher, so it gets the same operation, context,
validation, authorization decision, and audit as a package call. A test holds
the two to the same decisions.

The host binds the call:

- The plugin identity is the plugin that the host invokes. The client takes no
  plugin or package argument.
- The context comes from what the host is doing. A route handler is `studio`
  with the signed-in operator. A worker, a seed, and a validation without an
  operator are `background`. A projection is `system`. A `background` or
  `system` call never carries an operator.
- A call outside a host invocation, under another plugin's invocation, or after
  the invocation ended is refused.
- A plugin can call only the services that its manifest declares in `services`.

After a change to the registry, regenerate the client with one command from
`apps/server`:

```sh
go run ./internal/extensions/services/gen
```

The command writes `packages/plugin-sdk/go/plugin/services_registry_gen.go` and
`packages/plugin-sdk/server-services.json`. A test fails while they differ from
the registry. `plugintest.Services` builds the client over a handler for a
plugin's own tests.

## Secrets

A `secret` field is write-only for Studio. The Server stores it with envelope
encryption. A read through the API returns `set`, `not_set`, or `needs_value`
for each secret, never the value. A plugin reads a value with `secrets.read@1`
in a `studio`, `background`, or `system` context. See
[Plugin secrets](plugin-secrets.md).

A secret never enters a Player manifest, Player state, a log, an audit event, a
URL, or an error message. The audit event of a write names the secret keys that
changed.

## Connections

A plugin declares its outbound connections in `connections`. An Owner or
Administrator creates connection records on the generated Connections page and
gives the network consents there. A `connection` field holds a record ID. The
plugin calls `http.fetch@1` with that ID. See
[Plugin connections](plugin-connections.md) for the declaration, the address
and redirect rules, the consents, secret headers, and the failure codes.

An `oauth2` connection adds an OAuth 2.0 provider. The operator registers an
OAuth client, enters its ID and secret on the connection page, and selects
Connect. The host runs the authorization code flow with PKCE, stores the
tokens as connection secrets, refreshes them, and adds the bearer header to
`http.fetch@1`. Plugin code never receives a token. See
[OAuth 2.0 connections](plugin-connections.md#oauth-20-connections).

Studio adds a **Connections** page below the plugin's route when the manifest
declares connections. The install review on the plugin's catalog page shows
each declaration: its origins, whether an operator enters the origin, private
network, plain HTTP, plaintext secrets, a response or time limit above the
default, and the OAuth endpoints and scopes.

## Storage and timers

A plugin keeps small values with `storage.kv@1`: 128-byte keys, 64 KiB values,
1 MiB in all, and an atomic `compareAndSet`. A plugin that declares
`timers.schedule@1` implements `HandleTimer(ctx, plugin.Timer) error`; the host
calls it at least once for each due timer, in the `system` context. See
[Plugin storage and timers](plugin-storage.md).

## Feeds

A plugin declares the datasets it publishes in `feeds` and publishes them
with `feeds.publish@1`. Each dataset is an ordinary Data Source with the
provider `<plugin id>.<feed id>`. The host stores the records, applies
operator overrides by policy, imports remote images as private plugin
assets, and reports late feeds in Content Health. See
[Plugin feeds](plugin-feeds.md).

## Personal data

A field of the plugin profile can carry `personal: { retentionDays }`, from 1 to
3650 days. Phase 1 enforces this:

- The manifest validator refuses a personal field that is `required`, because
  the host removes the value when the retention ends.
- A personal field is top level. A repeating group does not hold one.
- The host records when each personal field was last written. A host task runs every six hours. It removes a value, and a secret, that is
  older than its retention.
- When the task removes a value, it increases the document revision and
  releases references to fonts and media that the document no longer uses.
- `PersonalFields()` gives later features the declarations.

Phase 1 does not add subject export or erase, masked Player state, or sensitive
Player state. Those need a subject key and Player work in later phases. Backups
keep personal data until the backup expires. Countdown Bar declares no personal
field.

## Resource ownership

- A `font` field records a font usage for the instance. The font library
  refuses to remove a family that an instance, enabled or not, uses.
- A `media_asset` field records a reference in `plugin_media_references`. The
  media library refuses to archive or delete an asset that a settings document or
  an instance references.
- Deleting an instance, or an update that removes a value, releases the
  references and the secrets of the instance.

## Compatibility

- Version 1 and version 2 manifests parse and run as before. The fixtures of both
  versions run in the Go and the TypeScript tests.
- The shared fixtures in `packages/plugin-sdk/testdata/manifests` keep the Go
  parser and the Zod schema in agreement. `api-version-4.json` replaces the
  former unsupported-version fixture.
- The Player protocol does not change. A Player that hosts Plugin API 2 receives
  `plugin_state`. A Player without it receives the Plugin API 1 entry.
- `npm run plugins:new -- <id> --plugin-api 3` scaffolds a version 3 plugin.

## Countdown Bar on Plugin Manifest API 3

Countdown Bar keeps its five operations, its URLs, its fields, and its Player
output. These facts changed:

- The host stores the instances. Migration `00139` copies each existing bar into
  `plugin_instances` with the same ID, so Player state IDs, font usage, and audit
  history point at the same bar. The legacy `countdown_bar_instances` and
  `countdown_bar_targets` tables stay, unread, for one release. A later
  migration drops them.
- An update must send `expectedRevision`. Existing clients that update without
  it receive `428`. This is the deliberate change of this phase.
- The audit actions are `plugin.instance.created`, `plugin.instance.updated`,
  and `plugin.instance.deleted`. The removal blocker kind is
  `countdown_bar_instance`.
- Studio generates the pages. `studio/index.tsx` only supplies the icon. Studio
  does not link the urgency stages to the lead time any more. The stage values
  keep their schema defaults.
- The `GET` response has no `null` members. An unset optional field is absent.

An upgrade test (`plugins/countdown-bar/server/upgrade_integration_test.go`)
builds a database at schema 138 with weekly, one-time, location, screen, group,
and all-screen bars, a font, and a disabled bar. It checks that the migrated
installation projects the same Plugin API 1 entries and the same Plugin API 2
state to the same screens.

### Line counts

`scripts/plugins/countdown-bar-lines.sh [revision]` counts physical lines of the
plugin's own files with `wc -l`. It does not count the Store artwork, the
generated `automation.gen.json`, the locale files, or the generated OpenAPI. The
before revision is `a94e81b1b`, the last commit before the move.

| Category                                                              | Before | After |
| --------------------------------------------------------------------- | -----: | ----: |
| Server CRUD, storage, targets, routes (`server/{store,http,plugin}.go`) |    489 |    88 |
| Migrations                                                            |    117 |   172 |
| Studio CRUD and editor (`studio/*.ts`, `studio/*.tsx`)                |  1,167 |     6 |
| API and automation (`api/`, `automation.yaml`)                        |    243 |     0 |
| Domain validation, projection, demo (`model.go`, `demo.go`, `plugin.go`) |  250 |   145 |
| Player runtime (`runtime/`)                                           |    725 |   725 |
| Manifest (`tilecast.plugin.json`)                                     |     76 |   437 |
| Tests                                                                 |  1,375 |  1,111 |

The `server/plugin.go` file moved from storage code to the two hooks. The manifest
grew because the field schema now lives there. The after migration count
includes the copy migration. Generic code is new for the whole Server: the
instance, settings, schedule, secret, and Studio code is shared by every plugin of
this kind and is not in the table.

## Not in this phase

Phase 1 does not add OAuth, feeds, `storage.kv@1`, timers, webhooks, events,
a delivery engine, notification
channels, content health providers, plugin capabilities, staff pages, kiosks,
participant sessions, moderation, public links, Player reports, audio cues,
serial or GPIO or printer services, stream connections, TCP, installed-package
parity for `plugin-runtime.state@1`, content services for plugins, or editor
action slots. A `data_source` field is not valid in a plugin manifest. Phase 2
adds host connections, `http.fetch@1`, OAuth 2.0 connections, `storage.kv@1`,
durable timers, feeds, and `instances.read@1`. Phase 2 does not add webhooks,
events, the delivery queue, `blob.fetch@1`, `storage.blob@1`, stream or socket
connections, the Player purge list, moderation, or installed-plugin parity
for these services; later phases add them.
