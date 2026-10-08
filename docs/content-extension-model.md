# Tilecast content extension model

Status: accepted architecture plan. This document defines how Widgets, Data
Sources, plugins, and future independently distributed extension packages fit
together. It builds on [Widgets V2](widgets-v2.md) and the frozen
[Plugin API v1](plugin-api.md).

The purpose of this plan is to keep four things true at the same time:

1. adding a normal Tilecast Widget stays easy;
2. plugins can bundle Widgets and Data Sources without inventing another
   renderer or another data model;
3. a useful class of custom Widgets and Data Sources can exist without a
   full plugin;
4. independently downloaded code never becomes trusted Player or Server code
   merely because it is called a Widget or plugin.

This is a direction for later implementation, not a statement that runtime
installation is available today. Plugin API v1 remains frozen. Widgets V2
continues on its existing stack.

## Decision summary

Tilecast has three extension units and one distribution unit.

| Unit        | Owns                                         | May exist alone       | May be bundled by a plugin           |
| ----------- | -------------------------------------------- | --------------------- | ------------------------------------ |
| Widget      | Presentation                                 | Yes                   | Yes                                  |
| Data Source | Data acquisition and typed output            | Yes, when declarative | Yes                                  |
| Plugin      | Application behavior and integration         | Yes                   | n/a                                  |
| Package     | Distribution, version, provenance, and trust | n/a                   | Can carry any supported contribution |

The dependency model is:

```text
                       extension sources
                              |
              +---------------+---------------+
              |               |               |
             core           plugin          package
              |               |               |
              v               v               v
       +--------------+                +------------------+
       | Widget       |                | Data Source      |
       | Registry     |                | Registry         |
       +------+-------+                +---------+--------+
              |                                  |
              |                           typed Data Documents
              |                                  |
              +----------------+-----------------+
                               |
                               v
                        Widget presentation
                               |
                    +----------+----------+
                    |                     |
              trusted executor      sandboxed executor
              release code          future package code
                    |                     |
                    +----------+----------+
                               |
                               v
                         WidgetSurface
                               |
                     shared Player Runtime
                               |
                 Electron / WPE / Android WebView

Plugin
  + server behavior
  + Studio pages
  + routes and workers
  + migrations
  + Widget contributions -------> Widget Registry
  + Data Source contributions --> Data Source Registry
```

The source of an extension is orthogonal to what the extension is. A Widget is
a Widget whether it ships in Tilecast, is owned by a bundled plugin, or comes
from a future external package.

## Why this model

Tilecast should borrow the useful separation from mature extension systems
without copying their trust model.

Grafana separates visualization panels, Data Sources, and applications. An
application may bundle panels and Data Sources, but those contributions remain
ordinary panels and Data Sources. That maps well to Tilecast: a plugin may
bundle Widgets and Data Sources without creating "plugin Widgets" or "plugin
Data Sources."

Home Assistant demonstrates that custom visual components are useful on their
own. Tilecast should keep a much narrower runtime contract, however. A Widget
receives prepared resources and Widget context, not broad application state or
credentials.

Backstage's newer extension systems favor small named extension points over one
large plugin API. Tilecast should follow the same principle: Widget, Data
Source, Studio navigation, and Server behavior remain separate contracts.

Superset and Grafana both make scaffolding, validation, and packaging part of
the extension developer experience. Tilecast should do the same. A contributor
should not need to understand registry internals before making a Widget.

References used while settling this plan:

- Grafana plugin types:
  https://grafana.com/developers/plugin-tools/key-concepts/plugin-types-usage
- Grafana plugin scaffolding:
  https://grafana.com/developers/plugin-tools
- Home Assistant custom cards:
  https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/
- Backstage extension points:
  https://backstage.io/docs/plugins/new-backend-system/
- Backstage frontend extensions:
  https://backstage.io/docs/next/frontend-system/architecture/extensions/
- Superset extensions:
  https://superset.apache.org/developer-docs/extensions/quick-start/
- OCI artifact guidance:
  https://specs.opencontainers.org/image-spec/manifest/
- Sigstore verification:
  https://docs.sigstore.dev/cosign/verifying/verify/

These are design inputs, not compatibility targets.

## 1. Widget is the visual extension unit

Widgets V2 is the Widget extension API.

There is one implementation contract:

```text
tilecast.widget.json
        +
defineWidget(...)
        +
Web Component, normally Lit
        |
        v
@tilecast/widget-sdk
        |
        v
WidgetMount
```

Do not add parallel APIs such as:

```text
definePluginWidget()
defineCustomWidget()
plugin.renderWidget()
```

A core Widget, plugin-owned Widget, private source-built Widget, and future
downloaded Widget all describe the same content type.

The current Widgets V2 ownership rules remain binding:

