# Tilecast Generalization and Contributor Architecture Roadmap

Status: proposed, reconciled with `main` at `7efc5dee` after Plugin API v1, the programmable control plane, Edge M11, Widgets V2, static plugin Widget composition, and declarative Data Source module composition.

This roadmap covers the remaining cross-cutting work that would make Tilecast easier to extend, safer to change, and easier for a new contributor to understand.

The goal is **not** to add a large framework. Tilecast already has good architectural boundaries. The next step is to make those boundaries executable and reusable so contributors do not have to remember which Go, TypeScript, Kotlin, Rust, C, OpenAPI, CI, and documentation files happen to describe the same contract.

The guiding model is:

```text
one contract
    ↓
generated mechanical bindings where useful
    ↓
idiomatic native implementations
    ↓
shared conformance where implementations must agree
```

## What has already landed

The first version of this roadmap assumed several architectural projects were still in progress. They are now foundations to build on.

### Plugin and extension architecture

Plugin API v1 is complete through M7 and frozen. Forms and Emergency Alerts are plugin-owned, Countdown Bar uses the generic runtime surface path, and the remaining core special cases were removed.

Tilecast now also has separate extension contracts for:

- Plugins: `tilecast.plugin.json` + `pluginctl`;
- Widgets V2: `tilecast.widget.json` + `widgetctl`;
- declarative Data Sources: `tilecast.datasource.json` + `datactl`.

Plugin-owned static Widgets and declarative Data Sources compose into the same catalogs as root-owned modules.

The root already exposes:

```sh
npm run extensions:check
npm run extensions:generate
```

These commands should become the basis of repository-wide generation rather than introducing a fourth extension manifest or another extension framework.

### Shared Player Runtime and Edge

The shared Player Runtime is real and is hosted by both Electron and WPE. Tilecast Edge M1 through M11 have merged, including the remote-web isolation path.

The runtime already has an unusually strong cross-engine conformance suite:

- deterministic runtime fixtures;
- a manual clock;
- Electron and WPE runners;
- semantic comparison;
- evidence/error/result comparison;
- perceptual screenshot comparison.

Do not replace or wrap that system in a generic test framework.

### Widgets V2

Widgets V2 now has:

- first-class Widget modules;
- the redesigned Studio authoring shell;
- `WidgetMount` previews using the production renderer;
- source-aware authoring;
- the first-wave catalog;
- plugin-owned Widget composition;
- generated `widget.<type>` capability lists;
- Storybook;
- Playwright visual regression against committed Linux Chromium baselines.

The visual-regression foundation therefore already exists. New work should reuse its deterministic techniques when another surface genuinely needs screenshot baselines rather than adding Chromatic, Percy, or another hosted visual testing dependency.

### Programmable control plane

Tilecast now has:

- user bearer authentication and PATs;
- the remote `tilecast` CLI;
- MCP;
- generic plugin automation;
- `packages/api-client`, generated with `oapi-codegen` from the composed `docs/openapi.yaml`.

This materially changes the API part of the roadmap. The generated Go client is now the precedent:

```text
docs/openapi/core.yaml
        +
plugins/*/api/openapi.yaml
        ↓
      pluginctl
        ↓
docs/openapi.yaml
        ↓
   oapi-codegen
        ↓
packages/api-client
        ↓
      CLI / MCP
```

The Studio should eventually consume the **same HTTP contract** rather than maintain a separate handwritten set of wire types.

### Demo Mode

Demo Mode is already implemented. It runs the real Server, Studio, PostgreSQL schema, migrations, domain services, API, auth/CSRF behavior, pairing flow, and simulated Players.

It has deterministic `basic` and `kitchen-sink` scenarios, fixed IDs, a reset API, and Playwright E2E.

Do not replace it with a mock backend or a second declarative data model.

---

# Architectural principles

## One specification, native implementations

Tilecast is intentionally polyglot. Go, TypeScript, Kotlin, Rust, C, Python, and shell all have legitimate roles.

When behavior must match across languages, prefer:

- one documented semantic contract;
- one machine-readable fixture corpus where examples can define the behavior;
- native implementations in each language;
- native tests consuming the same fixtures.

Do **not** introduce Wasm, FFI, a common embedded interpreter, or a cross-language framework merely to avoid maintaining a small amount of idiomatic code.

