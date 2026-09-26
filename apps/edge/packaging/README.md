# Tilecast Edge packaging, installation and migration

This directory has the system integration files for Tilecast Edge. `tilecast-edge-migrate` installs them from a signed release and runs the one-way migration from the Electron Linux Player. `tilecast-edge-update` installs later releases (M10, section 4). The design and its guarantees are in [`docs/tilecast-edge-next.md`](../../../docs/tilecast-edge-next.md) (M7), and the root-operation reviews are [`docs/tilecast-edge-migration-threat-review.md`](../../../docs/tilecast-edge-migration-threat-review.md) and [`docs/tilecast-edge-update-threat-review.md`](../../../docs/tilecast-edge-update-threat-review.md).

> **Status.** Edge plays server content, including synchronized groups (M6). It is qualified on the headless WPE platform only. Physical DRM and Wayland hardware qualification is M11. Do not migrate a production screen before the release notes say that its hardware class is qualified.

## Files

| File                                            | Installed as                             | Enabled                                                                                          |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `systemd/tilecast-edge.service`                 | `/etc/systemd/system/`                   | by the migrator, at the cutover                                                                  |
| `systemd/tilecast-renderer.service`             | `/etc/systemd/system/`                   | by the migrator, at the cutover                                                                  |
| `systemd/tilecast-edge-migrate.service`         | `/etc/systemd/system/`                   | never (started by `migrate`)                                                                     |
| `systemd/tilecast-edge-migrate-recover.service` | `/etc/systemd/system/`                   | only during a cutover                                                                            |
| `systemd/tilecast-edge-selftest.service`        | `/etc/systemd/system/`                   | never (a migration task)                                                                         |
| `systemd/tilecast-renderer-selftest.service`    | `/etc/systemd/system/`                   | never (a migration task)                                                                         |
| `systemd/tilecast-renderer-probe.service`       | `/etc/systemd/system/`                   | never (a migration task)                                                                         |
| `systemd/tilecast-edge-compat.service`          | `/etc/systemd/system/`                   | never (a migration task)                                                                         |
| `systemd/tilecast-edge-import.service`          | `/etc/systemd/system/`                   | never (a migration task)                                                                         |
| `systemd/tilecast-edge-update.socket`           | `/etc/systemd/system/`                   | by the migrator, at the cutover, with Edge                                                       |
| `systemd/tilecast-edge-update.service`          | `/etc/systemd/system/`                   | never (started by its socket)                                                                    |
| `sysusers.d/tilecast-edge.conf`                 | `/usr/lib/sysusers.d/tilecast-edge.conf` |                                                                                                  |
| `tmpfiles.d/tilecast-edge.conf`                 | `/usr/lib/tmpfiles.d/tilecast-edge.conf` |                                                                                                  |
| `udev/70-tilecast-display.rules`                | `/usr/lib/udev/rules.d/`                 |                                                                                                  |
| `modules-load.d/tilecast-edge.conf`             | `/usr/lib/modules-load.d/`               |                                                                                                  |
| `systemd-user/tilecast-session-bridge.service`  | `/etc/systemd/user/`                     | never (started by its path unit)                                                                 |
| `systemd-user/tilecast-session-bridge.path`     | `/etc/systemd/user/`                     | by `install`, for every user manager; `ConditionUser=tilecast` limits it to the tilecast account |

A release is installed under `/opt/tilecast-edge/<version>/`, and `/opt/tilecast-edge/current` is a symbolic link to the active version. The previous version directory stays in place. `tilecastd` never replaces its own binaries.

While an update is provisional, the helper also writes `tilecast-edge-update-guard.service` and `tilecast-edge-update-guard.timer` in `/etc/systemd/system/`. They are not part of any release, they run the previous release's helper, and the helper removes them when the update is confirmed or rolled back.

## Requirements

- Linux 5.6 or later (`openat2`), systemd 248 or later (`systemctl --machine=<user>@.host` and `StandardOutput=truncate:`). Debian 12 and later meet both.
- On a machine with the Electron player: the kiosk account's user manager runs at boot. The Electron player's installer turns on lingering for the account; if it is off, run `loginctl enable-linger <account>`.
- The screen's Tilecast Server is reachable during the migration. The import checks the installation identity before it keeps the credential.

## Accounts and boundaries