- **shared Widget renderer** means the Widget runtime module plus `WidgetMount`, used by Studio, Storybook/fixtures, and the Player Runtime;
- **shared Player Runtime** means the complete playback document/engine hosted by Electron, Edge/WPE, and Android; Studio intentionally does not instantiate it for ordinary Widget authoring preview;
- a Widget owns presentation, not acquisition;
- a Widget reads only prepared Data Documents and verified media aliases;
- a Widget does not fetch;
- a Widget does not receive credentials or the Player host object;
- the runtime owns evidence and playback state;
- the same component renders fullscreen, in a Layout, and in Studio preview.

### 1.1 The current #706 contracts stay

The following contracts from Widgets V2 PR 1 remain the foundation:

- `@tilecast/widget-sdk`;
- `@tilecast/widget-kit`;
- `defineWidget()`;
- `tilecast.widget.json`;
- first-class component presentations;
- `WidgetMount`;
- component capability negotiation;
- compatibility presentations for older Players;
- Storybook fixtures and visual regression;
- one shared-runtime implementation across Electron and WPE, with Android
  convergence following separately.

This plan generalizes discovery and ownership. It does not replace those
contracts.

The first implementation of that model in Studio and the first redesigned
native Widget family are specified in
[Widgets V2 authoring and first-wave migration](widgets-v2-authoring-and-first-wave.md).

## 2. Data Source is the data extension unit

A Data Source owns:

- acquisition;
- authentication handled by its host boundary;
- parsing;
- sanitization;
- refresh and retry;
- caching;
- typed fields and Data Documents;
- date-selection policy;
- attribution;
- diagnostics.

A Widget owns how those prepared values look.

A Data Source never becomes visual merely because it was bundled with a
Widget. A Widget never acquires remote data merely because it was bundled with
a Data Source.

### 2.1 Two Data Source classes

Tilecast should support two kinds of Data Source extension.

#### Declarative Data Source

A declarative Data Source uses a Tilecast-owned adapter. It may exist without a
plugin.

Examples of safe adapter classes already present in the codebase include:

- `manual_object`;
- `manual_records`;
- `http_records`.

A future definition lives in:

```text
data-sources/<name>/
  tilecast.datasource.json
  fixtures/
  tests/
```

A declarative definition may describe configuration, fixed or bounded fetch
inputs, output fields, refresh behavior, attribution, and authoring guidance.
It may not include scripts, expressions, SQL, arbitrary process execution, or
an implementation of network I/O.

Tilecast Server owns the adapter implementation and therefore owns:

- URL and redirect policy;
- SSRF protection;
- response-size limits;
- timeout policy;
- parsing bounds;
- cache state;
- scheduling;
- Player projection.

This is the preferred custom Data Source model.

#### Executable Data Source provider

Some integrations need code: OAuth, proprietary authentication, stateful
protocols, specialized polling, or domain workflows.

Those belong to a plugin and use the existing
`plugin.DataSourceProvider`/Host boundary.

Plugin API v1 is not changed for this plan. Its current executable provider
shape does not need to become a multi-provider framework merely because a
plugin can bundle many declarative Data Source definitions. If a real plugin
later needs several executable providers, that is evidence for a versioned
Plugin API change rather than a reason to widen v1 speculatively.

A later Plugin API version may also make a static Data Source descriptor
authoritative for catalog metadata while the server contribution supplies only
behavior, but that is not required to let a plugin bundle declarative Data
Sources.

## 3. Plugin is the application and integration unit

A plugin owns behavior that does not belong in a Widget or declarative Data
Source:

- Server routes;
- background workers;
- domain storage;
- application-specific authorization;
- Studio application pages;
- Takeovers or other Host-service interactions;
- executable Data Source providers;
- application lifecycle.

A plugin may also bundle ordinary Widget and Data Source modules.

Example:

```text
plugins/
  athletics/
    tilecast.plugin.json
    plugin.go
    server/
    studio/
    migrations/

    widgets/
      scoreboard/
        tilecast.widget.json
        runtime/
        fixtures/

      upcoming-games/
        tilecast.widget.json
        runtime/
        fixtures/

    data-sources/
      schedule/
        tilecast.datasource.json
        fixtures/
```

There is no Go `WidgetProvider` contribution and no
`plugin.renderWidget()`.

The Widget toolchain discovers `plugins/*/widgets/*`. The Data Source
toolchain discovers `plugins/*/data-sources/*`. Plugin tooling adds ownership
and validates the complete plugin.

This keeps the dependency direction clean:

```text
Widget API      <- Widget modules
Data Source API <- Data Source definitions
Plugin API      <- plugin behavior

Plugin directory may contain modules from all three systems.
```

Plugin API v1 remains frozen.

