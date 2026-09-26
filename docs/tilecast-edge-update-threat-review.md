# Tilecast Edge updater: threat-boundary review

This is the written threat-boundary review that the Edge security invariants require for a new root operation ([`tilecast-edge-next.md`](tilecast-edge-next.md), invariant 16; [`tilecast-edge.md`](tilecast-edge.md) §4.3). It covers the M10 update path: the root helper `tilecast-edge-update`, its socket and its guard units, the update coordinator in `tilecastd`, and the server's part in a Tilecast Edge deployment. Read it before you change `apps/edge/tilecast-edge-update`, `apps/edge/crates/edge-release`, `apps/edge/tilecastd/src/update.rs`, the helper's units in `apps/edge/packaging/systemd`, or the `edge` family code in `apps/server/internal/updates`.

The migrator has its own review, [`tilecast-edge-migration-threat-review.md`](tilecast-edge-migration-threat-review.md). The two share the release installer (`edge-release`) and the release signing key.

## 1. Trust boundaries

```text
 Tilecast Server (release authority)
   | verifies the signed envelope at import; authorizes a deployment
   | install_player_update command, update metadata, artifact (device credential)
   v
 tilecastd (tilecast account; tilecast-edge.service)
   | verifies the envelope again; downloads into the content store (resume, SHA-256)
   | durable job in state.db; decides when to activate and when to confirm
   |
   |  /run/tilecast-edge-update/update.sock   root:tilecast 0660
   |  one JSON line per connection; five fixed operations
   v
 tilecast-edge-update serve (root; tilecast-edge-update.service, socket activated)
   | peer: tilecast UID and the tilecast-edge.service cgroup only
   | verifies envelope, archive, inner manifest, every file; stages; activates
   | root transaction: /var/lib/tilecast-edge-update/transaction.json (0600)
   v
 /opt/tilecast-edge/<version>/, current, units and system files, systemd
   ^
   | rolls back a candidate that does not confirm
 tilecast-edge-update guard (root; the previous release's binary)
   tilecast-edge-update-guard.service at boot, before the Edge units
   tilecast-edge-update-guard.timer every 30 s while an update is provisional
```

| Boundary                          | What crosses it                                                                                                     | Direction of trust                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Server to `tilecastd`             | The command payload, the update metadata (with the signed envelope), the archive bytes.                             | Untrusted until the envelope signature and the archive digest verify.                 |
| `tilecastd` to the helper         | An artifact digest, the envelope and its signature, a version name, a reason code.                                  | Untrusted. The helper verifies everything again and takes no path, unit or command.   |
| The content store to the helper   | The bytes of one object, which the `tilecast` account owns and can change.                                          | Untrusted. The helper copies them into a private file and verifies the copy.          |
| The candidate release to the host | Binaries, units and system files of a release signed with the Tilecast key.                                         | Trusted for what it is signed as. A signed release that does not work is rolled back. |
| The daemon's status to the helper | `status.get` over the Edge socket, read only for the confirmation check and after a rollback.                       | Untrusted. It can delay a confirmation or cause a rollback, never a root action.      |
| The candidate to its own rollback | Nothing. The guard runs the previous release's binary, from units the previous helper wrote, before the Edge units. | The candidate cannot stop, change or delay the guard.                                 |

## 2. Authority

### 2.1 The Tilecast Server

The server is the only release authority. An Edge release is a Player release of the `edge` family (`player_releases.player_family`), with an architecture (`x86_64` or `aarch64`). The server:

- imports a release from GitHub or from the owner's upload only after it verifies the envelope signature with the configured update key (`TILECAST_UPDATE_MANIFEST_PUBLIC_KEY`, or the built-in key), the Edge envelope rules (`validateEdgeManifest`) and the archive's size and SHA-256;
- keeps one version per family and architecture, and refuses a version code that is not newer than every imported release of that family and architecture;
- targets an Edge deployment only at screens whose heartbeat reports `playerFamily: "edge"` and the release's architecture. Other Edge screens are `incompatible`, and Electron and Android screens are not targeted. An Electron release never reaches an Edge screen;
- serves the archive only to a targeted screen of an active deployment (`/api/v1/player/updates/{releaseId}/artifact`, device credential, range requests);
- settles an Edge target as `succeeded` only on the screen's explicit `succeeded` report, never from a heartbeat with the new version code. A `failed` report with `installerStatus: "rolled_back"` pauses a canary.

