# Testing and CI

## Validation contracts

`Pull request validation` runs on every PR base and on `main`. Each subsystem has one reusable workflow. The PR and `main` jobs call the same workflow.

CI has two tiers. Use the tier to decide where a check belongs.

- **Pull request checks** are fast and deterministic. They fail only because of the change under review. They are the lint, format, type, build, and unit-test checks, the Demo Mode functional suite, and the documentation build. Only these checks can block a merge.
- **Extended validation** checks are slow, need a special runner, or depend on the environment more than on the change. They are the Studio screenshot comparison, iOS CI, Android emulator conformance, the Android Core host boot test, and WebView2 conformance. They run every night and on demand. They never block a PR.

Add a check to the PR tier only when a contributor can reproduce a failure on an ordinary machine. A check that fails for reasons outside the change belongs in Extended validation.

`scripts/ci/affected.mjs` defines the affected areas and their consumers. It compares the merge base of the actual base and head commits. This comparison supports stacked PRs. Deleted and renamed paths retain their affected areas.

Run the classifier and its contract tests from the repository root:

```sh
npm run test:ci
node scripts/ci/affected.mjs --base origin/main --head HEAD
node scripts/ci/affected.mjs apps/dashboard/src/components/Button.tsx
```

The graph selects these contracts:

| Change                  | Selected contracts                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Studio component        | Studio, production image, Demo Mode functional tests                                   |
| Linux Player source     | Linux tests and TypeScript build; package contract only for release-sensitive inputs   |
| CLI or MCP              | CLI and API client                                                                     |
| Widget or Widget SDK    | Widget conformance and visuals, Studio, server catalog, runtime and renderer consumers |
| Plugin Studio code      | Plugin conformance, Studio and Demo Mode                                               |
| Plugin runtime code     | Plugin conformance, runtime and renderer consumers                                     |
| Player Runtime          | Runtime, Electron, WPE and renderer conformance                                        |
| Edge installer or units | Rust and migration under systemd                                                       |
| Server player protocol  | Server, Android, runtime and real-server Edge tests                                    |
| Activity contract       | Player protocol contracts and activity parity                                          |
| Documentation           | Documentation checks                                                                   |

Unknown shared packages select all areas. Workflow, dependency, and classifier changes also select all areas. Add a consumer rule and tests when you add a shared package.

Detection runs only the dependency-free affected-area graph tests before classification, so unrelated helper tests do not delay job fan-out. The doctor and aggregate helper tests run in `CI workflow contracts` when CI infrastructure changes. Workflow YAML tests run there after installation of the root tool dependencies. `Required PR validation` includes its result.

Dashboard formatting and lint, the production build, and two coverage-enabled Vitest shards run as independent jobs. Each shard publishes its JUnit report. The coverage job merges the Vitest blob reports before it writes the coverage summary and artifact. The required Dashboard workflow does not pass if a selected job fails.

Node CI jobs use the root `package-lock.json` with a workspace filter when one application is sufficient. Dashboard CI installs `@tilecast/dashboard` and the root tools used by formatting. Linux Player CI installs `@gibsonmb71/tilecast-player-linux` and its linked workspace dependencies, including Player Runtime. A full local workspace install still uses `npm ci`.

HTTP rules identify files with Player endpoints and shared routing or authentication. The Player configuration, manifest, and media delivery handlers have separate files. Settings, users, dashboard authentication, backups, notifications, and content administration select server and production browser validation. They do not select Players. A source contract test requires each Player handler to retain its consumer mapping.

Manifest, layout, and Player configuration JSON schemas select Player consumers. The activity fixtures select activity parity. Reserved schema package metadata selects server, Studio, and CLI contracts. Schema package README files select documentation only. New API schema files and unknown shared packages select all areas until their consumers have a rule.

The Demo Mode browser job builds and starts the production server image. It also validates the production Compose file. This job satisfies container validation when browser tests are selected. A separate container job runs only when the browser job does not run.

## Linux Player validation

Every Linux Player change runs its unit tests and TypeScript build. Pull requests run the packaged release contract when a change can affect Electron packaging, release signing or verification, Player updates or installation, packaged assets, package metadata or dependencies, the shared Player Runtime, or the CI contract. Linux Player source and test changes outside those paths use the fast validation job.

