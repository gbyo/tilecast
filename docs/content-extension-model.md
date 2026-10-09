# Tilecast extension architecture

**Status: current architecture contract.**

This document defines how Widgets, Data Sources, bundled plugins, installed
packages, and the Marketplace fit together. It describes the current ownership
and trust boundaries. Historical delivery phases are intentionally omitted.

Use these documents for detailed contracts:

- [Widgets V2](widgets-v2.md) for the component runtime.
- [Widget authoring](widget-authoring.md) for Studio authoring and field
  mapping.
- [Data Source modules](data-source-modules.md) for declarative Data Sources.
- [Plugin API v1](plugin-api.md) for trusted bundled plugins.
- [Extension packages](packages.md) for package format, installation, runtime
  capabilities, updates, rollback, and restore.
- [Marketplace](marketplace.md) for the curated catalog.

The core rule is that an extension's **purpose** and its **source** are separate
questions. A Widget is a Widget whether it ships with Tilecast, belongs to a
bundled plugin, or comes from an installed package. Provenance changes trust,
availability, and execution; it does not create another content model.

## Decision summary

Tilecast has three extension units and one distribution unit:

- **Widget:** presentation.
- **Data Source:** data acquisition and typed output.
- **Plugin:** application or integration behavior that does not fit the first
  two units.
- **Package:** distribution, version, provenance, permissions, and contribution
  delivery.

Do not add a fifth content model for Marketplace items, custom repositories, or
package-owned contributions.

## 1. Widget is the visual extension unit

A Widget owns visual meaning and presentation. Widgets V2 use one component
contract and one rendering implementation across Studio previews, fullscreen
playback, and Layout zones.

A Widget does not fetch arbitrary network data, hold credentials, read host
storage, or decide playback evidence. It consumes prepared resources through
the Widget SDK.

Core, bundled-plugin, and package-owned Widgets all use the same definition
shape. Their source changes the discovery and trust path, not the authoring or
presentation model.

## 2. Data Source is the data extension unit

A Data Source owns acquisition, parsing, sanitization, refresh, caching,
diagnostics, attribution, and typed Data Documents. A Widget consumes its
prepared output and stays provider-neutral.

