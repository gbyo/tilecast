# Development

Install Go 1.24 or later, Node.js 22 or later, npm, and Docker. Then, run `make bootstrap`.

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

Add sequential Goose SQL files to `apps/server/internal/database/migrations`. Each migration must contain these sections:

- `-- +goose Up`
- A functional `-- +goose Down`

The server applies pending migrations during startup. Do not edit a released migration. Add a new migration.

## Integration database

Local unit tests do not change a database. The container smoke test does these operations:

1. Builds the image.
2. Starts PostgreSQL.
3. Applies migrations.
4. Tests the first-Owner flow.

CI compiles the applications and runs the unit checks after each change.
