---
title: Developers
description: Run Tilecast from source, check changes, and find the repository's technical references.
---

Tilecast is an AGPL-3.0-only project in the [`gbyo/tilecast` repository](https://github.com/gbyo/tilecast). The repository contains the server, Studio, Android and Linux Players, shared packages, deployment files, and this documentation site.

## Repository layout

| Path                   | Contents                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/server/`         | Go server, HTTP API, and database migrations. The server applies pending migrations before it accepts requests. |
| `apps/dashboard/`      | React and TypeScript management app, Tilecast Studio.                                                           |
| `apps/player-android/` | Kotlin and Jetpack Compose Player for Android TV devices.                                                       |
| `apps/player-linux/`   | Electron Player for Linux kiosk devices.                                                                        |
| `apps/docs/`           | Astro and Starlight public documentation.                                                                       |
| `packages/`            | Shared design tokens and application contracts.                                                                 |
| `deploy/`              | Docker deployment and optional network integrations.                                                            |
| `docs/`                | Engineering references, API descriptions, and implementation contracts.                                         |

## Run the server and Studio locally

You need Go (use the version in `apps/server/go.mod`), Node.js with npm, and a PostgreSQL database. From the repository root:

1. Install workspace and Go dependencies:

   ```sh
   make bootstrap
   ```

2. Set `TILECAST_DATABASE_URL` to a development database Tilecast can use:

   ```sh
   export TILECAST_DATABASE_URL='postgres://localhost:5432/tilecast?sslmode=disable'
   ```

3. Start the Go server in one terminal:

   ```sh
   make dev-server
   ```

4. Start the Vite development server in a second terminal:

   ```sh
   make dev-dashboard
   ```

The Go server applies pending migrations during startup. Complete the one-time Owner setup in Studio when using a new database. Vite reloads dashboard changes; restart the Go server after changing server code. Server settings are read from `TILECAST_*` environment variables; [`deploy/docker/.env.example`](https://github.com/gbyo/tilecast/blob/main/deploy/docker/.env.example) lists the deployment settings.

## Check and build changes

From the repository root, `make check` runs the repository's documented format, lint, test, and static checks. `make build` builds the dashboard bundle, server binary, and Android debug APK. See [Contributing](https://github.com/gbyo/tilecast/blob/main/CONTRIBUTING.md) before opening a pull request. Security reports follow the private process in the repository's [Security Policy](https://github.com/gbyo/tilecast/blob/main/SECURITY.md).

## Work on the public docs

The docs site is an npm workspace. Run these commands from the repository root:

```sh
npm run docs:dev
npm run docs:check
npm run docs:build
```

Follow the [documentation style guide](https://github.com/gbyo/tilecast/blob/main/apps/docs/STYLE.md). The docs build also checks internal links.

## Technical references

- [HTTP API overview](../reference/api/) explains the shared API contract and links to the OpenAPI description.
- [Development setup](https://github.com/gbyo/tilecast/blob/main/docs/development.md) covers local database and migration workflows.
- [Architecture](https://github.com/gbyo/tilecast/blob/main/docs/architecture.md) describes the server and application boundaries.
- [Android Player development](https://github.com/gbyo/tilecast/blob/main/docs/android-development.md) covers Android build and device workflows.
