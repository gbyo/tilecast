# Tilecast Generalization and Contributor Architecture Roadmap

Status: proposed. Reconciled with current `main` and the in-flight testing/CI work in PR #739.

This roadmap is intentionally narrow. Tilecast already has the important architectural foundations: Plugin API v1, the programmable control plane, the generated Go API client, the shared Player Runtime, Edge, Widgets V2 infrastructure, declarative Data Source modules, Demo Mode, Player Runtime conformance, Widget visual regression, and—once #739 lands—a tested affected-consumer CI graph plus real-stack Studio visual regression.

The remaining work should make those systems agree through explicit contracts. It should **not** introduce another framework.

Two concurrent projects are explicitly outside this roadmap until they land:

- the remaining Widget → Widgets V2 migration;
- Android → shared renderer / Player Runtime migration.

Do not make generalization work fight either migration. Player-contract cleanup must inspect the final post-migration architecture before changing ownership.

## North star

```text
one authoritative contract
        ↓
generated mechanical bindings where useful
        ↓
handwritten product/domain behavior
        ↓
native tests and shared conformance
```

The goal is that a contributor does not need repository folklore to know which copies of an API response, capability identifier, or cross-player rule must change together.

## What is already solved

Do not rebuild these systems.

### Extensions

Keep the existing extension model:

- Plugins: `tilecast.plugin.json` + `pluginctl`;
- Widgets V2: `tilecast.widget.json` + `widgetctl`;
- declarative Data Sources: `tilecast.datasource.json` + `datactl`;
- `npm run extensions:check`;
- `npm run extensions:generate`.

Plugin API v1 stays frozen. Core code must not learn plugin identifiers merely to make tooling easier.

### API control plane

Keep the existing public API ownership:

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

The Go Server stays handwritten Chi + domain services. The CLI and MCP stay handwritten user-facing surfaces over the generated transport client.

### Display/runtime conformance

Keep the existing fixture owners:

- Activity contract → `packages/api-schema/activity`;
- manifest/schedule contracts → `packages/manifest-schema`;
- Edge wire formats → `packages/edge-protocol`;
- shared renderer semantics → `packages/player-runtime/conformance`;
- Widget visual behavior → `widgets/visual`.

Do not move these into a generic `packages/conformance` junk drawer.

### Visual and real-stack testing

PR #739 is the testing/CI architecture to build on. It already adds:

- a tested repository-owned affected-consumer graph in `scripts/ci/affected.mjs`;
- shared PR/main subsystem validation;
- selected Edge validation instead of the whole matrix on every change;
- real Demo Mode authoring journeys;
- Linux Chromium Studio screenshot regression;
- Linux Chromium Widget screenshot authority;
- reviewed baselines and diff artifacts.

After #739 lands, **do not add another affected-area system or another visual testing service**. Extend those systems only when a new contract has a real consumer.

### Demo Mode

Demo Mode remains the authoritative browser/integration environment:

- real Server;
- real Studio;
- real PostgreSQL and migrations;
- real domain services;
- real auth/CSRF;
- real API;
- deterministic IDs;
- simulated Players;
- Playwright.

Add new scenarios or helper APIs only when a concrete test needs them. Do not create a second YAML/mock product model.

---

# Decisions confirmed by current research

## OpenAPI composition and validation

Keep `pluginctl` as the composer. It understands Tilecast plugin ownership and generic OpenAPI tools do not.

Add **Redocly CLI** only as the generic OpenAPI/spec/reference layer. Use a repository `redocly.yaml` with a deliberately tuned ruleset. Start from `recommended` or `spec`; do not turn every style preference into a blocking error. Tilecast-specific semantic checks remain in `pluginctl`.

Add **oasdiff** for compatibility checking of the composed contract. Run it against the PR's real base commit so stacked PRs compare correctly. Roll out definite breaking-change enforcement only after the current contract baseline is trustworthy.

Do not generate Go Server handlers. A route/spec parity test around the production Chi router provides the important guarantee without replacing Tilecast's server architecture.

## Studio API client

Use:

- **openapi-typescript** to generate TypeScript wire types from the composed `docs/openapi.yaml`;
- **openapi-fetch** as the low-level typed browser transport.

Do **not** make `openapi-react-query` Tilecast's primary query layer.

