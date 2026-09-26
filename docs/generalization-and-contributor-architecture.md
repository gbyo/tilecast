# Tilecast Generalization and Contributor Architecture Roadmap

Status: proposed

This roadmap describes the next cross-cutting architecture work for Tilecast after the in-progress Plugin API and shared Player Runtime/Edge renderer work. The goal is not to introduce a large framework. The goal is to make Tilecast easier to change safely by turning repeated cross-application agreements into explicit contracts, generated bindings, native implementations, and shared conformance tests.

## Goals

Tilecast should make the correct development path obvious:

1. Define or change the contract.
2. Generate language bindings or registries where generation is useful.
3. Implement behavior idiomatically in the owning application.
4. Run shared conformance when multiple implementations must agree.
5. Run only the affected validation locally and in CI.
6. Use Demo Mode for real-system integration and browser testing.

A contributor should not need to know which unrelated files happen to duplicate a wire enum, API response, capability identifier, or protocol rule.

## Principles

### One specification, native implementations

Tilecast is intentionally polyglot: Go, TypeScript, Kotlin, Rust, C, Python, and shell all have legitimate roles.

Do not introduce FFI, Wasm, or a shared runtime merely to avoid duplicating a small algorithm. For cross-language behavior, prefer:

- one documented contract;
- one machine-readable fixture corpus;
- idiomatic implementations in each language;
- native tests in each language against the same fixtures.

### Generate mechanics, not product logic

Generation is appropriate for:

- API wire types;
- capability constants;
- registries;
- composed OpenAPI;
- generated documentation/reference artifacts.

Do not generate Tilecast domain services, React pages, workflow logic, or whole Go HTTP handlers merely because a generator can.

### Keep existing architectural boundaries

This roadmap must not weaken:

- the Go modular-monolith domain boundaries;
- Plugin API host boundaries;
- the shared Player Runtime host contract;
- Android's native implementation;
- Edge's daemon/renderer separation;
- Demo Mode's use of real domain services and APIs.

## OSS decisions

### OpenAPI

Keep Tilecast's own Plugin API OpenAPI composition.

The Plugin API already makes this split:

- `docs/openapi/core.yaml`: core API;
- `plugins/*/api/openapi.yaml`: plugin fragments;
- `pluginctl`: Tilecast-aware composition and plugin-boundary validation;
- `docs/openapi.yaml`: canonical composed API.

Do not replace `pluginctl` composition with a generic bundler. Generic tooling does not understand plugin base-path ownership or Tilecast's plugin boundaries.

Add:

- **Redocly CLI** for OpenAPI linting and reference correctness;
- **openapi-typescript** for generated TypeScript wire types;
- **openapi-fetch** for the small typed Studio HTTP transport;
- **openapi-react-query** for typed TanStack Query integration;
- **oasdiff** for semantic API compatibility checks in pull requests.

Do not migrate the Go server to generated handlers. Tilecast's existing Chi handlers, strict decoding, domain services, authentication, CSRF, and plugin route registration should remain explicit.

### Studio API tests

Use **Mock Service Worker (MSW)** for Studio unit/integration tests that exercise HTTP behavior.

MSW complements, rather than replaces, Demo Mode:

- pure logic: Vitest;
- Studio HTTP integration: Vitest + MSW;
- real full-stack browser behavior: Demo Mode + Playwright.

### Repository tooling

Keep **Make** as the public task interface.

Use **mise** only for polyglot tool installation/version selection and environment setup.

Do not adopt Nx, Turborepo, Bazel, or another repository-wide build framework. Tilecast is not primarily a JavaScript monorepo, and the cost of forcing Go, Kotlin, Rust, C, Docker, and Node into one build graph is not justified.

### API property testing

After the OpenAPI contract is sufficiently complete, evaluate **Schemathesis** against disposable Demo Mode installations.

Start with safe/read-only endpoints and API-change-only or scheduled CI. Do not make broad stateful fuzzing a required check until signal quality is proven.