The server has no Edge-specific endpoint. The Edge rules are rules of the existing Player Updates model.

### 2.2 `tilecastd`

`tilecastd` runs as `tilecast`, holds the device credential, and never runs as root or starts a process. For an update it:

- validates the `install_player_update` payload (UUIDs, `playerFamily: "edge"`, version code, artifact digest, mode, bounded window time) and writes a durable job (migration 0006). The command handler returns at once (`update_accepted`); the job is the at-most-once record;
- fetches the metadata and verifies the envelope signature with the same key, the envelope's architecture against `std::env::consts::ARCH`, and that the envelope, the metadata and the command agree on version, digest and size. A release whose state schema is older than this database's schema is refused before download (`update_schema_incompatible`);
- downloads the archive through the content store (`Domain::Update`), pinned before the first byte, with range resume and full SHA-256 verification before the object exists;
- asks the helper to stage, then, when the mode, the maintenance window, the absence of a takeover and a live server link allow it, to activate;
- as the candidate, asks the helper to confirm only after the confirmation rules hold for 120 s (§6), and reports every job state to the server.

A compromised `tilecast` account can therefore choose when to ask the helper for one of its operations, with the digests and version names that it chooses. §4 shows why that gives it no root action beyond installing a genuinely signed, newer release, or undoing a provisional one.

### 2.3 `tilecast-edge-update`

The helper is the only root process of the update path. It has five operations and no other entry point.

