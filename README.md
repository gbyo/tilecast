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
  Self-hosted digital signage for Android TV, Fire TV, Google TV, Linux, and Windows.
</p>

<p align="center">
  <a href="https://tilecast.org/">Documentation</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
  ·
  <a href="LICENSE">License</a>
</p>

---

Tilecast is a self-hosted digital signage system.

Run the server on your own hardware, build and schedule content in **Tilecast Studio**, and pair screens running **Tilecast Player**. There is no hosted Tilecast control plane and no subscription required to keep your screens running.

## What it does

Build playlists and multi-zone layouts from images, video, websites, widgets, and live data. Schedule them to individual screens or groups, temporarily take over displays, and see what your players are doing from Studio.

Players cache the content they need, so a temporary network or server outage does not turn into a wall of blank screens.

Tilecast also includes:

- reusable Data Sources for things like calendars, feeds, weather, JSON, and CSV
- built-in and plugin-provided Widgets
- screen groups, remote commands, health reporting, and live previews
- publishing and review workflows for teams
- an API, webhooks, integration tokens, and Prometheus-compatible metrics
- installable plugins for optional features such as forms and emergency alerts

See [the documentation](https://tilecast.org/) for the full feature set.

## Players

Tilecast Player runs on Android-based signage devices, Linux, and Windows.

Android support covers Android TV, Google TV, Fire TV, and compatible dedicated players. The repository also contains the Linux players and **Tilecast Edge**, the newer Linux player architecture built around Tilecast's shared Player Runtime. **Tilecast Player for Windows** is the native Windows host of the same shared Player Core and Player Runtime, for Windows 10 and Windows 11 PCs on x64 and ARM64; see [`docs/tilecast-windows.md`](docs/tilecast-windows.md).

Player development and platform-specific details live in [`apps/`](apps/) and [`docs/`](docs/).

## Run Tilecast

You need Docker Engine and Docker Compose v2.

Create the environment file:

```sh
cp deploy/docker/.env.example deploy/docker/.env
```

Set a strong `POSTGRES_PASSWORD` in `deploy/docker/.env`.

For a local HTTP installation, keep:

```env
TILECAST_COOKIE_SECURE=false
```

Normal installs run a published Stable server image selected by `TILECAST_VERSION` in `deploy/docker/.env` (`stable` follows Stable releases; pin a release such as `0.11.0` for controlled upgrades). Then start Tilecast:

```sh
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d
```

Open [http://localhost:8080](http://localhost:8080) and follow the setup flow to create your organization and first Owner account.

For production installs, player setup, reverse proxies, updates, and operations, see **[tilecast.org](https://tilecast.org/)**.

## Development

Tilecast is a monorepo containing the Go server, React/TypeScript Studio, Android Player, Linux players, Windows Player, shared Player Runtime, plugins, and documentation.

The development toolchain is defined in `mise.toml`.

```sh
make bootstrap
make doctor
```

Run the server and Studio:

```sh
make dev-server
make dev-dashboard
```

Before submitting a change:

```sh
make check
make build
```

See [Development](docs/development.md) for area-specific setup, including Android, Edge, media, plugins, and documentation.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before making a change.

## License

Tilecast is licensed under the [GNU Affero General Public License v3.0](LICENSE).
