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

Detection runs the dependency-free affected-area and aggregate tests with Node before any package installation. Workflow YAML tests run in `CI workflow contracts`, after installation of the root tool dependencies. CI infrastructure changes select this job. `Required PR validation` includes its result.

HTTP rules identify files with Player endpoints and shared routing or authentication. The Player configuration, manifest, and media delivery handlers have separate files. Settings, users, dashboard authentication, backups, notifications, and content administration select server and production browser validation. They do not select Players. A source contract test requires each Player handler to retain its consumer mapping.

Manifest, layout, and Player configuration JSON schemas select Player consumers. The activity fixtures select activity parity. Other API schemas select server, Studio, and CLI contracts. Schema package README files select documentation only. Unknown shared packages still select all areas.

The Demo Mode browser job builds and starts the production server image. It also validates the production Compose file. This job satisfies container validation when browser tests are selected. A separate container job runs only when the browser job does not run.

## Required checks

Require these stable check names in the branch ruleset:

- `Required PR validation`
- `Required Edge validation`

Both workflows run for every PR. An aggregate fails when detection fails, a selected job fails or is cancelled, or a selected job is skipped. The contract tests require every validation job to appear in the aggregate dependencies.

On 2026-09-28, the active `Main branch ruleset` requires a PR but contains no required status checks. There is no separate legacy protection rule on `main`. These workflows define the intended check contract. Repository administrators must configure the required checks in the ruleset.

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

Simulated Players do not send screenshot captures. Screen detail tests wait for the real Live preview panel and its uncaptured metadata. The Activity snapshot covers the seeded empty Proof of Play state. The Widget suite uses each fixture's manual clock and production mount. Both suites permit at most a 0.5% pixel difference. Do not increase this tolerance to make a failure pass.

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
