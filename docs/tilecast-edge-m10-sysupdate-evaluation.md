# Tilecast Edge M10: systemd-sysupdate evaluation

**Status:** Decided, 2026-09-25
**Decision:** Tilecast Edge does not use `systemd-sysupdate`. M10 builds on the M7 release installer.
**Evidence:** [`apps/edge/ci/sysupdate-spike.sh`](../apps/edge/ci/sysupdate-spike.sh), run in Debian 12, Debian 13 and Ubuntu 24.04 containers.

## 1. Why this evaluation exists

[`tilecast-edge.md`](tilecast-edge.md) §15 told M10 to prototype `systemd-sysupdate` before it wrote update code, and to write custom code only for a gap that the prototype shows. Mender is not a candidate.

M7 already has a release installer. It verifies a signed release manifest with the Tilecast Ed25519 update key, verifies the size, SHA-256 and mode of every file, installs an immutable `/opt/tilecast-edge/<version>/` tree through a staging directory, `fsync` and `rename(2)`, switches `/opt/tilecast-edge/current` atomically, installs the systemd, sysusers, tmpfiles, udev and modules-load files, and verifies an installed tree again before use. The question was whether `systemd-sysupdate` removes a meaningful part of that code, or of the new M10 work.

## 2. The spike

The spike script defines one transfer: a local `tar` source into a `directory` target under `/opt/tilecast-edge`, with `CurrentSymlink=/opt/tilecast-edge/current`, `InstancesMax=2` and `Verify=yes`. Each release is a small tree with a 60 MB file, so that an installation takes long enough to interrupt.

| Host         | systemd | Where `systemd-sysupdate` is                                    |
| ------------ | ------- | --------------------------------------------------------------- |
| Debian 12    | 252.39  | Not packaged. The host has no `systemd-sysupdate`.              |
| Debian 13    | 257.13  | Package `systemd-container`, which is not installed by default. |
| Ubuntu 24.04 | 255.4   | Package `systemd`.                                              |

Debian 12 is a supported Edge host ([`apps/edge/packaging/README.md`](../apps/edge/packaging/README.md), requirements). A mechanism that is absent on a supported host cannot be the Edge update path.

## 3. Results

The results on Debian 13 and Ubuntu 24.04 are the same.

| Property                                                                 | Result                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The existing Tilecast archive (`tilecast-edge-<version>-<arch>.tar.zst`) | Fails. The tar import of both versions does not detect zstd compression, sends the compressed bytes to `tar` and stops. A `.tar.xz` archive works.                                                                                                                                                |
| Local tar source into `/opt/tilecast-edge/<version>`                     | Works for `.tar.xz`. The installed tree is mode `0700` and owned by root, so the `tilecast` account cannot run its binaries. A fix-up step after each installation is necessary.                                                                                                                  |
| The `current` link                                                       | `systemd-sysupdate update` switches `current` as soon as the files are in place. It has no step that installs a version without activating it.                                                                                                                                                    |
| Verification of a local source                                           | None. `Verify=` has an effect only for `url-file` and `url-tar` sources. The spike installed a local archive with `Verify=yes` and no checksum or signature.                                                                                                                                      |
| Verification of a remote source                                          | A `SHA256SUMS` file with a detached OpenPGP signature `SHA256SUMS.gpg`, checked against `/etc/systemd/import-pubring.gpg`. There is no Ed25519 raw-signature option and no per-file digest or mode inside the archive.                                                                            |
| Authenticated download                                                   | None. A `url-*` source is a plain HTTP or HTTPS URL. A transfer file cannot send the Tilecast device credential. A download through `systemd-sysupdate` must come from an unauthenticated location, not from `/api/v1/player/updates/<release>/artifact`.                                         |
| An artifact that Tilecast already downloaded                             | Possible only as a local source directory with a matching file name, and then with no verification (see above).                                                                                                                                                                                   |
| Interrupted installation                                                 | `SIGKILL` during unpacking leaves `.#sysupdate<version><random>` in `/opt/tilecast-edge`. `current` does not change. The next run removes the leftover (`RemoveTemporary=yes`) and installs again. M7 behaves the same with `<version>.staging`.                                                  |
| Retention                                                                | `InstancesMax=2` deletes the oldest version when the next installation starts, before the new version is proven. `ProtectVersion=` protects versions named by specifiers such as `%A` (the booted OS version). It cannot express "the previous confirmed release" or "the provisional candidate". |
| Return to the previous version                                           | `systemd-sysupdate update 0.3.0` answers "already installed" and leaves `current` on the newer version. There is no rollback operation.                                                                                                                                                           |
| Provisional activation, health confirmation, automatic rollback          | Not in scope of the tool.                                                                                                                                                                                                                                                                         |
| System integration files (units, sysusers, tmpfiles, udev, modules-load) | Not in scope of the tool.                                                                                                                                                                                                                                                                         |

## 4. What `systemd-sysupdate` would remove

At most, the staging directory, its `rename(2)` and the atomic `current` switch: about 40 lines of `release.rs`.

To use it, Edge would have to add:

- a second archive format (`.tar.xz`) or a second artifact beside the signed `.tar.zst`;
- a second trust model (OpenPGP `SHA256SUMS.gpg` and a system keyring) beside the Tilecast Ed25519 key, or an unverified local source;
- a fix-up of modes after every installation;
- a way to install without activation;
- the rollback, provisional window and retention rules outside the tool;
- an unauthenticated download location, or the local-source path with no verification;
- `systemd-container` on Debian 13, and a second update path for Debian 12.

The per-file verification of the signed M7 manifest, the installed-tree verification and the system integration files stay necessary in every case.

## 5. Decision

`systemd-sysupdate` does not give a material simplification. It would add a second trust model, a second archive format and a second installer beside M7, and it cannot use the authenticated Tilecast artifact download. Edge does not use it.

M10 does this instead ([`tilecast-edge.md`](tilecast-edge.md) §15):

1. The Tilecast Server stays the release authority. Edge releases are Player releases of the `edge` player family, in the existing Player Updates model, deployments and canary.
2. A signed update envelope binds the downloadable archive to the M7 release manifest. The same Ed25519 key signs both.
3. `tilecastd` downloads the archive into its verified content store through the authenticated artifact endpoint, with resume.
4. One narrow root helper, `tilecast-edge-update`, stages, activates, confirms and rolls back through the M7 installer code, refactored into the `edge-release` crate.
5. A root-owned transaction record and a guard timer that runs the previous release's helper roll back a candidate that does not confirm.

## 6. When to evaluate again

Evaluate `systemd-sysupdate` again only if all of these become true:

- every supported Edge host ships it in its default installation;
- it can verify an Ed25519 signature that Tilecast controls, or a local source;
- it can install a version without activating it.
