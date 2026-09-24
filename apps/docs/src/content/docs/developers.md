---
title: Developers
description: Build Tilecast from source, run it locally, and find your way around the repository.
---

Tilecast is developed in one repository on GitHub. It's licensed under AGPL-3.0, and contributions are welcome.

## What Tilecast is built with

| Part                      | Technology                 | Location              |
| ------------------------- | -------------------------- | --------------------- |
| Tilecast Server           | Go, PostgreSQL             | `apps/server`         |
| Tilecast Studio           | React and TypeScript       | `apps/dashboard`      |
| Tilecast Player (Android) | Kotlin and Jetpack Compose | `apps/player-android` |
| Tilecast Player (Linux)   | Electron                   | `apps/player-linux`   |
| These docs                | Astro and Starlight        | `apps/docs`           |

The server is a single Go application. It applies its own database migrations at startup and serves Studio from files built into the server binary.

## Run Tilecast locally

You need Go, Node.js 22 or later, npm, Docker, and a PostgreSQL database. `apps/server/go.mod` sets the Go version. From the repository root:

1. Install dependencies:

   ```sh
   make bootstrap
   ```

2. Point the server at your development database. The server doesn't start without it:

   ```sh
   export TILECAST_DATABASE_URL='postgres://localhost:5432/tilecast?sslmode=disable'
   ```

3. Start the server:

   ```sh
   make dev-server
   ```

4. In a second terminal, start Studio:

   ```sh
   make dev-dashboard
   ```

Studio reloads when you change its code. Restart the server after you change Go code. The server reads the rest of its settings from `TILECAST_*` environment variables. `deploy/docker/.env.example` shows the common ones.

Before you open a pull request, run the checks:

```sh
make check
```

## Work on these docs

The documentation site is the `@tilecast/docs` workspace. From the repository root:

```sh
npm run docs:dev
```

Follow the [docs writing style](https://github.com/gbyo/tilecast/blob/main/apps/docs/STYLE.md) when you add or change a page.

## Go further

- [Contributing guide](https://github.com/gbyo/tilecast/blob/main/CONTRIBUTING.md)
- [Development setup](https://github.com/gbyo/tilecast/blob/main/docs/development.md)
- [Architecture](https://github.com/gbyo/tilecast/blob/main/docs/architecture.md)
- [Android development](https://github.com/gbyo/tilecast/blob/main/docs/android-development.md)