A Data Source definition may declare an optional semantic field role. The
shared vocabulary and Studio mapping order are defined in
[Widget authoring](widget-authoring.md#semantic-field-roles).

### 2.1 Two Data Source classes

Tilecast supports two implementation classes:

1. **Declarative Data Sources.** A `tilecast.datasource.json` definition names
   one supported definition-driven adapter. Core modules, plugin-owned modules,
   and installed package modules use the same validator and output contract.
2. **Executable bundled-plugin Data Sources.** A trusted bundled plugin may
   implement Plugin API v1 `DataSourceProvider` behavior when declarative
   adapters are not sufficient.

Installed packages do not inject arbitrary Go or native Data Source code into
the Server. Package-owned Data Sources use the supported declarative adapters.

## 3. Plugin is the application and integration unit

A bundled plugin is trusted release code below `plugins/`. Plugin API v1 is
frozen and intentionally separate from the external package runtime.

A bundled plugin may contribute Studio routes, Server routes, migrations,
background behavior, Widgets, and Data Sources through the Plugin API
interfaces. Installation gates its active behavior.

An installed package may carry a `plugin` contribution for package identity
and compatibility, but it does not load Plugin API v1 code into the Server.
External executable Server behavior uses the package's isolated WebAssembly
runtime and declared capabilities instead.

## 4. Source and provenance are first-class

Every effective contribution has a normalized source:

- `core`: shipped by Tilecast.
- `plugin`: owned by a bundled plugin in the same release.
- `package`: supplied by an installed external package.

Source metadata is used for collision checks, availability, provenance,
support information, and Studio presentation. It never changes the meaning of
the Widget or Data Source contract.

The source is discovered by the host. A Widget or Data Source manifest must not
self-declare a source that can impersonate another owner.

Marketplace and custom repository entries are package acquisition sources. They
do not add new contribution source kinds.

## 5. Identity rules

New package-owned identities are qualified by package ID. Tilecast-owned
component types stay in the reserved `tilecast.*` namespace.

Existing persisted provider IDs remain compatibility identities. Do not rename
stored providers only to match a newer naming convention.

A bundled plugin's stable identity comes from `tilecast.plugin.json`, not its
directory name. A package's stable identity comes from
`tilecast.package.json`, not a repository or OCI path.

Two definitions may project to the same Widget component only when the
component type, version, tag, and entry point are identical. That case is a
compatibility alias, not a second component implementation.

## 6. Keep version concepts separate

Do not collapse these versions into one number:

- Tilecast release version.
- Widget component version.
- Widget or Data Source definition/configuration version.
- Plugin API version.
- Package manifest version.
- Package version.
- Player manifest schema version.
- External Widget execution ABI version.

A compatibility decision must name the versioned contract it depends on.

## 7. Repository layout

Current source-built contributions use these locations:

```text
widgets/<widget>/
data-sources/<source>/
plugins/<plugin>/
plugins/<plugin>/widgets/<widget>/
plugins/<plugin>/data-sources/<source>/
packages/{widget,data-source,plugin,package}-sdk/
marketplace/catalog.json
```

Installed package bytes live under the Server's package storage root, outside
the source tree. Runtime discovery never turns an arbitrary filesystem
directory into a trusted extension.

## 8. Registry and discovery architecture

Release-owned Widgets and Data Sources are discovered from their manifests and
generated ledgers. Plugin-owned contributions are resolved through the owning
plugin manifest. Installed package contributions join the effective catalog
only after the package pipeline validates and activates them.

The Server publishes one effective definition view to Studio and manifest
compilation. Studio does not maintain a second hard-coded list of package
contributions.

Player component capability lists are generated from the release-owned Widget
manifests. Installed external Widgets use the separate external execution
capability instead of extending that list.

## 9. Plugin and package installation

Bundled-plugin installation gates the behavior that already ships with the
release. Removing the installation does not delete historical plugin data.

Package installation resolves and verifies an external artifact before it
activates any contribution. Package update, rollback, and removal keep the
current contribution set atomic.

An operation that would remove a contribution still used by content is refused
with `package_in_use`. Content must be removed or changed first. Package
removal is not a content-deletion operation.

## 10. Contributor experience

Normal contributions must not require new host switches.

A core Widget uses:

```sh
npm run widgets:new -- scoreboard
npm run widgets:check
```

A bundled-plugin Widget uses:

```sh
npm run widgets:new -- scoreboard --plugin athletics
npm run plugins:check
npm run widgets:check
```

A declarative Data Source uses:

```sh
npm run data-sources:new -- lunch-menu --adapter http_records
npm run data-sources:check
```

Package authors use the package SDK and the package manifest. They do not clone
Tilecast in order to become trusted in-process code.

## 11. Data Source definition schema

`tilecast.datasource.json` is declarative. It describes configuration,
bounded fetch inputs where supported, typed output fields, refresh behavior,
attribution, and authoring metadata.

It does not contain executable expressions, SQL, process commands, arbitrary
JavaScript, or a dynamic adapter name.

The supported adapters and validation rules are defined in
[Data Source modules](data-source-modules.md). A package-owned declarative Data
Source uses the same rules.

## 12. Trusted versus external Widget execution

There are two Widget execution classes.

### Trusted Widget

A core or bundled-plugin Widget is compiled into the Tilecast release. Hosts
mount it directly through the trusted Widget registry and `WidgetMount`.

Trusted does not mean unrestricted. The Widget SDK still withholds arbitrary
networking, storage, credentials, host internals, and playback evidence APIs.

### External Widget

A package-owned Widget arrives as verified package bytes. Studio never imports
that code into the Studio document. It previews the Widget through the
sandboxed frame boundary.

Player delivery and execution are separate gates. The Server and Player Core
can describe, download, hash-check, and pin an external Widget bundle. A Player
may execute it only when the host advertises the qualified
`widget.external-runtime` capability and uses the sandboxed executor.

No production host should advertise that capability merely because bundle
delivery exists. Per-target isolation and performance qualification remain
required. The dated sandbox measurements live under
[`records/`](records/README.md).

## 13. External Data Sources

Installed packages may contribute declarative Data Sources. They are validated
through the same definition contract as release-owned declarative modules and
are restricted to the supported definition-driven adapters.

Package Data Sources never load arbitrary Server code.

A bundled plugin can still use the trusted Plugin API `DataSourceProvider`
when executable behavior is required. External executable behavior belongs to
the package WebAssembly runtime, not Plugin API v1.

## 14. Package and distribution model

`tilecast.package.json` owns package identity, compatibility, distribution,
contributions, and optional runtime capability requests.

The current installer supports reviewed Marketplace entries and custom public
GitHub repositories. Artifacts are resolved to immutable OCI digests and
verified through the package trust pipeline before activation.

The official Marketplace is a curated metadata catalog. It does not host
package bytes and is not a security audit.

See [Extension packages](packages.md) and [Marketplace](marketplace.md) for the
binding format and trust rules.

## 15. Installation, update, rollback, and restore

An installation records the exact package version, digest, provenance, active
contributions, runtime grants, and retained bytes needed by the current
pipeline.

Update re-resolves and verifies the candidate. Rollback restores the retained
previous activation. Both are blocked when the target contribution set would
orphan content.

Backups include the package database state and package summary metadata.
Package bytes under the configured package root are part of the deployment's
backup responsibility.

## 16. Player delivery for external Widgets

Manifest v18 can carry an external Widget package block with:

- package ID;
- verified package digest;
- bundle SHA-256;
- bundle size;
- authenticated download path.

Player Core treats the bundle as verified content. It downloads the bytes
through the authenticated package route, validates size and SHA-256, pins the
content, and refuses activation when verification fails.

The presentation requires `widget.external-runtime`. Hosts that do not report
that capability receive normal compatibility handling and never execute the
bundle.

The bundle path inside a package is fixed by the package contract. Authors do
not provide arbitrary Player filesystem paths.

## 17. Studio model

Studio has one Widget gallery, one Data Source gallery, and one plugin/package
store experience.

Definition source may affect provenance badges, installation state, trust
review, and support links. It does not select a separate Widget editor.

Trusted Widgets preview through the real component. Package Widgets preview
through the Server-built sandbox frame. Package Studio interfaces run in their
own sandboxed frame and communicate through the bounded bridge.

## 18. Compatibility and migration

Existing provider IDs, plugin installation rows, content records, and shipped
Player schemas keep their compatibility meaning.

A package feature must not reinterpret an older manifest or make old content
unreadable. A newer definition or package capability is additive unless its
own versioned contract explicitly says otherwise.

Retired built-in plugins stay inert compatibility data. Unknown package or
plugin state from a newer release must fail closed or remain distinguishable;
it must not silently execute.

## 19. Security invariants

### Widgets

- No credentials or arbitrary host object.
- No arbitrary network or filesystem access.
- No direct proof-of-play or Activity authority.
- External code never joins the trusted Studio or Player document.

### Data Sources

- All external values are untrusted input.
- Declarative package sources use fixed supported adapters.
- SSRF, redirect, body-size, record-count, and type limits stay enforced at the
  Server boundary.

### Plugins and package runtime

- Bundled Plugin API code is trusted release code.
- External runtime code is isolated from Plugin API v1.
- The package WebAssembly host exposes only its documented capability-based
  ABI and no WASI.
- Capability requests are reviewed and bounded; they are not implicit grants.

### Packages

- Resolve mutable references to immutable digests before activation.
- Verify provenance and manifest consistency.
- Never execute bytes that were not retained and verified by the package
  pipeline.
- Keep update and rollback atomic.

## 20. Validation and conformance

Use the owner-specific checks:

- `npm run widgets:check` for Widget manifests, modules, generated capability
  bindings, and component conformance.
- `npm run data-sources:check` for declarative Data Source modules.
- `npm run plugins:check` for bundled Plugin API contributions.
- Package SDK and Server package tests for package parsing, provenance,
  lifecycle, runtime grants, and effective catalog composition.
- Player manifest and host conformance tests for external bundle delivery and
  capability handling.

Generated files remain generated. Do not edit a host registry by hand to make a
new contribution appear.

## 21. Current implementation state

The following are current product capabilities:

- bundled Plugin API v1 plugins;
- core and bundled-plugin Widgets and Data Sources;
- package format, OCI resolution, provenance verification, install, update,
  rollback, removal, and backup metadata;
- Marketplace and custom public GitHub repository discovery;
- package-owned declarative Widget and Data Source contributions;
- Studio sandbox preview for package Widgets;
- verified Player delivery for external Widget bundles;
- capability-based external WebAssembly Server runtime, background jobs, and
  Studio interface bridge.

External Widget execution on a Player remains capability-gated. The presence of
manifest v18 or bundle delivery is not evidence that a platform has qualified
the external Widget sandbox.

## 22. Binding principles

1. Widget is the visual extension unit.
2. Data Source is the data extension unit.
3. Plugin is the application and integration unit.
4. Package is the distribution and trust unit.
5. Source and provenance are orthogonal to contribution type.
6. Trusted bundled code and external package code use different execution
   boundaries.
7. Studio authoring is definition-driven, not provider-switch-driven.
8. Player presentation stays shared across platforms.
9. Compatibility identities and shipped schema meanings remain stable.
10. New extension capability belongs at the narrowest existing contract that
    can own it safely.
