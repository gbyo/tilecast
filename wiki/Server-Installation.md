# Server Installation

The supported starting point is Docker Engine with Docker Compose v2.

## Files and services

The default Compose stack contains:

| Service       | Purpose                                                   |
| ------------- | --------------------------------------------------------- |
| `server`      | Tilecast API, Studio, media workers, and player endpoints |
| `postgres`    | PostgreSQL 17                                             |
| `cloudflared` | Optional Cloudflare Tunnel profile                        |

Persistent state is split between two Docker volumes:

| Volume          | Contents                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------- |
| `postgres_data` | Users, screens, playlists, schedules, settings, audit and operational state                   |
| `tilecast_data` | Uploaded media, generated variants, thumbnails, resumable uploads, and cached Player releases |

Both volumes are required for a complete restore.

## Basic installation

From the repository root:

```sh
cp deploy/docker/.env.example deploy/docker/.env
```

Edit `deploy/docker/.env`. At minimum, replace the PostgreSQL password:

```dotenv
POSTGRES_PASSWORD=use-a-long-random-password
```

Set the public URL to the exact origin used by browsers and players:

```dotenv
TILECAST_PUBLIC_URL=http://192.0.2.10:8080
TILECAST_COOKIE_SECURE=false
```

Select the installed server version. `TILECAST_VERSION` is the one place that selects it: keep `stable` to follow Stable releases, or pin an explicit release for controlled upgrades:

```dotenv
TILECAST_VERSION=stable
```

Start Tilecast:

```sh
docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   up -d
```

Open the configured URL and create the first Owner account.

## Local-network deployment

Plain HTTP is intended only for a trusted local network.

- Keep `TILECAST_COOKIE_SECURE=false`.
- Restrict port 8080 to the trusted LAN with the host firewall.
- Do not expose PostgreSQL.
- Give the server a stable address or stable local DNS name.
- Expect players to need manual server entry.

The Compose example disables mDNS because multicast discovery through Docker bridge networking is not dependable on every host. Discovery may also fail across VLANs, guest Wi-Fi, wireless client isolation, or routed networks.

## HTTPS reverse proxy

For any public hostname:

```dotenv
TILECAST_PUBLIC_URL=https://signage.example.org
TILECAST_COOKIE_SECURE=true
```

Proxy the hostname to Tilecast Server on port 8080. Keep the server and PostgreSQL on a private network. Preserve WebSocket upgrade headers.

Do not put a login gateway in front of player API routes unless the gateway is deliberately configured to allow Tilecast Player authentication. A browser-only access policy can prevent TVs from pairing, synchronizing, or reporting status.

## Cloudflare Tunnel

Cloudflare is optional. It is useful when remote players need to reach Tilecast without an inbound port forward.

1. Create a remotely managed tunnel in Cloudflare Zero Trust.
2. Add a public hostname with service `http://server:8080`.
3. Add the token to `deploy/docker/.env`:

   ```dotenv
   CLOUDFLARE_TUNNEL_TOKEN=your-token
   TILECAST_PUBLIC_URL=https://signage.example.org
   TILECAST_COOKIE_SECURE=true
   ```

4. Start the tunnel profile:

   ```sh
   docker compose      --env-file deploy/docker/.env      -f deploy/docker/compose.yml      --profile tunnel      up -d
   ```

The tunnel token is a secret. Do not commit it.

## Health checks

```sh
curl https://signage.example.org/healthz
curl https://signage.example.org/readyz
```

`/healthz` confirms the process is running. `/readyz` also checks dependencies required to serve the application, including database access, writable media storage, FFmpeg, and FFprobe.

View service state and logs:

```sh
docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   ps

docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   logs --tail=200 server postgres
```

## Important environment settings

The example environment file documents the supported deployment limits. Common ones include:

- `TILECAST_MAX_UPLOAD_BYTES`
- `TILECAST_MEDIA_WORKERS`
- `TILECAST_MEDIA_RESERVED_FREE_BYTES`
- `TILECAST_VIDEO_MAX_WIDTH`
- `TILECAST_VIDEO_MAX_HEIGHT`
- `TILECAST_VIDEO_MAX_FRAME_RATE`
- `TILECAST_WEBSITE_ALLOW_PRIVATE_HTTP`
- `TILECAST_MAX_EMERGENCY_DURATION_HOURS`
- `TILECAST_UPDATE_MANIFEST_PUBLIC_KEY`

Studio runtime settings can narrow deployment limits but cannot exceed them. Secrets, filesystem paths, database URLs, signing material, and hard security limits remain environment-controlled.

## Before production use

- Put public installations behind HTTPS.
- Back up both persistent volumes.
- Pin a known Tilecast Server release with `TILECAST_VERSION`.
- Test a full restore away from production.
- Test each actual TV device and firmware.
- Complete player commissioning and physical power verification.
- Record who has Owner and Administrator access.

See [[Backups and Upgrades]] and the repository's [deployment reference](https://github.com/Gibsonmb71/tilecast/blob/main/docs/deployment.md).