## Phase 0: finish the boundaries already in flight

Before large API and Player contract refactors, finish the current architectural work:

- Plugin API v1 through M7, including Forms generalization and removal of remaining plugin-specific host special cases;
- shared Player Runtime/Edge renderer work that is currently defining the final host/runtime boundary.

Work that does not overlap these boundaries may begin earlier:

- this architecture document;
- root generation/check command cleanup;
- affected-area tooling;
- `make doctor`;
- toolchain version normalization.

## Phase 1: make OpenAPI executable

### 1.1 Lint the composed contract

Add Redocly configuration and validate `docs/openapi.yaml`.

Require normal JSON operations to define, where applicable:

- unique `operationId`;
- request schema;
- success response schema;
- standard error responses;
- security behavior;
- useful descriptions.

Existing incomplete operations should be fixed incrementally before their Studio consumers migrate to generated types.

### 1.2 Verify server route parity

Add a Go test that:

1. builds the production Chi router;
2. walks registered routes with `chi.Walk`;
3. parses the composed OpenAPI document;
4. compares method + path pairs.

Fail when:

- a public API route is registered but undocumented;
- an OpenAPI operation has no server route;
- operation IDs are duplicated.

Maintain only a small explicit allowlist for legitimate non-OpenAPI transport endpoints.

This is preferred over generated Go handlers because it preserves Tilecast's server architecture while making the API specification enforceable.

### 1.3 Detect breaking API changes

Compare the pull request's composed OpenAPI to the base revision with `oasdiff`.

Roll out in two steps:

1. report compatibility findings without blocking;
2. after the existing specification is clean enough, block definite breaking changes.

Intentional breaking changes must be explicit release decisions rather than accidental drift.

## Phase 2: make `@tilecast/api-schema` useful

Turn `packages/api-schema` into the home of generated public API TypeScript contracts while retaining existing shared fixtures such as Activity.

Suggested structure:

```text
packages/api-schema/
  package.json
  README.md
  generated/
    openapi.d.ts
  activity/
    ...
  test/
```

Generate `generated/openapi.d.ts` from `docs/openapi.yaml` with `openapi-typescript`.

Commit generated output and fail CI when regeneration produces a diff. This gives fresh checkouts editor support and makes API changes reviewable.

Introduce root commands:

```sh
make generate
make generated-check
```

These become the umbrella for:

- Plugin API generated files;
- composed OpenAPI;
- API TypeScript bindings;
- capability bindings;
- future small generated registries.

## Phase 3: replace handwritten Studio transport duplication

Create one typed transport layer around `openapi-fetch`.

It owns:

- same-origin credentials;
- CSRF attachment;
- standard Tilecast error-envelope decoding;
- `ApiError`;
- network errors;
- proxy/non-JSON failure handling;
- 204 responses;
- abort signals.

Use `openapi-react-query` for typed TanStack Query integration.

Keep semantic domain modules above the transport, for example:

```text
apps/dashboard/src/api/
  transport.ts
  errors.ts
  query.ts
  domains/
    screens.ts
    layouts.ts
    activity.ts
```

Components should normally consume domain query/mutation helpers rather than literal HTTP paths.

Do not generate hundreds of React hook files. Generated wire types and a thin typed query layer are enough.

Migrate one domain at a time. For each domain:

1. complete the relevant OpenAPI request/response definitions;
2. regenerate types;
3. move HTTP calls to the typed transport;
4. move query/mutation calls to the typed query layer;
5. delete duplicate handwritten wire types and request wrappers.

The long-term goal is for `apps/dashboard/src/api/types.ts` to contain only genuine Studio view models, if any, rather than copies of server DTOs.

Direct `fetch()` should remain only where the response is intentionally not a normal JSON API object, such as image bytes or streaming transports.

## Phase 4: standardize Studio HTTP tests

Adopt MSW for new Studio tests that need HTTP behavior.

