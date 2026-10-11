# GitHub Player updates

Tilecast distributes Android APK and Linux AppImage Player builds, Tilecast
Edge release archives, and Windows Player MSIX packages, through signed
published releases at `gbyo/tilecast`. No Google Play, Amazon Developer,
or paid Android developer account is required. Unknown-app installation remains
a one-time local commissioning permission. On Android 12 and newer, eligible
signed self-updates request Android's supported unattended-update mode. Older
Android and Fire OS installers may still require local confirmation.

## Release contract

One coordinated GitHub release carries the Player platforms for a version. Android and Edge are required for every release. The Windows Player is required for Stable and optional for Beta.
The release is `vX.Y.Z` (Stable) or `vX.Y.Z-beta.N` (Beta, a GitHub
pre-release). [`release-process.md`](release-process.md) specifies the
process. Tilecast Server imports each Player family in the release on its own.
A release that carries only some of the families imports those families.

Each family in a release must contain exactly named assets:

Android:

- `tilecast-player.apk`
- `tilecast-player-update.json`
- `tilecast-player-update.json.sig`

Linux (the legacy Electron Player; not part of a coordinated release, and
imported only from the existing `player-linux-v*` releases):

- `tilecast-player.AppImage`
- `tilecast-player-update-linux.json`
- `tilecast-player-update-linux.json.sig`

Tilecast Edge (one set for each architecture, `x86_64` or `aarch64`):

- `tilecast-edge-<version>-<arch>.tar.zst`
- `tilecast-edge-update-<arch>.json`
- `tilecast-edge-update-<arch>.json.sig`

Windows Player (one set for each architecture, `x86_64` or `aarch64`):

- `tilecast-windows-<version>-<arch>.msix`
- `tilecast-windows-update-<arch>.json`
- `tilecast-windows-update-<arch>.json.sig`

A coordinated release also contains `SHA256SUMS`, the inventory
`tilecast-release.json`, and for Edge the signed release manifest and the SBOM
of each architecture. The server ignores these files. A GitHub release for the
Server or for a WPE prebuild has no Player assets, and the server ignores it.

A direct upload of an Edge release names the envelope `tilecast-edge-update.json`
and its signature `tilecast-edge-update.json.sig`. A direct upload of a Windows
release names the envelope `tilecast-windows-update.json` and its signature
`tilecast-windows-update.json.sig`.

The schema-1 JSON identifies `tilecast-player`, its platform, version code/name,
stable or beta channel, artifact name/size/SHA-256, and release notes. Android
also carries application ID `org.tilecast.player`, minimum SDK 23, and signing
certificate SHA-256. The signature is base64 Ed25519 over the exact JSON bytes.
Official Tilecast Server builds include the public release-verification key.
`TILECAST_UPDATE_MANIFEST_PUBLIC_KEY` may override it for custom Player builds;
the private key is never installed on Tilecast Server.

The Tilecast Edge JSON is the signed update envelope
([`tilecast-edge.md`](tilecast-edge.md) §15). It identifies `tilecast-edge`,
`playerFamily: "edge"`, platform `linux`, the architecture, the version code and
name, the channel, the archive name, size and SHA-256, the SHA-256 of the signed
release manifest inside the archive and of its SBOM, and the state database schema
of the release. The same key signs it in the same way. The server refuses an Edge
envelope that carries Android fields, a wrong archive name, an unknown
architecture or a version code that does not match its version name.

The Windows Player JSON is the same schema-1 signed envelope. It identifies
`tilecast-windows`, `playerFamily: "windows"`, platform `windows`, the
architecture, the version code and name, the channel, and the package name,
size and SHA-256. The Edge-only release-manifest fields must be absent: the
MSIX package carries the signed Windows publisher identity, and the envelope
binds the package. The same key signs it in the same way. The server refuses a
Windows envelope that carries Android or Edge release-manifest fields, a wrong
package name, an unknown architecture or a version code that does not match
its version name.

## Player families

Every release belongs to one Player family:

| Family           | Artifact                                 | Architecture               |
| ---------------- | ---------------------------------------- | -------------------------- |
| `android`        | `tilecast-player.apk`                    | Not architecture-specific. |
| `electron-linux` | `tilecast-player.AppImage`               | Not architecture-specific. |
| `edge`           | `tilecast-edge-<version>-<arch>.tar.zst` | `x86_64` or `aarch64`.     |
| `windows`        | `tilecast-windows-<version>-<arch>.msix` | `x86_64` or `aarch64`.     |