Tilecast already has useful semantic TanStack Query keys such as `["screens"]`, `["screens", id]`, `["activity", ...]`, and `["settings"]`. Those keys are an application cache/invalidation contract. Replacing them with generated HTTP method/path/parameter keys would couple cache semantics to transport shape and create unnecessary migration churn.

Keep handwritten domain query/mutation wrappers and semantic keys. Generated code should type the HTTP boundary, not design Studio's cache behavior.

## Studio HTTP tests

Use **MSW** only where a test should exercise the browser HTTP boundary without booting the full product:

- transport/envelope handling;
- CSRF behavior;
- API errors;
- network failures;
- a small number of domain integration tests.

Do not create a generated mock Server and do not mass-convert component tests. PR #739's Demo Mode journeys and visual tests remain the real-stack regression net.

## Generation

Use the real generators and check freshness by regeneration + diff. Do not implement a second "checker" that independently reconstructs generated output.

Generation order matters:

```text
extensions:generate
    ↓
composed docs/openapi.yaml
    ↓
Go API client generation
    ↓
TypeScript OpenAPI types
    ↓
later: presentation capability bindings
```

## Repository tooling

Keep **Make** as the public command surface.

A root **mise** configuration is useful for language tool versions, but mise must not become a second task runner. Heavy/platform prerequisites such as Docker, Android SDK, WPE/Edge images, FFmpeg, and browsers belong in diagnostics/documentation rather than being hidden behind mise.

The current version drift should be resolved deliberately, not incidentally:

- Node versions differ between CI and Docker;
- repository Go modules declare one version while the Server Docker builder uses another;
- Rust already has an explicit toolchain file;
- Java/Android already has an explicit CI baseline.

## Property testing

**Schemathesis** is useful only after OpenAPI response schemas are complete enough to be meaningful.

If introduced, start as a nonblocking/manual or API-change-only Demo Mode pilot over safe/read-heavy operations. Do not add a permanent noisy fuzz job merely because a tool exists.

---

# Remaining implementation: three PRs

Use **at most three PRs** for this roadmap. Prefer multiple coherent commits inside a PR over micro-PRs.

## PR 1 — Contracts and contributor foundation

This PR makes the public API and generated artifacts trustworthy and gives contributors one obvious local workflow.

### Generation/check hygiene

Add root commands:

```sh
make generate
make generated-check
make doctor
```

Do **not** reimplement `check-changed` if PR #739 has landed; use its `scripts/ci/affected.mjs` architecture.

`make generate` should:

1. run `npm run extensions:generate`;
2. regenerate `packages/api-client` from the newly composed OpenAPI;
3. generate the TypeScript OpenAPI contract in `@tilecast/api-schema`;
4. later pick up additional small generated contract bindings automatically.

`make generated-check` should execute the real generation path and fail on a diff.

Update `make check` so first-party extension modules are not accidentally omitted. In particular, the Data Source module and generated API client must have an explicit validation path.

Do not make expensive Edge/WPE/visual/full-browser checks part of the default fast check; #739's selected CI and documented deep checks remain authoritative.

### Make OpenAPI executable

Tighten the existing `pluginctl` derived-conformance checks rather than building a second Tilecast linter.

Move toward this invariant:

> Every supported ordinary `/api/v1` HTTP operation has a stable `operationId`, description, declared security, typed parameters/body where applicable, and typed success response body where applicable.

Complete weak response schemas that currently force callers such as the CLI to decode `map[string]any` for stable public DTOs.

Do not force truly dynamic settings/value bags to pretend they are closed types.

Add a production-router ↔ composed-OpenAPI parity test using `chi.Walk`:

- compare HTTP method + normalized path;
- include bundled plugin routes;
- fail on undocumented `/api/v1` routes;
- fail on described operations the built Server does not register;
- keep health/static/non-API transports out;
- use only a tiny named exception list if a transport genuinely cannot belong to OpenAPI;
- test that any exception is still live so the list cannot rot.

Add Redocly with a small, reviewed `redocly.yaml`. Do not duplicate Tilecast-specific `pluginctl` rules.

Add oasdiff to the existing CI selection model after #739. Only API/OpenAPI-affecting changes should run it. Compare against the actual PR base. If the current spec is clean enough, fail definite breaking changes; otherwise land a clearly documented report-only baseline first and make blocking the next small cleanup, not a giant allowlist.

