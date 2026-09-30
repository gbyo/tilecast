# Backups and Upgrades

A complete Tilecast backup needs both PostgreSQL and the entire Tilecast data volume.

## What to back up

### PostgreSQL

Contains:

- organization and users
- screens and credentials
- playlists and assignments
- groups and schedules
- settings and policies
- audit and operational state
- media metadata
- update deployment state

### `/data`

The `tilecast_data` volume contains:

- `/data/media/originals`
- `/data/media/variants`
- `/data/media/thumbnails`
- resumable upload state
- `/data/updates`

Restoring only PostgreSQL produces records that point to missing files. Restoring only `/data` produces files with no matching records.

Also back up deployment configuration separately. Do not place copied secrets in the repository or in public documentation.

## Consistent backup window

For a simple single-server installation, stop Tilecast Server while leaving PostgreSQL running. This prevents new uploads and configuration changes while the snapshots are taken.

From the repository root:

```sh
docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   stop server
```

Dump PostgreSQL:

```sh
docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   exec -T postgres   sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'   > tilecast-postgres.dump
```

Find the actual data-volume name:

```sh
docker volume ls --format '{{.Name}}' | grep tilecast_data
```

Archive it, replacing `YOUR_TILECAST_DATA_VOLUME`:

```sh
docker run --rm   -v YOUR_TILECAST_DATA_VOLUME:/source:ro   -v "$PWD":/backup   alpine   tar -czf /backup/tilecast-data.tar.gz -C /source .
```

Restart the server:

```sh
docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   start server
```

Store the database dump, data archive, and deployment configuration together in protected backup storage.

## Test restores

Do not count a backup as valid until it has been restored to a separate test installation.

During a restore, the database and `/data` snapshot must come from the same backup window. Verify:

- Owner login
- screen records
- content thumbnails
- playlist contents
- schedule preview
- media delivery
- Player release records

Tilecast does not currently provide a one-click restore workflow. Treat restore commands as administrative database and Docker-volume work.

## Upgrade checklist

1. Read the release notes.
2. Confirm the release is intended for Tilecast Server, Tilecast Player, or both.
3. Back up PostgreSQL and `/data`.
4. Record the current image tag, source commit, and environment file.
5. Upgrade during a maintenance window.
6. Start the stack.
7. Check `/healthz` and `/readyz`.
8. Review server logs for migration or media-worker errors.
9. Confirm Studio login.
10. Confirm several representative players remain online and playing.
11. Deploy Player APK updates separately through **Settings → Player updates**.

## Stable server upgrade

Normal installs run a published server image, so a Stable upgrade is a version change, not a source rebuild.

If this installation still uses the former Compose file with a `build:` section under `server`, update the deployment files once first (pull them in the existing checkout) and confirm the Compose file now selects a published image through `TILECAST_VERSION`. Later upgrades never touch the checkout again.

```sh
# Take and verify a backup first.
# Set TILECAST_VERSION in deploy/docker/.env to the desired release.
docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   pull
docker compose   --env-file deploy/docker/.env   -f deploy/docker/compose.yml   up -d
```

Database migrations run before the server begins accepting traffic. Preserve the `postgres_data` and `tilecast_data` volumes. To deliberately track main instead of Stable releases, set `TILECAST_VERSION=development`; it may be unstable.

## Rollback warning

Do not assume an older server image can read a database after newer migrations have run.

A safe rollback usually requires restoring the matching pre-upgrade PostgreSQL and `/data` backup, not merely changing `TILECAST_VERSION` back.