A manifest without `playerFamily` is `android`, `electron-linux` or `windows`
by its platform. Version codes must increase within one family and
architecture.

### Version ordering

The version code of a coordinated release is `(MAJOR * 1000000 + MINOR * 1000 +
PATCH) * 100 + slot`. The slot is the Beta number for a Beta and 99 for Stable.
Beta 1, Beta 2, Stable, and the next version therefore have increasing codes,
and a screen on a Beta can update to the next Beta or to Stable. A version below
`0.26.0` keeps its legacy code, which ignores the suffix. The server, Edge, the
Windows Player, and the Android build apply this rule to the version name, the
version code, and the channel, and each refuses a signed manifest in which they
disagree. See [`release-process.md`](release-process.md) for the rule and for
the screens that need a bridge release.

The record of a release is keyed by the GitHub release ID, the family, and the
architecture. One GitHub release can therefore hold an Android release, two Edge
releases, and two Windows releases. A GitHub release that is complete in the
database is not downloaded again. The server reads up to five pages of 100
releases, so a Server release or a WPE prebuild release cannot hide a Player
release. A family that fails verification is recorded as the reason of the last
check and in the server log. It does not stop the other families.

Studio maps a GitHub pre-release to the `beta` channel and any other release to
the `stable` channel. The server refuses a manifest whose signed channel is the
other one. A deployment reaches only screens of its release's family: a
screen reports its family (`playerFamily`) and, for Edge and Windows, its
architecture (`playerArchitecture`) in the heartbeat. An Edge or Windows
screen that has not reported them, or reports another architecture, is
`incompatible`. A release never reaches a screen of another family. The
Electron Player also refuses an `install_player_update` command whose
`playerFamily` is not `electron-linux`. The `install_player_update` payload
carries `playerFamily` and `expectedArtifactSha256` beside the existing
fields.

Drafts, arbitrary repositories, arbitrary asset names/URLs, invalid signatures, downgrades, incompatible SDK declarations, checksum mismatches, invalid APK signatures, and signing-certificate mismatches are rejected. A verified APK is streamed to a temporary file beneath `/data/updates`, checked, and atomically renamed. Players download only from their paired Tilecast server using authenticated range requests.

## Permanent signing keys

Create the Android key once and preserve secure offline backups:

```sh
keytool -genkeypair -keystore tilecast-player-production.jks -alias tilecast-player -keyalg RSA -keysize 4096 -validity 10000
openssl genpkey -algorithm Ed25519 -out tilecast-update-private.pem
openssl pkey -in tilecast-update-private.pem -pubout -out tilecast-update-public.pem
openssl pkey -pubin -in tilecast-update-public.pem -outform DER | tail -c 32 | openssl base64 -A
```

Never rotate the Android signing key casually: Android accepts an APK update only when its signing identity matches the installed application. Never commit either private key, keystore, aliases, passwords, signed APKs, or GitHub tokens.

For a local signed build, set `TILECAST_ANDROID_KEYSTORE_PATH`, `TILECAST_ANDROID_KEYSTORE_PASSWORD`, `TILECAST_ANDROID_KEY_ALIAS`, `TILECAST_ANDROID_KEY_PASSWORD`, `TILECAST_UPDATE_MANIFEST_PRIVATE_KEY`, `TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_FILE`, `ANDROID_HOME`, and run `scripts/build-player-release.sh`. Outputs go to ignored `release-output/` unless overridden.

## Release builds

The workflow `.github/workflows/release.yml` builds, signs, and publishes every
platform. It reads the secrets below and fails closed when one is missing. The
workflows `player-release.yml` (Android), `windows-player-release.yml`, and
`edge-release.yml` build one platform and upload Actions artifacts. They never
publish. A tag push does not start a release. The tags `player-v*` and `server-v*`
no longer publish anything.