### TypeScript contract package

Turn `@tilecast/api-schema` into the TypeScript home of the public HTTP wire contract while preserving its Activity fixtures.

Generate and commit something like:

```text
packages/api-schema/
  activity/
  generated/
    openapi.d.ts
  package.json
  README.md
```

Generate from the **composed** `docs/openapi.yaml`, never from core alone.

Expose the generated types cleanly to Studio. No hand edits to generated files.

### Contributor/toolchain polish

Add `mise.toml` for normal language runtimes only, keeping Make as the task interface.

Add `make doctor` as a diagnostic, not an installer. It should report relevant required/optional prerequisites and support an area when useful.

Resolve Node/Go build-version drift deliberately after validating the repository on the chosen versions. Do not silently upgrade language versions merely to make numbers match.

Update stale contributor/package descriptions in `AGENTS.md` and public developer docs while touching this architecture.

### PR 1 must not touch

- the active Widget V2 migration except generated contract consumers that are unavoidable;
- Android shared-renderer migration;
- Widget/Studio visual architecture from #739;
- `scripts/ci/affected.mjs` except to register a genuinely new contract consumer after #739 lands;
- Player capability ownership.

---

## PR 2 — One typed Studio API boundary

This PR removes the second handwritten HTTP wire contract from Studio without redesigning Studio's cache model.

### Low-level transport

Add `openapi-fetch` over the generated `@tilecast/api-schema` types.

Keep the transport React-independent.

It owns only HTTP mechanics:

- same-origin credentials;
- typed path/query/body/response shapes;
- Tilecast success/error envelope handling;
- the existing `ApiError` behavior;
- abort signals;
- 204/empty responses;
- malformed/non-JSON reverse-proxy failures;
- network errors.

Keep CSRF authority explicit. Mutation/domain functions may continue accepting the current CSRF token and attach it through the typed transport; do not make the transport import AuthProvider or hide account/session state in a singleton.

Preserve the `@tilecast/studio` plugin-facing request contract with a compatibility wrapper over the new transport.

### Preserve semantic TanStack Query keys

Do not use `openapi-react-query` as the cache architecture.

Keep or formalize domain modules such as:

```text
apps/dashboard/src/api/
  transport.ts
  errors.ts
  domains/
    screens.ts
    playlists.ts
    layouts.ts
    activity.ts
    settings.ts
    ...
```

Domain helpers own:

- semantic query keys;
- prefix invalidation;
- compatibility normalization;
- optimistic updates;
- convenient Studio-facing view models.

OpenAPI owns only the HTTP wire contract.

### Migrate normal JSON calls in this one PR

Use domain-by-domain commits inside the PR rather than opening a PR per domain.

Migrate the normal JSON request paths currently duplicating `fetch`/envelope/error behavior, including the independent activity/user/settings/API helpers where their contracts are ordinary JSON.

Keep raw `fetch` only where it is genuinely the correct transport, for example:

- images/blobs;
- MJPEG/streaming;
- downloads/uploads that intentionally need raw streaming semantics;
- browser security ceremonies where Web APIs require special handling.

Do not preserve raw fetch merely because a file historically used it.

Retain compatibility normalizers that intentionally support mixed Server versions. Generated types do not make compatibility policy disappear.

The target end state is:

- no second handwritten stable DTO definition when OpenAPI owns that DTO;
- `src/api/types.ts` contains only genuine Studio/view/compatibility types, or naturally becomes small enough to remove;
- one normal JSON error/envelope implementation;
- plugin Studio calls use the same transport foundation.

### Tests

Add MSW only for the new transport contract and representative domain behavior:

- success envelope;
- API error envelope;
- 204;
- malformed/non-JSON failure;
- network failure;
- CSRF-bearing mutation;
- abort signal.

Do not rebuild the entire test suite around MSW.

Run and preserve #739's real Demo Mode authoring journeys and Studio visual baselines. Those are the regression proof that the transport refactor did not change product behavior.

### Optional Schemathesis pilot

At the end of PR 2, evaluate the now-complete OpenAPI contract with Schemathesis against disposable Demo Mode.

Only commit it if the signal is useful.

If committed:

