# Data Source modules

**Status:** binding. The static extension work implements this document.
Later changes do not change the contracts in §2–§5 without a new version.

**Packages:** `@tilecast/data-source-sdk`
(`packages/data-source-sdk`), one module for each Data Source below
`data-sources/`, and the `data-sources` Go module that embeds the root
manifests.

A declarative Data Source module describes one Data Source definition in
`tilecast.datasource.json` plus a sample configuration in `fixtures/`.
The module contains no code. Tilecast Server owns refresh, caching,
fetch, and projection. The manifest names a generic adapter. The Server
maps the name to its adapter implementation.

The Announcements Data Source (`data-sources/announcements/`) proves the
module path. Its definition is identical to the legacy release entry it
replaces. Only the authoring format changed.

## 1. Manifest

The manifest schema is
`packages/data-source-sdk/src/manifest.ts`. The generated JSON Schema is
`packages/data-source-sdk/schema/tilecast-datasource.schema.json`. The
manifest contains these fields:

- `apiVersion`: always `1`. It versions the manifest format. It is
  separate from the definition version.
- `id`: the stable provider ID. Keep a compatibility ID unchanged. Do
  not rename an existing provider.
- `version`: the definition version.
  A package update that changes this definition is refused while a
  saved Data Source uses it. The refusal reports how many Data Sources
  remain. Delete those sources, then update the package. A definition that did not
  change does not block the update.
- `name`, `description`, `category`, `icon`: catalog wording.
- `configurationSchema`: the authoring fields. It uses the Studio
  control set.
- `defaultConfiguration`: the defaults for the schema.
- `outputSchema`: the typed output fields. It uses the Tilecast Data
  Types in §3.
- `adapterId`: one exact Server adapter ID from §4.
- `fetch`: the bounded fetch input. It is required for `http_records`
  and forbidden for other adapters.
- `refreshBehavior`: `manual` or `interval`.
- `requiresManifestV13`: compatibility metadata. Migrated definitions
  keep the flag they already carry.
- `setup`: flat Studio guidance copy. It contains no references and no
  executable content.
- `attribution`: the on-screen credit when the source requires one.
- `deprecation`: compatibility metadata as needed.

The manifest must not contain JavaScript, Go function names, SQL,
expressions, transforms, process execution, or sockets. The manifest
must not declare its own `source`. Discovery injects the source. A file
that declares a source is rejected.

## 2. Module layout

A root module lives in this layout:

```text
data-sources/<name>/
  tilecast.datasource.json
  fixtures/
    default.json
```

A plugin-owned module lives in this layout:

```text
plugins/<plugin>/data-sources/<name>/
  tilecast.datasource.json
  fixtures/
    default.json
```

The root source kind is `core`. The nested source kind is `plugin`.
The plugin ID is the stable `tilecast.plugin.json` ID. The plugin
directory name is a filesystem location. It is never identity.

`fixtures/default.json` holds a sample configuration object. Every key
in the sample must name a declared configuration field.

## 3. Data Types

An output field uses one Tilecast Data Type. The set mirrors
`supportedOutputFieldTypes` in `contentdefs`. The Server projector
understands exactly these types:

`text`, `number`, `integer`, `percent`, `currency`, `boolean`, `date`,
`datetime`, `duration`, `url`, `asset`.

A module that declares another type fails validation.

The `number`, `percent`, and `currency` types accept finite base-10 numbers.
The `integer` type accepts base-10 integers from
`-9007199254740991` through `9007199254740991`. The `duration` type accepts a
nonnegative base-10 integer in seconds up to `9007199254740991`; it projects as
`durationSeconds`. The `asset` type accepts a UUID for a Tilecast Media asset
and projects as `kind: "asset"` with a canonical lowercase `assetId`. An empty
value projects as `null`. A malformed or out-of-range value remains text and
does not become a media grant.

Date-time values use RFC 3339 with a valid calendar date, hours from 00 to
23, and a numeric offset or `Z`. Fractional seconds use a decimal point.
URL values must be absolute and contain no whitespace. Server and Studio
tests use `packages/manifest-schema/data-document-value-fixtures.json` to
check the same coercion results.

Output fields may declare an optional semantic `role`. Use a lowercase
identifier of up to 40 characters, beginning with a letter and containing
only letters, digits, and underscores. Prefer the shared roles listed in
`docs/widgets-v2-authoring-and-first-wave.md`; the Server preserves the role
in Player Data Documents.