Android needs `TILECAST_ANDROID_KEYSTORE_BASE64`, the two Android key passwords,
`TILECAST_ANDROID_KEY_ALIAS`, `TILECAST_UPDATE_MANIFEST_PRIVATE_KEY_PEM`, and
`TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_PEM`. The build checks that the public key
equals the repository key, builds and verifies the signed APK, extracts package
and version metadata from the APK, signs and verifies the update manifest, and
verifies that the APK size and hash agree. The build checks the APK signing
certificate against the pinned permanent certificate. Secret files exist only in
the Actions runner temporary directory.

Windows builds natively: x64 on `windows-latest` and ARM64 on `windows-11-arm`.
Emulation is never ARM64 support. It needs the two update keys, the code-signing
identity `TILECAST_MSIX_PFX_BASE64` with `TILECAST_MSIX_PFX_PASSWORD`, and the
manifest publisher `TILECAST_MSIX_PUBLISHER`. The public key must match the
repository key in `apps/edge/release/tilecast-update-key.pem`, and the PFX
subject must equal the manifest publisher, or the build fails before it
compiles. Each architecture builds the Player and the `tilecast-msix-version`
helper, stages the executable with its Player Runtime artifact, renders the MSIX
manifest from the template, packs and signs the package with the Windows SDK,
writes the update envelope, and signs it with the Tilecast Ed25519 key. A build
provenance attestation covers the package and the envelope.

The release workflow runs the server importer over the assets before it
publishes. See [`release-process.md`](release-process.md).

## Studio and player flow

The full-width **Settings → Player Updates** workspace has two views:
**Deployments** and **Release catalog**. A compact **Player type** selector sits
in the same operator toolbar as the views, and includes the current screen count
for each Player family. The URL stores the family in `platform` and the view in
`view`. Studio preserves unrelated query parameters. Page-level family changes
discard transient deployment overlays; changing Player type inside the deploy
workflow resets only choices that no longer apply.

**Deploy update** is the normal operational path and is available from either
view. The Release catalog is an administrative inventory, not a prerequisite for
deployment. It exposes release notes, verification state, cached artifacts,
manual upload and source configuration. Owners see **Sync releases** and release
maintenance commands only while that catalog is open.

Owners select **Sync releases** to refresh the fixed GitHub catalog.
**More → Upload release** accepts the exact three-file set above.
The upload dialog separates transfer progress from server verification.
The server applies the same manifest-signature, artifact hash, size, platform,
and version checks to both sources.
Android releases also require valid package, minimum-SDK, and certificate metadata.
A verified direct upload enters the private update cache atomically.
GitHub availability is optional.

Tilecast refreshes an empty GitHub catalog or a catalog older than 15 minutes.
Studio retains existing releases during refresh.
The Release catalog shows provider and verification errors with a retry action.
GitHub variants with the same tag and release metadata share one version card.
Direct uploads remain separate. The five newest version groups are shown first,
with explicit disclosure for older entries. Edge and Windows builds use
operator-facing architecture labels (**Intel / AMD 64-bit** and **ARM64**) while
retaining the exact `x86_64` or `aarch64` identifier.

A deployment still selects one concrete release record. If a verified GitHub
build is not cached, **Prepare build** starts the existing server-side cache
operation from the deployment workflow. Preparation continues independently of
the dialog; Studio polls the release catalog every second while a build is
downloading and shows actual bytes against the signed artifact size. An operator
may close the dialog and return later. If the dialog remains open, **Continue**
becomes available when the selected build becomes verified and cached. Owners and Administrators
may prepare a build because both roles may create update deployments; release
source configuration, direct upload and cache cleanup remain Owner operations.

The release detail shows notes, verification state, cache state, and active use.
Technical details include the artifact name, hash, and signature state.
Cache removal requires confirmation.
An active or paused deployment prevents cache removal.
A purged direct upload must be uploaded again.

Authenticated GitHub requests receive a higher API allowance.
The Owner opens **More → Configure source** to configure or connect GitHub.
To enable the device flow, create a GitHub OAuth App and enable **Device Flow**.
Set its public client ID in Studio or with `TILECAST_GITHUB_CLIENT_ID`.
GitHub requires a callback URL but does not use it for device flow.
The fixed Tilecast repository URL is a valid callback.
Tilecast Server does not require an OAuth client secret.