| Operation  | Input from the request                                       | What it does                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`   | none                                                         | Returns the current release, the installed version names (at most 16) and the open or last transaction. Takes no lock.                                                                    |
| `stage`    | `artifactSha256`, `envelope` (base64), `signature` (base64)  | Verifies the envelope; copies the content-store object named by the digest into a private file while it hashes it; verifies and unpacks the archive into `/opt/tilecast-edge/<version>/`. |
| `activate` | `versionName`                                                | Writes `ActivateIntent`, answers, then arms the guard and makes the staged, verified, newer release current and provisional.                                                              |
| `confirm`  | `versionName`                                                | Checks the running candidate's own status (§6) and ends the provisional window.                                                                                                           |
| `rollback` | `reason` (lowercase ASCII, digits and `_`, at most 64 bytes) | Returns to the previous release while the transaction is provisional. Refused after a confirmation.                                                                                       |

The same binary has four command-line modes for root: `serve` (the socket unit's service), `guard` (the guard units), `status` and `rollback` (an operator). The command line takes no path, version or unit.

## 3. The socket and its peers

- `tilecast-edge-update.socket` listens on `/run/tilecast-edge-update/update.sock`, owner `root`, group `tilecast`, mode 0660, in a directory of mode 0755. `Accept=no`: one helper process serves connections one at a time and exits after 60 s without one.
- The helper reads the peer's credentials (`SO_PEERCRED`). The UID must be the `tilecast` account's, and `/proc/<pid>/cgroup` must place the process exactly in `/system.slice/tilecast-edge.service` on the unified hierarchy. Root and every other unit of the `tilecast` account, including the renderer and the session bridge, get `peer_not_allowed` before the helper reads a request.
- The renderer unit also has `InaccessiblePaths=-/run/tilecast-edge-update`, so the renderer cannot reach the socket file.
- Root uses the command line (`tilecast-edge-update status`, `rollback`), not the socket.
- A request is one line of at most 64 KiB, read within 10 s. The envelope may be at most 16 KiB and the signature at most 1 KiB before base64 decoding; a longer base64 text is refused without decoding. Unknown fields are refused (`deny_unknown_fields`).
- Every operation except `status` takes an exclusive `flock` on `/var/lib/tilecast-edge-update/lock`, which the guard also takes, so one update operation runs at a time. A request that waits more than 300 s gets `update_busy`.

The real-systemd test (`apps/edge/ci/update_e2e.py`) sends a request from a transient unit as root and as `tilecast`, and checks that both get `peer_not_allowed`.

## 4. Inputs and how they are handled

### 4.1 The artifact: content store to a private copy

The helper never takes a path. It builds the content-store path from the validated digest and a fixed root: `/var/lib/tilecast-edge/cas/sha256/<first two hex>/<64 hex>`.

- It opens the object one path component at a time from `/`: each directory with `openat` and `O_DIRECTORY | O_NOFOLLOW` relative to the one before it, and the object with `O_NOFOLLOW`, `O_NONBLOCK` and `O_NOCTTY`. No component of the path can be a link, and a FIFO cannot block the open. This gives the same result as `openat2` with `RESOLVE_NO_SYMLINKS`. The helper does not use `openat2`, because its `RestrictSUIDSGID=` seccomp filter makes `openat2` fail with `ENOSYS` (the filter cannot read the file mode in the argument structure of `openat2`). The real-systemd test found this failure; the sandbox did not change.
- The open file must be a regular file owned by the `tilecast` account, of exactly the envelope's `artifactSizeBytes`.
- The helper copies the file into `/var/lib/tilecast-edge-update/work/archive.partial` (root, mode 0600, `O_CREAT | O_EXCL | O_NOFOLLOW`, in a 0700 directory) and hashes the bytes as it copies. It stops at more bytes than the envelope names, and refuses a copy whose size or SHA-256 differs from the envelope (`artifact_digest_mismatch`). The copy needs the archive size plus 64 MiB of free space, or the stage fails with `insufficient_disk`.
- From then on only the private copy is read. The `tilecast` account can change the content-store object during or after the copy, but not the copy. This closes the time-of-check to time-of-use gap between the digest check and the unpack: the bytes that are verified are the bytes that are unpacked.
- The copy is removed when the stage ends, successful or not.

### 4.2 Outer signature: the update envelope

The envelope (`edge-release/src/envelope.rs`) binds the archive to the release inside it. The release build writes it with `apps/edge/release/envelope.py` and signs it with the Tilecast update key, with `openssl pkeyutl -sign -rawin`, the same step as the release manifest and the Linux Player's update manifest. There is no second key and no second algorithm.

The helper verifies, in this order:

1. The size (at most 16 KiB) and the Ed25519 signature over the exact bytes, with the trusted key. The key is compiled in. A root-owned override file (`/etc/tilecast-edge/release-signing-key`) that is not writable by group or others replaces it for custom builds.
2. The fields: `schemaVersion: 1`, `product: "tilecast-edge"`, `playerFamily: "edge"`, `platform: "linux"`, a known architecture, a valid version name whose version code matches, the archive name `tilecast-edge-<version>-<arch>.tar.zst`, a size between 1 byte and 4 GiB, lowercase SHA-256 digests, release notes of at most 4,000 characters and a positive state schema. Unknown fields are refused.
3. The architecture against this machine (`release_wrong_architecture`).
4. That the request's `artifactSha256` is the envelope's (`artifact_mismatch`).
5. That the version is newer than `current` (`update_not_newer`). A version that is already installed is verified again against the envelope's release-manifest digest, and is then not written again.

`tilecastd` and the server run the same signature and field checks on the same bytes before they download or import anything (Rust and Go implementations, both tested against the release build's own signed envelope).

### 4.3 The archive

The archive is read with pure Rust decoders (`ruzstd`, `tar`). Nothing is unpacked by the entry's own name, mode, owner or link target.

- First pass: the size and SHA-256 of the whole file against the envelope, then the release manifest and its signature, each exactly once, as regular entries of at most 1 MiB and 1 KiB.
- The SHA-256 of the manifest bytes must be the envelope's `releaseManifestSha256` before the signature is even parsed. Then the manifest signature, its version, version code and architecture against the envelope, and the SBOM's digest against the envelope's `sbomSha256`.
- Second pass: only directories and regular files are accepted. Every regular file must be a path of the signed manifest, at most once, with the manifest's size. A link, a device, a FIFO, a hard link, a duplicate, an extra path or a missing file stops the stage.
- Paths are relative, at most 512 bytes and 12 components, each of at most 128 bytes from `[A-Za-z0-9._+-]` and never `.` or `..`. At most 8,192 files, 1 GiB for one file and 4 GiB in total, and at most three times as many archive entries as files.

### 4.4 Inner manifest and the installed tree

Each file is written through the M7 verified writer: `O_CREAT | O_EXCL | O_NOFOLLOW` below a fresh `<version>.staging` directory, hashed while it is written, refused on a size or digest mismatch, and given the signed mode (only 0644 or 0755) explicitly, whatever the helper's umask. Directories are 0755. The tree is synced and renamed to `/opt/tilecast-edge/<version>/`. An installed version directory is never written again.

Before activation, and again before a rollback uses the previous release, the helper verifies the installed tree: the signature, every file's size, digest and mode, and that there is no extra entry or link in the tree (`verify_installed`). The activation also requires that the candidate's manifest digest is the one that the transaction recorded.

### 4.5 System files

The activation and the rollback install system files only from the release being made current, and only these fixed files ([`edge-release/src/manifest.rs`](../apps/edge/crates/edge-release/src/manifest.rs), `UNITS` and `USER_UNITS`):

- the units in `packaging/systemd/` (the Edge daemon, the renderer, the migration and self-test units, and the helper's socket and service) into `/etc/systemd/system`;
- `packaging/sysusers.d/tilecast-edge.conf` into `/usr/lib/sysusers.d`, `packaging/tmpfiles.d/tilecast-edge.conf` into `/usr/lib/tmpfiles.d`, `packaging/udev/70-tilecast-display.rules` into `/usr/lib/udev/rules.d` and `packaging/modules-load.d/tilecast-edge.conf` into `/usr/lib/modules-load.d`;
- the session bridge's user units into `/etc/systemd/user`, and its path unit's link in `default.target.wants`.

Each is written with a temporary file, `fsync`, `rename(2)` and a directory `fsync`, mode 0644. The names are constants of the crate; a release cannot add a file to this list. The guard units are not release files (§5.3).

## 5. The transaction, activation and rollback

### 5.1 The root transaction record

`/var/lib/tilecast-edge-update/transaction.json` is the helper's only durable state (directory 0700, file 0600, owner root, at most 256 KiB). A finished transaction moves to `previous.json`. It holds:

- a schema version (1) and a random transaction ID;
- the candidate and the previous release: version name, version code and the SHA-256 of the signed release manifest;
- the phase: `activate_intent`, `provisional`, `confirm_intent`, `confirmed`, `rollback_intent` or `rolled_back`;
- the boot ID (the kernel boot ID and the start time of PID 1) and the `CLOCK_BOOTTIME` start and deadline of the provisional window;
- the restart counts the window started from, a bounded reason code, whether the previous release refused a newer state schema, and at most 64 events of at most 200 characters.

It never holds a credential, a server address, a URL or anything from the server except the signed release identities. The real-systemd test checks the modes and that neither file contains a credential or a URL.

### 5.2 Activation

A phase is written durably before the side effects that it names, and every step can run again, so after a crash the guard finishes or undoes it.

1. `ActivateIntent`, after the checks: no open transaction, `current` is a valid installed release, the candidate is staged, verifies and is newer.
2. The helper answers the daemon, and then continues without it: the activation stops the daemon that asked.
3. It arms the guard (§5.3) before anything that runs changes.
4. It stops `tilecast-renderer.service`, then `tilecast-edge.service`, and waits for both stop jobs. The renderer stops first because WPE WebKit finds its helper processes under `/opt/tilecast-edge/current/lib/wpe`.
5. It verifies the candidate tree again, installs the candidate's system files (§4.5) and switches `current` with one `rename(2)`.
6. `daemon-reload`, then `systemd-sysusers` and `systemd-tmpfiles --create` with their fixed Edge configuration files.
7. `Provisional`, with the boot ID and a 600 s deadline.
8. It starts the daemon and then the renderer. `start` clears the unit's failed state, which also sets systemd's `NRestarts` to zero, so the candidate's restarts count from zero.

### 5.3 The guard, and why it runs the previous release

The guard is `tilecast-edge-update-guard.service` (enabled for `multi-user.target`, `Before=tilecast-edge.service tilecast-renderer.service`, `ConditionPathExists=/var/lib/tilecast-edge-update/transaction.json`) and `tilecast-edge-update-guard.timer` (every 30 s). The helper that starts the activation writes both from constants in `guard_units.rs`, and the only variable is the validated version name in `ExecStart=/opt/tilecast-edge/<previous>/bin/tilecast-edge-update guard`.

The guard runs the previous release's helper, not `current`, for these reasons:

- a candidate whose helper cannot start, or starts and fails, is still rolled back. The real-systemd test activates a release whose daemon and helper both exit at once;
- the candidate's unit files cannot change the guard, because the guard units are not release files and the candidate's system files do not include them;
- the previous release is known to run on this machine; the candidate is not.

On each run the guard reads the transaction and:

| Phase                        | Guard action                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActivateIntent`             | Rolls back (`activation_interrupted`).                                                                                                                                              |
| `Provisional`, another boot  | Rolls back (`rebooted_while_provisional`), before the Edge units start.                                                                                                             |
| `Provisional`, deadline past | Rolls back (`confirmation_timeout`).                                                                                                                                                |
| `Provisional`, crashing      | Rolls back when the daemon restarted more than 3 times or the renderer more than 5 times (`candidate_*_restarting`), or when systemd gave up on either unit (`candidate_*_failed`). |
| `Provisional`, otherwise     | Starts only a unit that is stopped (an activation interrupted before its start). It never restarts a running or restarting unit, because that would reset the restart evidence.     |
| `ConfirmIntent`              | Finishes the confirmation.                                                                                                                                                          |
| `RollbackIntent`             | Finishes the rollback.                                                                                                                                                              |
| `Confirmed`, `RolledBack`    | Disarms the guard and archives the record.                                                                                                                                          |

