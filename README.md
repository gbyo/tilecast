<h1 align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset=".github/logos/tilecast-logo-white.svg"
    >
    <source
      media="(prefers-color-scheme: light)"
      srcset=".github/logos/tilecast-logo-black.svg"
    >
    <img
      alt="Tilecast"
      src=".github/logos/tilecast-logo-black.svg"
      width="240"
    >
  </picture>
</h1>

<p align="center">
  <strong>Actually open source signage.</strong>
</p>

<p align="center">
  Self-hosted digital signage for Android TV, Fire TV, Google TV, and Linux.
</p>

<p align="center">
  <a href="https://github.com/Gibsonmb71/tilecast/wiki">Documentation</a>
  ·
  <a href="https://github.com/Gibsonmb71/tilecast/wiki/Install-Tilecast-Player">Install a Player</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
  ·
  <a href="LICENSE">License</a>
</p>

---

Tilecast is an open-source digital signage platform for organizations that want to run their own signage infrastructure without relying on a paid cloud service. Run the Tilecast Server on your own hardware, manage displays through **Tilecast Studio**, and connect Android TV or Linux devices running **Tilecast Player**.

## Features

- **Self-hosted** — your server, database, media, and players stay under your control.
- **Media library** — upload and organize images and videos with folders, collections, tags, availability dates, and expiration.
- **Playlists & layouts** — sequence content or build multi-zone screen layouts with media, widgets, text, shapes, and playlist zones.
- **Scheduling** — target content to screens and groups with scheduled assignments and takeovers.
- **Widgets** — clocks, countdowns, QR codes, websites, YouTube, tickers, menus, tables, agendas, weather, metrics, and more.
- **Data Sources** — connect reusable Calendar, RSS, Atom, JSON, CSV, weather, transit, alerts, manual data, and other structured sources to visual content.
- **Offline playback** — players cache content and continue operating when the server or network is temporarily unavailable.
- **Fleet management** — monitor screens, send remote commands, organize displays, manage groups, perform bulk changes, and view live previews.
- **Reliability tools** — unattended startup, watchdog recovery, safe mode, kiosk controls, and player health reporting.
- **Team workflows** — roles, content review, publishing controls, screen scopes, and multi-factor authentication.
- **Integrations** — API access, integration tokens, webhooks, notifications, and Prometheus-compatible fleet health.
- **Installable built-in plugins** — add only the optional features an installation needs: submission forms, countdown bars, emergency alerts, watermarks, noise meters. Plugins ship with Tilecast; installing one never downloads code.

See [Widgets, Data Sources, and Layouts](docs/widgets-and-layouts.md) for a detailed overview of Tilecast's content system.

## Players

Tilecast currently provides two Player platforms:

| Platform       | Support                                                     |
| -------------- | ----------------------------------------------------------- |
| **Android TV** | Fire TV, Google TV, and other compatible Android TV devices |
| **Linux**      | x86_64 signage computers with kiosk and systemd support     |
| **ARM Linux**  | Working on it                                               |

Both platforms support the core Tilecast playback system, including pairing, playlists, layouts, widgets, scheduling, offline caching, remote management, and live previews.

For installation and deployment:

- [Install Tilecast Player](https://github.com/Gibsonmb71/tilecast/wiki/Install-Tilecast-Player)
- [Reliability and Kiosk](https://github.com/Gibsonmb71/tilecast/wiki/Reliability-and-Kiosk)
- [Troubleshooting](https://github.com/Gibsonmb71/tilecast/wiki/Troubleshooting)

## Quick start

### Requirements

- Docker Engine
- Docker Compose v2

Clone the repository and create your environment file:

```sh
cp deploy/docker/.env.example deploy/docker/.env
```

Edit `deploy/docker/.env` and replace `POSTGRES_PASSWORD` with a strong password.

For a local HTTP installation, leave:

```env
TILECAST_COOKIE_SECURE=false
```

Start Tilecast:

```sh
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d --build
```

Then open:

```text
http://localhost:8080
```

Tilecast will guide you through creating the organization and first Owner account. Database migrations run automatically when the server starts.

Check the installation with:

```sh
curl http://localhost:8080/healthz
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml ps
```

For a production deployment, see [Deployment](docs/deployment.md).

## Documentation

The [Tilecast Wiki](https://github.com/Gibsonmb71/tilecast/wiki) contains setup and operational guides.

Technical documentation is also maintained in [`docs/`](docs/), including:

- [Deployment](docs/deployment.md)
- [Architecture](docs/architecture.md)
- [Widgets, Data Sources, and Layouts](docs/widgets-and-layouts.md)
- [Display Control](docs/display-control.md)
- [API](docs/api.md)
- [Integrations](docs/integrations.md)
- [Installable Built-in Plugins](docs/plugins.md)
- [Content Review](docs/content-review.md)
- [Multi-factor Authentication](docs/multi-factor-authentication.md)

## Development

Tilecast is primarily built with:

- **Go** — server
- **React + TypeScript** — Studio
- **Kotlin** — Android Player
- **Electron** — Linux Player
- **PostgreSQL** — database

See [Development Setup](docs/development.md) for local development instructions.

## Contributing

Contributions, bug reports, and improvements are welcome.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

## License

Tilecast is licensed under the [GNU Affero General Public License v3.0](LICENSE).