The Owner starts sign-in, opens GitHub's device page, and enters the displayed code.
The private device code stays in server memory.
After approval, Tilecast validates the account.
Tilecast stores the token in `/data/updates/github-oauth.json` with owner-only permissions.
The API, audit metadata, diagnostics, and logs never contain the token.
Disconnect removes the local credential.
The GitHub account can revoke the OAuth App grant separately.
`TILECAST_GITHUB_TOKEN` is an environment-managed override.
Studio cannot disconnect that override.

## Deployment preflight and creation

Owners and Administrators select **Deploy update** to open one focused
three-stage workflow. Desktop uses a centered Dialog; narrow layouts use a
Drawer with the same state and footer.

1. **Update** chooses Player type and version. Versions are grouped independently
   of architecture. When more than one Edge or Windows build applies, the operator
   then chooses **Intel / AMD 64-bit** (`x86_64`) or **ARM64** (`aarch64`).
   An unambiguous version/build is selected automatically. A build matching no
   known screen in that Player family cannot continue. If the selected verified
   GitHub build is not cached, **Prepare build** starts its server-side
   preparation without requiring a detour through Release catalog.
2. **Targets** searches screens and Display Groups from the chosen Player family.
   Server preflight expands groups and removes duplicate screens.
   Incompatible screen options show the server reason.
   A selected group with an incompatible member blocks submission.
   Offline and already-current screens have separate warnings.
3. **Rollout** leads with the deployment review and defaults to **Install now**.
   Deployment mode is one compact choice; the maintenance time control appears
   only for **Maintenance window**. Canary configuration lives under
   **Rollout safeguards** and is disclosed only when the operator needs it.
   **Deploy update** submits the review without a second confirmation.

`POST /api/v1/update-deployments/preview` accepts `releaseId`,
`screenIds`, and `groupIds`.
The operation requires an Owner or Administrator session, CSRF, and write scope.
It authorizes direct and expanded targets.
It reads a consistent database snapshot without changing deployments,
commands, audit records, release cache, or provider state.

The response includes each screen and its exact incompatibility reason.
Counts distinguish eligible, offline, already-current, and incompatible targets.
Eligible count includes offline screens that can receive a queued command.
Offline count describes the existing 15-minute update-contact criterion.
It is not the computed fleet status.

Preview and creation use one target-expansion and compatibility resolver.
Creation evaluates the current metadata again inside its transaction.
Preview does not reserve targets or grant authorization.
Creation preserves family exclusion and deterministic canary selection.
Preview includes wrong-family group members so Studio can show the conflict.
Unknown Android SDK remains subject to verification on the Player.
Known SDK below the release minimum is incompatible.
Current-version rules remain unchanged.

Offline commands wait for the Player to reconnect.
The commands expire after seven days.
Already-current screens receive no update command.
Canary size is 1–50 and must leave targets for the next cohort.
Studio disallows a canary selection that contains already-current screens.
The server retains its existing canary rules.

After creation, Studio closes the workflow and opens the new deployment.
Players retrieve artifacts from their paired Tilecast Server.
Players never contact GitHub for deployment.

## Reading a deployment in Studio

The default **Deployments** view is an operator queue rather than one mixed
chronological list. Live work that needs intervention appears first under
**Needs attention** as compact action rows. Healthy live work is separate under
**In progress**, and terminal work appears in **Recent deployments**. Section
badges state screen counts rather than mixing deployment counts with target
counts. If no rollout is live, Studio shows an explicit all-clear instead of
dropping directly into history.

The Deployments tab carries a fleet-wide attention badge even while the operator is
browsing Release catalog. A family-scoped view also surfaces attention in other
Player types with a direct switch action. Selecting an attention row opens the rollout detail
already filtered to affected screens. Deployment and history surfaces use the
same operator-facing architecture labels as the deployment workflow while
preserving the exact architecture identifier.

**View rollout** reads `GET /api/v1/update-deployments/{id}`.
The detail shows mode, phase, canary size, times, and any safe pause reason.
Search and the **Needs attention**, **In progress**, **Finished**, and **All**
filters select screen rows.
Each row shows the current and expected version, canary status, report time,
and a plain-language state.
Failed and incompatible rows preserve the exact safe reason.

Only a downloading target shows percentage progress.
Studio computes that percentage from reported bytes and the signed artifact size.
Other states show a status without invented progress.
Owners and Administrators can retry failed targets.
Permission and TV-approval states do not offer retry.
**Cancel deployment** requires confirmation.
Cancellation does not revert an installed release.
Initial loading uses skeleton rows.
Background refresh retains the current rows.