## 4. Source and provenance are first-class

Widgets V2 PR 1 discovers only root `widgets/*`. That is sufficient for the
first vertical slice but must not become the permanent registry assumption.

Every registered contribution receives an internal source descriptor.

Conceptually:

```ts
type ExtensionSource =
  | {
      kind: "core";
    }
  | {
      kind: "plugin";
      pluginId: string;
    }
  | {
      kind: "package";
      packageId: string;
      packageVersion: string;
      digest: string;
    };
```

Registry entries contain both the contribution and its source.

Conceptually:

```ts
interface RegisteredWidget {
  manifest: WidgetManifest;
  definition: WidgetDefinition;
  source: ExtensionSource;
}

interface RegisteredDataSource {
  definition: DataSourceDefinition;
  source: ExtensionSource;
}
```

Source metadata is used for:

- availability;
- install and removal blockers;
- collision diagnostics;
- Studio provenance;
- support bundles;
- audit;
- updates;
- backup and restore;
- package trust.

Source metadata is not a reason to fork Widget or Data Source behavior.

### 4.1 Studio provenance

Studio should be able to explain where a contribution came from:

```text
Clock
Built in

Scoreboard
Plugin · Athletics

Lunch Menu
Custom · district96.lunch-menu
Version 2.1.0
```

Normal creation remains one Widget gallery and one Data Source gallery. Source
is supporting information, not a separate content system.

## 5. Identity rules

Identity must work for a local repository today and a distributed ecosystem
later.

### 5.1 Qualified new identities

New extension identities are qualified.

Built-in examples:

```text
tilecast.clock
tilecast.weather
tilecast.school-schedule
```

Future package examples:

```text
district96.lunch-menu
gbyo.athletics.scoreboard
acme.rooms.status
```

The `tilecast` namespace is reserved for release-owned contributions.

Component identity should allow more than one dot-separated namespace segment,
subject to the existing overall capability-name bound.

Conceptually:

```text
<publisher>.<name>
<publisher>.<package>.<name>
```

The exact validation remains deliberately conservative: lowercase ASCII
letters, digits and hyphens per segment, at least two segments, and a maximum
full `widget.<type>` capability length of 80 characters so it remains
inside the heartbeat capability-name bound.

### 5.2 Existing persisted provider IDs do not change

Existing provider IDs such as:

```text
clock
weather
countdown
```

are compatibility identities. Do not rewrite persisted Widget records.

For migrated legacy Widgets it is valid to have:

```text
persisted provider: clock
component type:     tilecast.clock
```

For a brand-new component-only V2 Widget, prefer one qualified ID for both:

```text
provider:       tilecast.scoreboard
component type: tilecast.scoreboard
```

This makes the legacy mapping an exception rather than the model for every new
Widget.

Apply the same qualified-ID rule to new standalone Data Source definitions.
Existing Data Source provider IDs remain compatible.

### 5.3 External package ownership

A future package has its own stable package identity, for example:

```text
district96.athletics
```

A package's contributions must either equal that package ID or live beneath
its namespace:

```text
district96.athletics
district96.athletics.scoreboard
district96.athletics.schedule
```

Moving an artifact between registries does not change its package ID.

## 6. Keep version concepts separate

Do not make one integer mean four different things.

### Widget

| Version                   | Meaning                                                 |
| ------------------------- | ------------------------------------------------------- |
| manifest API version      | Shape and semantics of `tilecast.widget.json`           |
| definition/config version | Persisted Widget configuration contract                 |
| component version         | Player/runtime rendering contract                       |
| package version           | Release version of an independently distributed package |

Widgets V2 currently has `version` and `component.version`. Add an explicit
manifest `apiVersion` before external authors depend on the file format.
Keeping the existing top-level field named `version` is acceptable if its
meaning is documented as the definition/config version; renaming it is not
required merely for aesthetics.

A future package version is SemVer and does not replace either existing
version.

### Data Source

A Data Source similarly has:

- definition manifest API version;
- definition/config version;
- adapter or provider contract version where required;
- package version only when distributed independently.

### Plugin

Plugin API v1 keeps its existing:

- `apiVersion`;
- `definitionVersion`.

Bundled v1 plugins still have no separate package version because they ship
with Tilecast. A future external package wrapper can add one without changing
the v1 persisted plugin identity.

## 7. Repository layout

The target source layout is:

```text
widgets/
  <widget>/
    tilecast.widget.json
    runtime/
    fixtures/

data-sources/
  <source>/
    tilecast.datasource.json
    fixtures/

plugins/
  <plugin>/
    tilecast.plugin.json
    server/
    studio/
    migrations/

    widgets/
      <widget>/
        tilecast.widget.json
        runtime/
        fixtures/

    data-sources/
      <source>/
        tilecast.datasource.json
        fixtures/
```

