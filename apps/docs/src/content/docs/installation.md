---
title: Installation
description: Install Tilecast Server with Docker Compose and choose how browsers and Players reach it.
---

Tilecast Server runs with Docker Engine and Docker Compose v2. The Compose file in the Tilecast repository builds the server image and starts PostgreSQL next to it. Nothing in the default setup depends on an outside cloud service.

## Start the server

Run these commands from a clone of the [Tilecast repository](https://github.com/gbyo/tilecast).

1. Copy the example environment file:

   ```sh
   cp deploy/docker/.env.example deploy/docker/.env
   ```

2. Open `deploy/docker/.env` and replace `POSTGRES_PASSWORD` with a long random password.
3. Set `TILECAST_PUBLIC_URL` to the address that browsers and Players will use, for example `http://192.0.2.10:8080`.
4. Start Tilecast:

   ```sh
   docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d --build
   ```

5. Open the public URL in a browser. Tilecast asks you to name your organization and create the first Owner account.

The server applies database migrations each time it starts, so there's no separate migration step.

:::caution
If the server will be reachable from the internet, set up HTTPS before you create the Owner account. Use an `https://` public URL and set `TILECAST_COOKIE_SECURE=true`.
:::

## Choose how Tilecast is reached

| Setup                     | Use it when                                                             | Settings                                                             |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Local network over HTTP   | Every browser and Player is on a trusted local network.                 | `TILECAST_COOKIE_SECURE=false`, and limit port 8080 with a firewall. |
| HTTPS reverse proxy       | You have a hostname and a certificate.                                  | An `https://` public URL and `TILECAST_COOKIE_SECURE=true`.          |
| Cloudflare Tunnel profile | Players at other sites need to connect without opening an inbound port. | The optional `tunnel` Compose profile and a tunnel token.            |

Players normally connect by address. Automatic discovery on the local network is off in the default Compose setup, because multicast doesn't pass reliably through Docker bridge networking, VLANs, or guest Wi-Fi. Typing the server address on the Player always works.

Passkeys need HTTPS and a hostname. On a plain HTTP installation, or one reached by IP address, accounts can still use an authenticator app and recovery codes.

## Check that it's running

```sh
curl http://192.0.2.10:8080/healthz
```

`/healthz` answers when the server process is running. `/readyz` also checks the database, media storage, FFmpeg, and FFprobe, and returns HTTP 503 when one of them is unavailable.

## Keep both volumes

Tilecast stores its state in two Docker volumes:

- `postgres_data` holds users, screens, playlists, schedules, settings, and history.
- `tilecast_data` holds uploaded media, the processed copies Tilecast makes for playback, thumbnails, and cached Player releases.

A backup needs both. Restoring only one of them leaves records without files, or files without records.

## Go further

The detailed deployment reference, including every environment setting, is in the repository: [Deployment](https://github.com/gbyo/tilecast/blob/main/docs/deployment.md) and [Cloudflare Tunnel](https://github.com/gbyo/tilecast/blob/main/deploy/cloudflare/README.md).
