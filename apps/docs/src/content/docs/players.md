---
title: Players
description: Install Tilecast Player on an Android TV device or a Linux computer and pair it with your server.
---

Tilecast Player is the app that runs on each display. There are two builds, and both pair, play, schedule, and update the same way.

| Platform                       | Devices                                                      | Install format                       |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------ |
| Android TV, Fire TV, Google TV | TV devices, including ones without Google Play Services      | Signed APK: `tilecast-player.apk`    |
| Linux                          | 64-bit Intel or AMD computers with an X11 or Wayland desktop | AppImage: `tilecast-player.AppImage` |

Download both from the [Tilecast releases page](https://github.com/gbyo/tilecast/releases). A Linux computer can also install the Player directly from your server with the installer script that Tilecast Server publishes.

## Connect a display

1. Install and open Tilecast Player on the display device.
2. Select your server from the list, or enter its address. The Player checks the server's identity before it continues.
3. Leave the six-character pairing code on the screen.
4. In Studio, go to **Screens** > **Fleet**, select **Pair screen**, and enter the code.
5. Check that the device details in Studio match the physical display, then select **Approve and pair**.
6. Finish the setup steps that the Player shows on the display.

Don't approve a request based on the code alone. Compare the model, platform, and network address with the device in front of you. If you don't recognize a request, select **Reject**.

## Server address rules

The Player accepts plain `http://` only for private network addresses, `localhost`, and `.local` names. A public hostname needs `https://`. The Player never switches an `https://` address to `http://` on its own.

If the Player can't find your server in the list, enter the address. Automatic discovery doesn't cross VLANs, guest Wi-Fi, or most Docker network setups.

## If the server identity changes

A paired Player remembers which Tilecast installation it belongs to. If the same address starts answering as a different installation, the Player stops and won't send its credential. This usually means the wrong database was restored, or a hostname now points at another server. Check the server before you reset the Player: pairing it again to the wrong installation creates a new screen instead of recovering the old one.

## Before a display runs unattended

Installing and pairing a Player doesn't prove it will recover after a power cut, wake the TV, or stay locked to the Tilecast app. Test each device model and firmware you deploy. The [Install Tilecast Player](https://github.com/gbyo/tilecast/blob/main/wiki/Install-Tilecast-Player.md) and [Reliability and Kiosk](https://github.com/gbyo/tilecast/blob/main/wiki/Reliability-and-Kiosk.md) guides in the repository cover each platform in detail.
