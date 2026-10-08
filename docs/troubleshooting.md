# Troubleshooting

## Linux Edge renderer and live preview diagnosis

- **Preview unavailable while playback continues:** inspect the Edge `renderer.preview` capability and daemon/renderer diagnostics. Edge can suspend still previews after renderer stalls to protect playback. Reloading Studio does not establish whether a capture reached the renderer. See [Live previews](live-previews.md).
- **Renderer fails following migration or update:** review the [Edge 0.2.1 sandbox findings](tilecast-edge-sandbox-review.md) and [Edge architecture](tilecast-edge.md). WPE requires its own bubblewrap sandbox and the validated runtime-library closure. Do not use Linux Legacy Electron flags or disable WebKit's sandbox.
- **Remote production display:** collect read-only status and logs first. Do not issue exploratory restarts, credential replacements, or rollbacks without an understood recovery path and physical-access plan.

## Reliability and power

- **Zero-Touch Readiness says Needs setup or Partially ready:** inspect every safeguard on the screen’s Reliability tab. Accessibility and install permission require local Android approval. Boot launch is confirmed only after a real boot and healthy foreground return. Cached fallback requires fully prepared downloadable content. Use **Run setup again** in the local maintenance menu without deleting pairing.
- **A canary update paused:** review the safe rollout reason. Tilecast pauses for explicit failure, safe mode, or a missed reconnect; it does not continue to held screens automatically after a bad canary.

- **Managed Kiosk remains Standard:** the policy is requested but Android has not confirmed device-owner permission and active lock task. Provision locally on compatible firmware.
- **Tilecast does not launch after boot:** consumer firmware may block foreground launch. Open Tilecast once, remove vendor battery restrictions, and record `foreground_launch_blocked` in Studio; cached content remains available when launched.
- **TV did not turn off or wake:** Android Power Assist asks Android to sleep/wake and does not send raw CEC. On Linux, open the screen's Display Control details, confirm `cec-ctl`/`ddcutil` installation and device permissions, probe again, and distinguish a command that was sent from a display state that was confirmed.
- **Display Control is unsupported:** capability detection is per Player. Check `/dev/cec0`, the CEC device group, the display's I²C access, and `ddcutil detect --brief`; a missing or incompatible provider is reported without interrupting playback.
- **Accessibility keeps returning from Settings:** Settings and installers are excluded by default. End the loop with the maintenance sequence and verify the locally configured package allowlist.
- **Recovery screen is shown:** the bounded watchdog entered safe mode. Inspect the diagnostic code and storage, then issue Retry recovery or Exit safe mode. Tilecast does not automatically delete cache, manifests, or pairing.

- **No server appears:** use manual entry, confirm the TV and server share a network, and check multicast or client-isolation rules.
- **Public HTTP is rejected:** use HTTPS. HTTP is permitted only for private IPv4, link-local, localhost, and `.local` addresses after a visible warning.
- **Code expired:** request a new code on the TV; pairing sessions last ten minutes.
- **Identity changed:** confirm the address points to the intended installation, then reset the saved connection. Tilecast will not send the old credential to a different installation ID.
- **Screen is disabled:** enable it in Screens. Pairing remains intact.
- **Pairing revoked:** choose Pair again on the TV and approve a new request.
- **Pairing recovery required:** the player installation matches an existing screen with an active credential. Review the existing screen name and select **Repair and replace credential**. The old credential remains valid until this player successfully enrolls, and all content relationships stay on the original screen record.
- **Unsupported request field:** update Studio and Player together. Strict JSON errors now name the mismatched field; pairing and enrollment request bodies are never written to logs.
- **Tunnel connection fails:** enter the public HTTPS hostname manually and verify the Tunnel routes to `http://server:8080`.
- **AirPlay is unavailable:** confirm that the Linux Player has UxPlay 1.73.6, GStreamer H.264 support, Avahi, and a supported decoder. Run the AirPlay installer on an x86_64 Debian-family host. The installer gets the UxPlay source archive from Tilecast Server and gets build dependencies from Debian package mirrors. AirPlay failure does not stop Player installation, pairing, or normal playback.

## Presentation Networks and AirPlay discovery

