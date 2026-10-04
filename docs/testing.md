# Testing and CI

## Validation contracts

`Pull request validation` runs on every PR base and on `main`. Each subsystem has one reusable workflow. The PR and `main` jobs call the same workflow.

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
| Studio component        | Studio, production image, Demo Mode browser and visual tests                           |
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

HTTP rules identify files with Player endpoints and shared routing or authentication. The Player configuration, manifest, and media delivery handlers have separate files. Settings, users, dashboard authentication, backups, notifications, and content administration select server and production browser validation. They do not select Players. A source contract test requires each Player handler to retain its consumer mapping.

Manifest, layout, and Player configuration JSON schemas select Player consumers. The activity fixtures select activity parity. Reserved schema package metadata selects server, Studio, and CLI contracts. Schema package README files select documentation only. New API schema files and unknown shared packages select all areas until their consumers have a rule.

The Demo Mode browser job builds and starts the production server image. It also validates the production Compose file. This job satisfies container validation when browser tests are selected. A separate container job runs only when the browser job does not run.

## Required checks

Require these stable check names in the branch ruleset:

- `Required PR validation`
- `Required Edge validation`

Both workflows run for every PR. An aggregate fails when detection fails, a selected job fails or is cancelled, or a selected job is skipped. The aggregate uses only the runner shell after its dependencies finish; it does not check out the repository or install Node. The contract tests require every validation job to appear in the aggregate dependencies and exercise the fail-closed shell logic.

On 2026-09-28, the active `Main branch ruleset` requires a PR but contains no required status checks. There is no separate legacy protection rule on `main`. These workflows define the intended check contract. Repository administrators must configure the required checks in the ruleset.

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

Each test resets the demo. Run functional and Studio visual suites in sequence because they share the installation. Both suites refuse a server that does not report Demo Mode.

The functional journeys cover authoring, publication, previews, settings, plugin discovery, manifest delivery, commands, CSRF, and reset recovery. Component tests remain the source for individual control behavior.

## Screenshot review

Linux Chromium is the committed screenshot authority for Studio and Widgets. The lockfile pins Playwright and its browser revision. Visual jobs use Ubuntu 24.04. The suite fixes the viewport, scale, locale, timezone, theme, and reduced motion. It disables animations and hides the caret during comparison. It waits for fonts, decoded images, and Widget render completion.

Studio fixes browser `Date` while timers and real server time continue. The tests mask server contact times, enrollment and sign-in dates, update ages, notification counts, and pairing expiry metadata. Screen details mask the effective assignment and next transition values because the server evaluates schedules with real time. Status labels and controls remain visible. The overview masks its live chart, health values, and measured-screen counts. The next schedule panel uses the fixed browser time and remains visible. Widget renderers have no masks. Widget editor snapshots select the 320 × 180 Small zone preset so the full frame is visible.

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

Inspect every changed image. Run the comparison again without `--update-snapshots`. Commit only the reviewed PNG files under each suite's `__screenshots__/linux/` directory. CI never accepts or commits changed screenshots. There is no second macOS golden set.

Run `npm run test:visual:probe` on Linux, or `bash scripts/ci/visual-linux.sh probe` on macOS, to verify regression detection. The probe first compares the unchanged Widget editor. It then changes input styles and requires the comparison to fail. The probe cannot update baselines.

On failure, CI uploads the expected, actual, and difference screenshots, the HTML report, and traces. Studio failures also include the Demo Mode stack logs. Open the reports with these commands:

```sh
npx playwright show-report e2e/visual/playwright-report
npx playwright show-report widgets/visual/playwright-report
```

The container helper copies reports into `e2e/visual/test-results/linux-run/`.

## React Doctor

React Doctor checks Studio React code for patterns that ESLint does not cover. Its settings are in `apps/dashboard/doctor.config.json`: it does not send scores or crash reports, and it does not run the supply-chain check.

```sh
npm run doctor
npm run doctor:changed
```

`npm run doctor` scans the full dashboard and reports all existing findings. `npm run doctor:changed` reports only findings that your branch adds compared with the base branch. Pull request CI runs the changed scope against the pull request base and fails on new errors. Warnings do not fail the job. A release run has no base branch, so it skips this step.

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
TEST_DATABASE_URL='postgres://localhost:5432/tilecast_test?sslmode=disable' go test -p 1 -coverprofile=coverage.out ./...
go tool cover -func=coverage.out
cd ../cli
go test -coverprofile=coverage.out ./...
go tool cover -func=coverage.out
```

Studio produces a terminal summary, JSON summary, LCOV data, and HTML. Server and CLI jobs produce Go profiles. Each CI job writes a summary to the Actions job summary and uploads the coverage files.

Server integration tests share one PostgreSQL database. They use an advisory lock around destructive fixture resets. Some suites also run background services against those fixtures. Keep `-p 1` until all database users have isolated schemas or a verified connection-owned lock. Unit tests without PostgreSQL can use normal package parallelism.

Android runtime conformance caches its API 34 Google APIs x86_64 Nexus 6 AVD snapshot. A cache miss creates a clean boot snapshot; the conformance launch uses `-no-snapshot-save` so timezone, display, and test mutations do not replace the cached boot baseline. Bump the version in the cache key when the AVD configuration changes incompatibly.

## Deep platform validation

Edge PRs select Rust, WPE, runtime, conformance, real-server, migration, and activity parity jobs from the same graph. Relevant changes on `main` run the full Edge suite. Dispatch and twice-weekly scheduled runs also run the full suite. Documentation-only changes do not start platform images.

The image dependency chain is in `scripts/ci/edge-images.hcl`. Bake uses explicit parent targets and separate GHA cache scopes. Run a selected image build locally:

```sh
docker buildx bake -f scripts/ci/edge-images.hcl wpe edge --load
```

Run the existing scenario scripts from `apps/edge/ci/` and `apps/edge/renderer-wpe/ci/` with those images. The Rust, kernel CEC, PipeWire, WirePlumber, renderer, migration, power-loss, and activity assertions remain in their original suites.

The scheduled Go race workflow runs the server integration contract with `-race`. Reproduce it with `TEST_DATABASE_URL` set and `go test -race -p 1 ./...` from `apps/server`. Investigate a failure in the package reported by Go. The repository has no Go fuzz entry points, so this change adds no scheduled fuzz job.

## Timing evidence

`scripts/ci/timing.mjs` reads public job metadata through `gh`. It reports elapsed time and the sum of job execution seconds. Queue time and cache state affect wall time. Use these measurements to compare runner work and feedback time separately:

```sh
node scripts/ci/timing.mjs 36385719535 36385719698
```

The [CI timing record](ci-timings.md) contains representative runs and selection comparisons.