The socket-activated helper runs the same check each time it starts, before it serves a request.

### 5.4 Rollback

Rollback is idempotent: `RollbackIntent`, stop the renderer and the daemon, verify the previous tree against the recorded manifest digest, install the previous release's system files, switch `current`, `daemon-reload`, `systemd-sysusers` and `systemd-tmpfiles`, start the daemon and the renderer, disarm the guard, `RolledBack`, archive.

- If the previous tree does not verify, the helper starts whatever `current` names, so the screen does not stay dark, keeps the transaction in `RollbackIntent` with `previous_release_corrupt`, and the guard tries again. It never switches to an unverified tree.
- A rollback that the daemon or an operator asks for waits up to 60 s for the previous daemon's status, to record a refused newer state schema (§8). A rollback by the guard does not wait: the Edge units are ordered after the guard, so the previous daemon cannot start until the guard exits.
- The candidate stays installed until a later confirmation's retention removes it. It is never activated again unless the server deploys it again.

### 5.5 Power loss

The candidate is provisional until it confirms. An unconfirmed candidate is rolled back after a power loss even if it was healthy before it: the guard sees a different boot ID and rolls back before the Edge units start. The next deployment decides whether to try it again. This keeps one rule, "a release that did not confirm in the boot it was activated in is not trusted", instead of a second probation that would have to prove health after a boot.