- `tilecastd` runs as the fixed `tilecast` account (`sysusers.d`). On a machine migrated from the Electron player the account can already exist as the kiosk login; `systemd-sysusers` leaves an existing account unchanged.
- The renderer runs as the same account in its own unit, which makes all of `/var/lib/tilecast-edge` inaccessible to it. It reads media only through daemon-granted capabilities on `/run/tilecast-edge/media.sock`.
- `tilecast-edge-migrate` runs as root only when an operator starts it or at boot to finish an interrupted attempt. It has no listener, sends nothing to the network and never reads the device credential.
- `tilecast-edge-update` runs as root only when its socket starts it for a request from `tilecastd`, or as the update guard. It refuses every peer that is not in `tilecast-edge.service`, has no network, and cannot see the device credential's directory. The migration tasks (self-test, output probe, compatibility check, import) run as `tilecast` in their own units.

## 1. Verify and install the release

A release is a directory tree with `tilecast-edge-release.json` (every file with its size, SHA-256 and mode) and `tilecast-edge-release.json.sig` (an Ed25519 signature with the Tilecast update key, the same key that signs Linux Player updates). Unpack it anywhere.

The first installation cannot verify the migrator with itself, so verify the manifest first with OpenSSL and the published public key, [`apps/edge/release/tilecast-update-key.pem`](../release/tilecast-update-key.pem) (the same key as the server's `DefaultUpdateManifestPublicKey`):

```sh
openssl pkeyutl -verify -rawin -pubin -inkey tilecast-update-key.pem \
  -in tilecast-edge-release.json \
  -sigfile <(openssl base64 -d -A -in tilecast-edge-release.json.sig)
```

Then, as root:

```sh
./bin/tilecast-edge-migrate install --from .
```

`install` verifies the signature again, copies exactly the signed files (each one hashed while it is copied, never through a link), switches `current`, installs the units and system configuration, and runs `systemd-sysusers` and `systemd-tmpfiles`. It enables no system unit. It does turn lingering on for `tilecast` and enables the session bridge's path unit for that account's session; the bridge runs only while `tilecastd`'s socket exists. It applies the display udev rule and loads `i2c-dev` when it can, and otherwise prints a warning: both take effect at the next boot. See the [threat-boundary review](../../../docs/tilecast-edge-migration-threat-review.md) §3.4.1. A changed or missing file stops it before `current` changes. Installing the same release again changes nothing.

For a custom build signed with your own key, put the base64 public key in `/etc/tilecast-edge/release-signing-key` (owned by root, not writable by group or others).

## 2a. Migrate from the Electron player

As root:

```sh
/opt/tilecast-edge/current/bin/tilecast-edge-migrate migrate --kiosk KIOSK
```

`KIOSK` is the account that runs the Electron player (its `tilecast-player.service` user unit). The command starts `tilecast-edge-migrate.service` and prints its progress. An SSH disconnect stops only the progress output; the migration continues.

The migration follows the binding sequence. It stops at the first failure:

| Step | What happens                                                                                                                               | On failure  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 1    | Verify the installed release again: the signature, every file, nothing extra.                                                              | refused     |
| 2    | Check that the kiosk account, its user manager and the legacy unit exist, and that Edge is not enabled.                                    | refused     |
| 3    | Self-test: read the DRM outputs as `tilecast`, and run the real daemon and renderer on the built-in fixture until each item is proven.     | refused     |
| 4    | Check the legacy player's cached presentation against the installed capability profile, offline.                                           | refused     |
| 5    | Hold the migration lock. Hold Edge's commands (probation). Enable the boot recovery.                                                       | rolled back |
| 6    | Disable and stop the legacy unit, the display manager and the console on tty1. Confirm that no legacy process runs.                        | rolled back |
| 7    | Leave the legacy AppImage, data and unit files where they are. Record their digests.                                                       |             |
| 8    | Copy the legacy state for the `tilecast` account and run `tilecastd import-legacy --refresh`. Remove the copy.                             | rolled back |
| 9    | Enable and start Edge.                                                                                                                     | rolled back |
| 10   | Settle: the server link, the renderer on DRM, the current presentation accepted with playback evidence and fresh progress, for 60 seconds. | rolled back |
| 11   | Accept: release Edge's commands, disable the boot recovery.                                                                                |             |

"Refused" means nothing was changed. "Rolled back" means: Edge is disabled and confirmed stopped, then the display session and the legacy unit are restored exactly as they were, and the legacy files are compared with their digests. The attempt's record, with the reason, is in `tilecast-edge-migrate status`.

Settlement has a deadline (`--settle-seconds`, default 600, from 120 to 3600). Some conditions roll back at once because waiting cannot help: a rejected credential, a presentation that the renderer cannot show, safe mode, or the legacy player running again.

A crash or power loss never accepts. After a crash of the migration service, its `ExecStopPost=` recovery rolls back at once. After a power loss during the cutover or settlement, `tilecast-edge-migrate-recover.service` rolls back at boot, before Edge or the display manager starts.

Exit code: 0 accepted, 1 refused or rolled back.

## 2b. Clean installation (no Electron player)

```sh
/opt/tilecast-edge/current/bin/tilecast-edge-migrate clean-install
```

The same self-test, then Edge is enabled and settles on its setup surface. If it cannot, Edge is disabled again and the display session is restored. Then pair the screen: type the server address on the setup surface, choose a server that LAN discovery found, or without a keyboard:

```sh
/opt/tilecast-edge/current/bin/tilecastctl pair https://signs.example.org
/opt/tilecast-edge/current/bin/tilecastctl status   # shows the code to approve
```

Approve the code in Studio.

## 3. The rollback window

Until the migration is accepted, an operator can roll back:

```sh
/opt/tilecast-edge/current/bin/tilecast-edge-migrate rollback
```

Acceptance ends the rollback window: `rollback` then refuses. The legacy player stays on disk, disabled. Removing it is a later maintenance action, not part of the cutover.

To migrate again after a rollback, run `migrate` again. The import runs with `--refresh`: executed command keys are only ever added, so a command that either player ran never runs again. While a migration settles, Edge runs no commands; they wait on the server for whichever player the migration leaves running.

## 4. Updates

After the migration or clean installation, Edge updates itself from the Tilecast Server. Upload the release in Studio (**Settings → Player Updates → Tilecast Edge**) or import it from GitHub, then deploy it to screens. See [`docs/player-updates.md`](../../../docs/player-updates.md).

An update goes through these steps:

1. `tilecastd` accepts the `install_player_update` command, checks the signed envelope (family, architecture, newer version, state schema), downloads the archive into its content store with resume, and verifies its size and SHA-256.
2. It asks the helper to **stage** the release. The helper copies the archive into its private directory while it hashes it, verifies the envelope, the inner manifest and every file, and installs `/opt/tilecast-edge/<version>/`. Nothing that runs changes.
3. **Activate**: the helper arms the guard, stops the renderer and then the daemon, installs the candidate's units and system files, switches `current` with one `rename(2)`, and starts the daemon and then the renderer. The candidate is provisional.
4. **Confirm**: the candidate daemon reconnects to the server and shows its presentation with fresh playback evidence. After 120 seconds of stable evidence it asks the helper to confirm, then reports success to the server. The helper disarms the guard and removes releases older than the previous one.
5. **Roll back**: a candidate that does not confirm in time, keeps restarting, or runs after a reboot is rolled back by the guard, which runs the previous release's helper. The previous units and `current` come back, the previous daemon starts, and it reports the failure to the server. The same deployment does not try the release again.

To inspect or undo an update, as root:

```sh
/opt/tilecast-edge/current/bin/tilecast-edge-update status
/opt/tilecast-edge/current/bin/tilecast-edge-update rollback   # only while provisional
```

A candidate that migrated the state database to a schema the previous release cannot read is restored as a binary, but the previous daemon refuses the database and shows its recovery surface (`state_db_newer_schema`). A deployment cannot reach a daemon in recovery mode, so recovery is manual: install a fixed release with the same or a newer schema with `tilecast-edge-migrate install --from <release>` (section 1) and restart `tilecast-edge.service` and `tilecast-renderer.service`, or restore a copy of the database from before the update. The helper never changes the database. See [`docs/tilecast-edge-update-threat-review.md`](../../../docs/tilecast-edge-update-threat-review.md) §8.

## Output

The migrator uses the DRM backend: the renderer owns the display on tty1 without a desktop session. A machine that must keep its desktop compositor cannot migrate with this release.

## Removing Edge

1. `systemctl disable --now tilecast-edge.service tilecast-renderer.service`.
2. Delete `/var/lib/tilecast-edge`, `/var/lib/tilecast-edge-migrate`, `/var/lib/tilecast-edge-update` and `/opt/tilecast-edge`, and the unit files listed above. Disable `tilecast-edge-update.socket` first.
3. Revoke or delete the screen in Studio if the machine will not play again.
