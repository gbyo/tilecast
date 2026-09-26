# Tilecast Edge migrator: threat-boundary review

This is the written threat-boundary review that the Edge security invariants require for a new root operation ([`tilecast-edge-next.md`](tilecast-edge-next.md), invariant 16). It covers `tilecast-edge-migrate` (M7) and the units it starts. Read it before you change `apps/edge/tilecast-edge-migrate`, the units in `apps/edge/packaging/systemd` or the `tilecastd` commands that the migrator runs.

## 1. What runs as root, and when

`tilecast-edge-migrate` runs as root only in these cases:

| Case                          | How it starts                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `install --from DIR`          | An operator runs it.                                                                                                                        |
| `migrate` and `clean-install` | An operator runs it. It writes a request and starts `tilecast-edge-migrate.service`, which runs `run`.                                      |
| `recover`                     | `ExecStopPost=` of `tilecast-edge-migrate.service`, and `tilecast-edge-migrate-recover.service` at boot while an attempt is in its cutover. |
| `rollback`                    | An operator runs it during the rollback window.                                                                                             |

It is not a daemon. It has no listener, it sends nothing to the network (`IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`), and it takes no input from the Tilecast Server. It is not a generic helper: the operations are the fixed list above, and each one has a fixed set of units and paths.

## 2. Assets

| Asset                                     | Why it matters                                                    |
| ----------------------------------------- | ----------------------------------------------------------------- |
| The device credential (`credential.json`) | It authenticates the screen. Only one stack may use it at a time. |
| The machine's root account                | A mistake in a root process is a mistake with the whole machine.  |
| The legacy player's files                 | They are the rollback. They must not change before acceptance.    |
| The installed release                     | Code that the `tilecast` account runs on every boot.              |
| The display                               | A failed cutover must not leave a dark screen.                    |

## 3. Trust boundaries and untrusted inputs

### 3.1 The kiosk account's files

A compromised Electron player controls everything that the kiosk account owns: the legacy data directory, the user unit and its drop-ins, and the environment that the unit sets. The migrator treats all of it as untrusted:

- **Account name.** From the operator's `--kiosk`, checked against a strict login-name pattern and looked up in `/etc/passwd`. The UID must be 1000 or more and not 65534. The name is an argument to `systemctl` only in `--machine=<name>@.host`, and never in a shell.
- **Data directory.** Read from the legacy unit's `Environment` (`TILECAST_DATA_DIR`, then `XDG_DATA_HOME`, then the player's default). The path must be absolute and have only plain components. The migrator opens it with `openat2(RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)`, so no component can be a link, and requires the directory to be owned by the kiosk UID.
- **Files in it.** Opened only by fixed names, relative to the directory descriptor, with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, `O_NOFOLLOW` and `O_NONBLOCK`. Each must be a regular file owned by the kiosk UID and at most 16 MiB. A link, a FIFO or a device is not read. The integration test plants a link to `/etc/shadow` where a state file belongs and checks that it is ignored.
- **Media names.** Root parses the copied `manifest-active.json` to find which cached media to copy. It keeps only asset and variant IDs of plain characters, at most 10,000 entries, and copies a file only if its size is the listed size. The bytes are verified later by the unprivileged importer; root never trusts them.
- **The credential file.** Root copies its bytes and never parses them, logs them or holds them longer than the copy. The copy is removed after the import, on success or failure, and again by every rollback.

### 3.2 Files root writes for the `tilecast` account

The Edge state directory is owned by `tilecast`. A compromised `tilecast` account could try to redirect a root write with a link. The migrator:

- opens `/var/lib/tilecast-edge` with `RESOLVE_NO_SYMLINKS` and requires it to be owned by `tilecast`;
- creates `legacy-copy` itself, as root, with mode 0700, and fills it through its descriptor with `O_CREAT | O_EXCL | O_NOFOLLOW`;
- hands each file and directory to `tilecast` with `fchown` on the open descriptor, and the top directory last, so the `tilecast` account cannot add anything while root fills it.

The compatibility input is copied into `/run/tilecast-edge-migrate/compat` (root-owned, mode 0750, group `tilecast`). It holds only the cached manifest, not the credential.

### 3.3 The release

- **Signature.** Ed25519 over the exact bytes of `tilecast-edge-release.json`, with the same key and the same `openssl pkeyutl -sign -rawin` step as the Linux Player update manifest. The trusted key is compiled in. A root-owned override file (`/etc/tilecast-edge/release-signing-key`) that is not writable by group or others replaces it for custom builds.
- **Domain separation.** The manifest must say `product: "tilecast-edge"` and `platform: "linux"` and name this machine's architecture, so a signed Linux Player manifest is never an Edge release.
- **Paths.** Only paths in the signed manifest are installed. Each is relative with plain components, at most 12 deep. No file may also be a directory of another file. The required files and units must be present.
- **Bytes.** Each source file is opened without following links, must be a regular file of the signed size, and is hashed while it is copied. A mismatch stops the install before `current` changes. Modes are only 0644 or 0755 and are set explicitly.
- **Atomicity.** The tree is built in `<version>.staging`, renamed into place, and `current` is switched with one `rename(2)`. An installed version directory is never overwritten.
- **Before each migration.** The installed tree is verified again: the signature, every file's size, digest and mode, and no extra entry or link in the tree.
- **Bootstrap.** The first verifier cannot verify itself. The operator verifies the downloaded manifest with `openssl pkeyutl -verify` before the first `install` (the command is in the packaging README).

