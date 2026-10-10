# Release process

Tilecast publishes one coordinated release for each version. The release
contains every platform that is available for that version. This document is
the specification of that process. The public contributor guide is
[Releasing Tilecast](../apps/docs/src/content/docs/developers/releasing.mdx).

## Scope

One release covers these products:

| Product                     | Distribution                                             |
| --------------------------- | -------------------------------------------------------- |
| Tilecast Server             | GitHub Packages (GHCR) container image                   |
| Browser Player              | Bundled in the Server image. It has no separate asset.   |
| Tilecast Edge (Linux)       | GitHub Release assets for `x86_64` and `aarch64`         |
| Tilecast Player (Windows)   | GitHub Release assets for x64 and ARM64                  |
| Tilecast Player (Android)   | GitHub Release assets for Android TV, Google TV, Fire TV |
| Tilecast for iOS and iPadOS | Apple App Store. It is not a GitHub asset.               |

The legacy Electron Linux Player is not part of a coordinated release. Its
existing releases stay available and importable. See
[Releases that shipped earlier](#releases-that-shipped-earlier).

## Channels

| Channel     | Version form    | GitHub Release | Server image tags                                                     |
| ----------- | --------------- | -------------- | --------------------------------------------------------------------- |
| Stable      | `vX.Y.Z`        | Release        | `X.Y.Z`, `stable`, `latest`, and `beta` when it is the newest release |
| Beta        | `vX.Y.Z-beta.N` | Pre-release    | `X.Y.Z-beta.N` and `beta`                                             |
| Development | None            | None           | `development` and `sha-<commit>`                                      |

Development is not a release. `server-image.yml` publishes a Development image
for each change to `main`. It never creates a GitHub Release. It never moves
`stable`, `latest`, or `beta`.

A Beta release is a pre-release of the next Stable version. Beta 1 of
`0.26.0` is `v0.26.0-beta.1`. The Stable release of the same version is
`v0.26.0`. Studio maps a GitHub pre-release to the signed `beta` channel and a
GitHub Release to the signed `stable` channel. The server refuses a release
whose signed channel disagrees with its GitHub kind.

## Versions and update ordering

A coordinated version is `X.Y.Z` or `X.Y.Z-beta.N`, from `0.26.0` on. `N` is a
number from 1 to 98 with no leading zero. Any other suffix is refused.

Every platform compares one number, the update version code. The code is:

```text
code = (MAJOR * 1000000 + MINOR * 1000 + PATCH) * 100 + slot
slot = N for a Beta, 99 for Stable
```

The code increases in this order:

| Version         | Code    |
| --------------- | ------- |
| `0.26.0-beta.1` | 2600001 |
| `0.26.0-beta.2` | 2600002 |
| `0.26.0`        | 2600099 |
| `0.26.1-beta.1` | 2600101 |
| `0.26.1`        | 2600199 |
| `0.27.0-beta.1` | 2700001 |

A Beta can update to the next Beta or to Stable. A Stable release can update
to the next Beta or the next Stable release. No code is above `2100000000`,
which is the Android `versionCode` limit. The largest major version is
therefore `20`.

The server, Tilecast Edge, the Windows Player, the Android build, and the
release scripts each implement this rule. All of them run one corpus,
`packages/player-contracts/fixtures/release-versions.json`. Change the rule in
all of them and in the corpus in one change.

The channel is part of the version name. The server, Edge, and the Windows
Player refuse an envelope when the signed channel is not the channel the name
implies. A `-beta.N` name must be `beta`. A name without a suffix must be
`stable`.

### The first unified version

The first coordinated version is `0.26.0`. The audit of every version that
shipped before the unified release found these codes:

| Line                  | Highest shipped version         | Code  |
| --------------------- | ------------------------------- | ----- |
| Android               | `0.25.0` (`versionCode` 46)     | 46    |
| Electron Linux Player | `0.17.0`                        | 17000 |
| Tilecast Edge         | `0.2.1-preview.1`               | 2001  |
| Windows Player        | None. It is not published yet.  | None  |
| Server                | None. No Server release exists. | None  |

The lowest unified code is `2600001`. It is above every shipped code. A
version below `0.26.0` keeps the legacy code `MAJOR * 1000000 + MINOR * 1000 +
PATCH` and the suffix does not count. Every shipped version therefore keeps the
code it shipped with, and every unified release is newer than every shipped
release.

The tags `player-v0.26.0` to `player-v0.29.2` exist in the repository. They
mark commits that were never published as a release, and they are not on `main`.
They use another tag name. They do not collide with `v0.26.0`.

### Windows package versions

An MSIX package version has four parts. For a unified release it is
`MAJOR.MINOR.PATCH.slot`, with the same slot as the version code. Windows
therefore orders packages in the same way as the server orders updates. The old
rule, which used revision 1 for Beta and 2 for Stable, applies below `0.26.0`.

### Where the version is set

Each platform keeps its own development version:

| File                                                                          | Used by        |
| ----------------------------------------------------------------------------- | -------------- |
| `apps/edge/release/VERSION`                                                   | Tilecast Edge  |
| `apps/player-windows/release/VERSION`                                         | Windows Player |
| `versionName` and `versionCode` in `apps/player-android/app/build.gradle.kts` | Android        |

The release tag is the authority for a release. Each release build runs
`scripts/release/stamp_version.py --version X.Y.Z` in its own checkout. The
script writes the release version and the update version code into the three
sources. It commits nothing. A release build then checks that the signed
envelope reports that version and code. The Server image receives the version
through `VERSION_NUMBER`. Internal crate and package versions are not release
versions and do not change.

## Where release data lives

| Place                    | Holds                                                                                                                  | Lifetime                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| GitHub Releases          | The downloadable builds, signed update envelopes, signatures, checksums, SBOMs, `tilecast-release.json`, and the notes | Permanent. Releases are immutable.    |
| GitHub Packages (GHCR)   | `ghcr.io/gbyo/tilecast-server` images, and `ghcr.io/gbyo/tilecast-wpe` WPE WebKit prebuilds (OCI artifacts)            | Permanent for versions. Aliases move. |
| GitHub Actions artifacts | Build output that passes between the jobs of one run                                                                   | Temporary. Never a release.           |

An Actions artifact is not a published release. Do not install from one.

The repository has immutable releases enabled. After a release is published,
its assets and its tag cannot change. The process never adds an asset to a
published release and never replaces one.

## Platform contract

`scripts/release/contract.json` is the contract. It lists each component, the
channels for which it is required, and the exact assets of each component.

| Component      | Stable   | Beta     | Assets                                                          |
| -------------- | -------- | -------- | --------------------------------------------------------------- |
| Server image   | Required | Required | A GHCR image, recorded by digest                                |
| Edge `x86_64`  | Required | Required | Archive, envelope, signature, release manifest, signature, SBOM |
| Edge `aarch64` | Required | Required | The same six files                                              |
| Windows x64    | Required | Optional | MSIX package, envelope, signature                               |
| Windows ARM64  | Required | Optional | MSIX package, envelope, signature                               |
| Android        | Required | Required | `tilecast-player.apk`, `tilecast-player-update.json`, signature |
| iOS and iPadOS | External | External | App Store. Not a GitHub asset. It never gates a release.        |
| Browser Player | Bundled  | Bundled  | In the Server image                                             |

A required component that is missing, incomplete, or not verified fails the
release. An optional component that is missing is listed in the release notes
and in `tilecast-release.json` with the reason. Its files are never published.
The release never describes an unavailable platform as shipped.

The Windows Player is required for Stable and optional for Beta. Change
`required` in `contract.json` to change this. The Windows Player has no
published release yet, and its signing material is separate from the other
platforms.

## Release assets

Every release contains these assets in addition to the platform files:

| Asset                   | Purpose                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SHA256SUMS`            | The SHA-256 of every other asset                                                                                           |
| `tilecast-release.json` | The inventory: version, channel, commit, each component with its status, files, hashes, sizes, and the Server image digest |

The inventory and the notes are deterministic. The same inputs give the same
bytes. The notes group the release by Server, Tilecast Edge, Windows, Android,
and iOS and Browser availability. A resumed run reads the Server image digest
from the `server` component of `tilecast-release.json`, never from the notes.
The digest line in the notes is for readers only.

## The release workflow

`.github/workflows/release.yml` is the only workflow that publishes a
coordinated release. Dispatch it from `main` with the version. A tag push does
not start a release. The workflow takes the global concurrency group
`tilecast-release`. Two releases never run at the same time. GitHub keeps one
pending run for a group, so queue releases one at a time.

| Job                          | Action                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`                    | Validates the tag. Checks that the commit is on `main`. Plans the release against the published releases. Resumes what a draft holds.                                     |
| `*_ci`                       | Runs the Server shipping bundle: server, dashboard, container, browser, plugins, widgets, data sources, and CLI                                                           |
| `server_image`               | Builds the Server image once and publishes only the immutable version tag.                                                                                                |
| `edge`, `windows`, `android` | Build, sign, and attest each platform. They call the platform workflows. They upload Actions artifacts and publish nothing.                                               |
| `assemble`                   | Applies the contract. Verifies every signature and artifact. Writes the inventory, checksums, and notes. Uploads to the draft. Downloads the draft and verifies it again. |
| `publish`                    | Checks the ordering again. Publishes the draft. Resolves the aliases.                                                                                                     |
| `promote`                    | Moves the Server image aliases to the published digest.                                                                                                                   |

`edge-release.yml`, `windows-player-release.yml`, `player-release.yml`, and
`server-release.yml` are building blocks. Each has `workflow_call` and none
publishes a release. The first three also run alone by `workflow_dispatch` as a
build check. They never publish.

### Verification

`apps/server/cmd/tilecast-release-verify` runs the importer of the Tilecast
Server over the directory of release assets. It reads every manifest, checks its
Ed25519 signature against `apps/edge/release/tilecast-update-key.pem`, checks the
asset names, the version, and the channel, and checks the size and SHA-256 of
each artifact. For Android it checks the APK signing certificate and the package
metadata. The workflow also pins the Android signing certificate.

A release that this check accepts is a release that the Server discovers and
imports. The check runs twice: on the assembled directory, and on the draft as
GitHub holds it.

### Secrets

| Secret                                                                                                                                  | Used by                |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `TILECAST_UPDATE_MANIFEST_PRIVATE_KEY_PEM`, `TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_PEM`                                                   | Edge, Windows, Android |
| `TILECAST_ANDROID_KEYSTORE_BASE64`, `TILECAST_ANDROID_KEYSTORE_PASSWORD`, `TILECAST_ANDROID_KEY_ALIAS`, `TILECAST_ANDROID_KEY_PASSWORD` | Android                |
| `TILECAST_MSIX_PFX_BASE64`, `TILECAST_MSIX_PFX_PASSWORD`, `TILECAST_MSIX_PUBLISHER`                                                     | Windows                |

A missing secret fails that platform build. The public key must equal the key in
the repository. A build never prints a secret and never writes one outside the
runner temporary directory.

## Resuming a release

Dispatch the same version again to resume. The result depends on the state of
the release:

| State          | Action                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No release     | Builds everything.                                                                                                                                                           |
| A draft exists | Downloads the draft. Verifies each platform. Reuses a platform whose manifest, signature, and artifact still verify. Builds the rest. The draft must target the same commit. |
| Published      | Builds nothing. Promotes the aliases that the release still owns. The run must start from the tagged commit.                                                                 |

A reused platform is not rebuilt and not signed again. Its bytes stay as they
are. An asset uploaded by an interrupted run is replaced only in a draft. The
Server image resumes from the digest in the draft inventory, or from a version
tag that an interrupted run published for the same commit. A version tag from
any other commit stops the release. A version tag is immutable.

Dispatch with `publish` off to build and verify the draft without publishing.
A later run with `publish` on resumes from that draft.

## Server image aliases

| Alias    | Names                                                    |
| -------- | -------------------------------------------------------- |
| `stable` | The newest published Stable release                      |
| `latest` | The same image as `stable`. It is a compatibility alias. |
| `beta`   | The newest published release of either kind              |

`scripts/release/release_plan.py` decides these rules. An alias moves only to
the newest release that it tracks, so an alias never moves backwards. The rules
for publication are:

- A Stable release must be newer than every published Stable release.
- A Beta release must be newer than every published release.
- A resumed release moves an alias only when it is still the newest.

A Stable hotfix for an older line moves `stable` and `latest`. It does not move
`beta` while a newer Beta exists.

The aliases move after the release is published. The promotion uses the digest
that the published inventory records, never the version tag, and never a build.
Only `stable`, `latest`, and `beta` can move, and only a Stable release can move
`stable` and `latest`. A failed or incomplete release never moves an alias.

`latest` currently names a build from before this process and `stable` does not
exist. The first Stable release creates `stable` and moves `latest`.

## Player update discovery

Tilecast Server reads the published GitHub Releases of `gbyo/tilecast`, and no
other repository. It imports each release in these steps:

1. It lists up to five pages of 100 releases. A Server release or a WPE release
   cannot hide a Player release.
2. It finds each player release a GitHub release carries. These are the Android
   pair, an Edge envelope for each architecture, a Windows envelope for each
   architecture, and the legacy Electron Linux pair. A release with none of them
   is ignored. It is not an error.
3. It verifies each one on its own. The signature, the names, the version, the
   channel, and the artifact size must agree. A problem in one family never
   hides another family.
4. It stores each verified one. The database key is the GitHub release ID, the
   family, and the architecture. The tag and the version code are unique for a
   family and architecture.
5. It records each rejected asset. Studio shows the first reason as the last
   check status, with the prefix `Rejected release asset:`. The server writes
   every reason to its log. A rejection is not a failed check. The server keeps
   the stored ETag, so an unchanged release list is not downloaded and verified
   again. An incomplete download is a plain error, and the next check reads the
   releases again.

A release that is complete in the database is not downloaded again. An optional
family that is absent does not stop the family that is present.

The record ID of an Android release stays `uuid5("github:<release id>")`. A
release that an earlier version imported keeps its row. No migration is
required.

## Releases that shipped earlier

| Release line          | Behavior                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `player-v*` (Android) | Import as before. Their `versionCode` values (46 and lower) are below every unified code. |
| `player-linux-v*`     | Import as before. The workflow `linux-player-release.yml` stays for that line only.       |
| `edge-v0.*-preview.*` | Import as before. The legacy code rule applies to them.                                   |
| `server-v*`           | None exists. The tag trigger is removed.                                                  |
| `wpe-*` releases      | Replaced by GHCR. See [WPE WebKit prebuilds](#wpe-webkit-prebuilds).                      |

The old tag triggers for `player-v*` and `server-v*` are removed. A new tag with
those names does nothing. Download links to existing release assets continue to
work.

A Tilecast Edge screen that runs `0.2.1-preview.1` or older checks the legacy
rule. It computes the legacy code for a unified name and refuses the envelope.
This is a safe failure. The screen keeps its release and reports the failure. To
move such a screen to the unified line, install a release built with this change
by the Edge installer. Alternatively, publish one bridge release at a legacy
name, for example `0.2.2-preview.1`, from a build of this change. The bridge
envelope carries the legacy code. The screen installs it. The bridge release
knows both rules and can then install every unified release. Android screens
need no bridge: Android compares only the `versionCode` integer, and every
unified code is larger.

## WPE WebKit prebuilds

The private WPE WebKit build takes about two hours. `wpe-prebuild.yml` builds
it once for each combination of the pinned WPE version, the normalized builder
inputs, and the architecture. It publishes the result to GHCR.

| Property    | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Repository  | `ghcr.io/gbyo/tilecast-wpe`                                                           |
| Tag         | `<wpe version>-<inputs key>-<arch>`, for example `2.54.0-7560c6d0974d040b-x86_64`     |
| Type        | OCI artifact, `application/vnd.tilecast.wpe-prebuild.v1`. It is not a runnable image. |
| Content     | One `application/x-tar` layer                                                         |
| Annotations | Architecture, inputs key, tar SHA-256, WPE version, source commit, creation time      |
| Provenance  | A build provenance attestation for the tar, and one stored beside the registry object |

A tag is published once. `publish-wpe-prebuild.sh` never replaces a tag. The
inputs key ignores comments and whitespace in the builder files, so a comment
edit does not invalidate a prebuild.

The Edge release build gets WebKit in three tiers and falls back from one to
the next:

1. The GHCR prebuild. `fetch-wpe-prebuild.sh` pulls it and checks that the
   manifest is this build's prebuild, that the layer hashes to its digest, and
   that the tar has a build provenance attestation from `wpe-prebuild.yml`.
2. The Actions cache.
3. A compile from source.

A missing prebuild or a prebuild that fails a check slows a release. It never
changes what ships.

The jobs that publish need `packages: write`. The jobs that pull need
`packages: read`. A package that is linked to a public repository is public.
After the first publication, confirm in the package settings that
`tilecast-wpe` is linked to this repository.

### Backfill and cleanup

The WPE prebuilds were published as GitHub Releases named `wpe-<version>-<key>-
<arch>`. They move to GHCR in two reviewed steps. Neither step runs
automatically.

1. Run `wpe-backfill.yml`. It starts with `dry_run` on. For each old release it
   checks the SHA-256 that GitHub records, the SHA-256 in the notes, and the
   attestation. It publishes the tar to GHCR under the old build's own inputs.
   It never replaces a tag. Run it again with `dry_run` off.
2. Run `wpe-release-cleanup.yml`. It starts with `dry_run` on. It checks that no
   file in the repository reads an old release URL. For each old release it runs
   `migrate-wpe-prebuild.sh check`, which requires GHCR to hold exactly that tar.
   It deletes a release and its tag only when `dry_run` is off and `confirm` is
   `delete-wpe-releases`.

## Removed automation

`publish-linux-player-package.yml` published `@gibsonmb71/tilecast-player-linux`
to the npm registry of GitHub Packages. It ran by manual dispatch. One run
exists, on 2026-07-20. No document, script, or workflow in the repository
installs the package, and the Player ships as an AppImage. The workflow is
removed. The versions that are already published stay in the registry. The
package is still the name of the workspace in `package.json`. Restore the
workflow only if a consumer appears.

## Procedures

### Cut a Beta

1. Merge the changes to `main` and wait for the checks to pass.
2. Dispatch `Tilecast Release` from `main` with `version` set to `0.26.0-beta.1`.
3. Read the job summary. It shows the draft notes.
4. Check the draft in the GitHub Releases page. It is published when the run
   ends, unless `publish` is off.

### Promote to Stable

Dispatch with `version` set to `0.26.0`. The release is a new build from the
commit that you dispatch from. It is not a rename of the Beta.

### Resume or recover

Dispatch the same version. Use the table in [Resuming a release](#resuming-a-release).
If a draft is wrong, delete the draft in GitHub and dispatch again. Never delete
a published release. A published release is immutable. Publish a new version.

### Verify a release you downloaded

```sh
gh release download v0.26.0 --repo gbyo/tilecast --pattern SHA256SUMS --pattern 'tilecast-*'
sha256sum -c SHA256SUMS --ignore-missing
```

### First release after this change

Do these steps in order:

1. Run `wpe-backfill.yml` with `dry_run` on, then off.
2. Pull one prebuild, for example `oras manifest fetch ghcr.io/gbyo/tilecast-wpe:2.54.0-7560c6d0974d040b-x86_64`.
3. Confirm that the `tilecast-wpe` and `tilecast-server` packages are public and
   linked to `gbyo/tilecast`.
4. Run `wpe-release-cleanup.yml` with `dry_run` on and read the result. Then run
   it with `dry_run` off and `confirm` set.
5. If preview Edge screens are deployed, publish a bridge release. See
   [Releases that shipped earlier](#releases-that-shipped-earlier).
6. Dispatch `Tilecast Release` with `0.26.0-beta.1`.
7. After a Beta period, dispatch `0.26.0`.

## Failure modes

| Symptom                                              | Cause and action                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `must be newer than the newest published`            | The version is not newer. Choose a higher version.                                                                |
| `a release tag is never reused`                      | The tag exists and has no release. Resolve the tag by hand.                                                       |
| `Resume it by dispatching from that commit`          | The release is published at another commit. Dispatch from that commit.                                            |
| `a stable release requires every required component` | A required build failed. Read the build job. Dispatch again. The platforms that passed are reused from the draft. |
| `already exists from another build`                  | A Server image with that version tag is from another commit. Choose a new version.                                |
| `unexpected asset` or `does not match the inventory` | The draft changed after assembly. Delete the draft and dispatch again.                                            |
| `no usable prebuilt WPE WebKit`                      | The GHCR prebuild is missing or failed a check. The build falls back to the cache or the compile.                 |

## Tests

| Test                                                                                           | Covers                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `go test ./internal/updates ./internal/version ./cmd/tilecast-release-verify` in `apps/server` | The version rule, discovery of every family, independent failure, repeat imports, duplicate detection, channel mapping, pagination, the verify command |
| `cargo test -p edge-release -p tilecast-windows`                                               | The version rule and the channel agreement on a screen                                                                                                 |
| `python3 -m unittest discover -s scripts/release`                                              | The version rule, stamping, planning, aliases, contract, assembly, resume, and the GitHub client                                                       |
| `python3 -m unittest discover -s release` in `apps/edge`                                       | The WPE publish, fetch, and migration scripts                                                                                                          |
| `node --test scripts/ci/contracts/*.test.mjs`                                                  | The structure of the release workflows                                                                                                                 |