## CI publishing

Set `TILECAST_RELEASE_PUBLISH_TOKEN` to a high-entropy secret to enable narrowly scoped CI publishing. A CI job may send the same three multipart files to `POST /api/v1/player-releases/upload` with `Authorization: Bearer <token>`. This token grants only release upload access. Studio uses the normal Owner session and CSRF token instead. Keep the publishing token in CI and deployment secret storage; it is never returned by the API or written to audit metadata. The update-manifest private key and Android keystore must never be installed on Tilecast Server.

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $TILECAST_RELEASE_PUBLISH_TOKEN" \
  -F "files=@tilecast-player.apk;type=application/vnd.android.package-archive" \
  -F "files=@tilecast-player-update.json;type=application/json" \
  -F "files=@tilecast-player-update.json.sig;type=text/plain" \
  https://tilecast.example.org/api/v1/player-releases/upload
```

The player resumes `.part` downloads, verifies available storage, SHA-256, package name, version code, minimum SDK, signing certificate, install permission, and Takeover state, then uses Android `PackageInstaller`. For API 31 and newer it declares `UPDATE_PACKAGES_WITHOUT_USER_ACTION` and requests `USER_ACTION_NOT_REQUIRED` for its own signed update. Android can still return `STATUS_PENDING_USER_ACTION`, so the Player preserves an explicit confirmation fallback instead of claiming universal silent installation. Takeover playback delays installation but not downloading. Pairing credentials, manifests, configuration, disabled state, and media cache live outside the APK and survive replacement. The package-replaced receiver and the already-enabled bounded Accessibility service both request a return to Tilecast after replacement; Accessibility never reads or clicks installer controls. Success is recorded after the updated Player reconnects at the expected version, remains up for at least 120 seconds or does not report uptime, is not in safe mode, and reports no update error. Healthy playback is not required, so a sleeping screen can settle the update.

Deployments may start with a deterministic canary cohort. Other targeted screens remain held until every canary reconnects successfully. The rollout pauses when a canary reports failure, enters safe mode, or remains reconnecting beyond the bounded health window. Studio shows the rollout phase and safe pause reason; it never treats `WaitingForUser` as failure.

## Settling a deployment

A Tilecast Edge target settles only on the screen's explicit report. The Edge
update helper keeps a new release provisional until the running release
confirms it (a live server link, a ready renderer and meaningful playback
evidence for 120 seconds), and only then does the screen send `succeeded`.
Heartbeat reconciliation never settles an Edge target, and the server refuses a
`succeeded` report for any other family. A release that does not confirm is
rolled back on the screen, which reports `failed` with `installerStatus:
"rolled_back"` and a reason code such as `confirmation_timeout`,
`rebooted_while_provisional`, `candidate_daemon_restarting` or
`candidate_daemon_failed`. A canary rollback pauses the deployment like any other
canary failure.

For the other families, including Windows, a target in `reconnecting` becomes
`succeeded` when an accepted heartbeat or bounded reconciliation confirms all
of these conditions:

- Player version code is at or above the expected version.
- Player uptime is at least 120 seconds, or the Player does not report uptime.
- Player is not in safe mode.
- Player reports no update error.

Healthy playback is not required. A sleeping screen can settle the update. The transition touches only non-terminal states, so it is idempotent. A repeated heartbeat does not change the target, double-count it, or move a completed deployment back to active. The deployment becomes `completed` when no target remains unfinished. Its original completion time remains unchanged.

The heartbeat path drops malformed optional playback identifiers instead of
rejecting the whole message (see [`player-protocol.md`](player-protocol.md)).
The lifecycle fields can therefore still settle the update. Reading the
deployment list or detail runs bounded reconciliation. Reconciliation settles a
target when the screen contacted the server within five minutes, reports the
expected version, meets the uptime condition, is not in safe mode, and reports
no update error. The reconciliation also completes an active deployment when
all targets are terminal. It runs before the canary pause check.

An offline Player receives a queued update command after it reconnects within the command expiry period. `WaitingForPermission` and `WaitingForUser` are expected operational states, not failures. Physical Fire TV and Google TV validation remains required for each device/OS family.
