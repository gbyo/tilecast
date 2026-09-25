---
title: Players
description: Install, pair, and update Tilecast Player on Android TV devices and Linux computers.
---

Tilecast Player runs on each display. Choose the Android APK for Android TV, Google TV, or Fire TV, or use the current Linux AppImage on a 64-bit x86_64 computer with a graphical desktop session.

Tilecast Edge is the new Linux Player that is still being developed. It replaces the current Electron/AppImage Player with a Linux service and WPE WebKit renderer. It is not the production Linux install yet; see [Tilecast Edge](../edge/) for the current preview.

| Player  | Install format                    | Notes                                                                                                            |
| ------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Android | Signed APK, `tilecast-player.apk` | For Android TV, Google TV, and Fire TV devices that allow APK installation.                                      |
| Linux   | AppImage                          | Current stable path. The server-provided installer targets x86_64 Linux with a graphical X11 or Wayland session. |
| Edge    | Signed Linux release tree         | Preview only. Use it only when a Tilecast release lists your hardware as supported.                              |

Find the Android APK on the [Tilecast releases page](https://github.com/gbyo/tilecast/releases). The Linux installer downloads a signed, verified release cached on your Tilecast Server. See [Install the Linux Player](./install-linux/).

## Connect a display

A Player can discover nearby servers or accept a manually entered address. Discovery is optional: the default Docker Compose setup disables mDNS, and multicast may not cross VLANs, guest networks, or access-point isolation. Enter the server address if it does not appear.

Use HTTPS for a public hostname. Both Players accept HTTP for local addresses such as private IPv4, `localhost`, and `.local` names. Enter the server address and optional port, without an API path.

An Owner or Administrator approves each new pairing request. Studio displays device details so you can compare the request with the display in front of you. For a step-by-step procedure, see [Pair a display](./pair-a-display/).

If you replace a broken device, choose **Replace hardware for an existing screen** during approval and select the existing screen. The logical screen, its assignments, schedules, policies, and history stay in place. The old credential is retired after the replacement Player enrolls.

## Playback and connection limits

Players store prepared content locally. A Player can continue to show cached content during a server or network interruption, but it cannot fetch a new assignment until it reconnects. Website and other remote content can also need its own network connection.

Pairing does not prove that a TV will launch Tilecast after a power cut or return from sleep. Android checks local readiness during commissioning. The Linux installer sets up a systemd user service, but a graphical session must still start on the host. Test the exact device model, firmware, and kiosk session before unattended use.

## Player tasks

- [Install Tilecast Player on Android TV](./install-android/).
- [Install Tilecast Player on Linux](./install-linux/).
- [Pair a display](./pair-a-display/).
- [Update a Player](./update-a-player/).
- [Compare Player capabilities](./capabilities/) before choosing hardware or depending on a platform-specific feature.