## Generate mechanics, not product behavior

Generation is appropriate for:

- OpenAPI client/type bindings;
- extension registries and ledgers;
- portable JSON Schemas;
- presentation-capability constants;
- composed reference artifacts;
- static indexes that a build tool cannot discover itself.

Generation is not appropriate for:

- Go domain services;
- complete server handlers;
- React pages;
- CLI UX;
- MCP workflow design;
- business logic;
- arbitrary schema-driven CRUD screens.

The existing control-plane architecture is the right precedent: the API client is generated, while CLI commands and MCP workflows are hand-designed.

## Keep ownership close to the contract

Do not move every shared fixture into one giant `packages/conformance` directory.

A contract should normally keep its fixtures beside the package that owns the contract:

- Activity contract fixtures: `packages/api-schema/activity`;
- manifest/scheduling fixtures: `packages/manifest-schema`;
- Edge IPC/wire fixtures: `packages/edge-protocol`;
- runtime rendering fixtures: `packages/player-runtime/conformance`;
- Widget visual fixtures: Widgets V2 visual suite.

Only introduce a new shared contract package when the semantic contract does not already have a natural owner.

## One public task interface

Keep **Make** as the contributor-facing task interface.

Other tools may implement work below Make, but contributors should not need to learn a second repository task language.

Do not adopt Nx, Turborepo, Bazel, Pants, or another monorepo build orchestrator. Tilecast is a polyglot product repository, not primarily a Node monorepo, and the current complexity does not justify moving every toolchain behind another build system.

---

# OSS/tooling decisions

These choices were rechecked against the current architecture.

## OpenAPI: keep `pluginctl`, add generic validation around it

`pluginctl` must remain the composer because it understands Tilecast-specific ownership:

- plugin API base paths;
- component collisions;
- plugin automation;
- generated-file freshness;
- extension boundaries.

Do not replace it with Redocly's bundler.