Provide shared test helpers for:

- standard success envelopes;
- standard Tilecast errors;
- CSRF failures;
- paginated responses;
- delayed/network failures.

Retire one-off `stubFetch()` helpers as touched.

Do not convert pure unit tests to MSW when no HTTP boundary is involved.

## Phase 5: create the Tilecast conformance system

Create a language-neutral package:

```text
packages/conformance/
  README.md
  catalog.json
  schema/
    fixture-set-v1.schema.json
  fixtures/
    server-url-policy/
    scheduling/
    activity-events/
    configuration/
    command-lifecycle/
    cache-identity/
    presentation-precedence/
```

Fixture files contain inputs and expected semantic outputs, not executable code.

Each application uses its native test framework to consume the same fixtures.

Initial candidates should reuse or migrate existing parity work:

- server URL normalization/security policy;
- schedule resolution;
- Activity event/session semantics;
- manifest compatibility behavior;
- configuration revision acceptance;
- cache identity;
- persistent command crash/retry behavior;
- presentation precedence.

Existing Activity and scheduling fixtures should be preserved semantically rather than replaced by new independent test cases.

Add:

```sh
make conformance
make conformance AREA=players
```

The root command runs native test suites and reports a contract/platform matrix. It does not reimplement the product behavior.

## Phase 6: canonical capability registry

Start this phase only after the shared Player Runtime/Edge host contract stabilizes.

Create a machine-readable registry for externally exchanged Tilecast capability identifiers:

```text
packages/capability-registry/
  capabilities.json
  schema.json
  README.md
```

The registry should cover wire-visible capabilities used by:

- Player ↔ Server negotiation;
- manifest requirements;
- presentation/runtime features;
- hardware features;
- display/control capability identifiers where represented as wire IDs.

Do not combine unrelated concepts that merely use the word capability, such as Forms authorization permissions.

Validate the registry with JSON Schema/Ajv and generate native constants for:

- TypeScript;
- Go;
- Kotlin;
- Rust.

Generated files must clearly identify their source and must not be edited manually.

Add checks that discourage introducing new raw capability literals outside the registry, generated output, fixtures, or tests that intentionally exercise unknown capabilities.

The contributor workflow for a new capability becomes:

1. add the registry entry;
2. run `make generate`;
3. implement it where relevant;
4. add or update conformance cases.

## Phase 7: make the repository understand affected areas

Move pull-request path classification out of GitHub Actions shell into repository-owned data.

Add:

```text
tools/areas.json
scripts/affected.mjs
```

Model areas such as:

- Studio;
- Server;
- Android Player;
- Electron Linux Player;
- Player Runtime;
- Edge;
- plugins;
- docs;
- container;
- E2E.

Each area defines source globs, dependencies, and relevant validation commands.

For example, a Player Runtime change affects both Electron and Edge runtime validation. A Plugin SDK change affects plugins, Server, Studio, Player Runtime, docs, and generated artifacts.

Use the same affected-area implementation for:

```sh
make check-changed
```

and GitHub pull-request validation.

This replaces duplicated path knowledge in workflow YAML.

## Phase 8: contributor bootstrap and diagnostics

Keep Make as the public interface.

Add mise configuration for the project's major developer toolchains.

Add:

```sh
make doctor
```

It should report required, optional, missing, and wrong-version tools, including as relevant:

- Node/npm;
- Go;
- Rust/rustup;
- Java;
- Android SDK;
- Docker;
- FFmpeg;
- Edge development image/support.

The doctor should understand affected areas when practical so a documentation-only contributor is not told to install an Android SDK merely to edit prose.

Normalize Node versions used by local development, CI, and Docker. Prefer an LTS release and upgrade deliberately instead of allowing different environments to drift across major versions.

Add contributor documentation that reduces setup to approximately:

```sh
git clone ...
cd tilecast
mise install
make bootstrap
make doctor
make check-changed
```

## Phase 9: evolve existing Demo Mode

