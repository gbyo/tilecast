# Development

Install the tool versions in `mise.toml`: Node.js 22, Go 1.26, and Java 17 (for the Android Player only). Install npm and Docker. Then, run `make bootstrap`. Run `make doctor` to see which tools are missing. Use `make doctor AREA=server|dashboard|edge|android|media|docs` to check only the tools that one area needs. Android tools are not required for other areas.

## Toolchain versions

`mise.toml` selects the versions that contributors and primary CI use. The Go version agrees with `go.work` and each `go.mod`. `apps/edge/rust-toolchain.toml` pins Rust.

The production Docker builder images in `deploy/docker/Dockerfile` are a separate build environment. They can use newer, validated versions than `mise.toml`. Docker must not change the contributor baseline. To change any version, change it on purpose, and run the full checks for the affected areas.

PostgreSQL is the only runtime dependency for Milestone 1.

Run `make dev-server` and `make dev-dashboard` in separate terminals. Restart the server after a server change.

Vite updates the dashboard automatically.

Run `make check` to do these checks:

- Dashboard format
- Lint
- Unit tests
- Go vet
- Go tests

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