### 3.4 systemd

- **System manager.** Reached over D-Bus. The migrator starts, stops, enables and disables only units from a fixed list in the crate, plus the unit ID that systemd itself reported for `display-manager.service`. Display units are restored only from the state that the migrator recorded before the cutover.
- **User manager.** Reached with `/usr/bin/systemctl --user --machine=<user>@.host`, a verb from a fixed set, and the fixed unit `tilecast-player.service`. The environment is cleared, the command has a 60 second timeout, and at most 64 KiB of its output is read. `show` output is parsed as `KEY=VALUE` lines.
- **Recovery dependency.** While an attempt is in its cutover, the migrator adds `Requires=` links from the Edge units to `tilecast-edge-migrate-recover.service` through systemd (`AddDependencyUnitFiles`), not by writing unit files. Disabling the recovery unit removes them.
- **Task units.** The self-test, the DRM probe, the compatibility check and the import are static unit files that are part of the signed release, not transient units. Their command lines are fixed. Each runs as `tilecast`, with no capabilities, and all but the import have no network. Their output goes to fixed files in `/run/tilecast-edge-migrate`, which root reads with a 256 KiB bound.

### 3.5 Status from the daemon

Settlement reads `status.get` over the Edge socket. A compromised `tilecast` account can fake a good status. The only effect it can reach is the accept or rollback decision for its own stack, which that account already controls; it cannot make root run anything. The status is parsed with the bounded IPC types.

## 4. Invariants the design keeps

| Invariant                                        | How                                                                                                                                                | Proof                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| One stack enabled on disk at a time              | Legacy is disabled before Edge is enabled; Edge is disabled before legacy is enabled again.                                                        | Crash matrix (the fake machine records any overlap).                         |
| One stack holds the credential at a time         | Edge is confirmed inactive before the legacy player starts again. If that cannot be confirmed, the rollback stops in `RollbackIntent` and retries. | Crash matrix; integration test.                                              |
| No second credential                             | The import uses the legacy credential. Nothing enrolls.                                                                                            | Import tests; integration test (the same screen ID after acceptance).        |
| Legacy files unchanged before acceptance         | Read-only opens; a snapshot after the legacy player stops is compared before it runs again.                                                        | Crash matrix; integration test (whole-tree digests).                         |
| No acceptance without evidence                   | Settlement requires the server link, the current presentation accepted with playback evidence and fresh progress, for a stable window.             | `settle.rs` tests; integration test.                                         |
| A crash never accepts                            | Every cutover and settlement phase recovers by rolling back; only `AcceptIntent` finishes an acceptance.                                           | Crash matrix, with and without a reboot.                                     |
| An unaccepted Edge never runs after a power loss | While the recovery unit is enabled, the Edge units require it and start after it. If the recovery cannot run, Edge does not start either.          | Integration test (power loss during settlement; no Edge start in that boot). |
| One command runs on one stack                    | A probation marker holds Edge's command passes until acceptance, so commands stay on the server for whichever stack wins.                          | `commands.rs` test.                                                          |

## 5. Residual risks

- **Root parses JSON from the kiosk account.** Only `manifest-active.json`, bounded to 16 MiB, into a small typed structure, to choose media file names. `serde_json` is memory-safe and has a recursion limit. The alternative, a second sandboxed unit only to list media, adds a moving part without removing a real risk.
- **A compromised kiosk account can block the migration.** For example, it can remove its files or restart the legacy player during settlement. The result is a refusal or a rollback, never a partial cutover.
- **The DRM output is proven only after the cutover.** Before it, the display session holds DRM master, so the self-test renders off screen and the probe only reads the outputs. Settlement then proves the output on screen, and a failure rolls back. Physical DRM qualification is M11.
- **Operator-supplied release key.** A root-owned key override is trusted completely. That is the same trust as root itself.

## 6. Review checklist for changes

- A new side effect gets an intent phase or a crash point, and the crash matrix covers it.
- A new unit name is a constant, and is added to the release manifest's required units.
- A new file read under the kiosk account's home uses the descriptor-relative, no-link, owner-checked open.
- Nothing from the kiosk account, the server or the status socket becomes a unit name, a path to execute or a command argument.
- The migrator never reads or logs the credential's contents.