- keep it nonblocking/manual, scheduled, or API-change-only initially;
- start with safe/read-heavy operations;
- authenticate through an isolated Demo Mode credential;
- never run destructive generated traffic against a non-demo installation;
- document exact reproduction.

If it is noisy because the schema still lacks useful constraints/setup information, document the result and defer it. Do not weaken the API schema just to satisfy the fuzzer.

---

## PR 3 — Player contracts after the renderer migrations land

**Do not start this PR until the separate Android → shared renderer work and the relevant Widget V2 migration are merged.**

Before coding, re-audit the final architecture. Do not assume the pre-migration Android/Player duplication still exists.

The purpose is to remove only the semantic duplication that remains after those migrations.

### Preserve existing owners

Do not move:

- Activity fixtures;
- manifest/schedule fixtures;
- Edge protocol fixtures;
- Player Runtime conformance;
- Widget visual fixtures.

Add `docs/conformance.md` as an inventory if one does not already exist.

### Ownerless multi-player semantics

Create a small neutral contract location only for semantics that still have at least two independent implementations and no existing owner.

The first candidate is Server URL normalization/security policy **if it remains independently implemented** after the Android migration.

Use one versioned fixture corpus and native tests in each implementation.

Other contracts such as cache identity/config revision/command lifecycle should be added only if the post-migration code still duplicates the same rule across independent implementations. Do not create empty architecture for hypothetical future duplication.

### Declarative presentation capability vocabulary

Re-audit the older capability strings after Android joins the shared renderer.

If `layout.*`, `content.*`, `collection.*`, `binding.core`, `format.typed`, `selection.*`, `playback.auto_skip`, `environment.time`, etc. are still repeated across language boundaries, place the **vocabulary** with the presentation/manifest contract, preferably under `packages/manifest-schema`.

Generate identifiers/constants where a language boundary still needs them.

Keep platform support profiles platform-owned. A generated identifier must not imply that every Player supports the same version.

Do not replace `widgetctl`'s existing generated `widget.<type>` capabilities.

Do not merge unrelated concepts merely because they use the word "capability":

- Plugin API capabilities;
- OAuth/API scopes;
- Forms authorization;
- runtime-host capabilities;
- hardware/provider diagnostic capabilities.

### Root conformance command

If useful after the audit, add:

```sh
make conformance
```

It delegates to the existing native suites. It is not a new universal test runner.

---

# Sequencing

The practical order is:

```text
PR #739 lands
      ↓
PR 1 — contracts + generation + contributor foundation
      ↓
PR 2 — Studio typed API migration
      ↓
wait for Widget V2 + Android shared-renderer migrations
      ↓
PR 3 — only the Player duplication that still exists
```

PR 1 and PR 2 may proceed while the Player migrations are underway because they should avoid those files.

If #739 is still open when implementation begins, do not duplicate or overwrite its CI/visual work. Either base the relevant commits after it or keep the first PR conflict-free and rebase once #739 lands.

# Final command model

Do not force every command to exist merely for symmetry. After this work, the useful public surface should be approximately:

```sh
mise install
make bootstrap
make doctor
make generate
make generated-check
make check

# from PR #739 / existing testing docs:
npm run test:ci
make demo
npm run test:e2e
npm run test:visual
npm run widgets:visual

# after PR 3 if it adds real value:
make conformance
```

The affected-consumer graph from #739 remains the CI authority. Do not create a second `make check-changed` classifier if it would just wrap the same logic without improving contributor ergonomics.

# Non-goals

This roadmap does **not** propose:

- more than three implementation PRs;
- Nx, Turborepo, Bazel, Pants, or another repository build framework;
- replacing Make as the contributor task surface;
- replacing `pluginctl` OpenAPI composition;
- generated Go Server handlers or domain services;
- generated CLI UX or MCP workflows;
- replacing the existing Go `packages/api-client`;
- `openapi-react-query` as Tilecast's cache architecture;
- one universal Player implementation through FFI/Wasm;
- a generic conformance fixture junk drawer;
- a universal "capability registry";
- replacing `widgetctl` Widget capability generation;
- redoing #739's affected graph or visual testing;
- a second Demo Mode/mock/YAML backend;
- a hosted visual testing dependency.

The intended result is a smaller architecture, not a larger one: one HTTP contract, one browser transport, existing semantic cache keys, existing native runtime boundaries, and shared fixtures only where independent implementations truly still need to agree.