Crash and power-loss tests cover every durable transition: 19 crash points for activation, confirmation and rollback, each with and without a power loss (`tilecast-edge-update/src/crash_tests.rs`), and a real power loss of the systemd container while a healthy candidate is provisional (`update_e2e.py`, scenario B).

## 6. Confirmation

The candidate `tilecastd` asks for confirmation only when all of these hold without a break for 120 s (the Player Updates settle threshold):

- the server link is connected, with contact after this daemon started and at most 120 s old;
- the renderer is ready and not in safe mode;
- the current presentation is not the safe-mode or fixture surface, the renderer accepted it and reported meaningful evidence;
- for content that plays, the renderer's last progress moved during the period.

The helper does not trust that request alone. It reads the daemon's status over the Edge socket and refuses unless the running daemon is the candidate version in normal mode, its server link is connected with contact after its start, the renderer is connected and not in safe mode or showing an incompatible presentation, and the current activation is accepted with evidence. A refusal never rolls back; the deadline does.

Only after `Confirmed` does the daemon report `succeeded`, and only then does the server settle the target. A heartbeat with the new version code is not a confirmation.

## 7. Privilege and sandbox

### 7.1 What the helper can reach

`tilecast-edge-update.service` and the guard service share one sandbox. The real-systemd test reads it back from systemd and from the running process.

