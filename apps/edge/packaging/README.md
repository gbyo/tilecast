# Tilecast Edge packaging and migration

This directory has the system integration files for Tilecast Edge:

| File                                | Installed as                                    |
| ----------------------------------- | ----------------------------------------------- |
| `systemd/tilecast-edge.service`     | `/etc/systemd/system/tilecast-edge.service`     |
| `systemd/tilecast-renderer.service` | `/etc/systemd/system/tilecast-renderer.service` |
| `sysusers.d/tilecast-edge.conf`     | `/usr/lib/sysusers.d/tilecast-edge.conf`        |
| `tmpfiles.d/tilecast-edge.conf`     | `/usr/lib/tmpfiles.d/tilecast-edge.conf`        |

Binaries and the renderer runtime go under
`/opt/tilecast-edge/<version>/`, with `/opt/tilecast-edge/current` as a
symbolic link to the active version. The previous version directory stays in
place for rollback.

> **Status.** Edge enrolls, reconciles the signed change feed, reports Edge
> status and runs the peer fabric. It holds the normal player WebSocket with an
> HTTP heartbeat fallback, but does not yet fetch the server manifest or run
> commands. Studio shows online presence, and the screen does not play server
> content. Do not migrate a production screen until those work packages in
> [`docs/tilecast-edge-next.md`](../../../docs/tilecast-edge-next.md) are
> complete.

## Accounts and boundaries

- `tilecastd` runs as the fixed `tilecast` account (`sysusers.d`). On a
  machine migrated from the Electron player this account usually exists
  already as the kiosk login; `systemd-sysusers` leaves it unchanged.
- The renderer runs as the same account in its own unit. It can read the
  content store and cannot read `identity/` or the state database.
- Installation is a one-time privileged step. After it, nothing runs as root.
  `tilecastd` never replaces its own binaries.

## One-time installation and migration

Run these steps as root. The order is important: only one process may own the
device credential at a time.

1. Install the files in the table above and the version directory. Then run:

   ```sh
   systemd-sysusers
   systemd-tmpfiles --create /usr/lib/tmpfiles.d/tilecast-edge.conf
   systemctl daemon-reload
   ```

2. Optional: write `/etc/tilecast-edge/edge.toml` (root-owned). Check it:

   ```sh
   /opt/tilecast-edge/current/bin/tilecastd check-config
   ```

3. Stop and disable the legacy player. It is a systemd user unit of the kiosk
   account (`KIOSK` below):

   ```sh
   systemctl --user --machine="$KIOSK@" disable --now tilecast-player.service
   ```

4. Import the legacy state once. The command runs as `tilecast`. It refuses
   to run while `tilecast-edge.service` runs.

   - If `KIOSK` is `tilecast`:

     ```sh
     runuser -u tilecast -- /opt/tilecast-edge/current/bin/tilecastd import-legacy \
       --from /home/tilecast/.local/share/tilecast-player
     ```

   - If `KIOSK` is another account, copy the directory first. The copy keeps
     the original unchanged:

     ```sh
     install -d -o tilecast -g tilecast -m 0700 /var/lib/tilecast-edge/legacy-copy
     cp -a "/home/$KIOSK/.local/share/tilecast-player/." /var/lib/tilecast-edge/legacy-copy/
     chown -R tilecast:tilecast /var/lib/tilecast-edge/legacy-copy
     runuser -u tilecast -- /opt/tilecast-edge/current/bin/tilecastd import-legacy \
       --from /var/lib/tilecast-edge/legacy-copy
     ```

   The import normalizes the saved server address with the player's rules,
   reads `/api/v1/system/identity`, and requires the saved installation ID.
   Only then does it store the device credential. It copies verified cached
   media into the content store. It never changes, moves or deletes legacy
   files. Exit code 0 means imported or already imported; the summary is
   printed as JSON. Exit code 1 means nothing was bound; go to
   [Rollback](#rollback).

   The server must be reachable for this step. A server that reports a
   different installation ID stops the import before the credential is sent.

5. Start Edge:

   ```sh
   systemctl enable --now tilecast-edge.service tilecast-renderer.service
   ```

6. Verify:

   ```sh
   runuser -u tilecast -- /opt/tilecast-edge/current/bin/tilecastctl status
   ```

   Expect `identity` to become `enrolled` after the first server pass. The
   daemon generates its own Edge key and certificate request and enrolls with
   the imported credential.

Running the import again is safe. A completed import is not repeated.

## Rollback

The legacy state is never modified, so rollback does not need a backup.

```sh
systemctl disable --now tilecast-edge.service tilecast-renderer.service
systemctl --user --machine="$KIOSK@" enable --now tilecast-player.service
```

The legacy player uses its own saved credential, which is the same device
credential that Edge imported. Keep `/var/lib/tilecast-edge` until the Edge
installation is accepted; it holds the Edge node key and certificate. Delete
it only when the machine returns to the legacy player permanently.

A revoked credential stays revoked for both. Re-pair the screen in Studio in
that case.

## Removing Edge

1. Stop and disable both units.
2. Delete `/var/lib/tilecast-edge` and `/opt/tilecast-edge`.
3. Revoke or delete the screen in Studio if the machine will not play again.
   Revocation also revokes its Edge certificate.
