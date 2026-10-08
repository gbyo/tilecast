# Tilecast Edge release reliability and WebKit sandbox review (0.2.1)

This document records the Tilecast Edge 0.2.1 hardening release. It explains each failure that the Edge 0.2.0 release showed on real screens, the root cause, the production fix, and the security boundary that remains. It supplements [`tilecast-edge-migration-threat-review.md`](tilecast-edge-migration-threat-review.md), [`tilecast-edge-update-threat-review.md`](tilecast-edge-update-threat-review.md) and [`tilecast-edge-remote-web-threat-review.md`](tilecast-edge-remote-web-threat-review.md). It does not change the process, privilege, wire, persistence or update guarantees of [`tilecast-edge.md`](tilecast-edge.md).

## 1. Failures on real hardware

Edge 0.2.0 was migrated on Debian 13 screens (systemd 257, Intel i915) with these results. Each row has a section below.

| Observation                                                                                           | Root cause                                                                                                         | Section |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| `tilecast-renderer-probe.service` exited 127 and the migration said `drm_output_unavailable`          | The release did not contain `libwpe-1.0.so.1`, which the private WPE WebKit loads                                  | 2, 6    |
| The renderer crashed with `SIGTRAP` after it looked in `$HOME/.config/pulse`                          | The `tilecast` account's home is `/var/lib/tilecast-edge`, which the renderer unit hides                           | 3       |
| `bwrap: Can't mount proc on /newroot/proc: Operation not permitted`                                   | `ProtectKernelTunables=yes` in the renderer units                                                                  | 4       |
| (Found by the 0.2.1 tests) `bwrap: Can't open source /: Function not implemented`                     | `RestrictSUIDSGID=yes` in the renderer units, with bubblewrap 0.12 or later                                        | 4       |
| The built-in fixture failed with `not enough free space` on a small `/run`                            | `self_test::run()` used the production content store policy, which reserves 1 GiB of free space                    | 5       |
| Failures appeared as `drm_output_unavailable`, `renderer_not_ready` after 120 s, `fixture_not_active` | The migrator and the self-test host did not name the layer that failed                                             | 6       |
| A 0.2.1 update would keep the 0.2.0 emergency drop-ins                                                | An update installs units but does not replace files that an administrator or script added to `/etc/systemd/system` | 7       |

The emergency field workaround set `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`, moved the self-test runtime to `/var/cache`, and set `HOME`. It was acceptable on a canary screen as a temporary measure. It is not the production fix, and Edge 0.2.1 does not use it.

## 2. Runtime dependency closure

**Problem.** The release builder installs every `-dev` package that WebKit needs to compile. `ldd` in that image succeeds for a release that a clean machine cannot start. The private WPE WebKit in `lib/wpe` links `libwpe-1.0.so.1`. A Debian 13 installation does not have to provide it.

**Contract.** [`apps/edge/release/system-baseline.txt`](../apps/edge/release/system-baseline.txt) lists the Debian packages that a release expects from the operating system. A shared library that a binary in the release loads is taken from the operating system when its package is on the list or is a dependency of a listed package. Every other library is carried in the release.

**Mechanism.** `stage-release.py` runs `runtime_closure.py carry` after it copies the private WPE tree.

- It reads the `NEEDED` libraries of every ELF file in the staged tree, and of every library it carries.
- It finds the Debian package that owns each library. A library of a package outside the baseline closure is copied to `lib/wpe/lib`, the directory in the `RUNPATH` of the private WebKit. It is stored under its `SONAME`, without a symbolic link.
- It copies the Debian copyright file of each carried package to `share/doc/tilecast-edge/licenses/`.
- It writes `share/doc/tilecast-edge/bundled-libraries.json`. The software bill of materials lists these packages and marks them as carried.
- A needed library that nothing provides fails the build.