Existing release definition JSON files may remain while older content is
migrated. Do not force a large catalog rewrite to create this layout.

New V2 Widgets use the module layout. New extension-oriented declarative Data
Sources use the Data Source module layout once that schema/tooling lands.

## 8. Registry and discovery architecture

No contributor edits a central registry.

### 8.1 Widget discovery

Refactor `discoverWidgets()` so it receives structured source entries instead
of deriving ownership from a hard-coded `/widgets/<dir>/` path.

At build time, the trusted source set includes:

```text
widgets/*/tilecast.widget.json
widgets/*/runtime/index.ts

plugins/*/widgets/*/tilecast.widget.json
plugins/*/widgets/*/runtime/index.ts
```

The discovery layer receives an explicit source with each manifest/module
pair.

It validates:

- manifest schema;
- source path;
- component identity;
- component version;
- custom-element tag;
- manifest/runtime agreement;
- duplicate provider IDs;
- duplicate component types;
- duplicate custom-element tags;
- source ownership rules;
- fixtures and tests.

A failure is a build/test problem. One malformed Widget never causes the
Player bundle to stop loading.

### 8.2 Player capabilities

All trusted source-built V2 Widgets are compiled into the Player runtime
artifact. Therefore a plugin-owned bundled Widget may be present in Player
capabilities even when that plugin is not installed on the Server.

That is expected.

Plugin installation controls whether the Server permits creation and projects
the Widget. It does not dynamically rewrite the Player binary.

### 8.3 Server catalog

Generalize content-definition loading around sources.

Conceptually:

```go
type DefinitionSource interface {
    Widgets() []SourcedWidgetDefinition
    DataSources() []SourcedDataSourceDefinition
}
```

The release catalog composes:

- existing embedded core definitions;
- root V2 Widget manifests;
- plugin-owned Widget manifests;
- root declarative Data Source definitions;
- plugin-owned declarative Data Source definitions;
- package-owned Widget and Data Source definitions from installed
  extension packages.

The shipped shape is the `contentdefs.Catalogs` interface with an atomic
`Provider`: each installed package contributes one external overlay in
package-ID order, and every rebuild swaps a complete immutable snapshot
into the services. The important property holds: `contentdefs.Catalog`
no longer assumes "embedded release file" is the only possible origin.

The catalog fingerprint includes source identity and definition bytes.

Do not create a source-specific provider switch.

### 8.4 Studio

Studio consumes the effective catalog and the same source metadata.

The Widget preview registry discovers all trusted source-built Widget runtime
modules through the same source-aware mechanism as the Player.

Do not add plugin-specific preview code.

## 9. Plugin installation and removal

Plugin ownership affects availability, not Widget semantics.

### 9.1 Availability

When a Widget or Data Source has:

```text
source.kind = plugin
source.pluginId = athletics
```

the generic catalog layer can determine whether Athletics is installed.

When not installed, Studio may either hide the definition from normal creation
or show it as unavailable with an **Install Athletics** affordance.

No Athletics-specific code belongs in the Widget gallery.

### 9.2 Generic removal blockers

Core already knows which persisted Widget instances and Data Source rows use a
provider.

Therefore plugin removal automatically checks content contributed by that
plugin.

Example:

```text
Athletics cannot be removed.

7 Widgets use Athletics Widget types.
2 Data Sources use Athletics source types.
```

This generic blocker exists in addition to `RemovalGuard`.
`RemovalGuard` remains for plugin-owned domain state that core cannot infer.

Removal never silently changes a provider or deletes unrelated content.

## 10. Contributor experience

Ease of contribution is a design requirement, not documentation polish.

A contributor adding a normal Widget should not need to understand:

- Go registries;
- Vite glob internals;
- Player capability files;
- Server catalog fingerprints;
- plugin installation SQL;
- Studio route internals;
- Edge capability profiles.

The tooling owns those.

### 10.1 Core Widget

The happy path remains:

```sh
npm run widgets:new -- scoreboard
npm run widgets:storybook
npm run widgets:check
```

The scaffold creates:

- manifest;
- runtime entry point;
- element;
- ready fixture;
- test;
- stories.

`widgets:generate` updates generated host metadata.

For local Widget work, Node/npm should be sufficient. A contributor should not
need Go or PostgreSQL merely to iterate on a pure Widget. Full repository CI
still validates Server compatibility.

### 10.2 Plugin-owned Widget

Use the same scaffold with ownership as an option:

```sh
npm run widgets:new -- scoreboard --plugin athletics
```

It writes:

```text
plugins/athletics/widgets/scoreboard/
```

and generates the same files as a core Widget.

There is no second plugin-Widget tutorial.

