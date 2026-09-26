# GitHub Player updates

Tilecast distributes Android APK and Linux AppImage Player builds, and Tilecast
Edge release archives, through signed published releases at
`Gibsonmb71/tilecast`. No Google Play, Amazon Developer,
or paid Android developer account is required. Unknown-app installation remains
a one-time local commissioning permission. On Android 12 and newer, eligible
signed self-updates request Android's supported unattended-update mode. Older
Android and Fire OS installers may still require local confirmation.

## Release contract

Every stable release, and every GitHub prerelease used as the beta channel, must contain exactly named assets:

Android:

- `tilecast-player.apk`
- `tilecast-player-update.json`
- `tilecast-player-update.json.sig`

Linux:

- `tilecast-player.AppImage`
- `tilecast-player-update-linux.json`
- `tilecast-player-update-linux.json.sig`

Tilecast Edge (one set for each architecture, `x86_64` or `aarch64`):

- `tilecast-edge-<version>-<arch>.tar.zst`
- `tilecast-edge-update-<arch>.json`
- `tilecast-edge-update-<arch>.json.sig`

A direct upload of an Edge release names the envelope `tilecast-edge-update.json`
and its signature `tilecast-edge-update.json.sig`.

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

## Player families

Every release belongs to one Player family:

| Family           | Artifact                                 | Architecture               |
| ---------------- | ---------------------------------------- | -------------------------- |
| `android`        | `tilecast-player.apk`                    | Not architecture-specific. |
| `electron-linux` | `tilecast-player.AppImage`               | Not architecture-specific. |
| `edge`           | `tilecast-edge-<version>-<arch>.tar.zst` | `x86_64` or `aarch64`.     |

A manifest without `playerFamily` is `android` or `electron-linux` by its
platform. Version codes must increase within one family and architecture. A
deployment reaches only screens of its release's family: a screen reports its
family (`playerFamily`) and, for Edge, its architecture (`playerArchitecture`) in
the heartbeat. An Edge screen that has not reported them, or reports another
architecture, is `incompatible`. An Edge release never reaches an Electron or
Android screen, and an Electron release never reaches an Edge screen. The
Electron Player also refuses an `install_player_update` command whose
`playerFamily` is `edge`. The `install_player_update` payload carries
`playerFamily` and `expectedArtifactSha256` beside the existing fields.

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

## GitHub Actions secrets

The `Tilecast Player Release` workflow requires `TILECAST_ANDROID_KEYSTORE_BASE64`, both Android key passwords, `TILECAST_ANDROID_KEY_ALIAS`, `TILECAST_UPDATE_MANIFEST_PRIVATE_KEY_PEM`, and `TILECAST_UPDATE_MANIFEST_PUBLIC_KEY_PEM`. It refuses missing secrets and non-increasing version codes, builds and verifies the signed APK, extracts package and version metadata from the APK, signs and verifies the update manifest, verifies APK size/hash agreement, and publishes the three assets. Secret files exist only in the Actions runner temporary directory.

Pushing a tag named `player-v<versionName>` publishes a release automatically. The tag version must exactly match Android `versionName`; tags containing `beta` publish as prereleases, while other tags publish to the stable channel. The workflow may also be run manually for an existing matching tag, with an explicit stable or beta channel. Release notes are generated by GitHub when a manual summary is not supplied.

## Studio and player flow

Owners can either select **Upload release** or **Sync from GitHub** under
**Settings → Player Updates**. Direct upload accepts the exact Android or Linux
three-file set above. The server applies the same manifest-signature, artifact
hash/size, platform, and version checks to both sources, plus Android package,
minimum-SDK, and signing-certificate checks for APKs. A verified direct upload
is moved atomically into the same private update cache and creates the same
Player release record used by deployments. GitHub availability is therefore
optional.

Tilecast refreshes the GitHub release catalog automatically when the catalog is empty or the previous check is more than 15 minutes old. Studio keeps **Sync from GitHub** as an immediate retry and displays provider, signature, and release-verification failures instead of showing an unexplained empty table.

When a release is being cached, the server records downloaded bytes while the
artifact streams to disk. The Player Updates page polls that release every
second during the download and shows the live megabytes downloaded against the
signed artifact size; it returns to the normal slower refresh interval when no
release is downloading.

Authenticated GitHub requests receive a substantially higher API allowance than anonymous requests. To enable the Studio **Connect GitHub** device flow, create a GitHub OAuth App, enable **Device Flow**, and set its public client ID as `TILECAST_GITHUB_CLIENT_ID`. The OAuth App callback URL is required by GitHub but is not used by device flow; the Tilecast repository URL is an acceptable callback for this fixed public-release integration. No OAuth client secret belongs on Tilecast Server.

The Owner starts sign-in in Studio, opens GitHub's device page, and enters the displayed one-time code. The private device code remains only in server memory. After approval, Tilecast validates the GitHub account and stores the access token in `/data/updates/github-oauth.json` with owner-only file permissions. The token is never returned through the API, audit metadata, diagnostics, or logs. Disconnecting removes the local credential; the GitHub account can separately revoke the OAuth App grant. `TILECAST_GITHUB_TOKEN` remains supported as an environment-managed override and cannot be disconnected from Studio.

Owners and Administrators deploy a fully verified cached release to screens or
sync groups. Studio and the server restrict each release to screens of its
family (and architecture, for Edge). Studio shows Android, Linux and Tilecast
Edge on separate tabs. Sync-group membership is resolved
at deployment start and duplicates are removed. Modes are download only,
install now, and maintenance window. Screen states distinguish downloading,
verification, permission/user approval, installation, reconnecting, success,
failure, cancellation, incompatibility, and already-current. Players always
retrieve the verified APK or AppImage from their paired Tilecast server; the
player never contacts GitHub.

## Reading a deployment in Studio

The Android, Linux or Tilecast Edge choice is held in the URL (`?platform=linux`,
`?platform=edge`), so a reload, a
bookmark, or the back button all return to the fleet the operator was reading
rather than to Android.

**Settings → Player Updates → Deployment history** answers "did this land?"
without arithmetic. Each row carries one meter divided into updated, waiting on
someone, failed, and still in progress, and one sentence saying what the
deployment needs — a retry, someone at a TV, or nothing. Every segment is
repeated as a number and a word, so no state is carried by colour alone.

Opening a row reads `GET /api/v1/update-deployments/{id}` and lists the screens
the deployment reaches, one row each: the plain-language status, what a person
has to do about it, the version the screen is coming from and going to, whether
it is a canary, and when it last reported. States are grouped into needs
attention, in progress, and finished; screens that need attention sort first and
carry a marked edge, and the three groups are also filter tabs. Only a running
download shows a percentage, computed from reported bytes against the release's
artifact size; every other state shows its place in a Queued → Downloading →
Installing → Updated trail, because a step is what the player actually reports.
Failed and cancelled screens show no trail position at all.

A failed screen offers **Retry**, and an active or paused deployment offers
**Cancel deployment**; both are limited to Owners and Administrators and follow
the same screen-scope rules as the rest of the update routes. A screen waiting
for permission or for approval on the TV is never presented as a failure.

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

For the other families, a target in `reconnecting` becomes `succeeded` when an accepted heartbeat or bounded reconciliation confirms all of these conditions:

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

An offline player cannot receive a new deployment. `WaitingForPermission` and `WaitingForUser` are expected operational states, not failures. Silent installation is not claimed. Physical Fire TV and Google TV validation remains required for each device/OS family.
