---
title: Install Tilecast Player on Android TV
description: Install the signed APK, pair the TV, and complete its required commissioning checklist.
---

Tilecast publishes one signed APK for Android TV, Google TV, and Fire TV. Install the APK on the TV, connect it to Tilecast Server, and complete the commissioning checklist before playback.

## Install the APK

1. Download `tilecast-player.apk` from the [Tilecast releases page](https://github.com/gbyo/tilecast/releases).
2. Transfer the APK to the TV using your normal sideloading method and open it with the installer on the device.
3. If Android asks, allow the installer you used to install apps. The setting name and steps vary by device and Fire OS version.
4. Open **Tilecast Player**.

Use [Pair a display](../pair-a-display/) to select your server and approve the request in Studio. The Player checks the server installation identity before it uses a stored credential. Public hostnames need HTTPS; a private LAN may use a local HTTP address.

## Complete the commissioning checklist

After first enrollment, the Player opens **Harden this player**. This required checklist checks local setup before it enters normal playback.

1. Set a local administrator PIN. It opens the Player maintenance tools on this device.
2. Follow the **Accessibility Control** step. On Android devices that support the standard accessibility settings, select **Open Accessibility Settings**, enable the service, and select **Verify again**. Accessibility Control is optional on Fire TV; Fire OS does not show the standard Android setting, so you can continue without it.
3. Under **Allow signed Player updates**, select **Open install permission**, grant the requested Android install permission, and select **Verify again**. The commissioning checklist does not continue until this permission is granted.
4. Under **Verify launch after boot**, restart the TV once. Return to Tilecast Player and select **Check boot result**. If the device firmware blocks launch after boot, the step remains unverified.
5. Under **Verify fullscreen presentation**, confirm that immersive mode and keep screen awake show as verified.
6. Select **Run self-test**, then **View result**.
7. Review **Zero-Touch Readiness** and select **Finish commissioning**.

A result with warnings can still be finished. Studio keeps the screen marked partially ready. The check does not guarantee recovery from power, network, hardware, or Android approval failures.

Android may still show an installation confirmation for a Player update, depending on the OS version and device firmware. The permission allows Tilecast to request signed updates; it does not override every system installer prompt.

## After setup

A new screen has no assigned content. Use [Tilecast Studio](../../studio/) to assign a playlist or published Layout. For later software releases, see [Update a Player](../update-a-player/).