### 10.3 Declarative Data Source

Provide:

```sh
npm run data-sources:new -- lunch-menu --adapter http_records
npm run data-sources:check
```

For a plugin-owned source:

```sh
npm run data-sources:new -- schedule --plugin athletics --adapter http_records
```

The scaffold creates:

- `tilecast.datasource.json`;
- a representative fixture;
- adapter-specific example configuration;
- output-schema fixture;
- tests where useful.

A declarative Data Source contributor should be able to validate fixtures
without running the whole Server.

### 10.4 Plugin

The existing flow remains:

```sh
npm run plugins:new -- athletics --name "Athletics"
npm run plugins:check
```

`pluginctl check` also invokes the Widget/Data Source validation for
contributions owned by that plugin.

### 10.5 Aggregate validation

Add a top-level convenience check once multiple extension toolchains exist:

```sh
npm run extensions:check
npm run extensions:generate
```

It orchestrates existing tools. It is not a fourth manifest format.

### 10.6 Future external author workflow

When independently distributed packages are implemented, external authors
should not have to clone the Tilecast monorepo.

Provide a supported scaffold/CLI with a flow conceptually like:

```sh
npx @tilecast/create-extension
npm run dev
npm run check
npm run build
npm run publish
```

The scaffold asks which contributions the package contains and creates only
those pieces:

```text
Widget
Declarative Data Source
Plugin behavior (when the external runtime exists)
Bundle/application
```

A Widget-only package should launch Storybook/fixture preview without a
Tilecast Server. A declarative Data Source package should run its adapter
fixtures locally without PostgreSQL. Full Tilecast integration remains
available for packages that need it, but it is not the first step.

The same schemas and conformance suites used by the monorepo are published for
external tooling. Do not maintain a separate "community Widget" API.

### 10.7 Shared tooling implementation

When Data Source tooling arrives, extract common build-time functions only
where duplication is real:

- source discovery;
- ownership parsing;
- qualified identity checks;
- collision reporting;
- deterministic ordering;
- generated-file checks;
- package provenance types.

Keep runtime SDKs separate:

- `@tilecast/widget-sdk` is a Player/preview runtime contract;
- Data Source definition tooling is a Server/content contract;
- Plugin SDK is an application behavior contract.

Do not merge them into one giant "extension SDK."

## 11. Data Source definition schema

`tilecast.datasource.json` is the versioned declarative Data Source
manifest (implemented in `packages/data-source-sdk`, detailed in
[Data Source modules](data-source-modules.md)).

It reuses the existing proven concepts:

- ID;
- version;
- name/description/category/icon;
- configuration schema;
- defaults;
- output schema;
- refresh behavior;
- attribution;
- setup guidance;
- generic adapter ID;
- bounded fetch specification where the adapter permits it.

It adds:

- `apiVersion`, separate from the definition/config version;
- explicit compatibility metadata where the release already carries it
  (`requiresManifestV13`);
- no executable fields.

The manifest names one of the exact Server adapter IDs, but only
`manual_object`, `manual_records`, and `http_records` have a declarative
binding; every other adapter is rejected at composition. Source and
provenance are injected by discovery: the file must not declare its own
source.

Do not create an arbitrary expression language.

Do not allow a definition to name a Server package or function.

The Go Server remains authoritative for execution and revalidates installed
definitions.

## 12. Trusted versus external Widget execution

There are two security classes.

### Trusted Widget

Sources:

- Tilecast core;
- bundled first-party plugin;
- private source build reviewed together with Tilecast.

Execution:

```text
WidgetMount
  -> direct custom element
  -> shared Player runtime document
```

This is the model implemented by Widgets V2 PR 1.

### External Widget

Source:

- a package installed at runtime from outside the Tilecast release.

An external Widget must not be imported directly into the trusted Player
document.

Future runtime structure:

```text
WidgetSurface
  -> WidgetExecutor
       + TrustedWidgetExecutor
       + SandboxedWidgetExecutor
```

The sandbox executor exposes only the conceptual Widget contract:

- bounded config;
- prepared Data Documents declared by the presentation;
- verified media aliases declared by the presentation;
- bounded Widget theme;
- corrected clock;
- locale/timezone/motion context;
- resize/container facts only where required;
- ready/empty/error lifecycle.

It exposes no:

- network;
- cookies;
- browser storage;
- credentials;
- arbitrary filesystem;
- Player host object;
- Studio session;
- DOM outside the Widget;
- proof-of-play API.

A sandboxed browsing context with an opaque origin and a narrow message bridge
is the leading browser-compatible design to prototype, but this document does
not freeze that implementation until it is measured on Electron, WPE, and the
Android shared-runtime WebView.

Do not weaken the runtime CSP to make external Widgets work.