Do not replace Demo Mode with a parallel declarative mock system.

Keep its existing properties:

- real Server;
- real Studio;
- real PostgreSQL;
- real migrations;
- real domain services;
- real API;
- normal auth/CSRF semantics;
- pairing through the real protocol;
- deterministic IDs;
- simulated players;
- Playwright integration.

Continue the rule that scenarios seed through domain services rather than SQL.

Generalize the existing Go scenario builder into composable typed presets and reusable simulated-player profiles.

Useful focused scenarios may include:

- `basic`;
- `kitchen-sink`;
- `empty`;
- `failure-lab`;
- `compatibility`;
- `large-library`;
- `plugin-dev`.

`failure-lab` should intentionally expose difficult UI states such as unavailable content, failed previews, stale/offline screens, mixed capability coverage, failed updates, manifest incompatibility, and plugin attention states.

Provide a TypeScript E2E helper that exposes stable symbolic handles instead of requiring tests to know fixed UUIDs or reset transport details.

For example, tests should be able to request a scenario and reference a named seeded screen without duplicating reset/API mechanics.

## Phase 10: API property testing

After OpenAPI coverage and response schemas are reliable, add Schemathesis against disposable Demo Mode.

Start with:

- GET/HEAD endpoints;
- endpoints with simple preconditions;
- API-change-only or scheduled CI.

Expand mutation/stateful testing only after the failure signal is useful.

A failing property test should identify a real contract or server problem rather than merely demonstrate that a complex endpoint requires setup the generator cannot infer.

## Desired end-state workflow

A typical feature should follow this path:

```text
contract change
    ↓
make generate
    ↓
generated API/capability bindings
    ↓
native implementation
    ↓
shared conformance where required
    ↓
Studio typed query/UI
    ↓
Demo scenario state if needed
    ↓
make check-changed
```

Pull-request validation should automatically cover, as appropriate:

- generated artifacts are current;
- OpenAPI linting;
- server route/spec parity;
- API compatibility;
- native language tests;
- shared conformance;
- affected builds;
- Demo Mode Playwright tests.

## Proposed implementation stack

Use a sequence of reviewable PRs:

1. Contracts/conformance ADR and root generation umbrella.
2. OpenAPI quality gate and route/spec parity.
3. Generated `@tilecast/api-schema` TypeScript definitions.
4. Typed Studio transport.
5. Typed React Query layer and representative domain migrations.
6. Remaining Studio API migration and duplicate transport/type removal.
7. API compatibility CI with `oasdiff`.
8. Conformance package and migration of existing schedule/activity fixtures.
9. Expanded Player/server conformance fixtures.
10. Capability registry and generated bindings.
11. Repository affected-area graph and `make check-changed`.
12. Contributor bootstrap, mise, `make doctor`, and toolchain normalization.
13. Demo Mode scenario/profile generalization and E2E symbolic handles.
14. Selective Schemathesis property testing.

## Sequencing constraints

The work does not all need to wait for the same dependency:

- PRs 1, 11, and 12 can begin while Plugin API work is still finishing because they have little architectural overlap.
- PRs 2 through 7 should target the post-M7 Plugin API shape so the final composed OpenAPI/plugin boundary is migrated once.
- PRs 8 through 10 should follow stabilization of the shared renderer/host capability work so Player contracts and capabilities are standardized once.
- Demo Mode improvements can proceed independently once their target feature states exist.

## Explicit non-goals

This roadmap does **not** propose:

- replacing Make with a monorepo framework;
- generating the Tilecast Go server from OpenAPI;
- one universal Player implementation shared through Wasm/FFI;
- a generic Go CRUD framework;
- a schema-driven React page framework;
- replacing Demo Mode with mocks or YAML;
- merging every internal concept named "capability" into one registry;
- introducing a proprietary cloud service or hosted build dependency.

The intended result is a more explicit and easier-to-contribute-to Tilecast without obscuring the existing architecture behind another framework.