For 0.2.1 the only carried library is `libwpe-1.0.so.1` (`libwpe-1.0-1`, BSD-2-Clause). Tilecast code does not use libwpe: the renderer uses the WPEPlatform API only, and the carried library is WebKit's own dependency. Libraries that the baseline provides stay with the operating system, which keeps patching them. This matters most for image and media decoders that the remote web helper exposes to untrusted pages.

**Check.** A builder `ldd` is not evidence. `run-closure-check.sh TREE` builds [`Dockerfile.closure`](../apps/edge/release/Dockerfile.closure), a clean Debian 13 image that has only the baseline (no `-dev` package, no WPE package, no Python), mounts the finished tree at `/opt/tilecast-edge/current`, and runs `ldd` on every ELF file. Any unresolved library fails the check. The release workflow runs it on each architecture before it publishes artifacts. The two WPE binaries `bin/tilecast-renderer-wpe` and `bin/tilecast-web-renderer-wpe` are required to exist.

The check was run on the published 0.2.0 tree. It reported `libwpe-1.0.so.1` as the only unresolved library, in 7 files. The same tree after `stage-release.py` in the release builder image resolves completely.

**Other requirements from the operating system.** `bubblewrap` and `xdg-dbus-proxy` are programs that WebKit starts for its sandbox. They are part of the screen's operating system requirements (see `apps/docs`, Edge requirements). If they are missing, the self-test reports a renderer failure at once (section 6).

## 3. Renderer `HOME` and `XDG_*`