## 4. Adapters

The manifest names one exact Server adapter ID. The registry lives in
`apps/server/internal/media/datasources.go`. Only three adapters have a
declarative binding:

| Adapter          | Use                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `manual_object`  | One author-maintained object. The manifest carries no fetch.                                     |
| `manual_records` | Author-maintained rows. The manifest carries no fetch.                                           |
| `http_records`   | One release-pinned HTTPS endpoint with a bounded field mapping. The manifest must carry `fetch`. |

Every other adapter reads an adapter-specific configuration shape or
runs executable code. A module that names one is rejected at
composition. Executable Data Sources stay on
`plugin.DataSourceProvider`. Plugin API v1 does not change.

The `fetch` input mirrors Go `FetchSpec`. It declares an absolute HTTPS
URL template, `json` or `csv` format, an optional accept header, an
optional records path, a field mapping, a maximum record count from 0
to 500, and a refresh interval of 0 or at least 60 seconds. The scheme
and host are fixed by the release. A placeholder may only fill the path
or query. A placeholder must name a `text`, `select`, `integer`, or
`number` configuration field. A `text` field must declare a maximum
length from 1 to 200. The mapping must target declared output fields
with plain paths. `data-sources:check` enforces the same rules the
Server enforces at catalog load.

## 5. Tooling

`datactl` owns the module lifecycle. It validates a module without
PostgreSQL, without a running Server, and without Go knowledge.

Create a root module:

```sh
npm run data-sources:new -- lunch-menu --adapter http_records
```

Create a plugin-owned module:

```sh
npm run data-sources:new -- schedule --plugin athletics --adapter http_records
```

The `--plugin` argument accepts a plugin ID or directory. It must
resolve to a real `tilecast.plugin.json`. The scaffold writes the
manifest and `fixtures/default.json` with adapter-specific starter
content. Replace the example endpoint before release.

Validate every module and generated file:

```sh
npm run data-sources:check
```

The check validates the manifest schema, API version, identity, source
ownership, adapter binding, configuration and default compatibility,
output field uniqueness and types, fetch safety, refresh bounds, the
sample fixture, attribution requirements, deterministic ordering, and
cross-source collisions.

Rewrite the generated files:

```sh
npm run data-sources:generate
```

Generation writes the portable JSON Schema and the plugin-owned ledger
`data-sources/plugin_sources.gen.go`. The ledger carries each nested
manifest with its stable plugin ID and exact bytes. `data-sources:check`
fails when a generated file is stale.

Run the aggregate workflow:

```sh
npm run extensions:check
npm run extensions:generate
```

The aggregate runs the plugin, Widget, and Data Source suites. It is
orchestration only. It is not a fourth extension API.

## 6. Server composition

The release catalog composes three origins into one
`contentdefs.Catalog`:

- the legacy grouped release files;
- the root `data-sources/` modules as core definitions;
- the plugin-owned modules from the generated ledger, each with its
  owning plugin ID.

Go embedding cannot reach `plugins/`. The generated ledger bridges the
gap. The manifest beside the module stays authoritative.

Source identity and definition bytes participate in the deterministic
fingerprint. A duplicate ID across origins is fatal at build, test, and
startup validation.

## 7. Installation lifecycle

Effective availability is static definition availability AND source
availability. Core definitions follow their static availability. A
plugin-owned definition additionally requires its owning plugin.

When the plugin is not installed:

- new creation with that provider is refused with
  `409 plugin_not_installed`;
- duplication with that provider is refused in the same way;
- assignment validation refuses the preserved row as a live source with
  `409 playlist_conflict`;
- manifest projection refuses the preserved row as a live source;
- the refresh worker does not fetch or project the preserved row. It
  records no attempt and no diagnostics, and it looks at the row again
  after five minutes;
- Tilecast Studio shows the provider as unavailable with the owning
  plugin named;
- persisted rows are preserved and stay inert.

Creation share-locks the installation row in the creation transaction.
Plugin removal takes the installation row `FOR UPDATE` before it counts
blockers. The two operations cannot interleave. Removal counts
persisted rows that use the plugin providers and blocks with ordinary
`data_source` entries (`2 Data Sources`, resolution `delete`). Removal
deletes only the installation record. It never deletes content.

Installing the plugin makes preserved content usable again. Install and
removal invalidate manifests when static contributions are present.
No plugin ID appears in a switch. No contributor edits a central
registry.
