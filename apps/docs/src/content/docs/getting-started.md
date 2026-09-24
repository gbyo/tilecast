---
title: Getting started
description: The order to set up a Tilecast installation, from the server to the first display.
---

By the end of this path, you'll have Tilecast Server running, one display paired to it, and content playing on that display.

## Before you start

You need:

- A computer that stays on and can run Docker Engine with Docker Compose v2. It runs Tilecast Server.
- A display device for Tilecast Player: a Fire TV, Google TV, or Android TV device, or a 64-bit Intel or AMD Linux computer with a graphical desktop session.
- A network where the display can reach the server's address.

One Tilecast installation serves one organization, such as a school, a library, or a business.

## Set up your first display

1. [Install Tilecast Server](../installation/). The first time you open it in a browser, Tilecast asks you to name your organization and create the first **Owner** account.
2. [Install Tilecast Player](../players/) on the display device. After you choose your server on the Player, it shows a six-character **pairing code**.
3. In Studio, go to **Screens** > **Fleet**, select **Pair screen**, and enter the code. Check that the device details match the display, then select **Approve and pair**.
4. Finish the setup steps that the Player shows on the display.
5. In Studio, go to **Content** > **Media**, upload an image or video, and wait until it shows **Ready**.
6. Add the media to a playlist, then choose that playlist as the screen's **fallback content**.

The Player downloads the content before it starts playing it. If the network drops later, it keeps playing what it already has.

:::note
A pairing code expires after ten minutes and works only once. If it expires, request a new code on the Player.
:::

## What plays on a screen

Fallback content is what a screen plays when nothing else applies. Tilecast decides what to show in this order:

1. An active takeover, which temporarily overrides everything else on the screens it targets.
2. A schedule that matches the current time.
3. The screen's fallback content.

Adding a schedule doesn't remove the fallback content. When the schedule ends, the screen goes back to it.

## Next steps

- [Use Tilecast Studio](../studio/) to organize screens into Display Groups and add schedules.
- Read [Operations](../operations/) before you leave a display running unattended.
- Plan backups in [Administration](../administration/) before you rely on the installation.