The `tilecast` account has the home directory `/var/lib/tilecast-edge` (`sysusers.d`). The renderer unit makes that directory inaccessible, so a library that resolves `$HOME/.config` (WebKit's sandbox checks `$HOME/.config/pulse`) failed.

`tilecast-renderer.service` and `tilecast-renderer-selftest.service` now set these variables and let systemd create the directories (`CacheDirectory=`, mode `0700`):

| Variable          | Production renderer                   | Self-test renderer                             |
| ----------------- | ------------------------------------- | ---------------------------------------------- |
| `HOME`            | `/var/cache/tilecast-renderer/home`   | `/var/cache/tilecast-renderer-selftest/home`   |
| `XDG_CONFIG_HOME` | `/var/cache/tilecast-renderer/config` | `/var/cache/tilecast-renderer-selftest/config` |
| `XDG_CACHE_HOME`  | `/var/cache/tilecast-renderer`        | `/var/cache/tilecast-renderer-selftest`        |
| `XDG_DATA_HOME`   | `/var/cache/tilecast-renderer/data`   | `/var/cache/tilecast-renderer-selftest/data`   |

The daemon state directory stays hidden from the renderer. The web helper runs as `tilecast-web`, whose home is its own writable state directory, so it needs no change. `release/test_units.py` checks that no renderer variable resolves into `/var/lib/tilecast-edge` and that each path is created by `CacheDirectory=`.

## 4. WebKit's own sandbox under the unit sandbox

WebKit starts every web process through `bubblewrap`. The unit sandbox and the bubblewrap sandbox must work together. Production and self-test units run with WebKit's sandbox on. `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS` is not set in any unit.

### 4.1 Which directive conflicts

The test ran `bwrap --unshare-pid --ro-bind / / --proc /proc --dev /dev` as an unprivileged user in a transient unit on Debian 13 with systemd 257 and bubblewrap 0.12.0, once with each directive of the renderer units. Only these directives failed:

| Directive                                     | Result                                                               | Mechanism                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProtectKernelTunables=yes`                   | `Can't mount proc on /proc: Operation not permitted`                 | The unit mounts read-only files over parts of `/proc`. When bubblewrap creates its user namespace, those mounts are locked. The kernel refuses a fresh `proc` mount while a locked, non-empty mount hides part of the existing one.               |
| `ProtectKernelLogs=yes`                       | the same                                                             | It masks `/proc/kmsg` in the same way. The renderer units never set it. It is listed because it fails in the same way.                                                                                                                            |
| `RestrictSUIDSGID=yes`                        | `Can't open source /: Function not implemented`                      | Its seccomp filter makes `openat2()` fail with `ENOSYS`, because a filter cannot inspect the `open_how` structure. bubblewrap 0.12 and later calls `openat2()` and does not fall back. Debian 13 ships bubblewrap 0.12.0 in its security updates. |
| `RestrictNamespaces=yes`, `SystemCallFilter=` | bubblewrap cannot create its namespace, or the process gets `SIGSYS` | Not used by the renderer units. They stay unused.                                                                                                                                                                                                 |

These directives did not conflict: `NoNewPrivileges=yes`, `CapabilityBoundingSet=` (empty), `ProtectHome=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, `PrivateNetwork=yes`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `LockPersonality=yes`, `RestrictAddressFamilies=`, `SystemCallArchitectures=native`, `TemporaryFileSystem=`, `InaccessiblePaths=`, `DevicePolicy=closed` with `DeviceAllow=`, `MemoryDenyWriteExecute=yes`, `MemoryHigh=`, `MemoryMax=`, `TasksMax=`, `ProtectProc=invisible`.

The same test with the real WebKit 2.54 confirms it. With `RestrictSUIDSGID=yes` still set, the release self-test ended in 4 s with `self_test_failed: renderer_exited: signal 6: bwrap: Can't open source /etc: Function not implemented`.

### 4.2 What changed

`ProtectKernelTunables=yes` and `RestrictSUIDSGID=yes` are removed from `tilecast-renderer.service`, `tilecast-renderer-selftest.service` and `tilecast-web-renderer.service`. `ProtectKernelLogs=` stays unset. Nothing else changed in these directives. The daemon, the self-test host, the probe and the root helpers keep every directive they had: they do not start WebKit.

### 4.3 The boundary that remains

| Removed protection                          | Why it is not needed for these units                                                                                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only `/proc/sys`, `/sys`, `/proc/kmsg` | The units run as an ordinary account (`tilecast`, `tilecast-web`) with an empty capability set and `NoNewPrivileges=yes`. Those files belong to root and are not writable or readable by that account. No process in the unit can gain the privilege to change that. |
| No setuid or setgid files                   | `NoNewPrivileges=yes` stops any set-user-ID program from raising privilege for the process tree. The writable directories are private `0700` trees of one account. `PrivateTmp=yes` gives a private `/tmp`.                                                          |

The unit still has dedicated service accounts, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, an empty `CapabilityBoundingSet=`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, the address-family limits, the device policy of the web helper, hidden daemon state and credential directories, and WebKit's own bubblewrap sandbox around every web process. WebKit's sandbox is stronger than the removed directives for the same data: it replaces the file system view of untrusted content.

### 4.4 The sandbox cannot be turned off in a release

The 0.2.0 field drop-ins set `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`, and they remain on a screen until section 7 removes them. `tilecast-renderer-wpe` and `tilecast-web-renderer-wpe` clear that variable at start, print a warning, and run with the sandbox. A CMake option `TILECAST_ALLOW_UNSANDBOXED_WEBKIT` (off by default) keeps the variable for development and CI containers that cannot create user namespaces. No release script sets it, and `build-edge-release.sh` fails if a release binary lacks the clearing code.

### 4.5 Media socket and the sandbox

Enabling the sandbox showed a defect that the disabled sandbox hid. WebKit binds the media socket file (`media.sock`) into the web process at start, and refuses a path that does not exist yet. Two cases need handling:

- The self-test starts the renderer before the self-test host binds the socket. A release renderer now waits up to 30 s for the socket before it creates the web context (development and CI builds do not sandbox and do not wait).
- A daemon restart replaces the socket file, and the bound file in the web process no longer reaches the daemon. When the renderer reconnects and sees a different socket than the one it bound, it exits with status 3 and its unit starts it again. A dedicated socket directory would avoid the restart. It would change the renderer contract, so it is a later change.

### 4.6 Evidence

- `apps/edge/release/test_units.py` checks the unit invariants.
- `apps/edge/ci/migrate_e2e.py` runs the whole migration, power loss, acceptance and update flow on real systemd with the production units and WebKit's sandbox on. The `preflight` phase proves the host can run the sandbox, `check_webkit_sandbox` proves that the web processes run under `bwrap` and that no unit disables the sandbox, and `accepted-reboot` proves the screen recovers after a power loss.
- `apps/edge/release/run-sandbox-check.sh TREE` starts the self-test units of a finished release on clean Debian 13 with real systemd. The release workflow runs it before it publishes artifacts. It was run on the 0.2.0 binaries with the 0.2.1 units and the private WPE WebKit 2.54: the self-test proved all four fixture items, including the video, in 12 s with four sandboxed web processes.

## 5. Self-test content store policy

`tilecastd self-test` keeps its state, content store and sockets in `/run/tilecast-edge-selftest`, a runtime directory on tmpfs. That design is unchanged. The 0.2.0 self-test used the production content store policy, which reserves 1 GiB of free space, so a 26 KB fixture failed on a small `/run`.

The self-test host now sets its own policy in `self_test::cas_config()`: a limit of 16 MiB and no reserved free space. The policy applies only to the self-test host. The production policy and the operator configuration file are not read by the self-test. `tilecastd/tests/self_test.rs` proves the fixture passes with 8 MiB free, and that a daemon with the production defaults refuses the same fixture on that file system.

## 6. Failure diagnostics

The migrator names the layer that failed. The leading token is stable. The text after the first colon is bounded (320 characters) and printable, and it never contains the device credential: the units involved handle no credential.

| Reason                                              | Meaning                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `drm_output_unavailable`                            | The probe ran, exited 5, and reported no connected output with a mode                          |
| `drm_probe_failed: exit status 127: <stderr>`       | The probe did not run to a report. 127 is the dynamic loader. `signal N` names a crash         |
| `self_test_failed: renderer_start_failed: <detail>` | The self-test renderer unit did not start, or ended before the host began                      |
| `self_test_failed: renderer_exited: <detail>`       | The renderer ended while the host waited. The migrator stops the host at once, not after 120 s |
| `self_test_failed: fixture_import_failed: <detail>` | The built-in fixture could not enter the content store (for example, no free space)            |
| `self_test_failed: fixture_invalid`                 | The fixture file is missing or does not match the contract                                     |
| `self_test_failed: content_store_unavailable`       | The self-test content store did not open                                                       |
| `self_test_failed: fixture_activation_failed`       | The presentation engine refused the fixture                                                    |
| `self_test_failed: renderer_error`                  | The renderer rejected the activation or reported an item error                                 |
| `self_test_failed: renderer_not_ready`              | The renderer never connected, and its unit stayed up                                           |
| `self_test_failed: evidence_timeout`                | The renderer connected and accepted the fixture but did not prove every item                   |

The probe, the self-test host and the self-test renderer write standard error to `selftest.err`, `drm-probe.err` and `selftest-renderer.err` in `/run/tilecast-edge-migrate` instead of the journal. The migrator reads the last 16 KiB without following a link, keeps at most three non-empty lines as one printable line of 240 characters, and records the exit status or signal with it. The attempt record keeps the same fields in `selfTest.reason` and `selfTest.detail`. The files are on tmpfs and are replaced for each attempt.

After a migration is accepted, the migrator runs `systemctl --user reset-failed` for the stopped Electron player unit. The unit shows `disabled` and `inactive` instead of `failed`. The unit, its files and its data stay. A rollback does not change the state.

## 7. The 0.2.0 field workaround

### 7.1 Who runs the update

The update from 0.2.0 to 0.2.1 is run by the 0.2.0 helper that is already on the screen: it activates the candidate, its guard runs after a power loss, and it performs a rollback. It does not know the field drop-ins, and the 0.2.1 release cannot add code to it. The 0.2.1 helper starts only after `current` points to 0.2.1.

So the cleanup is not part of the update transaction. It runs after the update is final.

### 7.2 Behavior

- **Before and during the provisional window.** Nothing removes the drop-ins. A rollback to 0.2.0 leaves the machine exactly as it was, with the workaround that 0.2.0 needs. The 0.2.1 renderers clear the variable that disables the sandbox (section 4.4), so the candidate runs with WebKit's sandbox even while the drop-ins exist.
- **After confirmation.** The 0.2.1 helper acts when it starts, once these conditions hold: the helper belongs to the current release, no update transaction is open, and no migration is settling. `tilecastd` sends an ordinary `status` request 90 s after it starts, and every 15 minutes, so the helper starts after the previous release's helper has exited. The helper gains no operation.
- **Allowlist.** `field_workaround.rs` lists five paths and the SHA-256 of the one content that was deployed at each:

| Path                                                                                 | SHA-256                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `/etc/systemd/system/tilecast-renderer-selftest.service.d/edge-0.2.0-field-fix.conf` | `16b3c5ee08191aa111ab72949a17fce5b334776cfa7d7f218fac3be416f1ddbc` |
| `/etc/systemd/system/tilecast-renderer.service.d/edge-0.2.0-field-fix.conf`          | `c1f0cd083640731cc682bd16ba6ddfd875c7c00692261447e67f8666258490e6` |
| `/etc/systemd/system/tilecast-web-renderer.service.d/edge-0.2.0-field-fix.conf`      | `9cb35e76c1ec8ef982fb46ef6ecf57a9a0c14474b04f7e2c497e16e86b8cb9d0` |
| `/etc/systemd/system/tilecast-edge-selftest.service.d/edge-0.2.0-field-fix.conf`     | `ce3d1dea27aba5d24346bdb4ba4870a80264df026b27b1ccd5168cc9db00545c` |
| `/etc/tilecast-edge/selftest-0.2.0-field.toml` (first canary only)                   | `50b452f6af225015935c34a17490d6dbbec24c495a525d6aa255a03395e0515d` |

The tests use the deployed bytes in `tilecast-edge-update/tests/field-workaround/`.

- **Exact matches only.** The helper opens each listed path without following a link, reads at most 16 KiB, and compares the digest. A file with another digest, a link, or a directory at a listed path is an unknown administrator override: it is not changed, and it is reported (journal, `field-workaround.json`, and `tilecast-edge-update overrides`). No other path is read or removed. The helper checks the digest again immediately before it removes a file.
- **Move, reload, discard.** The helper copies the matching files to `/var/lib/tilecast-edge-update/field-workaround-backup` (the manifest is written last), removes them, removes a drop-in directory that became empty (never one that holds another file), runs `daemon-reload`, and then deletes the backup. If the reload fails, it restores the files byte for byte. A crash at any point is finished or undone by the next run.
- **Effect on running units.** The reload does not restart a unit. The next restart uses the units without the drop-ins.

### 7.3 Security effect

The helper reads and removes files below `/etc/systemd/system` and `/etc/tilecast-edge`, which its unit already may write (`ReadWritePaths=/etc`). It adds no capability, no operation, no path from a request, and no command. The set of paths and digests is fixed in the binary. `tilecast-edge-update-threat-review.md` §7.3 lists the addition.

## 8. Qualification record

These results are from a real school screen, recorded by the Edge maintainers. They were obtained with Edge 0.2.0 and the emergency field workaround, not with a stock 0.2.1 release:

- Debian 13, systemd 257;
- Intel i915 DRM/KMS, HDMI output at 1920×1080 at 60 Hz;
- legacy import succeeded;
- the real DRM renderer was healthy;
- the screen reconnected to the Tilecast Server and produced playback evidence;
- a reboot recovered and started all Edge services.

This record does not qualify the 0.2.1 release, other graphics hardware, other outputs, other distributions or other architectures. The 0.2.1 release is qualified for a screen only after the two flows in [`tilecast-edge-next.md`](tilecast-edge-next.md) §11 pass on it with a stock signed artifact: a fresh migration, and an update of a screen that has the field workaround, including the rollback variant. The container tests above cover the software path under real systemd, not a physical display.