Do not implement runtime-installed external Widget code before Android shares
the Player runtime and the isolation spike meets the performance/security
gates.

## 13. External Data Sources

Runtime-installed declarative Data Sources are safer and may ship before
runtime-installed Widget code.

The Server:

1. verifies the package;
2. validates the definition against the supported Data Source manifest API;
3. ensures the adapter is on the allowed declarative adapter list;
4. checks identity collisions;
5. adds the definition to the effective catalog;
6. executes the existing trusted adapter.

The package supplies data, not executable Server code.

Executable external Data Source providers wait for the external plugin runtime
and its sandbox/capability model.

## 14. Package and distribution model

A package is a distribution container, not a fourth extension API.

A future package may contain:

- one or more Widgets;
- one or more declarative Data Sources;
- an external plugin module when that runtime exists;
- documentation;
- license/source metadata.

### 14.1 Package identity

A package has:

- stable qualified `packageId`;
- SemVer `packageVersion`;
- Tilecast compatibility range;
- contribution manifest;
- publisher metadata;
- source/docs/license metadata.

Registry location is not identity.

### 14.2 OCI

Use OCI artifacts as the canonical distribution format rather than inventing a
Tilecast-specific registry protocol.

OCI gives Tilecast:

- digest-addressed content;
- tags for human release names;
- ordinary private/public registry support;
- established pull/push tooling;
- artifact metadata;
- a path for attached signatures and attestations.

Use ORAS or an equivalent OCI library/tooling implementation.

An offline import format, if added, should carry the same package manifest and
digests. Do not create a second package semantics for ZIP uploads.

### 14.3 Signing and trust

Remote installation requires verification.

The intended trust classes are:

- **Official**: signed by Tilecast release infrastructure;
- **Verified publisher**: publisher identity explicitly trusted by policy;
- **Locally trusted**: administrator pins a signing identity/key;
- **Unsigned**: development mode only.

A signature proves provenance/integrity. It does not make executable code
safe, so the runtime sandbox remains mandatory.

Sigstore/cosign is the preferred first implementation because signatures bind
to the artifact digest and can bind to an OIDC identity.

## 15. Installation, updates, rollback, and restore

Runtime package installation is a later phase but the registries must leave
room for it.

Installed package state records at least:

- package ID;
- package version;
- OCI digest;
- source registry;
- signer/trust identity;
- compatibility state;
- previous activated digest;
- contribution IDs.

Never execute a floating tag. Resolve it to a digest and persist the digest.

The first update policy is manual:

```text
resolve release
-> verify digest/signature
-> validate compatibility
-> stage artifact
-> validate all contributions
-> activate atomically
-> retain previous artifact for rollback
```

Automatic update policy may follow only after rollback behavior is proven.

Backup metadata records exact installed package IDs, versions, digests, and
required package state.

When restore cannot obtain a required package, preserve its persisted content
and mark the contribution unavailable. Do not delete records because code is
missing.

## 16. Player delivery for external Widgets

Trusted Widgets are bundled into the Player release and continue to advertise
per-component capabilities such as:

```text
widget.tilecast.clock = 1
```

External Widgets are different. The Player advertises one capability for the
external Widget execution ABI instead of one capability per downloaded Widget:

```text
widget.external-runtime = 1
```

Version 1 is retrieval-only: the Player verifies the raw bundle but never
executes it. Version 2 executes the assembled sandbox frame:

```text
widget.external-runtime = 2
```

A presentation for an external Widget carries a `package` block with the
package ID and the verified package digest, plus exactly one artifact. A
version 1 presentation names the bundle SHA-256, size, and authenticated
download path; a version 2 presentation names only the `frame` block with
the sandbox frame SHA-256, size, and authenticated download path. Manifest
schema 18 carries version 1 claims and schema 19 carries version 2 claims;
each selects itself only for presentations that use an external Widget, and
other presentations keep their schema. A Player reporting only version 1
keeps its version 18 bundle claim; Players without the external-runtime
capability keep their current compatibility behavior.

The Player fetches the artifact through the same verified preparation path
as media: it downloads the bytes, checks size and SHA-256, pins the
verified bytes in the content store, and only then stores the pending
manifest. When preparation fails, the Player keeps the last known playable
presentation. It never activates a manifest whose artifacts are missing or
fail verification.

The bundle path is fixed (`runtime/index.js` inside the package). Authors
never declare it. Do not add downloaded Widget types to the bundled component
capability list.

The sandbox frame is the deterministic assembly of the verified bundle
with the generated frame bootstrap: the same assembler produces the Studio
preview document and the Player executable document, so one cached frame
serves every attach. Execution runs only inside the opaque-origin
`allow-scripts` frame behind the Widget bridge
(`docs/widget-sandbox-spike.md`).

