# Development

Install the tool versions in `mise.toml`: Node.js 22, Go 1.26, and Java 17 (for the Android Player only). Install npm and Docker. Then, run `make bootstrap`. Run `make doctor` to see which tools are missing. Use `make doctor AREA=server|dashboard|edge|android|media|docs` to check only the tools that one area needs. Android tools are not required for other areas.

## Toolchain versions

`mise.toml` selects the versions that contributors and primary CI use. The Go version agrees with `go.work` and each `go.mod`. The root `rust-toolchain.toml` pins Rust.

The repository has one virtual Cargo workspace and one root `Cargo.lock`.
Root default members are the Edge Rust packages. `--workspace` includes every
member, including future native products. Use `make edge-check` and
`make edge-test` for explicit Edge validation. Edge product version is
`apps/edge/release/VERSION`, independently of Rust library versions.
Use `make windows-check` and `make windows-test` for explicit Windows
Player validation. Windows product version is
`apps/player-windows/release/VERSION`. Windows unit tests run on any
host; the renderer and conformance need Windows with WebView2.

The production Docker builder images in `deploy/docker/Dockerfile` are a separate build environment. They can use newer, validated versions than `mise.toml`. Docker must not change the contributor baseline. To change any version, change it on purpose, and run the full checks for the affected areas.

PostgreSQL is the only runtime dependency for Milestone 1.

Run `make dev` to start the local PostgreSQL service, the Go server with [Air](https://github.com/air-verse/air) reload, and the Vite dashboard. The first run downloads the pinned Go watcher. Press Ctrl-C to stop the processes. The database volume remains for the next run. Run `make dev-down` to stop and remove the local development container and network while keeping the database volume.

The development database binds to `127.0.0.1:15432`. Set `TILECAST_DEV_DB_PORT` to use another port. Set `TILECAST_DATABASE_URL` to use an existing database and skip the local PostgreSQL service. The server uses port 8080 and Vite uses port 5173. Install FFmpeg and FFprobe, or run `make doctor AREA=media`, before you start the server.

Run `make watch-dashboard` or `make watch-linux` for the Vitest watch mode in those workspaces. Run `make quick` to select tests related to changed dashboard, Linux Player, Player Runtime, Android, or Go packages. The default comparison is `origin/main`; set `TILECAST_DEV_BASE` to use another ref. Quick validation does not replace the full checks.

Run `make test` for the full dashboard, extension SDK, Player Runtime, Linux Player, Go, CLI, and helper unit suites. Android unit tests remain in `make check` and `make android-check` so other contributors do not need the Android SDK. Run `make check` for merge-grade validation. It checks documentation, extensions, generated files, formatting, lint, dashboard tests, Go packages, CLI, helper tools, and Android unit tests.

Run `make build` to create the dashboard bundle and the server binary. The command copies the bundle into the server embed directory.

## Demo Mode

Run `make demo` to start a disposable installation with sample data and simulated players. Studio opens signed in. Run `npm run test:e2e` to run the browser smoke tests against it. Refer to [`demo-mode.md`](demo-mode.md).

Android player requirements and commands are documented in [`android-development.md`](android-development.md).

## Migration changes

Tilecast has one Goose version sequence. Core migrations are in `apps/server/internal/database/migrations`. A plugin keeps its migrations in `plugins/<name>/migrations`. Reserve the next version with this command:

```sh
npm run plugins:migration -- <plugin_id|core> <snake_case_name>
```

Each migration must contain these sections:

- `-- +goose Up`
- A functional `-- +goose Down`

The server applies pending migrations during startup. Do not edit a released migration. Add a new migration. `npm run plugins:generate` updates `apps/server/internal/database/migrations.lock.json`, and a server test compares the compiled migrations with it. Refer to [`plugin-api.md`](plugin-api.md#migrations).

## Plugins

A bundled plugin is one directory below `plugins/`. Create one with `npm run plugins:new -- <plugin_id>`, and run `npm run plugins:check` before you commit. Refer to [`plugin-api.md`](plugin-api.md).

## Integration database

Local unit tests do not change a database. The container smoke test does these operations:

1. Builds the image.
2. Starts PostgreSQL.
3. Applies migrations.
4. Tests the first-Owner flow.

CI compiles the applications and runs the unit checks after each change.