Changes to the Linux Player on `main` always run the packaged release contract. The reusable Linux workflow reports success only after fast validation and any selected package job pass. The aggregate PR check accepts a skipped package job when the path classifier did not select it.

## Local iteration

Run `make dev` to start the local PostgreSQL service, the Go server with reload, and the Vite dashboard. Press Ctrl-C to stop them. See [development setup](development.md) for ports, database settings, and the FFmpeg requirement.

Run `make quick` to run tests selected from changed paths. It uses Vitest's changed-file mode for Studio, Linux Player, and Player Runtime tests. It runs Go tests for changed packages. It also checks Android unit tests, CI contracts, or documentation when those paths change. Set `TILECAST_DEV_BASE` when the comparison ref is not `origin/main`.

Use `make test` for the full unit suites. Use `make check` for merge-grade validation. The quick command does not replace either command.

## Required checks

Require these stable check names in the branch ruleset:

- `Required PR validation`
- `Required Edge validation`
- `Required Windows validation`

All three workflows run for every PR. An aggregate fails when detection fails, a selected job fails or is cancelled, or a selected job is skipped. The aggregate uses only the runner shell after its dependencies finish; it does not check out the repository or install Node. The contract tests require every validation job to appear in the aggregate dependencies and exercise the fail-closed shell logic.

**Historical configuration observation (2026-09-28, not a present-day guarantee):** the active `Main branch ruleset` required a PR but contained no required status checks. There is no separate legacy protection rule on `main`. These workflows define the intended check contract. Repository administrators must configure the required checks in the ruleset.

The documentation formatting check on a PR covers the Markdown files that the PR changes. It does not fail a PR for formatting that was already wrong on `main`. The runs on `main` and the manual runs check every document.

Server CI runs `make gofmt-check` before `go vet`, tests, and build. The local `make check` target calls the same formatting gate, so both paths cover the same Go source trees.

Dashboard CI runs the localization scanner with `--check` on changed TypeScript and TSX files under `apps/dashboard/src`, compared with the PR base. It fails for new findings. The full scan reports existing findings for separate fixes. See [localization.md](localization.md) for focused and full scan commands.

## Studio architecture checks

Run `npm run architecture:scan --workspace @tilecast/dashboard -- --check --base origin/main src/pages/Example.tsx` for a changed Studio file. Omit `--base` to see all findings. Dashboard CI uses the same file list and comparison ref as the localization check.

The architecture mode uses the existing TypeScript AST scanner. It reports new local byte formatters and local `CancelledAction` classes. It reports raw error messages in JSX and toast feedback. Use `apiErrorMessage()` for localized API failures. The localization mode reports new English toast text.

Query-key checks activate when a domain has a module in `src/data/`. Key factories belong in that directory. UI consumers use the factories. The check reports inline keys in query options and common query-client operations. Existing inline keys remain incremental migration work.

The transport check reports generic `request<T>()` calls with static core paths. It also reports literal core API `fetch()` calls with JSON bodies or JSON reads. Dynamic plugin routes, typed transport, external requests, and binary reads retain their boundaries. The scanner is a structural check, not type-level data-flow analysis.

A genuine transport exception can use `architecture-ignore: <reason>` on the finding's line or the previous line. State the reason, such as a specialized upload. Do not use an exception to bypass an ordinary core JSON route. Git-fixture tests verify baseline comparison, missing refs, and domain activation. Run `npm run test:ci` after changes to these checks.

## Fast local iteration

Use changed tests while iterating, then use the full suite required by CI before merge. Fetch the comparison ref first:

```sh
git fetch origin main
git merge-base origin/main HEAD >/dev/null 2>&1 || {
  printf 'Fetch a base that shares history with HEAD, or run the full suite.\n' >&2
  exit 1
}
npm test --workspace @tilecast/dashboard -- --changed=origin/main --passWithNoTests
npm test --workspace @gibsonmb71/tilecast-player-linux -- --changed=origin/main --passWithNoTests
cd apps/server
go test ./internal/devices
```

Vitest follows its test dependency graph from changes since `origin/main`. Changes to its config or `package.json` run the full suite. `--passWithNoTests` lets documentation-only changes finish when no tests are related. For a different base, replace `origin/main` in both the merge-base check and Vitest command. The check stops when the ref is missing or unrelated; fetch a valid base or run the full suite. Run `go test` in each package that contains changed Go source. List each affected package when a change spans packages. These commands help with local iteration and do not replace CI's full test jobs.

