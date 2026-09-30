# Quick Start

This path creates a local Docker installation, pairs one player, and assigns a basic playlist.

## 1. Start Tilecast Server

From the repository root:

```sh
cp deploy/docker/.env.example deploy/docker/.env
```

Open `deploy/docker/.env` and replace:

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-password
```

For a local HTTP installation, set the address players will use:

```dotenv
TILECAST_PUBLIC_URL=http://YOUR_SERVER_ADDRESS:8080
TILECAST_COOKIE_SECURE=false
```

Start the stack (this pulls the published Stable server image selected by `TILECAST_VERSION`):

```sh
docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   up -d
```

Check it:

```sh
curl http://127.0.0.1:8080/healthz

docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   ps
```

Open `http://YOUR_SERVER_ADDRESS:8080` in a browser.

For an internet-facing installation, stop here and follow [[Server Installation]] before creating accounts. Use HTTPS and set `TILECAST_COOKIE_SECURE=true`.

## 2. Create the organization

The first browser session opens the setup screen. Enter the organization name and create the first Owner account.

There is one organization per Tilecast installation.

## 3. Install Tilecast Player

Install the player on either supported platform:

- **Android TV device** (Fire TV, Google TV, Android TV): install the `tilecast-player.apk` via ADB.
- **Linux computer** (x86_64): download and run `tilecast-player.AppImage`.

See [[Install Tilecast Player]] for both platforms.

Launch the player and select the Tilecast server. LAN discovery may not work across VLANs, guest networks, AP isolation, or Docker bridge networking. Manual server entry is always available.

## 4. Pair the screen

The TV shows a six-character pairing code.

In Studio:

1. Open **Screens**.
2. Select **Pair screen**.
3. Enter the code.
4. Confirm the device details.
5. Give the screen a useful name and location.
6. Select **Approve and pair**.

Leave the code visible until enrollment finishes.

## 5. Finish player commissioning

The newly paired player opens its local setup wizard. Complete every step shown on the TV, including the maintenance PIN and any Android permissions requested for the selected reliability features.

A policy request is not the same as an Android permission. Studio does not mark protected capabilities ready until the player confirms them.

## 6. Add content

Open **Content** and choose **Add content**.

- Upload an image or video.
- Or create a Website or YouTube Source.

Wait until uploaded media shows **Ready** before using it in a playlist.

## 7. Create a playlist

Open **Playlists**, create a playlist, and add the ready content.

Items play from top to bottom and loop. Set image or website duration, video offsets, fit mode, transition, delivery policy, and audio as needed.

## 8. Assign fallback content

Open the screen, select the playlist as its direct assignment, and save.

The player downloads and verifies required files before changing playback. The previous working manifest remains active while new content prepares.

## Next steps

- Use [[Screens and Groups]] to organize a larger deployment.
- Use [[Schedules]] for recurring or one-time playback.
- Complete [[Reliability and Kiosk]] before treating a screen as unattended.
- Configure [[Backups and Upgrades]] before production use.