## 17. Studio model

Studio keeps one authoring system.

Users should not have to decide whether they are creating a "core Widget" or a
"plugin Widget."

The Widget gallery is built from the effective Widget Registry.

The Data Source gallery is built from the effective Data Source Registry.

Filters/badges may show:

- built in;
- plugin;
- custom;
- unavailable;
- update available;
- trust state.

The editor is chosen by the definition contract, not by source kind.

For V2 Widgets, Studio preview uses the real Widget through `WidgetMount`
for trusted source-built Widgets and through `SandboxedWidgetExecutor`
for package-source Widgets. The sandboxed preview loads a Server-built
frame document for the verified bundle; the bundle is never imported
into the Studio document. Player execution of external Widgets stays
future work until the per-target isolation gates in §12 pass.

## 18. Compatibility and migration

This architecture must not make current content unreadable.

### Widgets

- Manifest v16 component presentations from #706 remain unchanged.
- Existing provider IDs remain valid.
- Existing RenderNode/native fallback remains until the normal Widgets V2
  migration permits removal.
- Existing Players continue receiving compatibility presentations.
- A new extension manifest API version does not reinterpret previously shipped
  manifests.

### Data Sources

- Existing provider IDs and stored rows remain valid.
- Existing release definition files remain valid while the new module layout is
  introduced.
- No mass migration of core definitions is required just to enable extension
  sources.

### Plugins

- Plugin API v1 is not reopened.
- Existing plugin IDs, install rows, migrations, and Host behavior do not
  change.
- Bundled Widget/Data Source ownership is derived by build tooling and catalog
  source metadata.
- A later Plugin API version may expose additional package/runtime capability
  only when an external plugin implementation requires it.

## 19. Security invariants

The following are architecture rules.

### Widget

A Widget never receives credentials or unrestricted network access.

Trusted source-built Widget code is release-trusted code.

Downloaded Widget code is never executed with that trust merely because it
passes schema validation or has a valid signature.

### Declarative Data Source

Definitions do not execute code.

Network access, when an adapter permits it, is performed by Tilecast Server
under the existing fetch policy.

### Plugin

Bundled Plugin API v1 code is trusted release code.

Future downloaded executable plugin code must use a sandboxed external runtime;
do not load arbitrary Go shared objects, Node modules, or same-process binaries
into Tilecast Server.

### Package

A package manifest cannot grant itself capabilities. The host decides what an
extension class is allowed to do.

## 20. Validation and conformance

### Widget checks

`widgets:check` eventually validates both core and plugin-owned Widget roots:

- manifest schema/API version;
- qualified IDs;
- component identity/version;
- tag uniqueness;
- source ownership;
- config bounds;
- Data Source references;
- fixtures;
- stories;
- tests;
- CSP/runtime rules;
- generated capability metadata.

### Data Source checks

`data-sources:check` validates:

- manifest schema/API version;
- qualified IDs;
- source ownership;
- configuration/defaults;
- output fields;
- adapter existence;
- fetch bounds;
- fixtures;
- attribution;
- collision rules.

### Plugin checks

`plugins:check` additionally verifies:

- every nested contribution is attributed to that plugin;
- no nested contribution bypasses the appropriate Widget/Data Source checks;
- plugin removal can identify contributed provider IDs;
- generated code/docs remain current.

### Cross-source checks

The build rejects collisions across all sources, not merely within one
directory tree.

The same identity cannot be supplied simultaneously by core, two plugins, or
two installed packages.

## 21. Implementation sequence

Do not implement this as one giant extension-platform PR.

### Phase A — lock the source boundary during Widgets V2

Do this before too much Studio/runtime code assumes root-only discovery:

1. add an explicit Widget manifest `apiVersion`;
2. document the four Widget version concepts;
3. permit multi-segment qualified component types while keeping the
   80-character `widget.<type>` capability bound;
4. establish the rule that new component-only provider IDs are qualified;
5. add `ExtensionSource`/provenance to Widget discovery and registry entries;
6. refactor Widget discovery to consume structured sources;
7. make build-time discovery capable of reading both `widgets/*` and
   `plugins/*/widgets/*`;
8. generalize the Server content-definition loader around sourced definitions;
9. add cross-source collision tests;
10. do not add runtime package installation;
11. do not change Plugin API v1.

A synthetic test source is enough to prove plugin ownership. Do not create a
fake product plugin solely for the test.

### Phase B — continue the existing Widgets V2 stack

Proceed with the current plan:

- generic real-component Studio preview;
- real Layout preview;
- Weather/Metric/Schedule/Chart pilots;
- gradual catalog migration;
- Android shared-runtime convergence.

Do not pull OCI, external packages, or sandbox work into these migration PRs.

### Phase C — Data Source modules