## Real application tests

The browser tests use the production Studio bundle, the server, PostgreSQL migrations, real domain services, and simulated players. They do not replace API responses. See [Demo Mode](demo-mode.md) for the reset API and the fixed record IDs.

```sh
npx playwright install chromium
make demo
npm run test:e2e
npm run test:visual
```

Each test resets the demo. Run functional and Studio visual suites in sequence because they share the installation. Both suites refuse a server that does not report Demo Mode. PR validation runs the functional suite. The Studio visual suite runs in [Extended validation](#extended-validation).

The functional journeys cover authoring, publication, previews, settings, plugin discovery, manifest delivery, commands, CSRF, and reset recovery. Component tests remain the source for individual control behavior.

## Screenshot review

Linux Chromium is the committed screenshot authority for Studio and Widgets. The lockfile pins Playwright and its browser revision. Visual jobs use Ubuntu 24.04. The suite fixes the viewport, scale, locale, timezone, theme, and reduced motion. It disables animations and hides the caret during comparison. It waits for fonts, decoded images, and Widget render completion.

Studio fixes browser `Date` while timers and real server time continue. The server evaluates schedules with real time, so a screenshot that is taken inside a seeded schedule window shows different content than the baselines. The seeded windows are weekdays 07:15 to 08:15 and 10:30 to 13:30, and Fridays 15:00 to 23:00, in `America/Chicago`. The visual jobs run `scripts/ci/demo-schedule-window.mjs` first. They skip the comparison and report a notice when the clock is inside a window or less than 20 minutes before one. A test in `scripts/ci/` keeps that script equal to the seeded schedules. The tests mask server contact times, enrollment and sign-in dates, update ages, notification counts, and pairing expiry metadata. Screen details mask the effective assignment and next transition values because the server evaluates schedules with real time. Status labels and controls remain visible. The overview masks its live chart, health values, and measured-screen counts. The next schedule panel uses the fixed browser time and remains visible. Widget renderers have no masks. Widget editor snapshots use the default frame, which fits the stage, and wait for the shared Widget mount instead of a status label.

Simulated Players report unsupported captures through the player API. Screen detail tests wait for the real Live preview panel: a capture error for the online screen and offline states for screens without a connected Player or a cached image. The Activity snapshot covers the seeded empty Proof of Play state. Dialog captures hide volatile background labels in their own layer, so masks cannot cover the dialog. Fixed date controls remain visible. The Widget suite uses each fixture's manual clock and production mount. Both suites permit at most a 0.5% pixel difference. Do not increase this tolerance to make a failure pass.

The Media snapshot selects name sorting through the real UI. Media processing can finish in a different order, so update time is not a deterministic sort key.

Relative update labels include both numeric ages and `just now`. Masked table contact labels have a fixed screenshot width, so their changing text cannot resize adjacent columns.

The initial 22 Studio PNG files were captured on Ubuntu 24.04 x64 with Playwright 1.63.0 and Chromium revision 1243 (153.0.8010.12). The capture runs were [36393103744](https://github.com/gbyo/tilecast/actions/runs/36393103744), [36394627433](https://github.com/gbyo/tilecast/actions/runs/36394627433), and [36395391085](https://github.com/gbyo/tilecast/actions/runs/36395391085). Each 1440 × 1000 image was reviewed for seeded data, complete loading, fonts, theme, masks, overlays, shared Widget rendering, and the intended editor or dialog state. Layout library thumbnails and the website Widget have no saved preview in the seed. Their unavailable states are expected.

The online screen baseline was refreshed from [36462713769](https://github.com/gbyo/tilecast/actions/runs/36462713769) after the simulator acknowledged unsupported captures. The test waits for the capture error, not the initial preview metadata.

The fleet baseline was refreshed from [36464361568](https://github.com/gbyo/tilecast/actions/runs/36464361568) after contact labels received a fixed screenshot width. All other 21 comparisons passed in that run.

On macOS, run the Linux container helper against the running demo:

```sh
bash scripts/ci/visual-linux.sh studio
bash scripts/ci/visual-linux.sh widgets
```

The helper uses the official Playwright Noble image at the installed Playwright version. It copies the source into an ephemeral container. It does not replace the host's dependencies. It uses the host's native container architecture because Chromium cannot run reliably under CPU emulation. CI confirms the comparison on the canonical GitHub runner.

After an intentional design change, generate proposed baselines:

```sh
# On Linux with Chromium installed:
npm run test:visual -- --update-snapshots
npm run widgets:visual -- --update-snapshots

# With Docker on macOS:
bash scripts/ci/visual-linux.sh studio --update-snapshots
bash scripts/ci/visual-linux.sh widgets --update-snapshots
```

Inspect every changed image. Run the comparison again without `--update-snapshots`. Commit only the reviewed PNG files under each suite's `__screenshots__/linux/` directory. There is no second macOS golden set.

You do not need Docker or a Linux machine to refresh the Studio baselines. Open Actions, choose `Refresh Studio visual snapshots`, and run it on your branch. The workflow renders the changed screenshots on the CI runner and commits them to that branch. It refuses to run on `main` and when the demo clock is inside a schedule window. The commit uses the workflow token, so it does not start other workflows. Review every changed PNG, then push a commit or re-run the checks. Extended validation never changes a screenshot.

Run `npm run test:visual:probe` on Linux, or `bash scripts/ci/visual-linux.sh probe` on macOS, to verify regression detection. The probe first compares the unchanged Widget editor. It then changes select control styles and requires the comparison to fail. The probe cannot update baselines.

On failure, CI uploads the expected, actual, and difference screenshots, the HTML report, and traces. Studio failures also include the Demo Mode stack logs. Open the reports with these commands:

```sh
npx playwright show-report e2e/visual/playwright-report
npx playwright show-report widgets/visual/playwright-report
```

The container helper copies reports into `e2e/visual/test-results/linux-run/`.

## React Doctor

React Doctor checks Studio React code for patterns that ESLint does not cover. Its settings are in `apps/dashboard/doctor.config.json`: it does not compute a score and it does not run the supply-chain check. The local scripts pass `--no-telemetry`, which also stops crash reporting.

```sh
npm run doctor
npm run doctor:changed
```

`npm run doctor` scans the full dashboard and reports all existing findings. `npm run doctor:changed` reports only the findings that your branch adds compared with the base branch. Neither command is part of `make check`, and neither fails when it finds issues.

Pull request CI runs the `millionco/react-doctor@v2` action in `ci-dashboard.yml`. It scans only the dashboard code that the pull request changes. It writes one sticky summary comment and inline review comments, and it adds the result to the job summary. It is advisory (`blocking: none`): findings never fail the pull request. It does not publish a commit status. The step runs on `pull_request` events only, so a release run does not scan. It uses `pull_request`, not `pull_request_target`. A pull request from a fork has a read-only token, so the action does not post comments there; its findings show in the job summary.

The checkout uses `fetch-depth: 0` so the action can find the merge base. The action sets `REACT_DOCTOR_NO_TELEMETRY` to stop crash reporting. The workflow pins the react-doctor `version` input to the version in `apps/dashboard/package.json`: change both together.

The `dashboard_ci` job in `pr-validation.yml` grants `issues: write` and `pull-requests: write` for the comments, and keeps `checks: write` for test reporting. A called workflow cannot request more than its caller grants, so `server-release.yml` grants the same permissions to its `dashboard_ci` job.

## Public documentation captures

The documentation generator uses the production Demo Mode installation. It
uses the Studio visual suite's browser settings and render waits. It does not
use regression masks or the pixel-difference contract.

```sh
make demo
npm run docs:screenshots
npm run docs:check
npm run docs:build
```

Install Chromium with `npx playwright install chromium` before the first run.
Run the generator separately from the other Demo Mode suites. Each capture
resets the same installation. The generator refuses a non-demo server.

The generator writes only named PNG files under
`apps/docs/src/assets/screenshots/`. Each state has light and dark sources at
2× pixel density. The docs figure selects the source for the docs theme.
The generator hides only the Demo Mode notice.
Review all images before commit. CI does not regenerate these source assets.
See the [capture inventory](../e2e/docs-screenshots/README.md) for routes,
required states, crops, and omitted states. The public screenshot policy is in
[the docs style guide](../apps/docs/STYLE.md#product-screenshots).

## Coverage

Coverage is diagnostic. There is no repository percentage gate.

```sh
npm run coverage
cd apps/server
TEST_DATABASE_URL='postgres://localhost:5432/tilecast_test?sslmode=disable' go test -coverprofile=coverage.out ./...
go tool cover -func=coverage.out
cd ../cli
go test -coverprofile=coverage.out ./...
go tool cover -func=coverage.out
```

Studio produces a terminal summary, JSON summary, LCOV data, and HTML. Server and CLI jobs produce Go profiles. Each CI job writes a summary to the Actions job summary and uploads the coverage files.

Each server integration-test package creates a temporary PostgreSQL database from `TEST_DATABASE_URL` and drops it after the package exits, including after a test failure. The database role needs permission to create and drop databases. Existing advisory locks still serialize tests inside the same package database; separate packages no longer share fixture tables or locks. The CI command uses normal Go package parallelism. Reproduce the server race job with `TEST_DATABASE_URL` set and `go test -race ./...` from `apps/server`.

## Validation timing summaries

Dashboard and Server CI jobs append a timing summary to the GitHub Actions job summary, including setup and validation step durations and total job elapsed time when the summary runs. Queue time is excluded. The Dashboard summary ranks the slowest test files and test cases from JUnit output. The Server summary ranks the slowest Go test packages and test cases from `go test -json` output. These measurements are informational; they do not set a test-time threshold or fail a job. Use `scripts/ci/timing.mjs` to compare completed workflow runs.

Android runtime conformance caches its API 34 Google APIs x86_64 Nexus 6 AVD snapshot. A cache miss creates a clean boot snapshot; the conformance launch uses `-no-snapshot-save` so timezone, display, and test mutations do not replace the cached boot baseline. Bump the version in the cache key when the AVD configuration changes incompatibly.

## Extended validation

`Extended validation` runs every night at 03:17 UTC and on demand. It is not part of PR validation, and it has no aggregate check. A failure appears on the run for `main`. It does not block a PR.

| Job                | What it runs                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| `studio_visual`    | The Studio screenshot comparison in Demo Mode                              |
| `ios_ci`           | The iOS build, unit, WebKit, and UI tests                                  |
| `android_emulator` | The Android runtime conformance and the Core host boot test on an emulator |

To run these checks on your branch, open Actions, choose `Extended validation`, and run it on that branch. Run `make demo` and `npm run test:visual` locally to reproduce the screenshot comparison. For iOS, use the commands in [the iOS README](../apps/ios/README.md). The WebView2 conformance check lives in `Windows Player CI`. It runs on `main`, every week, and on demand. It does not run on PRs.

## Deep platform validation

Edge PRs select Rust, WPE, runtime, conformance, real-server, migration, and activity parity jobs from the same graph. Relevant changes on `main` run the full Edge suite. Dispatch and twice-weekly scheduled runs also run the full suite. Documentation-only changes do not start platform images.

Windows PRs select the `windows` area: native Rust unit tests on Windows x64 and Windows ARM64 (including the MSIX, envelope, package-identity, and version-mapping contract tests), a Windows-only code cross-check on Linux, and, on `main`, the WebView2 conformance engine against the Electron reference. A weekly scheduled run exercises the current Evergreen WebView2. Shared Player crate changes also select Windows validation through the `player_core` graph edge. Run `make windows-check` and `make windows-test` locally; unit tests run on any host.

The image dependency chain is in `scripts/ci/edge-images.hcl`. Bake uses explicit parent targets and separate GHA cache scopes. Run a selected image build locally:

```sh
docker buildx bake -f scripts/ci/edge-images.hcl wpe edge --load
```

Run the existing scenario scripts from `apps/edge/ci/` and `apps/edge/renderer-wpe/ci/` with those images. The Rust, kernel CEC, PipeWire, WirePlumber, renderer, migration, power-loss, and activity assertions remain in their original suites.

The scheduled Go race workflow runs the server integration contract with `-race` and normal Go package parallelism. Investigate a failure in the package reported by Go. The repository has no Go fuzz entry points, so this change adds no scheduled fuzz job.

## Timing evidence

`scripts/ci/timing.mjs` reads public job metadata through `gh`. It reports elapsed time and the sum of job execution seconds. Queue time and cache state affect wall time. Use these measurements to compare runner work and feedback time separately:

```sh
node scripts/ci/timing.mjs 36385719535 36385719698
```

The [CI timing record](ci-timings.md) contains representative runs and selection comparisons.