- **Presentation Network is unavailable:** check that `TILECAST_PRESENTATION_NETWORK_KEY` is set to a valid 32-byte hex or Base64 value, then restart the server. A missing key leaves the rest of Tilecast running but blocks credential creation and player provisioning.
- **Credentials became unreadable after restore:** restore the same external encryption key used when the database was written. If it is unavailable, re-enter each network credential in Settings → Presentation Networks; the database ciphertext cannot be decrypted without the key.
- **Wi-Fi adapter unavailable:** confirm the Linux host exposes a usable adapter to NetworkManager. A Presentation Network does not add hardware.
- **NetworkManager unavailable:** install/enable the host's intended NetworkManager service and restart `tilecast-networkd`; the Tilecast installer will not migrate an existing Ethernet stack for you.
- **Helper missing or unhealthy:** run `sudo systemctl status tilecast-networkd`, inspect `sudo journalctl -u tilecast-networkd`, and re-run `/install-presentation-network.sh`. Do not give the kiosk user sudo or a general polkit rule.
- **Authentication failed, SSID not found, or DHCP timed out:** verify the saved network type, hidden-SSID flag, Enterprise identity/CA/domain, radio coverage, VLAN policy, and DHCP scope. Rotate the secret in Studio when the Wi-Fi administrator changes it.
- **Ethernet is not the default route:** inspect `ip route` and NetworkManager metrics. Tilecast tears down the sidecar Wi-Fi when it would displace Ethernet; it does not modify the Ethernet profile.
- **No usable wired IPv4:** group AirPlay requires the player-reported wired IPv4 and rejects loopback, link-local, multicast, IPv6, and temporary Wi-Fi addresses as RTP destinations.
- **Wi-Fi works but AirPlay is not visible:** verify UDP 5353/mDNS reachability and that access-point client isolation permits sender-to-gateway traffic. Tilecast does not bridge VLANs, route between them, provide an mDNS reflector, enable NAT/IP forwarding, or bypass client isolation.
- **Stale profile remains:** wait for configuration reconciliation or use Sync now. Assignment and revision are durable; the player removes obsolete `tilecast-presentation-*` profiles before installing the current assignment.

## Media

- **Readiness reports media infrastructure unavailable:** confirm `/data/media` is writable by the Tilecast runtime user and that the configured FFmpeg and FFprobe paths are executable.
- **Upload offset mismatch:** use `HEAD /api/v1/uploads/{id}` and resume from the returned `Upload-Offset`; do not restart from a client-cached offset.
- **Upload remains finalizing:** finalization is journaled. Leave the temporary/media volume and database row intact; the reconciliation worker retries storage movement and registration idempotently. A moved object with a failed database commit is recovered by its recorded asset/variant identity, and an abandoned source is failed and cleaned after the recovery window.
- **Insufficient storage:** free space or reduce the upload. Tilecast reserves `TILECAST_MEDIA_RESERVED_FREE_BYTES` after accounting for the declared upload size.
- **Processing failed:** inspect server logs using the request/job identifier. Studio receives only a safe error message, never raw FFmpeg output. Use Retry after correcting missing executables or storage permissions.
- **Variant unavailable:** the asset must be ready, the variant must be player-compatible, and the underlying file must still exist. Restore both database and media volume from the same backup point.

## Player synchronization and playback

- **Manifest remains out of date:** confirm the socket is connected, then allow the five-minute reconciliation fallback.
- **Insufficient player storage:** Automatic videos fall back to streaming, but explicit Download items prevent activation when the cache limit or free-space reserve is exceeded. The previous manifest keeps playing.
- **Download restarts or a cache is quarantined:** Tilecast verifies SHA-256 and size before accepting, serving offline, or promoting an update. Same-size corruption is rejected and redownloaded; keep the media directory writable so the invalid file can be quarantined or removed.
- **Cached content disappears after pairing/server changes:** cached manifests, configuration, downloads, and playback checkpoints are bound to installation ID, screen ID, and normalized server URL. A confirmed replacement or reassignment clears incompatible state rather than applying another screen's content.
- **Content is online-only:** Stream items require the server. Use Download, or Automatic for images and suitably sized videos.
- **No playable content:** every item failed or was unavailable. Tilecast waits before retrying instead of remaining black or entering a tight loop.
- **No content screen appears:** fallback precedence is active assigned playback, disabled, active-hours sleep, assigned-content-unavailable, offline, then known no-content. A transient network failure leaves a valid cached assigned presentation active. The unavailable surface is used when an assigned playlist/Layout has no currently renderable path; the no-content surface is used only when the server confirms there is no assignment. Organization logo, colors, message, and footer come from the effective player configuration.

## A schedule changes at the wrong time

Check the schedule's IANA timezone and the player clock warning in screen details. Tilecast Player uses one persisted server-corrected clock for schedules, availability, takeovers, overrides, and offline playback. Confirm a recent manifest sync and automatic date/time on the TV; a malformed fresh timestamp leaves the last valid offset in force. Around daylight-saving changes, nonexistent local times advance to the first valid time after the gap, while repeated times use the earlier start occurrence and later end occurrence.

If a future one-time event was created after the player lost connectivity, it cannot activate until the player receives a new manifest. Weekly rules already present in the active manifest continue recurring offline when their Download-policy assets remain cached.

## A website is unavailable or blocked

Open the website asset for safe player diagnostics. Confirm the TV can resolve and reach the origin, its clock is correct for TLS, and redirects remain on an explicitly allowed host. Tilecast never bypasses certificate errors. Add a related redirect host only when it is trusted and intentional; wildcards are unsupported.

Website pages are not offline-capable. Configure a ready fallback image for predictable offline presentation, or use the Tilecast placeholder/skip behavior. Do not rely on incidental WebView cache. On persistent site-state problems, an Owner or Administrator can clear website data from screen details; the command requires the player to reconnect before its ten-minute expiry.

For stale player policy, compare the effective configuration revision with the active revision reported by the player, then request configuration reconciliation from Settings → System. Invalid configuration preserves the previous valid revision and reports a safe error.

