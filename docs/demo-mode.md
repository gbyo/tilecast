# Demo Mode

Demo Mode runs a disposable Tilecast installation with realistic sample data. Use it for local development, browser tests, screenshots, contributor onboarding, and CI.

Demo Mode runs the real server, the real Studio bundle, the real PostgreSQL schema, the real domain services, and the real API. Only two things are simulated: the installation data and the players.

Demo Mode is not a mock API, a second backend, or a way to evaluate production security. Do not use it for an installation that holds real data.

## Commands

Run these commands from the repository root. They need Docker.

| Command            | Result                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `make demo`        | Builds the server image, starts PostgreSQL and the server, and seeds the `kitchen-sink` scenario. |
| `make demo-reset`  | Restores the scenario through the reset API. Set `SCENARIO=basic` to select a different scenario. |
| `make demo-logs`   | Follows the server log.                                                                           |
| `make demo-down`   | Stops the stack and deletes its volumes.                                                          |
| `npm run test:e2e` | Runs the Playwright smoke suite against the running demo. `make e2e` runs the same suite.         |

After `make demo`, open <http://localhost:18080>. Studio opens signed in as the demo Owner. Set `TILECAST_DEMO_PORT` to use a different port.

The stack uses `deploy/docker/compose.demo.yml`. It has its own Compose project, network, and volumes, so it never touches the data of `compose.yml`.

## Scenarios

| Scenario       | Contents                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kitchen-sink` | The default. Four locations, 13 screens, four groups, four users, eight processed images, a Clock Widget, a website, four tags, five playlists (one is an unpublished draft), two Layouts (one is a draft), three schedules, a draft campaign, two plugins with instances, organization settings, a pending pairing request, and the audit history these actions make. |
| `basic`        | Two locations, four screens, one group, three images, and two playlists. It seeds faster.                                                                                                                                                                                                                                                                              |

The `kitchen-sink` screens show every computed status except revoked, because a revoked screen leaves the fleet list:

| Status   | Screens                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| online   | Cafeteria East, Cafeteria West, Main Hallway, Front Office, Middle School Cafeteria, Gym Lobby, Staff Lounge |
| recent   | Library                                                                                                      |
| stale    | Board Room, Ticket Booth                                                                                     |
| offline  | Middle School Library, Stadium Concourse                                                                     |
| disabled | Middle School Main Hallway                                                                                   |

The screens report Fire TV, Android TV, and Linux players, different player versions, 1080p and 4K resolutions, and one portrait display. Staff Lounge has no location, no group, and no content.

Every seeded record has a fixed ID. The IDs are in `apps/server/internal/demo/ids.go`, and a reset recreates each record with the same ID. Browser tests use these IDs directly.

The Lobby Clock Widget appears only in the library and in the draft Layout. No released player reports the `environment.time` capability, so Tilecast correctly refuses to assign a clock to a screen.

To add a scenario, write a seed function from the primitives in `builder.go` and register it in `scenarios.go`. Seed with the domain services, not with SQL.

## Authentication

Demo Mode does not turn off authentication. When a request to `/api/v1/auth/status` has no valid session, the server issues an ordinary session for the demo Owner. The session is stored like any other session, has its own CSRF token, and records `demo` as its sign-in method. Role checks, screen scopes, CSRF checks, and audit attribution apply without change.

The status response includes `"demoMode": true`. Studio shows a banner on every page when this value is true.

Sign-out deletes the session. Studio then requests the status again and receives a new demo session.

## Reset

`POST /api/v1/demo/reset` replaces all data with a scenario:

```json
{ "scenario": "kitchen-sink" }
```

The request needs the Owner role and the session CSRF token. The endpoint exists only in Demo Mode. On any other installation, the route is not registered.

A reset removes every session. The response contains the CSRF token of a new session. The response returns after the data is seeded and every simulated player has connected, so a test can continue immediately.

`GET /api/v1/demo` returns the scenario name and the state of each simulated player.

## Simulated players

The server seeds each screen through the real pairing sequence: a pairing request, Owner approval, the private poll, and one-time enrollment. The simulator keeps the resulting device credentials in memory only.

Screens in the online state use the player socket. The Library screen uses the fallback HTTP heartbeat, so Studio shows it as recent. The simulator uses the public player API on the server loopback address:

- It reads `/api/v1/system/identity` and stops if the installation ID is different.
- It downloads the manifest again when it receives `manifest.changed`.
- It sends `player.status` heartbeats and answers `server.ping`.
- It claims, acknowledges, and completes queued commands with the result codes of the Android player. A command type that the Android player does not support fails with `command_unsupported`.

The simulator does not download media, render content, or report proof of play.

Stale, offline, and disabled screens have no simulator. Their last contact is set once at seed time, so they age from that moment. Reset the demo to restore them.

## Browser tests

The suite is in `e2e/`. It uses Playwright against a running Demo Mode stack, and it does not mock API responses.

```sh
npx playwright install chromium
make demo
npm run test:e2e
```

Set `TILECAST_E2E_BASE_URL` to test a different address. Before any test runs, the suite verifies that the server reports `demoMode`, and it stops if the server does not. Each test resets the demo first. Playwright keeps a trace and a screenshot for each failed test in `e2e/test-results`.

The `E2E smoke (Demo Mode)` job in pull request validation runs this suite. On a failure, it keeps the Playwright output and the server logs as an artifact.

## Production safety

Demo Mode starts only when `TILECAST_ENV` is `demo`. `development`, `production`, and all other values keep normal behavior. When Demo Mode starts, the server writes a warning to the log.

The server does not start in Demo Mode when:

- `TILECAST_PUBLIC_URL` is not a loopback address. Set `TILECAST_DEMO_ALLOW_REMOTE=true` only for a shared host that is disposable.
- `TILECAST_MDNS_ENABLED` is true.
- `TILECAST_SMTP_HOST` is set.
- `TILECAST_GITHUB_TOKEN` or `TILECAST_RELEASE_PUBLISH_TOKEN` is set.

The seeder writes a fixed installation ID. A seed or reset refuses to change a database that contains a different installation, so Demo Mode cannot replace a real installation.

The demo Compose file publishes the server on `127.0.0.1` only. Its PostgreSQL service has no published port.

## Configuration

| Variable                       | Default        | Purpose                                                                             |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------- |
| `TILECAST_DEMO_SCENARIO`       | `kitchen-sink` | Scenario to seed.                                                                   |
| `TILECAST_DEMO_RESET_ON_START` | `true`         | Seeds again at each start. When false, the data stays and the players enroll again. |
| `TILECAST_DEMO_PLAYERS`        | `true`         | Starts the simulated players.                                                       |
| `TILECAST_DEMO_ALLOW_REMOTE`   | `false`        | Permits a public URL that is not a loopback address.                                |
