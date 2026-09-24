---
title: Getting started
description: The shortest path from a new Tilecast installation to a paired display.
---

Follow this path to start Tilecast Server and pair one display. After that, use Studio to assign content.

One Tilecast installation represents one organization.

## Before you start

- A host that can run Docker Engine and Docker Compose v2.
- A display that can run Tilecast Player on Android TV, Google TV, Fire TV, or Linux x86_64.
- A network path between the display and the server.

Use an HTTPS address when a Player connects over the public internet. A private LAN can use a local address over HTTP.

## Set up the first display

1. [Install Tilecast Server](../installation/). On first visit, enter your organization name and create the first Owner account.
2. [Install Tilecast Player](../players/). Choose the Android or Linux guide for your display.
3. [Pair the display](../players/pair-a-display/). An Owner or Administrator approves the request in **Screens** > **Fleet**.
4. [Put content on a screen](../studio/). A new screen waits for a playlist or published Layout assignment.

A pairing code expires after ten minutes. If it expires before approval, request a new code from the Player.

The Android Player opens a required commissioning checklist after its first enrollment. Finish that checklist before expecting normal playback; the [Android Player guide](../players/install-android/) explains the steps.

## Next steps

- [Use Tilecast Studio](../studio/) to create and assign content.
- [Update a Player](../players/update-a-player/) after the first display is running.
- Read [Operations](../operations/) before leaving displays unattended.