## A Player update is unavailable or waiting

Confirm the release is published rather than draft and contains the three exact asset names. Check the trusted manifest public key, GitHub rate-limit status, `/data/updates` free space, and that the version code exceeds the installed player. Verification failures are intentionally undeployable.

If GitHub reports an API rate limit, open Settings → Player Updates and connect a GitHub account. If **Connect GitHub** is disabled, configure `TILECAST_GITHUB_CLIENT_ID` with a device-flow-enabled OAuth App client ID and restart Tilecast Server. An environment-managed `TILECAST_GITHUB_TOKEN` also authenticates requests. Tilecast requests no private-repository scope for the fixed public release source.

`Waiting for permission` requires enabling unknown-app installation for Tilecast Player. `Waiting for user` requires approving Android or Fire OS. Takeover playback delays installation. Interrupted downloads resume from `.part`. A certificate mismatch means the installed app and release use different Android keys and cannot update in place.

`Installed certificate mismatch` means the Player currently on the TV was signed with a different Android key than the verified release, commonly because a debug APK was installed during setup. Android cannot replace it in place. Uninstall that Player once, install the production-signed `tilecast-player.apk`, and pair the screen again. Preserve the same production keystore for every later release.

Linux Player `0.2.4` and earlier cannot safely complete an AppImage replacement
from Studio: the staged download loses its executable bit before restart. Install
`0.2.5` or newer manually once, ensure
`~/tilecast/tilecast-player.AppImage` is executable and owned by the kiosk user,
then later Studio deployments can atomically replace the AppImage and let the
user systemd unit start the verified update.

If the Linux service repeatedly reports that FUSE is unavailable, update its
`ExecStart` to:

```ini
ExecStart=%h/tilecast/tilecast-player.AppImage --appimage-extract-and-run
```

This is the supported managed startup path. It does not require FUSE 2 and
still preserves the original AppImage path for Studio-driven replacement.
Linux Player 0.5.0 and older use the legacy FUSE 2 runtime; later release
artifacts use the static runtime as the primary packaging-level fix.

The Tilecast-managed service is a **user** unit. Use `systemctl --user`, not
`sudo systemctl`; the latter operates a separate system manager and may still
be running an older unit without the recovery hook. Re-run **Set up autostart**
in Studio, or replace the hand-installed unit with the template the server
publishes at `/install/tilecast-player.service`. Studio captures the running
AppImage's display variables, data directory, and server URL, writes and
enables the unit, and deliberately does not start it: the current manual
process remains on screen until the next controlled restart, session restart,
or reboot. Do not run `systemctl --user start` or `--now` while that process is
still running, because that would create a duplicate player. If the player is
already stopped, or after the handoff, use:

```sh
systemctl --user daemon-reload
systemctl --user reset-failed tilecast-player
systemctl --user start tilecast-player
```

Current Tilecast-generated units include
`Environment=PATH=/usr/local/bin:/usr/bin:/bin`, so a provisioned UxPlay at
`/usr/local/bin/uxplay` is discoverable even when the display manager supplied
a minimal PATH. Re-running **Set up autostart** safely repairs an older
Tilecast-generated unit; an operator-owned unit without the Tilecast marker is
left unchanged.

The managed unit attempts to unmount stale FUSE filesystems below
`/tmp/.mount_*` before each start. It does not recursively delete arbitrary
temporary directories. If a separately installed system-level unit is required,
copy the same `ExecStartPre` from the template into that unit and manage it
consistently through `sudo systemctl`.

## Nobody can sign in with a passkey

Passkeys need a secure browser context and a registrable domain. A plain-HTTP
LAN installation, or one reached at an IP address, cannot run a WebAuthn
ceremony at all; Studio hides the passkey controls and states the reason on
My Account → Sign-in security. Serve Tilecast over HTTPS at a hostname and point
`TILECAST_PUBLIC_URL` at that address. When a proxy's external hostname differs
from the one the server sees, set `TILECAST_WEBAUTHN_RP_ID` and
`TILECAST_WEBAUTHN_ORIGINS` together and restart. The server logs the reason
passkeys are disabled at startup.

An existing passkey that stops working after the relying party changes cannot be
repaired: a credential is bound to the domain it was created for. Remove it and
enroll again from the new address.

## Someone is locked out of Studio

Have them use a recovery code first. Otherwise an Owner or Administrator opens
Settings → Users, edits the account, and chooses **Reset** under Two-step
verification; this clears every factor, signs that account out everywhere, and
is audit-logged. Only an Owner may reset an Owner or Administrator.

When the only Owner is locked out, run on the server host:

```sh
tilecast-server mfa reset owner@example.org
```

It reads the same `TILECAST_*` variables as the server and asks for
confirmation. See
[multi-factor authentication](multi-factor-authentication.md).

## Authenticator codes are always rejected

Tilecast accepts a code from the current thirty-second step and one step either
side. A device whose clock is off by more than about a minute will fail every
time; correct the clock on the phone, not on the server. A code that was just
used cannot be used again, so re-entering the same digits after a failed
attempt will not work — wait for the next code.