| Setting                                                                                                                                     | Effect                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_FSETID`                                                | Root, with only the file capabilities that installing files and running `systemd-tmpfiles` need. No `CAP_SYS_ADMIN`, no `CAP_NET_*`.  |
| `NoNewPrivileges=yes`, `RestrictSUIDSGID=yes`                                                                                               | No gain of privilege through an executed file. `RestrictSUIDSGID=` also blocks `openat2` (§4.1).                                      |
| `ProtectSystem=strict` with `ReadWritePaths=/etc /opt/tilecast-edge -/var/lib/tilecast-edge` and the four Edge directories under `/usr/lib` | `/usr` (outside those four directories), `/boot` and `/efi` are read-only. The state directory is writable through `StateDirectory=`. |
| `InaccessiblePaths=-/var/lib/tilecast-edge/identity`                                                                                        | The device credential's directory does not exist for the helper.                                                                      |
| `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`                                                                                      | No network. The helper reaches only D-Bus, the Edge socket and its own socket.                                                        |
| `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`                                                                                   | No home directories, no shared `/tmp`, no device nodes.                                                                               |
| `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`             | No kernel, cgroup, clock or hostname changes.                                                                                         |
| `LockPersonality`, `RestrictRealtime`, `RestrictNamespaces`, `MemoryDenyWriteExecute`, `SystemCallArchitectures=native`                     | Seccomp filters.                                                                                                                      |
| `UMask=0077`                                                                                                                                | Files the helper creates are private unless it sets a mode explicitly (release files and system files always are).                    |

`/etc` is writable because the helper writes units into `/etc/systemd/system` and `/etc/systemd/user`, and `systemd-sysusers` replaces the account databases in `/etc` by rename. The helper runs `systemd-sysusers` and `systemd-tmpfiles` inside this sandbox.

The helper unit is not enabled and has no dependency on `tilecast-edge.service`, because the activation stops that daemon and the helper must outlive it. `KillMode=process` and `TimeoutStopSec=15min` let an activation finish if the socket unit stops.

### 7.2 What the helper runs

- systemd, over D-Bus: `StartUnit`, `StopUnit`, `ResetFailedUnit`, `LoadUnit` and properties (`ActiveState`, `NRestarts`, job `State`), `EnableUnitFiles`, `DisableUnitFiles` and `Reload`. The unit names are the constants `tilecast-edge.service`, `tilecast-renderer.service`, `tilecast-edge-update-guard.service` and `tilecast-edge-update-guard.timer`.
- Two programs: `/usr/bin/systemd-sysusers /usr/lib/sysusers.d/tilecast-edge.conf` and `/usr/bin/systemd-tmpfiles --create /usr/lib/tmpfiles.d/tilecast-edge.conf`, with fixed absolute paths, fixed arguments, a cleared environment (`LANG=C` only), no standard input, and a 120 s timeout. There is no shell.
- Nothing else. No request, release, server string or daemon status becomes a unit name, a path to execute, an argument or an environment variable. The guard units' `ExecStart=` contains a version name that passed `is_version_name` (digits, dots and an optional `-` suffix of `[0-9A-Za-z.]`).

### 7.3 Secrets that the helper does not have

- the device credential (not readable in its mount namespace);
- the pairing secrets (in the same identity directory);
- the server address and any server session. The helper never connects to the server, and its unit has no network;
- the release signing key's private half, which is never on a screen.

The real-systemd test checks the running helper's environment and open file descriptors: no credential, no descriptor below `/var/lib/tilecast-edge/`, and Unix sockets only.

## 8. The state database and rollback

A candidate `tilecastd` migrates `state.db` after activation. The previous release's daemon refuses a database whose schema is newer than it knows (`state_db_newer_schema`, [`tilecast-edge.md`](tilecast-edge.md) §6.1) and runs in recovery mode instead of downgrading or changing it.

Therefore a candidate that migrated the database to a schema too new for the previous release cannot produce a fully working automatic rollback. The helper still restores the previous release, its units and its system files, and the screen shows the recovery surface, not the candidate. The database is never changed by the helper and never migrated backwards. There is no reverse SQL migration.

How the limitation is reduced and reported:

- `tilecastd` refuses a release whose envelope names a state schema older than its own database before it downloads anything (`update_schema_incompatible`);
- a rollback that the daemon or an operator asks for waits for the previous daemon and records `schemaIncompatible` in the transaction;
- after any rollback, the previous daemon's `tilecastctl status` shows recovery mode with `state_db_newer_schema`, and `tilecast-edge-update status` shows the rolled-back transaction and its reason;
- in recovery mode the daemon has no state, so it has no server binding and sends nothing. The server sees the screen stop reporting: Studio shows it `stale` and then `offline`, the deployment target stays at the last state the candidate reported, and a canary target that stays `installing` or `reconnecting` for ten minutes pauses the deployment;
- manual recovery: a deployment cannot reach a daemon in recovery mode, so an operator does the recovery on the screen. The operator installs a fixed release with the same or a newer state schema with `tilecast-edge-migrate install --from <release>` and restarts the Edge units, or restores a copy of the database from before the update. The helper keeps the database as it is for this.

## 9. Invariants

| Invariant                                               | How                                                                                                             | Proof                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Only signed, verified bytes become an installed release | Envelope signature, archive digest of the private copy, inner manifest signature, every file's digest and mode. | `edge-release` tests; `stage` refusal tests; the server's refused upload.     |
| Staging never activates                                 | `stage` writes only `/opt/tilecast-edge/<version>/`; only `activate` touches `current`, units or services.      | `edge-release` and crash tests; real-systemd scenario A.                      |
| An installed version never changes                      | `O_EXCL` staging and `rename(2)`; an existing version is verified, not written.                                 | `edge-release` tests.                                                         |
| One release is current, and it verifies                 | `current` changes by one `rename(2)`, only to a verified tree.                                                  | Crash matrix; real-systemd scenarios.                                         |
| A crash never confirms                                  | Only `ConfirmIntent`, written after the checks, leads to `Confirmed`.                                           | Crash matrix, with and without power loss.                                    |
| A candidate cannot stop its own rollback                | The guard runs the previous release's binary from non-release units, before the Edge units at boot.             | Crash tests; real-systemd scenarios B and C.                                  |
| The previous release stays until the candidate confirms | Retention runs only after `Confirmed`.                                                                          | Crash matrix; real-systemd scenario A.                                        |
| The renderer stops before `current` moves               | Fixed order in the activation and rollback.                                                                     | Real-systemd test (journal order of stop jobs and the helper's switch event). |
| Wrong family or architecture never installs             | Server targeting; the daemon's metadata checks; the helper's envelope checks.                                   | Server integration tests; `tilecastd` tests; `edge-release` tests.            |
| No generic root operation                               | Five operations, constant units, two fixed programs, no path or command input.                                  | Code review; peer and sandbox checks in the real-systemd test.                |

## 10. Residual risks

- **A signed release is trusted to run.** The key signs releases, and a signed release installs its units and runs as `tilecast` (the daemon) and as root (the helper's next start). The protection is the key, the release workflow and the server's authority. A signed but broken release is rolled back; a signed malicious release is not detected.
- **A compromised `tilecast` account can undo or delay.** It can ask for a rollback of a provisional release, withhold a confirmation until the deadline, or fake a good status to the helper. It cannot install an unsigned or older release, choose a path, or make the helper run anything. A faked status can only confirm the release that is already current and signed.
- **Root parses untrusted archive data.** The envelope and the manifest are parsed with `serde_json` after a size bound. The archive is decoded by `ruzstd` and `tar` in the root process, after the outer digest matched a signed envelope, so only bytes that the Tilecast key vouches for reach the decoders.
- **`/etc` is writable to the helper.** It needs to write units and lets `systemd-sysusers` replace the account files. A mistake in the helper could change other files in `/etc`. The writes are to constant names only.
- **The session bridge is not restarted by an update.** It is a user unit of the `tilecast` session. It keeps the binary it started with until the session restarts it, and it speaks the versioned IPC, so a new daemon accepts it or refuses it with a typed reason.
- **Transaction schema across releases.** The previous release's helper must read a transaction that the candidate's helper wrote (for a confirmation) and the other way round. Both refuse a newer transaction schema. A future change to the record must stay readable by the release before it, or the guard of an update across that change cannot finish.
- **Physical hardware.** The real-systemd test runs in a privileged container with headless WPE. Update and rollback on reference hardware, with DRM output and a real power cut, is M11.

## 11. Review checklist for changes

- A new side effect gets a durable phase or a crash point, and the crash matrix covers it with and without a power loss.
- A new unit name or system file is a constant of the crate, and is in the release manifest's required files.
- Nothing from a request, the server, a release file or the daemon's status becomes a unit name, a path to execute, an argument or an environment variable.
- A new read of `tilecast`-owned data uses the no-link, owner-checked open, and root uses only a private copy that it verified.
- The guard stays independent of the candidate: its binary is the previous release's, and its units are not release files.
- The helper's sandbox changes only with a real-systemd test run that shows why.