Add:

- `tilecast.datasource.json`;
- Data Source manifest schema;
- `data-sources/*` discovery;
- plugin nested Data Source discovery;
- `data-sources:new/check/generate`;
- source/provenance metadata;
- generic adapter conformance fixtures.

Start with declarative adapters only.

### Phase D — prove plugin composition

Use a real plugin that naturally needs a Widget or declarative Data Source.

Prove:

- plugin-owned Widget appears only while the plugin is available for authoring;
- it renders through the same V2 runtime;
- plugin-owned Data Source uses the normal catalog;
- uninstall blockers are generic;
- no core switch on plugin ID is introduced.

Do not invent a demo plugin if no product use case exists.

### Phase E — standalone declarative package installation

Before executable external code, implement packages containing only declarative
Data Sources and metadata-only contributions where useful.

This proves:

- package identity/version;
- OCI pull;
- digest pinning;
- signature verification;
- effective catalog composition;
- update/rollback;
- backup/restore;
- private registry support.

### Phase F — external Widget isolation spike

After Android shared-runtime convergence:

- package a real V2 Widget separately from Tilecast;
- load it through the sandbox executor;
- prove no network/storage/host access;
- run the same semantic fixtures;
- test CSP;
- test crash isolation;
- measure 1, 4, and 8 external Widgets;
- measure playlist churn and Layout resize;
- test Electron, WPE, and Android WebView.

Do not productionize external Widget installation if the security or low-end
performance result is poor.

### Phase G — external Plugin runtime

Implemented. A manifest version 2 package bundles external plugin
behavior as a WebAssembly module with bounded capability requests. The
server runs it in the capability-based Wasm host. Bundled Plugin API
v1 stays out of this path: no package loads arbitrary code
in-process.

A package may bundle:

- external plugin behavior;
- Widgets;
- declarative Data Sources.

The Widget/Data Source contracts do not change. See
[Extension packages](packages.md) for the runtime contract.

### Phase H — catalog and discovery service

An official extension catalog is metadata over signed packages.

It may list:

- Widgets;
- Data Sources;
- plugins;
- applications/bundles.

Self-hosters can also use a private registry or direct verified package
reference. Tilecast does not require the official catalog to install an
extension.

A commercial marketplace, ratings, payments, and similar product features are
separate future work, not architecture prerequisites.

## 22. Contribution definition of done

The architecture is working when all of these are true.

### Core Widget

A contributor can:

```sh
npm run widgets:new -- scoreboard
npm run widgets:storybook
npm run widgets:check
```

and need no hand-edited registry, host capability file, Studio renderer, Edge
renderer, Android renderer, or Go switch.

### Plugin Widget

A contributor can:

```sh
npm run widgets:new -- scoreboard --plugin athletics
npm run plugins:check
```

and the Widget uses exactly the same Widget SDK/runtime as a core Widget.

### Declarative Data Source

A contributor can:

```sh
npm run data-sources:new -- lunch-menu --adapter http_records
npm run data-sources:check
```

without writing Server fetch code.

### Plugin Data Source

A plugin can bundle a declarative Data Source with no new Plugin API surface,
or use the existing executable `DataSourceProvider` where real behavior is
required.

### Core architecture

Adding any of those contributions does not require a new provider switch in:

- Tilecast Server startup;
- Studio routing/gallery code;
- Player runtime;
- Edge;
- Android;
- backup/restore.

## 23. Things this plan intentionally does not do

Do not:

- reopen Plugin API v1 for Widget contribution interfaces;
- make every custom Widget a plugin;
- make every custom Data Source executable code;
- expose the old declarative RenderNode format as the permanent V2 Widget API;
- let Widgets fetch their own data;
- dynamically import Internet-downloaded Widget JavaScript into the trusted
  Player document;
- load arbitrary Go plugins into Tilecast Server;
- invent a Tilecast-only package registry protocol;
- make an official marketplace mandatory;
- require package/signing knowledge for ordinary in-repo contributions;
- migrate every existing Widget or Data Source before the extension source
  model can ship.

## 24. Binding principles

Future implementation should preserve these principles unless a new ADR
explicitly replaces them:

1. **Widget = presentation.**
2. **Data Source = data.**
3. **Plugin = behavior and application composition.**
4. **Package = distribution and provenance.**
5. **Registry = discovery and identity.**
6. **Executor = trust boundary.**
7. **Source does not change the Widget/Data Source contract.**
8. **Built-in contributions use the same extension contracts future
   contributions use.**
9. **No central registry edits for normal contributions.**
10. **Scaffold, validate, and generate the boring parts.**
11. **Plugin API v1 stays frozen until a real missing behavior requires another
    version.**
12. **Downloaded code never inherits release trust by default.**