Use [Redocly CLI](https://redocly.com/docs/cli/commands/lint/) only for generic OpenAPI/spec correctness and consistency. Its configuration supports repository-local rules in `redocly.yaml`, including built-in `spec`, `recommended`, and stricter rule sets.

Start with a deliberately small configuration. Tilecast already has custom semantic checks in `pluginctl`; do not duplicate every Tilecast-specific rule in Redocly.

## API compatibility: oasdiff

Use [oasdiff](https://github.com/oasdiff/oasdiff) against the composed contract.

Its `breaking` command is designed for CI and distinguishes definite errors from warnings. The rollout should be:

1. report changes in pull requests;
2. clean the current contract baseline;
3. block definite `ERR` changes;
4. keep warnings reviewable unless experience shows a warning class should be promoted.

The comparison must use the pull request's actual base SHA so stacked PRs compare against their own base.

## Studio API typing: openapi-typescript family

Use:

- [openapi-typescript](https://openapi-ts.dev/) for generated TypeScript `paths`/schema types;
- [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) for the thin browser transport;
- [openapi-react-query](https://openapi-ts.dev/openapi-react-query/) for typed TanStack Query integration where it improves call sites.

This fits the architecture because Studio already uses TanStack Query and because the existing Go control plane has established that **OpenAPI is the supported HTTP transport contract**.

Do not use OpenAPI Generator to create a large generated Studio SDK or hundreds of generated React hooks.

## Studio HTTP testing: MSW

Use [Mock Service Worker](https://mswjs.io/) for Studio tests that should exercise the HTTP boundary without booting Demo Mode.

MSW works at the network API boundary rather than replacing `fetch` with application-specific mocks, so the same handlers can exercise the real typed browser transport.

Do not auto-generate a complete mock server from OpenAPI. Explicit test handlers remain easier to understand and let each test describe the behavior it cares about.

## Toolchains: mise below Make

Use [mise](https://mise.jdx.dev/) for version selection/bootstrap only.

It should pin the tools for which a contributor reasonably expects the repository to provide a version:

- Node;
- Go;
- Rust/rustup;
- Java.

Keep platform-heavy dependencies such as Docker, the Android SDK, WPE build images, and FFmpeg in `make doctor` checks/documentation rather than pretending mise can make every host identical.

## API property testing: Schemathesis, later

Use [Schemathesis](https://schemathesis.io/) only after response schemas and authentication metadata are complete enough to produce useful failures.

Demo Mode is the correct target because it is disposable and uses the real API.

Start with safe operations and make the job informational or API-change-only before considering it a required check.

---

# Workstream A: unify generation and repository checks

This should be first because the recent extension/control-plane work has created several good generators that the root commands do not yet consistently orchestrate.

## Current gaps

At the current baseline:

- `extensions:generate` already composes Plugin, Widget, and Data Source generation;
- `extensions:check` already checks all three extension systems;
- `packages/api-client` has a `go:generate` directive for `oapi-codegen`;
- root `make check` still calls Plugin and Widget checks separately and does not use `extensions:check`;
- the Data Source Go module is not treated consistently by the root Go check list;
- API-client generation freshness is not a first-class root check;
- expensive Edge/runtime/visual/E2E checks are still separate, which is correct, but there is no clear "everything" command.

## Build

Add:

```sh
make generate
make generated-check
make check-changed
make check-all
```

### `make generate`

Order matters:

```text
1. npm run extensions:generate
      ↓
   composed docs/openapi.yaml is current
2. cd packages/api-client && go generate ./...
      ↓
   generated Go API client is current
3. generate TypeScript OpenAPI types
      ↓
   Studio contract bindings are current
4. generate presentation-capability bindings, once that workstream lands
```

The OpenAPI consumers must run **after** extension generation because plugin fragments are part of the canonical document.

### `make generated-check`

Do not maintain a second implementation of every generator.

Run the real generators and fail when the working tree changes. In CI this can be a fresh checkout followed by:

```sh
make generate
git diff --exit-code -- .
```

If local use should not modify a contributor's dirty tree, add a small wrapper that refuses to run the check when tracked generated files are already dirty, or performs the check in a temporary worktree. Keep the generator implementations themselves single-source.

### `make check`

Change the existing fast/default check to use the aggregate extension contract:

```text
extensions:check
format/lint
Dashboard unit tests
Server + first-party Go modules
packages/api-client tests
CLI tests
helper tests
Android unit/lint
docs checks
generated freshness for inexpensive generated artifacts
```

Do not silently omit `data-sources` simply because it became a separate module later than Plugins and Widgets.

### `make check-all`

Make the expensive boundary explicit rather than hiding it inside normal development:

```text
make check
+ Linux Player/runtime build + tests
+ Edge fmt/clippy/unit tests
+ Player Runtime Electron/WPE conformance where the Edge image is available
+ Widget visual regression
+ Demo Mode Playwright E2E
+ container build/validation
```

A contributor should know when a command requires Docker, the Edge image, browsers, or Android tooling.

## Acceptance criteria

- every committed generated artifact has one documented generator;
- one root command regenerates all generated artifacts in dependency order;
- CI proves generated files are fresh;
- `make check` no longer misses a first-party extension module;
- `make check-all` is the documented full local validation path.

---

# Workstream B: finish making OpenAPI an executable source of truth

The control-plane work already did much of the hard architectural work. The remaining problem is **contract completeness**.

A recent CLI bug was possible because code and tests agreed on a screen-list shape that the real Server did not return. That is exactly the class of error a complete generated contract should make difficult.

## B1. Tighten the existing `pluginctl` conformance checks

Do not create a parallel Tilecast OpenAPI checker.

Extend the current derived-conformance code that already checks:

- duplicate `operationId` values;
- parameter schemas;
- JSON request body schemas;
- response documentation;
- auth evidence;
- dangling references;
- plugin operation IDs;
- automation exclusions.

The current compatibility bridge intentionally skips some operations without an `operationId` or description. That was useful while the programmable control plane was being built, but it should not be the permanent state.

Move toward this rule:

> Every supported `/api/v1` HTTP operation has a stable `operationId`, description, security declaration, typed request where applicable, and typed response body where applicable.

Browser-only or non-automatable operations still belong in the HTTP contract. "Not exposed through CLI/MCP" is an automation concern, not a reason for the API response to remain untyped.

Keep only a tiny explicit exception list for routes that are genuinely outside the OpenAPI contract.

## B2. Add Server route ↔ OpenAPI parity

Add a Go integration test that builds the production Chi router, including bundled plugin routes, and walks it with `chi.Walk`.

Normalize each route into:

```text
METHOD /api/v1/path/{parameter}
```

Parse the composed `docs/openapi.yaml` and collect the same keys.

Fail when:

- a registered `/api/v1` route is absent from OpenAPI;
- OpenAPI describes an operation the built Server does not register.

Keep non-`/api/v1` health/static transports out of this comparison.

If a tiny number of unusual API transports cannot be represented cleanly, use a named, documented allowlist with tests that fail when an entry becomes stale.

Do not generate the Go handlers from OpenAPI. The test gives Tilecast the benefit of executable parity without replacing the existing Chi/domain architecture.

## B3. Add Redocly as the generic standards layer

Add a pinned `@redocly/cli` development dependency and root `redocly.yaml`.

Start with `recommended` or `spec` plus a deliberately selected set of errors. Do not immediately turn every style warning into a merge blocker.

The division of responsibility should be:

```text
pluginctl
  Tilecast ownership and semantic conventions

Redocly
  generic OpenAPI structure/spec/reference correctness

route parity test
  actual Server surface matches the document

oasdiff
  compatibility against the previous document
```

## B4. Add API compatibility CI

For a pull request:

```sh
git show "$BASE_SHA:docs/openapi.yaml" > "$RUNNER_TEMP/openapi-base.yaml"
oasdiff breaking --fail-on ERR   "$RUNNER_TEMP/openapi-base.yaml"   docs/openapi.yaml
```

During initial rollout, report without failing if the baseline has too much noise.

Once the contract is trustworthy, a definite breaking change should require an explicit API/version decision rather than slipping through as an incidental refactor.

## B5. Make generated Go client freshness explicit

`packages/api-client` is now a first-class consumer of the public contract.

Add it to the generation/freshness path and add tests that ensure its generated layer is reproducible from the committed `docs/openapi.yaml`.

The Go client remains the transport layer for CLI/MCP. Do not move CLI names, prompts, tables, risk classes, or workflow semantics into OpenAPI.

---

# Workstream C: give Studio the same API contract

The Dashboard still has a large handwritten `src/api/types.ts` and `src/api/client.ts`, including its own envelope/error transport.

The goal is not to delete those files in one rewrite. The goal is to make new and migrated domains derive their **wire contract** from the same OpenAPI used by the Go client.

## C1. Turn `@tilecast/api-schema` into the TypeScript contract package

Keep the existing Activity fixtures in the package.

Add generated OpenAPI types, for example:

```text
packages/api-schema/
  package.json
  activity/
    contract-v2-fixtures.json
  generated/
    openapi.d.ts
  README.md
```

Generate from **composed** `docs/openapi.yaml` with `openapi-typescript`.

Commit the generated declaration so:

- editor support works immediately after checkout;
- API changes have reviewable generated diffs;
- CI can prove freshness.

Do not hand-edit generated types.

## C2. Add one typed browser transport

Create a small transport around `openapi-fetch`.

It should own browser transport mechanics once:

- same-origin credentials;
- Tilecast's response/error envelope handling;
- `ApiError`;
- CSRF injection for session-backed unsafe requests;
- abort signals;
- empty/204 responses;
- non-JSON reverse-proxy failures;
- network errors.

Do not hide domain behavior here.

Keep normalization functions that intentionally support old/mixed Server responses until the compatibility window no longer needs them. A generated wire type does not automatically make compatibility normalization obsolete.

## C3. Add typed TanStack Query integration

Use `openapi-react-query` because Studio already uses TanStack Query.

Prefer small domain modules over literal route strings scattered through components:

```text
apps/dashboard/src/api/
  transport.ts
  errors.ts
  query.ts
  domains/
    screens.ts
    content.ts
    layouts.ts
    settings.ts
    ...
```

The generated layer knows HTTP paths and payloads. The handwritten domain layer may still own:

- query-key grouping conventions;
- normalization;
- optimistic update behavior;
- invalidation policy;
- convenient view-facing return types.

Do not generate every React hook.

## C4. Migrate incrementally

For each domain:

1. make its OpenAPI responses complete;
2. regenerate Go + TypeScript contract bindings;
3. migrate transport calls;
4. migrate query/mutation calls;
5. retain any real compatibility normalizers;
6. delete only the handwritten wire types that are now redundant.

Good early slices are domains with ordinary JSON CRUD/list semantics. Leave unusual streaming/download/security-ceremony calls until the base path is proven.

The end state is:

- `src/api/types.ts` contains only genuine UI/view models or disappears naturally;
- normal JSON API calls do not define a second wire contract in TypeScript;
- exceptional binary/streaming transports remain explicit.

---

# Workstream D: standardize Studio API tests without replacing real E2E

Adopt MSW for new or migrated tests that need HTTP behavior.

Provide a small helper layer for Tilecast conventions:

- `data` envelope;
- standard error envelope;
- auth/CSRF failures;
- paginated list responses;
- delayed requests;
- network failure.

Type fixture builders with generated OpenAPI types where practical.

Do **not** generate a complete mock backend from the API contract. Tests should declare behavior explicitly.

The test ladder should be:

```text
pure function/component logic
    Vitest

Studio + HTTP boundary
    Vitest + MSW

Widget rendering appearance
    existing Storybook + Playwright visual suite

real Studio/Server/Postgres workflows
    existing Demo Mode + Playwright

shared display-runtime semantics/visuals
    existing Player Runtime Electron/WPE conformance
```

This avoids duplicating responsibilities across test systems.

## Reuse the existing visual pattern

When a stable Studio surface genuinely needs screenshot regression, use the same principles the Widgets V2 suite already established:

- Linux Chromium baseline;
- deterministic data from Demo Mode;
- reduced motion;
- fixed viewport;
- fixed locale/timezone where relevant;
- hide caret and other unstable browser UI;
- screenshot only stable surfaces;
- retain diff artifacts on failure.

Do not blanket-snapshot every Studio page. Visual baselines should cover high-value stable shells/editors where pixel changes are meaningful.

---

# Workstream E: organize cross-language conformance without a junk drawer

The original roadmap proposed moving all shared fixtures into `packages/conformance`. Do **not** do that.

Tilecast now has multiple mature, well-owned conformance systems. Preserve them.

## Existing contract owners

Keep:

- Activity event contract → `packages/api-schema/activity`;
- schedule/manifest semantics → `packages/manifest-schema`;
- Edge IPC/media/update wire formats → `packages/edge-protocol`;
- shared renderer behavior → `packages/player-runtime/conformance`;
- Widget runtime appearance → `widgets/visual`.

Add a short `docs/conformance.md` inventory explaining which contract owns which fixtures and how to run each suite.

## Add `packages/player-contracts` only for currently ownerless player semantics

Some behavior is duplicated across Players but has no neutral contract owner.

A small package is justified for examples such as:

```text
packages/player-contracts/
  README.md
  server-url-policy/
    v1.json
  cache-identity/
    v1.json
  configuration-acceptance/
    v1.json
  command-lifecycle/
    v1.json
```

Do not move schedule or runtime fixtures into this package merely for symmetry.

### First candidate: Server URL policy

Today Android, Electron, and Edge independently implement the same Player URL-security policy. Put the agreed cases in one versioned fixture file and make all three native tests consume it.

Only include the CLI's URL handling if its product policy is intentionally identical. A remote operator CLI and an enrolled signage Player are different trust contexts; do not force them together merely because both parse URLs.

### Other candidates

Add a neutral fixture set only when there are at least two implementations that are supposed to agree:

- cache identity derivation;
- configuration revision acceptance/rejection;
- command retry/crash semantics;
- manifest compatibility decisions not already owned by `manifest-schema`;
- presentation selection/precedence not already covered by schedule/runtime fixtures.

## Root command

Add:

```sh
make conformance
```

It delegates to the native suites. It does not implement a new universal runner.

A useful output is a small matrix of contracts and participating implementations, but the authoritative pass/fail remains each language's normal test framework.

---

# Workstream F: remove drift from declarative presentation capabilities

The original roadmap proposed a generic Tilecast capability registry. That is now too broad and would duplicate systems that already exist.

## What is already generated

Widgets V2 already does the right thing:

```text
tilecast.widget.json
      ↓
   widgetctl
      ↓
packages/player-runtime/src/widgets/capabilities.gen.ts
apps/edge/tilecastd/src/widget_capabilities.rs
```

Do not replace this.

## What is still duplicated

The older declarative presentation vocabulary is still repeated in places such as:

- Server content-definition validation;
- Android Player presentation support;
- Electron/reference Player capability reporting;
- Edge's `NATIVE_CAPABILITIES`.

Examples include:

```text
layout.surface
layout.row
content.text
content.icon
collection.repeat
binding.core
format.typed
selection.temporal
playback.auto_skip
environment.time
web.remote
```

This is the actual registry problem.

## Put the vocabulary with the presentation/manifest contract

Prefer a neutral source under `packages/manifest-schema`, for example:

```text
packages/manifest-schema/
  presentation-capabilities-v1.json
```

The file should describe only the presentation capability vocabulary and its contract versions/categories.

Generate the mechanical constants/maps needed by:

- Server Go validation;
- Player Runtime/legacy Electron TypeScript;
- Android Kotlin;
- Edge Rust.

If a platform intentionally supports a lower version or subset, keep the **support profile** platform-owned while importing generated IDs. Do not lie by generating support a platform does not implement.

Keep separate:

- Plugin API declaration capabilities;
- OAuth/API scopes;
- Forms authorization capabilities;
- Player Runtime host capabilities such as `remoteWeb`;
- hardware/provider-specific diagnostic capability objects.

They are different contracts.

## Acceptance criteria

Adding or renaming a declarative presentation capability should not require searching the repository for string literals.

A capability change should be:

1. update the neutral presentation vocabulary;
2. run `make generate`;
3. implement/support it in the relevant Players;
4. update conformance fixtures/tests.

---

# Workstream G: replace CI path heuristics with a repository-owned affected graph

This has become more urgent after the CLI, API client, Widgets, Data Sources, Edge, and extension composition landed.

The current PR workflow still contains a handwritten shell classifier. It knows about many paths, but the dependency graph is now large enough that omissions are easy.

For example, a Data Source module can affect the Server catalog, Studio, container build, docs, extension checks, and E2E. A Widget can affect the runtime, Edge's generated capability list, Server, Studio, docs, visual tests, and container.

## Build

Add:

```text
tools/areas.json
scripts/affected.mjs
scripts/affected.test.mjs
```

Model first-class areas such as:

```text
server
cli
api-client
studio
android
electron
player-runtime
edge
plugins
widgets
data-sources
extensions
docs
container
e2e
widget-visual
```

Each area owns:

- source globs;
- downstream area dependencies;
- one or more validation command names.

The script:

1. reads changed paths;
2. matches direct owners;
3. computes the transitive downstream closure;
4. outputs JSON and, when requested, GitHub Actions outputs.

GitHub Actions still owns jobs, service containers, permissions, and caches. The script only answers **what is affected**.

Use the same implementation for:

```sh
make check-changed
```

and PR validation.

## Test the classifier

This is infrastructure code and should have fixtures.

Examples:

```text
packages/player-runtime/** → player-runtime + electron + edge + widgets/conformance as appropriate
widgets/**                → widgets + studio + server + electron + edge + container + docs + visual
data-sources/**           → data-sources + extensions + studio + server + container + docs + e2e
packages/api-client/**    → api-client + cli
docs/openapi/**           → extensions/openapi + api-client + studio API generation + docs
```

A regression in affected-area logic must be caught by tests rather than discovered because a PR skipped CI.

## Do not add a monorepo framework

This graph is small, explicit Tilecast metadata. It should remain understandable from one JSON file and one script.

---

# Workstream H: contributor bootstrap, toolchain consistency, and `make doctor`

## Current drift to resolve

The current repository demonstrates why this is useful:

- PR Node jobs use Node 22;
- the dashboard Docker build uses Node 26;
- Node 24 is the current LTS line;
- `go.work`/Server/CLI declare Go 1.25.7 while the Server Docker stage currently builds with Go 1.26;
- Edge already pins Rust 1.98.0;
- Android CI already clearly pins Java 17.

Not every newer compiler is wrong, but the policy is implicit.

## Decide and document canonical toolchains

For Node, prefer a current LTS release for CI, local development, and production builds unless a concrete dependency requires otherwise. At this baseline that means evaluating Node 24 LTS and moving CI/Docker together if the full suite passes.

For Go, make a deliberate decision instead of leaving `go.work` and Docker on different declared generations:

- either build with the declared repository toolchain;
- or intentionally adopt the newer Go toolchain and update the repository declarations/tests together.

Do not silently normalize Go versions as part of an unrelated refactor.

Rust continues to use the existing `rust-toolchain.toml`.

Java remains 17 until Android/AGP requirements change.

## Add mise

A root `mise.toml` should pin only the normal language toolchains.

Do not move Make targets into mise tasks. The user-facing commands remain:

```sh
mise install
make bootstrap
make doctor
make check-changed
```

## Add `make doctor`

Doctor should be a readable diagnostic, not an installer.

Check:

- Node/npm;
- Go;
- Rust/rustup;
- Java;
- Docker/Compose;
- FFmpeg/FFprobe where Server media work is affected;
- Android SDK/Gradle prerequisites when Android is affected;
- the Tilecast Edge dev image when Edge Linux/conformance work is affected;
- browser availability when visual/E2E work is requested.

Where practical, accept an area:

```sh
make doctor AREA=docs
make doctor AREA=edge
```

A docs-only contributor should not be told the Android SDK is mandatory.

---

# Workstream I: evolve Demo Mode instead of rebuilding it

Demo Mode's architecture is already correct.

Keep:

- real database and migrations;
- real Server and Studio;
- real domain services;
- real auth and CSRF;
- real API;
- pairing through the real protocol;
- deterministic seed IDs;
- simulated Players;
- Playwright against the actual stack;
- the rule that scenarios seed through domain services, never SQL.

## Generalize the Go builder only where repeated setup exists

Do not invent YAML describing the whole Tilecast data model.

Prefer composable Go helpers and player profiles inside the existing demo package.

Examples of reusable player profiles, if tests need them repeatedly:

```text
modern Android
legacy Android
Electron
Edge
limited presentation capabilities
stale
offline
command failure
manifest incompatibility
update failure
```

## Add scenarios from real testing needs

Keep `basic` and `kitchen-sink`.

Reasonable focused additions are:

- `empty`: first-run/empty-state UI;
- `failure-lab`: intentional failed/unavailable/stale states;
- `compatibility`: mixed Player generations/capabilities;
- `plugin-dev`: installed/uninstalled extension states.

Treat `large-library` as a manual/performance scenario rather than a default E2E fixture unless it proves necessary.

Avoid dozens of scenarios that become another product matrix to maintain.

## Give E2E symbolic handles

Tests should not need to know UUID constants or reset mechanics.

Extend the existing E2E support layer toward:

```ts
await demo.reset(api, "failure-lab");
const cafeteria = demo.screen("cafeteria-east");
```

The fixed IDs remain useful internally; the test API exposes stable names.

## Parallelism later, only if E2E becomes a bottleneck

The current E2E suite serializes because every test resets one installation.

Do not complicate Demo Mode preemptively.

If runtime becomes material, parallelize by running isolated Demo stacks per worker/port rather than weakening reset isolation or sharing mutable scenarios concurrently.

---

# Workstream J: selective API property testing

Do this only after Workstream B substantially completes the response schemas.

Use Schemathesis against a disposable Demo Mode stack.

Start with a curated operation set:

- public identity;
- authenticated GET/HEAD reads;
- ordinary list/detail endpoints;
- simple validation endpoints.

Then consider stateful workflows where setup is deterministic.

Initially run it:

- on a schedule;
- manually;
- or when OpenAPI/Server API paths change.

Do not make a noisy fuzzer block every CSS/docs pull request.

Promote it to required CI only for operation classes that have demonstrated stable signal.

---

# Workstream K: reconcile contributor and architecture documentation

Recent implementation moved faster than some repository guidance.

As the work above lands, update:

- `AGENTS.md` package descriptions that still call implemented contract packages "reserved";
- developer docs for the generated API client;
- extension contribution docs to point at `extensions:check` / `extensions:generate`;
- a new `docs/conformance.md` inventory;
- the documented local validation tiers: `check`, `check-changed`, `check-all`;
- the generated-file rule: never edit generated output directly;
- the affected-area/toolchain bootstrap workflow.

Documentation must describe the actual repository commands, not an aspirational second workflow.

---

# Revised implementation order

The original roadmap had fourteen PRs because several foundations did not yet exist. The merged work lets this be smaller and better targeted.

Use roughly this sequence:

| PR | Scope | Why now |
| --- | --- | --- |
| 1 | **Generation/check hygiene**: `make generate`, `generated-check`, use `extensions:check`, include Data Sources and `packages/api-client`, document validation tiers | Fixes real omissions immediately and creates the base for later generators |
| 2 | **Affected-area graph**: `tools/areas.json`, tested `affected.mjs`, `make check-changed`, migrate PR classifier | Every later workstream benefits from correct selective CI |
| 3 | **OpenAPI completeness**: tighten existing `pluginctl` derived conformance, complete weak response schemas, add Chi route parity | Makes the existing Go client and future TS client trustworthy |
| 4 | **OpenAPI generic/compat CI**: Redocly + oasdiff | Adds standards and backward-compat checks after the contract baseline is sound |
| 5 | **Studio API foundation**: generated `@tilecast/api-schema` types + `openapi-fetch` transport | Reuses the same contract as CLI/MCP |
| 6 | **Studio query/test migration**: `openapi-react-query`, MSW helpers, migrate representative domains | Proves ergonomics before broad conversion |
| 7 | **Remaining Studio API migration** in reviewable domain slices | Removes duplicate wire types without a flag-day rewrite |
| 8 | **Conformance inventory + ownerless Player contracts**: `docs/conformance.md`, URL policy first, root `make conformance` | Builds on the existing mature conformance systems rather than replacing them |
| 9 | **Declarative presentation-capability source** under `manifest-schema` + generated language bindings | Removes a concrete repeated string/version vocabulary; leaves Widget capabilities on `widgetctl` |
| 10 | **Toolchain/bootstrap**: mise, `make doctor`, resolve Node/Go build-version policy | Contributor quality-of-life after the task graph is explicit |
| 11 | **Demo Mode focused scenarios/profiles + symbolic E2E handles** | Makes full-stack tests easier to author and reuse |
| 12 | **Schemathesis pilot** | Only useful after API schemas are complete enough |

These do not need to be a rigid twelve-PR stack. A small phase may combine with an adjacent one when review remains clear. Do not create PRs merely to satisfy the numbering.

---

# Suggested command model after completion

```sh
# Install/pin language toolchains.
mise install

# Install repository dependencies.
make bootstrap

# Explain what this machine is ready to build.
make doctor

# Regenerate every committed generated artifact.
make generate

# Prove generated artifacts are fresh.
make generated-check

# Fast/default repository validation.
make check

# Run validation required by the current diff.
make check-changed

# Run cross-language semantic parity suites.
make conformance

# Expensive complete validation where prerequisites exist.
make check-all

# Real disposable product stack.
make demo
make e2e
```

Each command should be documented in one place and behave the same locally and in CI.

---

# Definition of done

This roadmap is complete when a contributor can make a cross-cutting feature without repository folklore.

Specifically:

- all supported HTTP operations have a trustworthy composed OpenAPI contract;
- Server routes and OpenAPI cannot silently diverge;
- CLI/MCP Go bindings and Studio TypeScript bindings come from that same contract;
- normal Studio API code no longer copies Server DTOs by hand;
- API breaking changes are visible in PRs;
- generated artifacts have one ordered root generation path;
- changed-file CI decisions come from a tested repository-owned dependency graph;
- shared semantic behavior has fixtures owned by the relevant contract;
- the duplicated declarative presentation-capability vocabulary has one source;
- Widget capabilities continue to come from Widget manifests;
- Widget visual regression and Player Runtime conformance remain the authoritative systems for their domains;
- Demo Mode remains the authoritative real-stack browser/integration environment;
- contributors can discover required toolchains and checks without reading workflow YAML.

---

# Explicit non-goals

This roadmap does **not** propose:

- replacing Make;
- adding Nx, Turborepo, Bazel, or Pants;
- replacing `pluginctl` OpenAPI composition;
- generating Tilecast's Go handlers/domain services from OpenAPI;
- generating CLI UX or MCP workflows from OpenAPI;
- replacing the existing Go `packages/api-client`;
- one universal Player implementation through Wasm or FFI;
- moving every fixture into one generic conformance directory;
- one universal registry for every concept called a capability;
- replacing Widget capability generation already owned by `widgetctl`;
- replacing Demo Mode with mocks or YAML;
- replacing the existing Player Runtime or Widget visual-regression suites;
- a hosted proprietary testing/build dependency.

The intended result is not "more architecture." It is that the architecture Tilecast already has becomes easier to discover, harder to accidentally violate, and cheaper to extend.
